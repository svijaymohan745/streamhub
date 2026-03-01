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
const HLS_OUTPUT_BASE = process.env.HLS_OUTPUT_BASE || '/tmp/hls_sessions';

// ─── HLS Session Store ────────────────────────────────────────────────────────
const hlsSessions = new Map();

function ensureHlsBase() {
    if (!fs.existsSync(HLS_OUTPUT_BASE)) fs.mkdirSync(HLS_OUTPUT_BASE, { recursive: true });
}

function cleanupSession(sessionId) {
    const session = hlsSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.cleanupTimer);
    if (session.ffmpeg) { try { session.ffmpeg.kill('SIGKILL'); } catch (e) { } session.ffmpeg = null; }
    try { if (fs.existsSync(session.outputDir)) fs.rmSync(session.outputDir, { recursive: true, force: true }); } catch (e) { }
    console.log(`[🗑] HLS session cleaned: ${sessionId}`);
    hlsSessions.delete(sessionId);
}

function scheduleCleanup(sessionId, delayMs = 5 * 60 * 1000) {
    const session = hlsSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
        console.log(`[⏰] 5-min cleanup fired: ${sessionId}`);
        cleanupSession(sessionId);
    }, delayMs);
}

// ─── Active Streams (Socket.IO) ───────────────────────────────────────────────
const activeStreams = {};

io.on('connection', (socket) => {
    socket.on('start_stream', (data) => {
        let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        if (ip.includes(',')) ip = ip.split(',')[0].trim();
        activeStreams[socket.id] = { ...data, ip, startTime: Date.now(), socketId: socket.id, progress: 0 };
        io.emit('active_streams', Object.values(activeStreams));
    });
    socket.on('update_progress', (data) => {
        if (activeStreams[socket.id]) { activeStreams[socket.id].progress = data.progress; io.emit('active_streams', Object.values(activeStreams)); }
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
    socket.on('admin_action', (data) => { if (data.socketId && data.action) io.to(data.socketId).emit('remote_action', { action: data.action }); });
    socket.on('stop_stream', () => { delete activeStreams[socket.id]; io.emit('active_streams', Object.values(activeStreams)); });
    socket.on('disconnect', () => { delete activeStreams[socket.id]; io.emit('active_streams', Object.values(activeStreams)); });
});

// ─── Database ─────────────────────────────────────────────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
const db = new sqlite3.Database('./data/history.db', (err) => { if (err) console.error('DB error:', err); });
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL, tmdb_id TEXT NOT NULL, media_type TEXT NOT NULL,
        title TEXT NOT NULL, poster_path TEXT, watched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── TMDB ─────────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });
    try {
        const r = await axios.get('https://api.themoviedb.org/3/search/multi', { params: { api_key: TMDB_API_KEY, query, include_adult: false } });
        res.json(r.data.results.filter(m => m.poster_path && (m.media_type === 'movie' || m.media_type === 'tv')));
    } catch (e) { res.status(500).json({ error: 'TMDB search failed' }); }
});
app.get('/api/movie/:id', async (req, res) => {
    try { res.json((await axios.get(`https://api.themoviedb.org/3/movie/${req.params.id}`, { params: { api_key: TMDB_API_KEY } })).data); }
    catch (e) { res.status(500).json({ error: 'Failed to fetch movie' }); }
});
app.get('/api/tv/:id', async (req, res) => {
    try { res.json((await axios.get(`https://api.themoviedb.org/3/tv/${req.params.id}`, { params: { api_key: TMDB_API_KEY } })).data); }
    catch (e) { res.status(500).json({ error: 'Failed to fetch TV' }); }
});
app.get('/api/tv/:id/season/:season_number', async (req, res) => {
    try { res.json((await axios.get(`https://api.themoviedb.org/3/tv/${req.params.id}/season/${req.params.season_number}`, { params: { api_key: TMDB_API_KEY } })).data); }
    catch (e) { res.status(500).json({ error: 'Failed to fetch season' }); }
});
app.get('/api/trending', async (req, res) => {
    try {
        const r = await axios.get('https://api.themoviedb.org/3/trending/movie/day', { params: { api_key: TMDB_API_KEY } });
        res.json(r.data.results.slice(0, 10).map(m => ({ id: m.id, title: m.title })));
    } catch (e) { res.status(500).json({ error: 'Failed to fetch trending' }); }
});
app.get('/api/grid', async (req, res) => {
    try {
        const page = Math.floor(Math.random() * 5) + 1;
        const r = await axios.get('https://api.themoviedb.org/3/movie/popular', { params: { api_key: TMDB_API_KEY, page } });
        res.json(r.data.results.filter(m => m.poster_path).slice(0, 18).map(m => `https://image.tmdb.org/t/p/w200${m.poster_path}`));
    } catch (e) { res.status(500).json({ error: 'Failed to fetch grid' }); }
});

// ─── Prowlarr ─────────────────────────────────────────────────────────────────
app.get('/api/torrents', async (req, res) => {
    const { q, year } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    try {
        const r = await axios.get(`${PROWLARR_URL}/api/v1/search`, {
            headers: { 'X-Api-Key': PROWLARR_API_KEY },
            params: { query: `${q} ${year || ''}`.trim(), type: 'search', limit: 100 },
        });
        res.json(r.data.filter(t => t.magnetUrl || t.downloadUrl)
            .map(t => ({ title: t.title, size: t.size, seeders: t.seeders, leechers: t.leechers, indexer: t.indexer, magnetUrl: t.magnetUrl || t.downloadUrl }))
            .sort((a, b) => b.seeders - a.seeders));
    } catch (e) { res.status(500).json({ error: 'Prowlarr search failed' }); }
});

// ─── Auth ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
    try {
        const r = await axios.post('http://192.168.2.54:1000/Users/AuthenticateByName', { Username: username, Pw: password }, {
            headers: { Authorization: 'MediaBrowser Client="StreamHub", Device="Web", DeviceId="123", Version="1.0.0"', 'Content-Type': 'application/json' },
        });
        res.json({ success: true, user: r.data.User, token: r.data.AccessToken });
    } catch (e) { res.status(401).json({ error: 'Invalid credentials' }); }
});

// ─── Jellyfin Check ───────────────────────────────────────────────────────────
app.get('/api/jellyfin/check', async (req, res) => {
    const { title, tmdbId } = req.query;
    if (!title || !process.env.JELLYFIN_API_KEY) return res.json({ exists: false });
    try {
        const jfUrl = (process.env.JELLYFIN_URL || 'http://192.168.2.54:1000').replace(/\/$/, '');
        const jfExt = (process.env.JELLYFIN_EXTERNAL_URL || jfUrl).replace(/\/$/, '');
        const r = await axios.get(`${jfUrl}/Items?IncludeItemTypes=Movie,Series&Recursive=true&searchTerm=${title}&Fields=ProviderIds`, { headers: { 'X-Emby-Token': process.env.JELLYFIN_API_KEY } });
        let match = null;
        if (r.data.Items?.length) {
            if (tmdbId) match = r.data.Items.find(i => i.ProviderIds?.Tmdb === tmdbId.toString());
            if (!match) match = r.data.Items.find(i => i.Name.toLowerCase() === title.toLowerCase());
        }
        if (match) return res.json({ exists: true, id: match.Id, url: `${jfExt}/web/index.html#!/details?id=${match.Id}` });
        res.json({ exists: false });
    } catch (e) { res.status(500).json({ error: 'Jellyfin check failed' }); }
});

// ─── Jellyseerr ───────────────────────────────────────────────────────────────
app.get('/api/jellyseerr/options', async (req, res) => {
    if (!process.env.JELLYSEERR_API_KEY || !process.env.JELLYSEERR_URL) return res.json({ configured: false });
    try {
        const base = process.env.JELLYSEERR_URL.replace(/\/$/, '') + '/api/v1';
        const key = process.env.JELLYSEERR_API_KEY;
        const [rr, sr] = await Promise.all([
            axios.get(`${base}/settings/radarr`, { headers: { 'X-Api-Key': key } }).catch(() => ({ data: [] })),
            axios.get(`${base}/settings/sonarr`, { headers: { 'X-Api-Key': key } }).catch(() => ({ data: [] })),
        ]);
        const radarr = rr.data[0] || null;
        const sonarr = sr.data[0] || null;
        if (radarr) try { const t = await axios.post(`${base}/settings/radarr/test`, radarr, { headers: { 'X-Api-Key': key } }); radarr.profiles = t.data.profiles || []; radarr.rootFolders = t.data.rootFolders || []; } catch { radarr.profiles = []; radarr.rootFolders = []; }
        if (sonarr) try { const t = await axios.post(`${base}/settings/sonarr/test`, sonarr, { headers: { 'X-Api-Key': key } }); sonarr.profiles = t.data.profiles || []; sonarr.rootFolders = t.data.rootFolders || []; } catch { sonarr.profiles = []; sonarr.rootFolders = []; }
        res.json({ configured: true, radarr, sonarr });
    } catch (e) { res.status(500).json({ error: 'Jellyseerr options failed' }); }
});

app.post('/api/jellyseerr/request', async (req, res) => {
    if (!process.env.JELLYSEERR_API_KEY || !process.env.JELLYSEERR_URL) return res.status(500).json({ error: 'Not configured' });
    try {
        const base = process.env.JELLYSEERR_URL.replace(/\/$/, '') + '/api/v1';
        const key = process.env.JELLYSEERR_API_KEY;
        const { mediaId, mediaType, serverId, profileId, rootFolder, requestUser } = req.body;
        let userId = 1;
        if (requestUser) {
            try {
                const uRes = await axios.get(`${base}/user`, { headers: { 'X-Api-Key': key } });
                const rLower = requestUser.toLowerCase();
                const m = (uRes.data?.results || []).find(u => u.username?.toLowerCase() === rLower || u.displayName?.toLowerCase() === rLower || u.email?.toLowerCase().includes(rLower));
                if (m) userId = m.id;
            } catch { }
        }
        const payload = { mediaId, mediaType, userId };
        if (serverId !== undefined) payload.serverId = serverId;
        if (profileId !== undefined) payload.profileId = profileId;
        if (rootFolder !== undefined) payload.rootFolder = rootFolder;
        const r = await axios.post(`${base}/request`, payload, { headers: { 'X-Api-Key': key } });
        res.json({ success: true, data: r.data });
    } catch (e) {
        const msg = e.response?.data?.message || 'Jellyseerr request failed';
        res.status(500).json({ success: false, error: msg });
    }
});

// ─── Magnet Resolution ────────────────────────────────────────────────────────
app.get('/api/get-magnet', async (req, res) => {
    const torrentUrl = req.query.url;
    if (!torrentUrl) return res.status(400).json({ error: 'URL required' });
    try {
        if (torrentUrl.startsWith('magnet:')) return res.json({ magnetUrl: torrentUrl });
        const r = await axios.get(torrentUrl, { headers: { 'X-Api-Key': PROWLARR_API_KEY }, responseType: 'arraybuffer', maxRedirects: 0 });
        const pt = await import('parse-torrent');
        const parsed = await pt.default(Buffer.from(r.data));
        res.json({ magnetUrl: pt.toMagnetURI(parsed) });
    } catch (e) {
        if (e.response?.status >= 300 && e.response?.status < 400) {
            const loc = e.response.headers.location || e.response.headers.Location;
            if (loc?.startsWith('magnet:')) return res.json({ magnetUrl: loc });
        }
        res.status(500).json({ error: 'Failed to parse magnet' });
    }
});

// ─── Probe: detect codec/container to decide direct play vs transcode ─────────
app.get('/api/probe', async (req, res) => {
    const magnetURI = req.query.magnet;
    const isSafari = req.query.safari === '1'; // sent by frontend
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    let fileInfo;
    try {
        fileInfo = (await axios.get(`${STREAMER_URL}/info?magnet=${encodeURIComponent(magnetURI)}`, { timeout: 60000 })).data;
    } catch (e) {
        return res.json({ status: 'pending', message: 'Fetching torrent metadata...' });
    }

    const ext = fileInfo.extension || '';
    const rawStreamUrl = `${STREAMER_URL}/stream?magnet=${encodeURIComponent(magnetURI)}`;

    return new Promise((resolve) => {
        const ffprobe = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', rawStreamUrl]);
        let output = '';
        ffprobe.stdout.on('data', chunk => { output += chunk.toString(); });

        ffprobe.on('close', () => {
            let codec = 'unknown', resolution = 'unknown', container = ext;
            try {
                const probe = JSON.parse(output);
                const vs = probe.streams?.find(s => s.codec_type === 'video');
                if (vs) { codec = vs.codec_name || 'unknown'; resolution = `${vs.width}x${vs.height}`; }
                if (probe.format?.format_name) container = probe.format.format_name.split(',')[0];
            } catch { }

            const isH264 = codec === 'h264' || codec === 'avc1';
            const isVP = codec === 'vp9' || codec === 'vp8';
            const isAV1 = codec === 'av1';
            const isMp4 = ['mov', 'mp4', 'mp4a', 'm4v'].includes(container) || ext === 'mp4' || ext === 'm4v';

            // Safari/iOS: only H.264+MP4 can direct play natively
            // Desktop Chrome/Firefox/Edge: H.264 (any container), VP8/VP9, AV1 all work
            const canDirectPlay = isSafari ? (isH264 && isMp4) : (isH264 || isVP || isAV1);

            console.log(`[Hub/probe] ${fileInfo.name} | codec:${codec} container:${container} safari:${isSafari} → ${canDirectPlay ? 'Direct Play ✓' : 'Transcode'}`);
            res.json({ status: 'ready', canDirectPlay, codec, container, resolution, fileName: fileInfo.name, fileSize: fileInfo.size });
            resolve();
        });

        ffprobe.on('error', () => {
            // ffprobe failed — safe default: direct play on desktop, transcode on Safari
            console.warn('[Hub/probe] ffprobe unavailable — using safe default');
            res.json({ status: 'error', canDirectPlay: !isSafari, codec: 'unknown', container: ext, resolution: 'unknown', fileName: fileInfo.name, fileSize: fileInfo.size });
            resolve();
        });
    });
});

// ─── HLS: Start transcode session ─────────────────────────────────────────────
app.post('/api/hls/start', async (req, res) => {
    const { magnet, codec, resolution } = req.body;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

    const sessionId = uuidv4();
    const outputDir = path.join(HLS_OUTPUT_BASE, sessionId);
    const playlistPath = path.join(outputDir, 'index.m3u8');
    const rawStreamUrl = `${STREAMER_URL}/stream?magnet=${encodeURIComponent(magnet)}`;

    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`[Hub/HLS] Session ${sessionId} | source: ${rawStreamUrl}`);

    const buildArgs = (encoder) => [
        '-i', rawStreamUrl,
        '-c:v', encoder,
        ...(encoder === 'h264_nvenc' ? ['-preset', 'p4', '-cq', '23'] : ['-preset', 'veryfast', '-crf', '23']),
        '-profile:v', 'high', '-level', '4.1',
        '-g', '48', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-f', 'hls',
        '-hls_time', '2',               // 2-second segments → faster first play
        '-hls_list_size', '0',           // keep ALL segments for seeking
        '-hls_flags', 'independent_segments+append_list',
        '-hls_segment_type', 'mpegts',
        '-hls_playlist_type', 'event',   // grows live; ENDLIST added when done
        '-hls_segment_filename', path.join(outputDir, 'seg%05d.ts'),
        playlistPath,
    ];

    const startFfmpeg = (encoder) => {
        const proc = spawn('ffmpeg', buildArgs(encoder), { stdio: ['ignore', 'pipe', 'pipe'] });
        let nvencFailed = false;

        proc.stderr.on('data', chunk => {
            const line = chunk.toString();
            if (line.includes('No NVENC capable devices found') || line.includes('Cannot load nvcuda')) nvencFailed = true;
            if (line.includes('frame=')) process.stdout.write(`[ffmpeg/${sessionId.substring(0, 8)}] ${line.trim()}\n`);
        });

        proc.on('close', code => {
            if (nvencFailed && encoder === 'h264_nvenc') {
                console.warn(`[Hub/HLS ⚠] NVENC unavailable — falling back to libx264: ${sessionId}`);
                const fb = startFfmpeg('libx264');
                const s = hlsSessions.get(sessionId);
                if (s) s.ffmpeg = fb;
            } else if (code === 0) {
                console.log(`[Hub/HLS ✓] Transcode complete: ${sessionId}`);
                const s = hlsSessions.get(sessionId);
                if (s) s.status = 'complete';
            } else if (code !== null) {
                console.error(`[Hub/HLS !] ffmpeg exited ${code}: ${sessionId}`);
            }
        });

        proc.on('error', err => { console.error(`[Hub/HLS !] spawn error: ${err.message}`); cleanupSession(sessionId); });
        return proc;
    };

    hlsSessions.set(sessionId, {
        ffmpeg: startFfmpeg('h264_nvenc'),
        outputDir, status: 'transcoding',
        codec: 'h264_nvenc', resolution: resolution || 'unknown',
        startTime: Date.now(), cleanupTimer: null,
    });

    // Respond immediately — playlist endpoint long-polls until first segments exist
    res.json({ sessionId, playlistUrl: `/api/hls/${sessionId}/index.m3u8`, status: 'transcoding' });
});

// ─── HLS: Stop / schedule cleanup ─────────────────────────────────────────────
app.post('/api/hls/stop/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!hlsSessions.has(sessionId)) return res.json({ success: true });
    console.log(`[Hub/HLS] Stop → scheduling 5-min cleanup: ${sessionId}`);
    const s = hlsSessions.get(sessionId);
    if (s) s.status = 'stopping';
    scheduleCleanup(sessionId, 5 * 60 * 1000);
    res.json({ success: true });
});

// ─── HLS: Serve playlist (long-polls until first segment is ready) ─────────────
app.get('/api/hls/:sessionId/index.m3u8', async (req, res) => {
    const { sessionId } = req.params;
    const filePath = path.join(HLS_OUTPUT_BASE, sessionId, 'index.m3u8');
    const dir = path.join(HLS_OUTPUT_BASE, sessionId);

    // Wait up to 30s for at least one .ts segment to exist
    for (let i = 0; i < 30; i++) {
        if (fs.existsSync(filePath)) {
            try {
                const segs = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
                if (segs.length > 0) break;
            } catch { }
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!fs.existsSync(filePath)) return res.status(504).send('Transcode timed out');

    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache, no-store', 'Access-Control-Allow-Origin': '*' });
    res.sendFile(filePath);
});

// ─── HLS: Serve segments (long-polls — handles seeking forward into unbuilt segs)
app.get('/api/hls/:sessionId/:segment', async (req, res) => {
    const { sessionId, segment } = req.params;
    if (!segment.endsWith('.ts')) return res.status(400).send('Invalid segment type');

    const filePath = path.join(HLS_OUTPUT_BASE, sessionId, segment);

    // Wait up to 60s for segment to be transcoded (handles seeking ahead)
    for (let i = 0; i < 60; i++) {
        if (fs.existsSync(filePath)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!fs.existsSync(filePath)) return res.status(404).send('Segment not found');

    res.set({ 'Content-Type': 'video/MP2T', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' });
    res.sendFile(filePath);
});

// ─── HLS Status ───────────────────────────────────────────────────────────────
app.get('/api/hls/status/:sessionId', (req, res) => {
    const s = hlsSessions.get(req.params.sessionId);
    if (!s) return res.json({ status: 'not_found' });
    let segs = 0;
    try { segs = fs.readdirSync(s.outputDir).filter(f => f.endsWith('.ts')).length; } catch { }
    res.json({ status: s.status, codec: s.codec, resolution: s.resolution, segmentsReady: segs, elapsed: Math.round((Date.now() - s.startTime) / 1000) });
});

// ─── Raw stream proxy (direct play) ──────────────────────────────────────────
app.use(createProxyMiddleware({
    target: STREAMER_URL, changeOrigin: true, proxyTimeout: 0, timeout: 0,
    pathFilter: '/api/stream',
    pathRewrite: { '^/api/stream': '/stream' },
    on: { proxyRes(proxyRes) { proxyRes.headers['Access-Control-Allow-Origin'] = '*'; } },
}));

// ─── Watch History ────────────────────────────────────────────────────────────
app.get('/api/admin/history', (req, res) => {
    db.all('SELECT * FROM history ORDER BY watched_at DESC LIMIT 200', [], (err, rows) => { if (err) return res.status(500).json({ error: 'DB error' }); res.json(rows); });
});
app.get('/api/history/:userId', (req, res) => {
    db.all('SELECT * FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 50', [req.params.userId], (err, rows) => { if (err) return res.status(500).json({ error: 'DB error' }); res.json(rows); });
});
app.delete('/api/admin/history', (req, res) => {
    db.run('DELETE FROM history', function (err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true }); });
});
app.post('/api/history', (req, res) => {
    const { user_id, tmdb_id, media_type, title, poster_path } = req.body;
    if (!user_id || !tmdb_id || !title || !media_type) return res.status(400).json({ error: 'Missing fields' });
    db.serialize(() => {
        db.run('DELETE FROM history WHERE user_id = ? AND tmdb_id = ?', [user_id, tmdb_id]);
        db.run('INSERT INTO history (user_id, tmdb_id, media_type, title, poster_path) VALUES (?, ?, ?, ?, ?)', [user_id, tmdb_id, media_type, title, poster_path], function (err) {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json({ success: true, id: this.lastID });
        });
    });
});

app.get('/api/stream-url', (req, res) => res.json({ url: STREAMER_URL }));
app.get('/api/status', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });
    try { res.json((await axios.get(`${STREAMER_URL}/status`, { params: { magnet } })).data); }
    catch { res.status(500).json({ error: 'Status fetch failed' }); }
});

// SPA catch-all
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

ensureHlsBase();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🎬 StreamHub running on port ${PORT}`);
    console.log(`📡 Streamer: ${STREAMER_URL}`);
    console.log(`🎞  HLS base: ${HLS_OUTPUT_BASE}`);
    console.log('====================================================');
});
