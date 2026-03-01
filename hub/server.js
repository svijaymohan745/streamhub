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

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PROWLARR_URL = process.env.PROWLARR_URL;
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY;
const STREAMER_URL = process.env.STREAMER_URL || 'http://localhost:6987';
const HLS_OUTPUT_BASE = process.env.HLS_OUTPUT_BASE || '/tmp/hls_sessions';

// ─── HLS Sessions ─────────────────────────────────────────────────────────────
const hlsSessions = new Map();

function ensureHlsBase() {
    if (!fs.existsSync(HLS_OUTPUT_BASE)) fs.mkdirSync(HLS_OUTPUT_BASE, { recursive: true });
}

function cleanupSession(sessionId) {
    const s = hlsSessions.get(sessionId);
    if (!s) return;
    clearTimeout(s.cleanupTimer);
    if (s.ffmpeg) { try { s.ffmpeg.kill('SIGKILL'); } catch (e) { } s.ffmpeg = null; }
    try { if (fs.existsSync(s.outputDir)) fs.rmSync(s.outputDir, { recursive: true, force: true }); } catch (e) { }
    console.log(`[🗑] HLS session cleaned: ${sessionId}`);
    hlsSessions.delete(sessionId);
}

function scheduleCleanup(sessionId, delayMs = 5 * 60 * 1000) {
    const s = hlsSessions.get(sessionId);
    if (!s) return;
    clearTimeout(s.cleanupTimer);
    s.cleanupTimer = setTimeout(() => {
        console.log(`[⏰] 5-min cleanup: ${sessionId}`);
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
            Object.assign(activeStreams[socket.id], { transcoding: data.transcoding, codec: data.codec, resolution: data.resolution, sessionId: data.sessionId });
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
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/grid', async (req, res) => {
    try {
        const page = Math.floor(Math.random() * 5) + 1;
        const r = await axios.get('https://api.themoviedb.org/3/movie/popular', { params: { api_key: TMDB_API_KEY, page } });
        res.json(r.data.results.filter(m => m.poster_path).slice(0, 18).map(m => `https://image.tmdb.org/t/p/w200${m.poster_path}`));
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
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

// ─── Auth ─────────────────────────────────────────────────────────────────────
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

// ─── Jellyfin ─────────────────────────────────────────────────────────────────
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
        const radarr = rr.data[0] || null; const sonarr = sr.data[0] || null;
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
        res.status(500).json({ success: false, error: e.response?.data?.message || 'Jellyseerr request failed' });
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

// ─── Probe Helpers ─────────────────────────────────────────────────────────────
function parseMagnetDn(magnetURI) {
    try {
        const params = new URLSearchParams(magnetURI.replace(/^magnet:\?/i, ''));
        const dn = params.get('dn');
        if (dn) {
            const name = decodeURIComponent(dn).trim();
            return { name, extension: name.split('.').pop().toLowerCase() };
        }
    } catch (e) { }
    return null;
}

function determineDirectPlay(fileInfo, isSafari) {
    const name = (fileInfo.name || '').toLowerCase();
    const ext = (fileInfo.extension || '').toLowerCase();
    // HEVC/H.265 cannot be decoded natively by most browsers
    const isHEVC = /\bx265\b|\bhevc\b|\bh\.?265\b/.test(name);
    if (isSafari) {
        // Safari/iOS: only H.264 in MP4
        return (ext === 'mp4' || ext === 'm4v') && !isHEVC;
    }
    // Desktop Chrome/Firefox/Edge: everything except HEVC direct-plays fine
    return !isHEVC;
}

// ─── Probe endpoint — instant, no ffprobe ─────────────────────────────────────
app.get('/api/probe', async (req, res) => {
    const magnetURI = req.query.magnet;
    const isSafari = req.query.safari === '1';
    if (!magnetURI) return res.status(400).json({ error: 'Missing magnet' });

    // Fast path: parse filename from magnet dn= (zero network calls, instant)
    const dnInfo = parseMagnetDn(magnetURI);
    if (dnInfo) {
        // Warm up torrent in background while player prepares
        axios.get(`${STREAMER_URL}/info?magnet=${encodeURIComponent(magnetURI)}`, { timeout: 120000 }).catch(() => { });
        const canDirectPlay = determineDirectPlay(dnInfo, isSafari);
        console.log(`[Hub/probe] ${dnInfo.name} | ${isSafari ? 'Safari' : 'Desktop'} → ${canDirectPlay ? 'Direct ✓' : 'HEVC → Transcode'}`);
        return res.json({ status: 'ready', canDirectPlay, codec: canDirectPlay ? 'h264' : 'hevc', container: dnInfo.extension, resolution: 'unknown', fileName: dnInfo.name, fileSize: 0 });
    }

    // Slow path: no dn= in magnet — ask streamer for filename
    try {
        const fileInfo = (await axios.get(`${STREAMER_URL}/info?magnet=${encodeURIComponent(magnetURI)}`, { timeout: 60000 })).data;
        const canDirectPlay = determineDirectPlay(fileInfo, isSafari);
        console.log(`[Hub/probe] ${fileInfo.name} | ${isSafari ? 'Safari' : 'Desktop'} → ${canDirectPlay ? 'Direct ✓' : 'Transcode'}`);
        return res.json({ status: 'ready', canDirectPlay, codec: canDirectPlay ? 'h264' : 'hevc', container: fileInfo.extension, resolution: 'unknown', fileName: fileInfo.name, fileSize: fileInfo.size });
    } catch (e) {
        return res.json({ status: 'pending', message: 'Fetching torrent metadata...' });
    }
});

// ─── HLS: Start transcode session ─────────────────────────────────────────────
app.post('/api/hls/start', async (req, res) => {
    const { magnet, codec, resolution } = req.body;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

    // Warm up torrent on streamer BEFORE ffmpeg starts — ensures a valid stream on first connect
    console.log('[Hub/HLS] Warming up torrent...');
    try {
        await axios.get(`${STREAMER_URL}/info?magnet=${encodeURIComponent(magnet)}`, { timeout: 120000 });
    } catch (e) {
        console.warn('[Hub/HLS] Torrent warmup failed (continuing):', e.message);
    }

    const sessionId = uuidv4();
    const outputDir = path.join(HLS_OUTPUT_BASE, sessionId);
    const playlistPath = path.join(outputDir, 'index.m3u8');
    const rawStreamUrl = `${STREAMER_URL}/stream?magnet=${encodeURIComponent(magnet)}`;

    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`[Hub/HLS] Session ${sessionId} | ${rawStreamUrl.substring(0, 80)}...`);

    const buildArgs = (encoder) => [
        '-i', rawStreamUrl,
        '-c:v', encoder,
        ...(encoder === 'h264_nvenc' ? ['-preset', 'p4', '-cq', '23'] : ['-preset', 'veryfast', '-crf', '23']),
        '-profile:v', 'high', '-level', '4.1',
        '-g', '48', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments+append_list',
        '-hls_segment_type', 'mpegts',
        '-hls_playlist_type', 'event',
        '-hls_segment_filename', path.join(outputDir, 'seg%05d.ts'),
        playlistPath,
    ];

    const startFfmpeg = (encoder) => {
        const proc = spawn('ffmpeg', buildArgs(encoder), { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.stderr.on('data', chunk => {
            const line = chunk.toString();
            if (line.includes('frame=')) process.stdout.write(`[ffmpeg/${sessionId.substring(0, 8)}] ${line.trim()}\n`);
        });

        proc.on('close', code => {
            if (code !== 0) {
                // Check segments produced — any non-zero exit + no segments = fallback
                let segs = 0;
                try { segs = fs.readdirSync(outputDir).filter(f => f.endsWith('.ts')).length; } catch { }

                if (segs === 0 && encoder === 'h264_nvenc') {
                    console.warn(`[Hub/HLS ⚠] NVENC failed (exit ${code}, no segments) — retrying with libx264: ${sessionId}`);
                    const fb = startFfmpeg('libx264');
                    const s = hlsSessions.get(sessionId);
                    if (s) s.ffmpeg = fb;
                    return;
                }
                if (segs === 0) {
                    console.error(`[Hub/HLS !] ffmpeg failed with no output (exit ${code}): ${sessionId}`);
                }
            } else {
                console.log(`[Hub/HLS ✓] Transcode complete: ${sessionId}`);
                const s = hlsSessions.get(sessionId);
                if (s) s.status = 'complete';
            }
        });

        proc.on('error', err => { console.error(`[Hub/HLS !] spawn: ${err.message}`); cleanupSession(sessionId); });
        return proc;
    };

    hlsSessions.set(sessionId, {
        ffmpeg: startFfmpeg('h264_nvenc'),
        outputDir, status: 'transcoding',
        codec: 'h264_nvenc', resolution: resolution || 'unknown',
        startTime: Date.now(), cleanupTimer: null,
    });

    res.json({ sessionId, playlistUrl: `/api/hls/${sessionId}/index.m3u8`, status: 'transcoding' });
});

// ─── HLS: Stop ────────────────────────────────────────────────────────────────
app.post('/api/hls/stop/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!hlsSessions.has(sessionId)) return res.json({ success: true });
    console.log(`[Hub/HLS] Stop → 5-min cleanup: ${sessionId}`);
    const s = hlsSessions.get(sessionId);
    if (s) s.status = 'stopping';
    scheduleCleanup(sessionId, 5 * 60 * 1000);
    res.json({ success: true });
});

// ─── HLS: Serve playlist (long-polls up to 60s for first segment) ─────────────
app.get('/api/hls/:sessionId/index.m3u8', async (req, res) => {
    const { sessionId } = req.params;
    const filePath = path.join(HLS_OUTPUT_BASE, sessionId, 'index.m3u8');
    const dir = path.join(HLS_OUTPUT_BASE, sessionId);

    for (let i = 0; i < 60; i++) {
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

// ─── HLS: Serve segments (long-poll handles forward seeking) ──────────────────
app.get('/api/hls/:sessionId/:segment', async (req, res) => {
    const { sessionId, segment } = req.params;
    if (!segment.endsWith('.ts')) return res.status(400).send('Invalid segment type');

    const filePath = path.join(HLS_OUTPUT_BASE, sessionId, segment);

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

// ─── Raw stream proxy ─────────────────────────────────────────────────────────
app.use(createProxyMiddleware({
    target: STREAMER_URL, changeOrigin: true, proxyTimeout: 0, timeout: 0,
    pathFilter: '/api/stream',
    pathRewrite: { '^/api/stream': '/stream' },
    on: { proxyRes(proxyRes) { proxyRes.headers['Access-Control-Allow-Origin'] = '*'; } },
}));

// ─── History ──────────────────────────────────────────────────────────────────
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
        db.run('INSERT INTO history (user_id, tmdb_id, media_type, title, poster_path) VALUES (?, ?, ?, ?, ?)',
            [user_id, tmdb_id, media_type, title, poster_path],
            function (err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true, id: this.lastID }); });
    });
});

app.get('/api/stream-url', (req, res) => res.json({ url: STREAMER_URL }));
app.get('/api/status', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet' });
    try { res.json((await axios.get(`${STREAMER_URL}/status`, { params: { magnet } })).data); }
    catch { res.status(500).json({ error: 'Status fetch failed' }); }
});

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
