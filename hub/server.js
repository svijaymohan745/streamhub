const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

// ─── Environment ──────────────────────────────────────────────────────────────
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PROWLARR_URL = process.env.PROWLARR_URL;
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY;
const STREAMER_URL = process.env.STREAMER_URL || 'http://localhost:6987';

// HLS config — segments live on the Ubuntu Hub
const HLS_OUTPUT_BASE = process.env.HLS_OUTPUT_BASE || '/tmp/hls_sessions';

// ─── HLS Session Store ────────────────────────────────────────────────────────
// sessionId -> { ffmpeg, outputDir, status, codec, resolution, startTime, cleanupTimer }
const hlsSessions = new Map();

function ensureHlsBase() {
    if (!fs.existsSync(HLS_OUTPUT_BASE)) {
        fs.mkdirSync(HLS_OUTPUT_BASE, { recursive: true });
    }
}

function cleanupSession(sessionId) {
    const session = hlsSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.cleanupTimer);

    if (session.ffmpeg) {
        try { session.ffmpeg.kill('SIGKILL'); } catch (e) { }
        session.ffmpeg = null;
    }

    try {
        if (fs.existsSync(session.outputDir)) {
            fs.rmSync(session.outputDir, { recursive: true, force: true });
            console.log(`[🗑] HLS session cleaned up: ${sessionId}`);
        }
    } catch (e) {
        console.warn(`[!] Cleanup error for session ${sessionId}:`, e.message);
    }

    hlsSessions.delete(sessionId);
}

function scheduleCleanup(sessionId, delayMs = 5 * 60 * 1000) {
    const session = hlsSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
        console.log(`[⏰] 5-min cleanup timer fired for session: ${sessionId}`);
        cleanupSession(sessionId);
    }, delayMs);
}

// ─── Active Streams (Socket.IO) ───────────────────────────────────────────────
const activeStreams = {};

io.on('connection', (socket) => {
    socket.on('start_stream', (data) => {
        let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
        activeStreams[socket.id] = {
            ...data,
            ip: clientIp,
            startTime: Date.now(),
            socketId: socket.id,
            progress: 0,
        };
        io.emit('active_streams', Object.values(activeStreams));
    });

    socket.on('update_progress', (data) => {
        if (activeStreams[socket.id]) {
            activeStreams[socket.id].progress = data.progress;
            io.emit('active_streams', Object.values(activeStreams));
        }
    });

    socket.on('update_transcode', (data) => {
        if (activeStreams[socket.id]) {
            activeStreams[socket.id].transcoding = data.transcoding;
            activeStreams[socket.id].codec = data.codec;
            activeStreams[socket.id].resolution = data.resolution;
            activeStreams[socket.id].sessionId = data.sessionId;
            io.emit('active_streams', Object.values(activeStreams));
        }
    });

    socket.on('admin_action', (data) => {
        if (data.socketId && data.action) {
            io.to(data.socketId).emit('remote_action', { action: data.action });
        }
    });

    socket.on('stop_stream', () => {
        delete activeStreams[socket.id];
        io.emit('active_streams', Object.values(activeStreams));
    });

    socket.on('disconnect', () => {
        delete activeStreams[socket.id];
        io.emit('active_streams', Object.values(activeStreams));
    });
});

// ─── Database ─────────────────────────────────────────────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });

const db = new sqlite3.Database('./data/history.db', (err) => {
    if (err) console.error('Database opening error: ', err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        tmdb_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        title TEXT NOT NULL,
        poster_path TEXT,
        watched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── TMDB APIs ────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query parameter "q" is required.' });
    try {
        const response = await axios.get('https://api.themoviedb.org/3/search/multi', {
            params: { api_key: TMDB_API_KEY, query, include_adult: false },
        });
        const results = response.data.results.filter(
            (m) => m.poster_path && (m.media_type === 'movie' || m.media_type === 'tv')
        );
        res.json(results);
    } catch (error) {
        console.error('TMDB Search Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch from TMDB' });
    }
});

app.get('/api/movie/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/movie/${req.params.id}`, {
            params: { api_key: TMDB_API_KEY },
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch movie details' });
    }
});

app.get('/api/tv/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/tv/${req.params.id}`, {
            params: { api_key: TMDB_API_KEY },
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch TV details' });
    }
});

app.get('/api/tv/:id/season/:season_number', async (req, res) => {
    try {
        const response = await axios.get(
            `https://api.themoviedb.org/3/tv/${req.params.id}/season/${req.params.season_number}`,
            { params: { api_key: TMDB_API_KEY } }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch Season details' });
    }
});

app.get('/api/trending', async (req, res) => {
    try {
        const response = await axios.get('https://api.themoviedb.org/3/trending/movie/day', {
            params: { api_key: TMDB_API_KEY },
        });
        const trending = response.data.results.slice(0, 10).map((m) => ({ id: m.id, title: m.title }));
        res.json(trending);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch trending movies' });
    }
});

app.get('/api/grid', async (req, res) => {
    try {
        const randomPage = Math.floor(Math.random() * 5) + 1;
        const response = await axios.get('https://api.themoviedb.org/3/movie/popular', {
            params: { api_key: TMDB_API_KEY, page: randomPage },
        });
        const posters = response.data.results
            .filter((m) => m.poster_path)
            .slice(0, 18)
            .map((m) => `https://image.tmdb.org/t/p/w200${m.poster_path}`);
        res.json(posters);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch grid posters' });
    }
});

// ─── Prowlarr ─────────────────────────────────────────────────────────────────
app.get('/api/torrents', async (req, res) => {
    const query = req.query.q;
    const year = req.query.year;
    if (!query) return res.status(400).json({ error: 'Movie query required.' });
    try {
        const response = await axios.get(`${PROWLARR_URL}/api/v1/search`, {
            headers: { 'X-Api-Key': PROWLARR_API_KEY },
            params: { query: `${query} ${year || ''}`.trim(), type: 'search', limit: 100 },
        });
        const validTorrents = response.data
            .filter((t) => t.magnetUrl || t.downloadUrl)
            .map((t) => ({
                title: t.title,
                size: t.size,
                seeders: t.seeders,
                leechers: t.leechers,
                indexer: t.indexer,
                magnetUrl: t.magnetUrl || t.downloadUrl,
            }))
            .sort((a, b) => b.seeders - a.seeders);
        res.json(validTorrents);
    } catch (error) {
        console.error('Prowlarr Search Error:', error.message);
        res.status(500).json({ error: 'Failed to search Prowlarr' });
    }
});

// ─── Jellyfin Auth ────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    try {
        const jellyfinAuthUrl = `http://192.168.2.54:1000/Users/AuthenticateByName`;
        const response = await axios.post(
            jellyfinAuthUrl,
            { Username: username, Pw: password },
            {
                headers: {
                    Authorization: 'MediaBrowser Client="StreamHub", Device="Web", DeviceId="123", Version="1.0.0"',
                    'Content-Type': 'application/json',
                },
            }
        );
        res.json({ success: true, user: response.data.User, token: response.data.AccessToken });
    } catch (error) {
        res.status(401).json({ error: 'Invalid Jellyfin credentials' });
    }
});

// ─── Jellyfin Check ───────────────────────────────────────────────────────────
app.get('/api/jellyfin/check', async (req, res) => {
    const { title, tmdbId } = req.query;
    if (!title) return res.json({ exists: false });
    if (!process.env.JELLYFIN_API_KEY) return res.json({ exists: false });
    try {
        const jfUrl = (process.env.JELLYFIN_URL || 'http://192.168.2.54:1000').replace(/\/$/, '');
        const jfExternalUrl = (process.env.JELLYFIN_EXTERNAL_URL || jfUrl).replace(/\/$/, '');
        const queryUrl = `${jfUrl}/Items?IncludeItemTypes=Movie,Series&Recursive=true&searchTerm=${title}&Fields=ProviderIds`;
        const response = await axios.get(queryUrl, { headers: { 'X-Emby-Token': process.env.JELLYFIN_API_KEY } });
        let match = null;
        if (response.data.Items && response.data.Items.length > 0) {
            if (tmdbId) match = response.data.Items.find((i) => i.ProviderIds && i.ProviderIds.Tmdb === tmdbId.toString());
            if (!match) match = response.data.Items.find((i) => i.Name.toLowerCase() === title.toLowerCase());
        }
        if (match) return res.json({ exists: true, id: match.Id, url: `${jfExternalUrl}/web/index.html#!/details?id=${match.Id}` });
        res.json({ exists: false });
    } catch (error) {
        res.status(500).json({ error: 'Failed to verify Jellyfin status' });
    }
});

// ─── Jellyseerr ───────────────────────────────────────────────────────────────
app.get('/api/jellyseerr/options', async (req, res) => {
    if (!process.env.JELLYSEERR_API_KEY || !process.env.JELLYSEERR_URL) return res.json({ configured: false });
    try {
        const baseUrl = process.env.JELLYSEERR_URL.replace(/\/$/, '') + '/api/v1';
        const apiKey = process.env.JELLYSEERR_API_KEY;
        const [radarrRes, sonarrRes] = await Promise.all([
            axios.get(`${baseUrl}/settings/radarr`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] })),
            axios.get(`${baseUrl}/settings/sonarr`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] })),
        ]);
        const radarr = radarrRes.data.length > 0 ? radarrRes.data[0] : null;
        const sonarr = sonarrRes.data.length > 0 ? sonarrRes.data[0] : null;
        if (radarr) {
            try {
                const testRes = await axios.post(`${baseUrl}/settings/radarr/test`, radarr, { headers: { 'X-Api-Key': apiKey } });
                radarr.profiles = testRes.data.profiles || [];
                radarr.rootFolders = testRes.data.rootFolders || [];
            } catch (e) { radarr.profiles = []; radarr.rootFolders = []; }
        }
        if (sonarr) {
            try {
                const testRes = await axios.post(`${baseUrl}/settings/sonarr/test`, sonarr, { headers: { 'X-Api-Key': apiKey } });
                sonarr.profiles = testRes.data.profiles || [];
                sonarr.rootFolders = testRes.data.rootFolders || [];
            } catch (e) { sonarr.profiles = []; sonarr.rootFolders = []; }
        }
        res.json({ configured: true, radarr, sonarr });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch Overseerr endpoints' });
    }
});

app.post('/api/jellyseerr/request', async (req, res) => {
    if (!process.env.JELLYSEERR_API_KEY || !process.env.JELLYSEERR_URL) return res.status(500).json({ error: 'Not configured' });
    try {
        const baseUrl = process.env.JELLYSEERR_URL.replace(/\/$/, '') + '/api/v1';
        const apiKey = process.env.JELLYSEERR_API_KEY;
        const { mediaId, mediaType, serverId, profileId, rootFolder, requestUser } = req.body;
        let userId = 1;
        if (requestUser) {
            try {
                const reqUserLower = requestUser.toLowerCase();
                const usersRes = await axios.get(`${baseUrl}/user`, { headers: { 'X-Api-Key': apiKey } });
                if (usersRes.data && usersRes.data.results) {
                    const match = usersRes.data.results.find(
                        (u) => (u.username && u.username.toLowerCase() === reqUserLower) ||
                            (u.displayName && u.displayName.toLowerCase() === reqUserLower) ||
                            (u.email && u.email.toLowerCase().includes(reqUserLower))
                    );
                    if (match) userId = match.id;
                }
            } catch (e) { }
        }
        const payload = { mediaId, mediaType, userId };
        if (serverId !== undefined) payload.serverId = serverId;
        if (profileId !== undefined) payload.profileId = profileId;
        if (rootFolder !== undefined) payload.rootFolder = rootFolder;
        const response = await axios.post(`${baseUrl}/request`, payload, { headers: { 'X-Api-Key': apiKey } });
        res.json({ success: true, data: response.data });
    } catch (e) {
        const errMsg = e.response && e.response.data && e.response.data.message ? e.response.data.message : 'Failed to push request to Jellyseerr';
        res.status(500).json({ success: false, error: errMsg });
    }
});

// ─── Magnet Resolution ────────────────────────────────────────────────────────
app.get('/api/get-magnet', async (req, res) => {
    const torrentUrl = req.query.url;
    if (!torrentUrl) return res.status(400).json({ error: 'URL is required' });
    try {
        if (torrentUrl.startsWith('magnet:')) return res.json({ magnetUrl: torrentUrl });
        console.log(`[Hub] Fetching local torrent: ${torrentUrl}`);
        const response = await axios.get(torrentUrl, {
            headers: { 'X-Api-Key': PROWLARR_API_KEY },
            responseType: 'arraybuffer',
            maxRedirects: 0,
        });
        const pt = await import('parse-torrent');
        const parseTorrent = pt.default;
        const parsed = await parseTorrent(Buffer.from(response.data));
        const magnetUri = pt.toMagnetURI(parsed);
        res.json({ magnetUrl: magnetUri });
    } catch (e) {
        if (e.response && e.response.status >= 300 && e.response.status < 400) {
            const location = e.response.headers.location || e.response.headers.Location;
            if (location && location.startsWith('magnet:')) return res.json({ magnetUrl: location });
        }
        res.status(500).json({ error: 'Failed to parse torrent into magnet' });
    }
});

// ─── Probe: detect file codec/container via ffprobe ───────────────────────────
// The Hub reads the raw stream URL from the Windows streamer and probes it.
app.get('/api/probe', async (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    // First ask the Windows streamer for file info (name, size, extension)
    let fileInfo;
    try {
        const infoRes = await axios.get(`${STREAMER_URL}/info?magnet=${encodeURIComponent(magnetURI)}`, {
            timeout: 60000, // Torrent metadata can take a moment
        });
        fileInfo = infoRes.data;
    } catch (e) {
        // Streamer may still be fetching metadata — respond with a pending state
        return res.json({ status: 'pending', message: 'Fetching torrent metadata...' });
    }

    const ext = fileInfo.extension || '';
    const rawStreamUrl = `${STREAMER_URL}/stream?magnet=${encodeURIComponent(magnetURI)}`;

    // Run ffprobe against the raw stream from Windows Streamer
    return new Promise((resolve) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            rawStreamUrl,
        ]);

        let output = '';
        ffprobe.stdout.on('data', (chunk) => { output += chunk.toString(); });

        ffprobe.on('close', (code) => {
            let codec = 'unknown';
            let resolution = 'unknown';
            let container = ext;

            try {
                const probe = JSON.parse(output);
                const videoStream = probe.streams && probe.streams.find((s) => s.codec_type === 'video');
                if (videoStream) {
                    codec = videoStream.codec_name || 'unknown';
                    resolution = `${videoStream.width}x${videoStream.height}`;
                }
                if (probe.format && probe.format.format_name) {
                    container = probe.format.format_name.split(',')[0];
                }
            } catch (e) {
                console.warn('[Hub/probe] ffprobe parse error:', e.message);
            }

            // Direct play: H.264 in MP4/MOV container — universally supported
            const canDirectPlay = (
                (codec === 'h264' || codec === 'avc1') &&
                (container === 'mov' || container === 'mp4' || container === 'mp4a' || ext === 'mp4')
            );

            const result = {
                status: 'ready',
                canDirectPlay,
                codec,
                container,
                resolution,
                fileName: fileInfo.name,
                fileSize: fileInfo.size,
            };

            console.log(`[Hub/probe] ${fileInfo.name} | codec:${codec} container:${container} → ${canDirectPlay ? 'Direct Play' : 'Transcode'}`);
            res.json(result);
            resolve();
        });

        ffprobe.on('error', (err) => {
            console.error('[Hub/probe] ffprobe spawn error:', err.message);
            // If ffprobe isn't available or fails, assume we need to transcode for safety
            res.json({
                status: 'error',
                canDirectPlay: false,
                codec: 'unknown',
                container: ext,
                resolution: 'unknown',
                fileName: fileInfo.name,
                fileSize: fileInfo.size,
            });
            resolve();
        });
    });
});

// ─── HLS: Start transcode session ────────────────────────────────────────────
app.post('/api/hls/start', express.json(), async (req, res) => {
    const { magnet, codec, resolution } = req.body;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

    const sessionId = uuidv4();
    const outputDir = path.join(HLS_OUTPUT_BASE, sessionId);
    fs.mkdirSync(outputDir, { recursive: true });

    const playlistPath = path.join(outputDir, 'index.m3u8');
    const rawStreamUrl = `${STREAMER_URL}/stream?magnet=${encodeURIComponent(magnet)}`;

    console.log(`[Hub/HLS] Starting transcode session: ${sessionId}`);
    console.log(`[Hub/HLS] Source: ${rawStreamUrl}`);
    console.log(`[Hub/HLS] Output: ${outputDir}`);

    // Build ffmpeg args — try NVENC first, fallback handled in error
    const ffmpegArgs = [
        '-i', rawStreamUrl,

        // Video: NVIDIA NVENC H.264
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',        // balanced speed/quality
        '-cq', '23',            // constant quality
        '-profile:v', 'high',
        '-level', '4.1',
        '-g', '48',             // keyframe every 48 frames (4s at 12fps, ≈2s at 24fps)
        '-sc_threshold', '0',

        // Audio: stereo AAC for maximum compatibility
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',

        // HLS output
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_flags', 'delete_segments+append_list+independent_segments',
        '-hls_segment_type', 'mpegts',
        '-hls_playlist_type', 'event',
        '-hls_segment_filename', path.join(outputDir, 'seg%05d.ts'),

        playlistPath,
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let ffmpegStarted = false;
    let nvencFailed = false;

    ffmpeg.stderr.on('data', (chunk) => {
        const line = chunk.toString();

        // Detect successful start
        if (!ffmpegStarted && line.includes('frame=')) {
            ffmpegStarted = true;
            console.log(`[Hub/HLS ✓] Transcoding started (NVENC): ${sessionId}`);
        }

        // Detect NVENC unavailable
        if (line.includes('No NVENC capable devices found') || line.includes('Cannot load nvcuda.dll')) {
            nvencFailed = true;
            console.warn(`[Hub/HLS ⚠] NVENC not available — falling back to libx264: ${sessionId}`);
        }

        // Log progress lines at debug level
        if (line.includes('frame=') || line.includes('speed=')) {
            process.stdout.write(`[ffmpeg/${sessionId.substring(0, 8)}] ${line.trim()}\n`);
        }
    });

    ffmpeg.on('error', (err) => {
        console.error(`[Hub/HLS !] ffmpeg spawn failed: ${err.message}`);
        cleanupSession(sessionId);
    });

    ffmpeg.on('close', (code) => {
        if (nvencFailed) {
            // Restart with libx264
            console.log(`[Hub/HLS] Restarting with libx264 fallback: ${sessionId}`);
            const fallbackArgs = ffmpegArgs.map((a) => {
                if (a === 'h264_nvenc') return 'libx264';
                if (a === 'p4') return 'veryfast';
                if (a === 'cq') return '';  // handled differently below
                return a;
            }).filter(Boolean);
            // Replace -cq 23 with -crf 23
            const cqIdx = fallbackArgs.indexOf('23');
            if (cqIdx > 0) fallbackArgs[cqIdx - 1] = '-crf';

            const fallbackProc = spawn('ffmpeg', fallbackArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            hlsSessions.get(sessionId).ffmpeg = fallbackProc;

            fallbackProc.stderr.on('data', (chunk) => {
                const line = chunk.toString();
                if (line.includes('frame=') || line.includes('speed=')) {
                    process.stdout.write(`[ffmpeg-sw/${sessionId.substring(0, 8)}] ${line.trim()}\n`);
                }
            });
            fallbackProc.on('close', () => {
                console.log(`[Hub/HLS] Transcode (libx264) finished: ${sessionId}`);
            });
        } else if (code !== null && code !== 0) {
            console.error(`[Hub/HLS] ffmpeg exited with code ${code}: ${sessionId}`);
        } else {
            console.log(`[Hub/HLS ✓] Transcode complete: ${sessionId}`);
            const session = hlsSessions.get(sessionId);
            if (session) session.status = 'complete';
        }
    });

    hlsSessions.set(sessionId, {
        ffmpeg,
        outputDir,
        status: 'transcoding',
        codec: 'h264_nvenc',
        resolution: resolution || 'unknown',
        startTime: Date.now(),
        cleanupTimer: null,
    });

    // Wait briefly for ffmpeg to start writing segments before responding
    await new Promise((resolve) => setTimeout(resolve, 500));

    res.json({
        sessionId,
        playlistUrl: `/api/hls/${sessionId}/index.m3u8`,
        status: 'transcoding',
    });
});

// ─── HLS: Stop / schedule cleanup ────────────────────────────────────────────
app.post('/api/hls/stop/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!hlsSessions.has(sessionId)) {
        return res.json({ success: true, message: 'Session not found (may have already cleaned up)' });
    }
    console.log(`[Hub/HLS] Stop request for session: ${sessionId} — scheduling 5-min cleanup`);
    const session = hlsSessions.get(sessionId);
    if (session) session.status = 'stopping';
    scheduleCleanup(sessionId, 5 * 60 * 1000);
    res.json({ success: true, message: 'Cleanup scheduled in 5 minutes' });
});

// ─── HLS: Serve playlist + segments ──────────────────────────────────────────
app.get('/api/hls/:sessionId/index.m3u8', (req, res) => {
    const { sessionId } = req.params;
    const filePath = path.join(HLS_OUTPUT_BASE, sessionId, 'index.m3u8');

    if (!fs.existsSync(filePath)) {
        // Transcode may still be spinning up
        return res.status(202).set('Retry-After', '2').json({ status: 'pending' });
    }

    res.set({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.sendFile(filePath);
});

app.get('/api/hls/:sessionId/:segment', (req, res) => {
    const { sessionId, segment } = req.params;

    // Only allow .ts files
    if (!segment.endsWith('.ts')) return res.status(400).send('Invalid segment');

    const filePath = path.join(HLS_OUTPUT_BASE, sessionId, segment);
    if (!fs.existsSync(filePath)) return res.status(404).send('Segment not found');

    res.set({
        'Content-Type': 'video/MP2T',
        'Cache-Control': 'public, max-age=600',
        'Access-Control-Allow-Origin': '*',
    });
    res.sendFile(filePath);
});

// ─── HLS Status endpoint ──────────────────────────────────────────────────────
app.get('/api/hls/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = hlsSessions.get(sessionId);
    if (!session) return res.json({ status: 'not_found' });

    // Count segments written as a proxy for progress
    let segmentCount = 0;
    try {
        segmentCount = fs.readdirSync(session.outputDir).filter((f) => f.endsWith('.ts')).length;
    } catch (e) { }

    res.json({
        status: session.status,
        codec: session.codec,
        resolution: session.resolution,
        segmentsReady: segmentCount,
        elapsed: Math.round((Date.now() - session.startTime) / 1000),
    });
});

// ─── Existing proxy: raw stream from Windows Streamer ─────────────────────────
app.use(
    createProxyMiddleware({
        target: STREAMER_URL,
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        pathFilter: '/api/stream',
        pathRewrite: { '^/api/stream': '/stream' },
        on: {
            proxyRes(proxyRes) {
                proxyRes.headers['Access-Control-Allow-Origin'] = '*';
            },
        },
    })
);

// ─── Watch History ────────────────────────────────────────────────────────────
app.get('/api/admin/history', (req, res) => {
    db.all('SELECT * FROM history ORDER BY watched_at DESC LIMIT 200', [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

app.get('/api/history/:userId', (req, res) => {
    db.all(
        'SELECT * FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 50',
        [req.params.userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(rows);
        }
    );
});

app.delete('/api/admin/history', (req, res) => {
    db.run('DELETE FROM history', function (err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true });
    });
});

app.post('/api/history', (req, res) => {
    const { user_id, tmdb_id, media_type, title, poster_path } = req.body;
    if (!user_id || !tmdb_id || !title || !media_type) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    db.serialize(() => {
        db.run('DELETE FROM history WHERE user_id = ? AND tmdb_id = ?', [user_id, tmdb_id]);
        db.run(
            'INSERT INTO history (user_id, tmdb_id, media_type, title, poster_path) VALUES (?, ?, ?, ?, ?)',
            [user_id, tmdb_id, media_type, title, poster_path],
            function (err) {
                if (err) return res.status(500).json({ error: 'Database record error' });
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

// ─── Stream URL (legacy) ──────────────────────────────────────────────────────
app.get('/api/stream-url', (req, res) => res.json({ url: STREAMER_URL }));

app.get('/api/status', async (req, res) => {
    const magnetURI = req.query.magnet;
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet URL' });
    try {
        const response = await axios.get(`${STREAMER_URL}/status`, { params: { magnet: magnetURI } });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to retrieve proxy status' });
    }
});

// ─── SPA Catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
ensureHlsBase();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🎬 StreamHub UI Server running on port ${PORT}`);
    console.log(`📡 Streamer (Windows): ${STREAMER_URL}`);
    console.log(`🎞  HLS output base: ${HLS_OUTPUT_BASE}`);
    console.log('====================================================');
});
