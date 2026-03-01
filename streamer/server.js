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
// Key: infoHash (lower-case hex) — stable regardless of magnet URL encoding/ordering
const activeTorrents = new Map(); // infoHash → torrent
const pendingCallbacks = new Map(); // infoHash → [callbacks...]

/** Extract the 40-char hex info-hash from any magnet URI. */
function getInfoHash(magnetURI) {
    try {
        const m = magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
        return m ? m[1].toLowerCase() : null;
    } catch { return null; }
}

/**
 * Safe torrent getter — deduplicates on infoHash so two requests for the same
 * torrent with different magnet strings never both call client.add() (which
 * causes "Cannot add duplicate torrent" and leaves callbacks hanging forever).
 */
function getTorrent(magnetURI, callback) {
    const key = getInfoHash(magnetURI) || magnetURI;

    // ①  Check our ready-torrent cache
    const existing = activeTorrents.get(key);
    if (existing) {
        if (existing.ready) return callback(existing);
        return existing.once('ready', () => callback(existing));
    }

    // ②  Secondary guard: ask WebTorrent directly (handles edge-cases where
    //    our map missed an add, e.g. after a crash-recovery scenario)
    const wtExisting = client.get(key);
    if (wtExisting) {
        activeTorrents.set(key, wtExisting);
        // client.get() may return a lightweight object without EventEmitter in some WTv versions
        if (wtExisting.ready) return callback(wtExisting);
        if (typeof wtExisting.once === 'function') {
            return wtExisting.once('ready', () => callback(wtExisting));
        }
        // Not ready but can't subscribe — treat as pending and let client.add() handle it
        // (WebTorrent will deduplicate internally)
    }


    // ③  Another concurrent request is already calling client.add() — queue
    if (pendingCallbacks.has(key)) {
        pendingCallbacks.get(key).push(callback);
        return;
    }

    // ④  First caller — initiate add
    console.log(`[+] Adding torrent: ${magnetURI.substring(0, 60)}...`);
    pendingCallbacks.set(key, [callback]);

    const dlPath = DEFAULT_DL_PATH || FALLBACK_DL_PATH || undefined;
    const addOpts = dlPath ? { path: dlPath } : {};

    // Wrap in try-catch for synchronous errors from WebTorrent
    try {
        client.add(magnetURI, addOpts, (torrent) => {
            activeTorrents.set(key, torrent);
            const pending = pendingCallbacks.get(key) || [];
            pendingCallbacks.delete(key);

            if (!torrent.ready) {
                torrent.once('ready', () => pending.forEach(cb => cb(torrent)));
            } else {
                pending.forEach(cb => cb(torrent));
            }
        });
    } catch (err) {
        // client.add threw synchronously (shouldn't happen, but be safe)
        console.error(`[!] client.add threw synchronously: ${err.message}`);
        // Try to recover via client.get
        const t = client.get(key);
        const pending = pendingCallbacks.get(key) || [];
        pendingCallbacks.delete(key);
        if (t) {
            activeTorrents.set(key, t);
            if (t.ready) pending.forEach(cb => cb(t));
            else t.once('ready', () => pending.forEach(cb => cb(t)));
        } else {
            pending.forEach(cb => cb(null));
        }
    }
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
        const key = getInfoHash(magnetURI) || magnetURI;
        torrent.idleTimeout = setTimeout(() => {
            console.log(`[🗑] Destroying idle torrent: ${torrent.name}`);
            torrent.destroy({ destroyStore: true }, () => { console.log(`[🗑] Cleaned: ${torrent.name}`); });
            activeTorrents.delete(key);
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
