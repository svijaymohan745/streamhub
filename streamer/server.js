import express from 'express';
import WebTorrent from 'webtorrent';
import cors from 'cors';
import path from 'path';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = 50;

const app = express();
const client = new WebTorrent();

// Prevent unhandled errors from crashing the Node process
client.on('error', (err) => {
    console.error('[!] WebTorrent Client Error:', err.message);
});

// Polyfill/safety measure for Node 18+ AbortController errors in bittorrent-tracker
process.on('uncaughtException', (err) => {
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        // Ignore expected fetch aborts from tracker timeouts
        return;
    }
    console.error('[!] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    if (reason && (reason.name === 'AbortError' || reason.code === 'ABORT_ERR')) {
        // Ignore expected fetch aborts from tracker timeouts
        return;
    }
    console.error('[!] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Allow requests from the UI Hub (Machine A)
app.use(cors());

// A map to keep track of active torrents we are seeding/streaming
const activeTorrents = new Map();

app.get('/stream', (req, res) => {
    let magnetURI = req.query.magnet;

    if (!magnetURI) {
        return res.status(400).send('Missing "magnet" query parameter.');
    }

    // Add torrent to WebTorrent client (or get it if already downloading)
    let torrent = activeTorrents.get(magnetURI);

    if (torrent) {
        if (torrent.ready) {
            handleStream(torrent, req, res, magnetURI);
        } else {
            // Because we stored the original instance in activeTorrents, .on will work
            torrent.on('ready', () => handleStream(torrent, req, res, magnetURI));
        }
    } else {
        console.log(`[+] Adding new torrent: ${magnetURI.substring(0, 60)}...`);
        client.add(magnetURI, {
            // We can specify a download path if needed, defaulting to memory/temp for now
        }, (newTorrent) => {
            activeTorrents.set(magnetURI, newTorrent);
            handleStream(newTorrent, req, res, magnetURI);
        });
    }
});

function handleStream(torrent, req, res, magnetURI) {
    if (!torrent.files || torrent.files.length === 0) {
        console.error(`[!] Error: No files found for torrent: ${torrent.name || magnetURI.substring(0, 50)}`);

        // Remove from tracking and destroy so it doesn't linger dead in memory
        activeTorrents.delete(magnetURI);
        try { if (!torrent.destroyed) torrent.destroy(); } catch (err) { }

        if (!res.headersSent) {
            res.status(500).send('Torrent metadata invalid or missing files');
        }
        return;
    }

    if (!torrent.activeConnections) torrent.activeConnections = 0;
    torrent.activeConnections++;
    if (torrent.idleTimeout) {
        clearTimeout(torrent.idleTimeout);
        torrent.idleTimeout = null;
    }

    console.log(`[✓] Torrent Ready: ${torrent.name} (Active Connections: ${torrent.activeConnections})`);

    // Find the largest file in the torrent (almost always the movie/video file)
    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    console.log(`[▶] Streaming: ${file.name} (${(file.length / 1024 / 1024 / 1024).toFixed(2)} GB)`);

    let mimeType = 'video/mp4';
    if (file.name.toLowerCase().endsWith('.mkv')) mimeType = 'video/x-matroska';
    else if (file.name.toLowerCase().endsWith('.webm')) mimeType = 'video/webm';
    else if (file.name.toLowerCase().endsWith('.avi')) mimeType = 'video/x-msvideo';

    // Handle HTTP Range Requests (essential for seeking in video players)
    const range = req.headers.range;
    if (!range) {
        // If the video player doesn't send a Range header, just send the whole file as a stream
        res.writeHead(200, {
            'Content-Length': file.length,
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes'
        });
        const stream = file.createReadStream();

        stream.on('error', (err) => {
            console.log(`[~] Stream Pipeline closed: ${err.message}`);
        });

        stream.pipe(res);
        return;
    }

    // Parse the range header (e.g., "bytes=32324-")
    const positions = range.replace(/bytes=/, "").split("-");
    const start = parseInt(positions[0], 10);
    const total = file.length;
    const end = positions[1] ? parseInt(positions[1], 10) : total - 1;
    const chunksize = (end - start) + 1;

    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType
    });

    const stream = file.createReadStream({ start, end });

    stream.on('error', (err) => {
        // Swallowing "Writable stream closed prematurely" errors which happen 
        // normally when a browser aborts a chunk request during scrubbing
    });

    res.on('error', (err) => {
        // Ignore response socket errors
    });

    stream.pipe(res);

    // Handle client disconnection
    req.on('close', () => {
        console.log(`[x] Client disconnected from stream: ${file.name}`);
        stream.destroy();
        torrent.activeConnections--;

        if (torrent.activeConnections <= 0) {
            console.log(`[!] No active streams for ${torrent.name}. Starting 5-minute cleanup timer...`);
            torrent.idleTimeout = setTimeout(() => {
                console.log(`[🗑️] Torrent idle for 5 minutes. Destroying to free space: ${torrent.name}`);
                torrent.destroy({ destroyStore: true }, () => {
                    console.log(`[🗑️] Successfully deleted ${torrent.name} data from disk.`);
                });
                activeTorrents.delete(magnetURI);
            }, 5 * 60 * 1000); // 5 minutes
        }
    });

    torrent.on('error', (err) => {
        console.error(`[!] Torrent error: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).send(`Torrent Error: ${err.message}`);
        }
    });
}

// Endpoint to quickly check download status from the UI if desired
app.get('/status', (req, res) => {
    let magnetURI = req.query.magnet;
    if (!magnetURI) return res.json({ error: 'Missing magnet' });

    let torrent = client.get(magnetURI);
    if (!torrent) return res.json({ status: 'not_found' });

    res.json({
        name: torrent.name,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        progress: torrent.progress,
        numPeers: torrent.numPeers,
        timeRemaining: torrent.timeRemaining
    });
});

const PORT = 6987; // Same port PlayTorrio used for familiarity!
app.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🚀 WebTorrent Streamer running on port ${PORT}`);
    console.log(`📡 Ready to receive magnet links from the UI Hub`);
    console.log('====================================================');
});
