import express from 'express';
import WebTorrent from 'webtorrent';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = 50;

const app = express();
app.use(cors());

const client = new WebTorrent();

client.on('error', (err) => {
    console.error('[!] WebTorrent Client Error:', err.message);
});
process.on('uncaughtException', (err) => {
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return;
    console.error('[!] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    if (reason && (reason.name === 'AbortError' || reason.code === 'ABORT_ERR')) return;
    console.error('[!] Unhandled Rejection:', reason);
});

// ─── Storage Configuration ─────────────────────────────────────────────────────
const DEFAULT_DL_PATH = process.env.DEFAULT_DL_PATH || null;
const FALLBACK_DL_PATH = process.env.FALLBACK_DL_PATH || 'D:/TempMovies';
const LARGE_FILE_THRESHOLD_GB = parseFloat(process.env.LARGE_FILE_THRESHOLD_GB || '20');

function getDiskFreeBytes(drivePath) {
    try {
        const drive = path.parse(drivePath).root.replace(/\\/g, '');
        const result = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, { encoding: 'utf8' });
        const match = result.match(/FreeSpace=(\d+)/);
        if (match) return parseInt(match[1], 10);
    } catch (e) { console.warn(`[!] Could not check free space for ${drivePath}:`, e.message); }
    return Infinity;
}

function pickDownloadPath(fileSizeBytes) {
    if (!DEFAULT_DL_PATH && !FALLBACK_DL_PATH) return undefined;
    const thresholdBytes = LARGE_FILE_THRESHOLD_GB * 1024 * 1024 * 1024;
    if (DEFAULT_DL_PATH && fileSizeBytes <= thresholdBytes) {
        const freeBytes = getDiskFreeBytes(DEFAULT_DL_PATH);
        if (freeBytes > fileSizeBytes * 1.1) return DEFAULT_DL_PATH;
    }
    if (FALLBACK_DL_PATH) {
        if (!fs.existsSync(FALLBACK_DL_PATH)) fs.mkdirSync(FALLBACK_DL_PATH, { recursive: true });
        return FALLBACK_DL_PATH;
    }
    return undefined;
}

// ─── Torrent State ─────────────────────────────────────────────────────────────
// activeTorrents: magnetURI → torrent (ready or in-flight)
const activeTorrents = new Map();

// pendingCallbacks: magnetURI → [callback,...] queued while client.add() is in-flight
// The FIRST caller fires client.add(); subsequent callers are queued and called when ready.
const pendingCallbacks = new Map();

/**
 * Safe torrent getter — if the torrent is already known (active or pending), resolves
 * immediately or queues. Never calls client.add() more than once per magnetURI.
 * callback receives the ready torrent instance (or null on error).
 */
function getTorrent(magnetURI, callback) {
    // Already fully ready
    const existing = activeTorrents.get(magnetURI);
    if (existing) {
        if (existing.ready) return callback(existing);
        return existing.once('ready', () => callback(existing));
    }

    // Someone else already called client.add() — queue behind them
    if (pendingCallbacks.has(magnetURI)) {
        pendingCallbacks.get(magnetURI).push(callback);
        return;
    }

    // First caller — initiate add
    console.log(`[+] Adding torrent: ${magnetURI.substring(0, 60)}...`);
    pendingCallbacks.set(magnetURI, [callback]);

    const dlPath = DEFAULT_DL_PATH || FALLBACK_DL_PATH || undefined;
    const addOpts = dlPath ? { path: dlPath } : {};

    client.add(magnetURI, addOpts, (torrent) => {
        activeTorrents.set(magnetURI, torrent);
        const pending = pendingCallbacks.get(magnetURI) || [];
        pendingCallbacks.delete(magnetURI);

        if (!torrent.ready) {
            // Wait for ready before firing callbacks
            torrent.once('ready', () => {
                pending.forEach(cb => cb(torrent));
            });
        } else {
            pending.forEach(cb => cb(torrent));
        }
    });
}

// ─── /stream endpoint ─────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).send('Missing "magnet" query parameter.');

    getTorrent(magnetURI, (torrent) => {
        handleStream(torrent, req, res, magnetURI);
    });
});

function handleStream(torrent, req, res, magnetURI) {
    if (!torrent || !torrent.files || torrent.files.length === 0) {
        console.error(`[!] No files found for torrent: ${torrent?.name || 'unknown'}`);
        if (!res.headersSent) res.status(500).send('Torrent has no files');
        return;
    }

    if (!torrent.activeConnections) torrent.activeConnections = 0;
    torrent.activeConnections++;
    if (torrent.idleTimeout) { clearTimeout(torrent.idleTimeout); torrent.idleTimeout = null; }

    console.log(`[✓] Torrent Ready: ${torrent.name} (Connections: ${torrent.activeConnections})`);

    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    console.log(`[▶] Streaming: ${file.name} (${(file.length / 1024 / 1024 / 1024).toFixed(2)} GB)`);

    let mimeType = 'video/mp4';
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === 'mkv') mimeType = 'video/x-matroska';
    else if (ext === 'webm') mimeType = 'video/webm';
    else if (ext === 'avi') mimeType = 'video/x-msvideo';

    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, { 'Content-Length': file.length, 'Content-Type': mimeType, 'Accept-Ranges': 'bytes' });
        const stream = file.createReadStream();
        stream.on('error', () => { });
        stream.pipe(res);
        req.on('close', () => onConnectionClose(torrent, magnetURI));
        return;
    }

    const positions = range.replace(/bytes=/, '').split('-');
    const start = parseInt(positions[0], 10);
    const total = file.length;
    const end = positions[1] ? parseInt(positions[1], 10) : total - 1;
    const chunksize = end - start + 1;

    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
    });

    const stream = file.createReadStream({ start, end });
    stream.on('error', () => { });
    res.on('error', () => { });
    stream.pipe(res);

    req.on('close', () => {
        stream.destroy();
        onConnectionClose(torrent, magnetURI);
    });

    torrent.on('error', (err) => {
        console.error(`[!] Torrent error: ${err.message}`);
        if (!res.headersSent) res.status(500).send(`Torrent Error: ${err.message}`);
    });
}

function onConnectionClose(torrent, magnetURI) {
    torrent.activeConnections = Math.max(0, (torrent.activeConnections || 1) - 1);
    if (torrent.activeConnections <= 0) {
        console.log(`[!] No active streams for "${torrent.name}". Starting 5-min cleanup timer...`);
        torrent.idleTimeout = setTimeout(() => {
            console.log(`[🗑] Destroying idle torrent: ${torrent.name}`);
            torrent.destroy({ destroyStore: true }, () => { console.log(`[🗑] Cleaned: ${torrent.name}`); });
            activeTorrents.delete(magnetURI);
        }, 5 * 60 * 1000);
    }
}

// ─── /info endpoint ───────────────────────────────────────────────────────────
app.get('/info', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    console.log(`[i] Info request: ${magnetURI.substring(0, 60)}...`);

    getTorrent(magnetURI, (torrent) => {
        if (!torrent || !torrent.files || torrent.files.length === 0) {
            return res.status(500).json({ error: 'No files in torrent' });
        }
        const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
        const ext = file.name.toLowerCase().split('.').pop();
        res.json({
            name: file.name,
            size: file.length,
            extension: ext,
            streamUrl: `/stream?magnet=${encodeURIComponent(magnetURI)}`,
        });
    });
});

// ─── /status endpoint ─────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.json({ error: 'Missing magnet' });
    const torrent = client.get(magnetURI);
    if (!torrent) return res.json({ status: 'not_found' });
    res.json({ name: torrent.name, downloadSpeed: torrent.downloadSpeed, uploadSpeed: torrent.uploadSpeed, progress: torrent.progress, numPeers: torrent.numPeers, timeRemaining: torrent.timeRemaining });
});

const PORT = 6987;
app.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🚀 WebTorrent Streamer running on port ${PORT}`);
    console.log(`📡 Primary path  : ${DEFAULT_DL_PATH || '(WebTorrent default)'}`);
    console.log(`📦 Fallback path : ${FALLBACK_DL_PATH}`);
    console.log(`📏 Large file threshold: ${LARGE_FILE_THRESHOLD_GB} GB`);
    console.log('====================================================');
});
