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

// Prevent unhandled errors from crashing the Node process
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

// --- Storage Configuration ---
// Primary download path - WebTorrent default (system temp if not set)
const DEFAULT_DL_PATH = process.env.DEFAULT_DL_PATH || null; // e.g. C:/StreamCache
const FALLBACK_DL_PATH = process.env.FALLBACK_DL_PATH || 'D:/TempMovies';
const LARGE_FILE_THRESHOLD_GB = parseFloat(process.env.LARGE_FILE_THRESHOLD_GB || '20');

/**
 * Get free disk space in bytes for a given path.
 * Uses Windows `dir` command for cross-platform simplicity here.
 */
function getDiskFreeBytes(drivePath) {
    try {
        // Use wmic on Windows to get free space
        const drive = path.parse(drivePath).root.replace(/\\/g, '');
        const result = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, { encoding: 'utf8' });
        const match = result.match(/FreeSpace=(\d+)/);
        if (match) return parseInt(match[1], 10);
    } catch (e) {
        console.warn(`[!] Could not determine free space for ${drivePath}:`, e.message);
    }
    return Infinity; // If we can't check, assume plenty of space
}

/**
 * Pick the best download path given the expected file size.
 */
function pickDownloadPath(fileSizeBytes) {
    if (!DEFAULT_DL_PATH && !FALLBACK_DL_PATH) return undefined; // Let WebTorrent use its default

    const thresholdBytes = LARGE_FILE_THRESHOLD_GB * 1024 * 1024 * 1024;
    const primaryPath = DEFAULT_DL_PATH;

    if (primaryPath && fileSizeBytes <= thresholdBytes) {
        // File is not huge — use primary path
        const freeBytes = getDiskFreeBytes(primaryPath);
        if (freeBytes > fileSizeBytes * 1.1) { // 10% margin
            console.log(`[📁] Using primary path: ${primaryPath}`);
            return primaryPath;
        }
    }

    // Fallback to D:/TempMovies for large files or if primary is full
    if (FALLBACK_DL_PATH) {
        console.log(`[📁] Using fallback path: ${FALLBACK_DL_PATH}`);
        if (!fs.existsSync(FALLBACK_DL_PATH)) {
            fs.mkdirSync(FALLBACK_DL_PATH, { recursive: true });
        }
        return FALLBACK_DL_PATH;
    }

    return undefined;
}

// --- Active Torrents Map ---
const activeTorrents = new Map(); // magnetURI -> torrent instance

// --- /stream endpoint ---
app.get('/stream', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).send('Missing "magnet" query parameter.');

    let torrent = activeTorrents.get(magnetURI);

    if (torrent) {
        if (torrent.ready) {
            handleStream(torrent, req, res, magnetURI);
        } else {
            torrent.once('ready', () => handleStream(torrent, req, res, magnetURI));
        }
    } else {
        console.log(`[+] Adding new torrent: ${magnetURI.substring(0, 60)}...`);
        // We don't know file size yet at add time, so use fallback path if default defined
        const dlPath = DEFAULT_DL_PATH || FALLBACK_DL_PATH || undefined;
        const addOpts = dlPath ? { path: dlPath } : {};

        client.add(magnetURI, addOpts, (newTorrent) => {
            activeTorrents.set(magnetURI, newTorrent);
            handleStream(newTorrent, req, res, magnetURI);
        });
    }
});

function handleStream(torrent, req, res, magnetURI) {
    if (!torrent.files || torrent.files.length === 0) {
        console.error(`[!] No files found for torrent: ${torrent.name || 'unknown'}`);
        activeTorrents.delete(magnetURI);
        try { if (!torrent.destroyed) torrent.destroy(); } catch (e) { }
        if (!res.headersSent) res.status(500).send('Torrent metadata invalid or missing files');
        return;
    }

    if (!torrent.activeConnections) torrent.activeConnections = 0;
    torrent.activeConnections++;
    if (torrent.idleTimeout) {
        clearTimeout(torrent.idleTimeout);
        torrent.idleTimeout = null;
    }

    console.log(`[✓] Torrent Ready: ${torrent.name} (Connections: ${torrent.activeConnections})`);

    // Find the largest video file
    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    console.log(`[▶] Streaming: ${file.name} (${(file.length / 1024 / 1024 / 1024).toFixed(2)} GB)`);

    let mimeType = 'video/mp4';
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === 'mkv') mimeType = 'video/x-matroska';
    else if (ext === 'webm') mimeType = 'video/webm';
    else if (ext === 'avi') mimeType = 'video/x-msvideo';

    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            'Content-Length': file.length,
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
        });
        const stream = file.createReadStream();
        stream.on('error', () => { });
        stream.pipe(res);
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
        torrent.activeConnections--;
        if (torrent.activeConnections <= 0) {
            console.log(`[!] No active streams for "${torrent.name}". Starting 5-min cleanup timer...`);
            torrent.idleTimeout = setTimeout(() => {
                console.log(`[🗑] Destroying idle torrent: ${torrent.name}`);
                torrent.destroy({ destroyStore: true }, () => {
                    console.log(`[🗑] Cleaned up: ${torrent.name}`);
                });
                activeTorrents.delete(magnetURI);
            }, 5 * 60 * 1000);
        }
    });

    torrent.on('error', (err) => {
        console.error(`[!] Torrent error: ${err.message}`);
        if (!res.headersSent) res.status(500).send(`Torrent Error: ${err.message}`);
    });
}

// --- /status endpoint ---
app.get('/status', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.json({ error: 'Missing magnet' });

    const torrent = client.get(magnetURI);
    if (!torrent) return res.json({ status: 'not_found' });

    res.json({
        name: torrent.name,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        progress: torrent.progress,
        numPeers: torrent.numPeers,
        timeRemaining: torrent.timeRemaining,
    });
});

// --- /info endpoint - return file info without starting a stream (for Hub probe) ---
app.get('/info', (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    let torrent = activeTorrents.get(magnetURI);

    const sendInfo = (t) => {
        if (!t.files || t.files.length === 0) {
            return res.status(500).json({ error: 'No files in torrent' });
        }
        const file = t.files.reduce((a, b) => (a.length > b.length ? a : b));
        const ext = file.name.toLowerCase().split('.').pop();
        res.json({
            name: file.name,
            size: file.length,
            extension: ext,
            streamUrl: `/stream?magnet=${encodeURIComponent(magnetURI)}`,
        });
    };

    if (torrent) {
        if (torrent.ready) sendInfo(torrent);
        else torrent.once('ready', () => sendInfo(torrent));
    } else {
        // Add torrent to get metadata
        console.log(`[i] Info request — adding torrent for metadata: ${magnetURI.substring(0, 60)}...`);
        const dlPath = DEFAULT_DL_PATH || FALLBACK_DL_PATH || undefined;
        const addOpts = dlPath ? { path: dlPath } : {};
        client.add(magnetURI, addOpts, (newTorrent) => {
            activeTorrents.set(magnetURI, newTorrent);
            sendInfo(newTorrent);
        });
    }
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
