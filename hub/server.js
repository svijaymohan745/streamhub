const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });

// Track active streaming sessions
const activeStreams = {};

io.on('connection', (socket) => {
    socket.on('start_stream', (data) => {
        // data expected: { user_id, title, device }
        let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim(); // Get originated IP if behind proxy

        activeStreams[socket.id] = { ...data, ip: clientIp, startTime: Date.now(), socketId: socket.id, progress: 0 };
        io.emit('active_streams', Object.values(activeStreams));
    });

    socket.on('update_progress', (data) => {
        if (activeStreams[socket.id]) {
            activeStreams[socket.id].progress = data.progress;
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

// --- Database Initialization ---
const fs = require('fs');
if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data', { recursive: true });
}

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
// Serve the static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Environment Variables
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PROWLARR_URL = process.env.PROWLARR_URL; // e.g. http://192.168.2.54:9696
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY;
const STREAMER_URL = process.env.STREAMER_URL || 'http://localhost:6987'; // Defaulting for local test

// --- API: Search TMDB for Movies & TV ---
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query parameter "q" is required.' });

    try {
        const response = await axios.get(`https://api.themoviedb.org/3/search/multi`, {
            params: {
                api_key: TMDB_API_KEY,
                query: query,
                include_adult: false
            }
        });

        // Filter out items without posters, and only keep movies and tv
        const results = response.data.results.filter(m => m.poster_path && (m.media_type === 'movie' || m.media_type === 'tv'));
        res.json(results);
    } catch (error) {
        console.error('TMDB Search Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch from TMDB' });
    }
});

// --- API: Get Movie Details & High-Res Backdrop ---
app.get('/api/movie/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/movie/${req.params.id}`, {
            params: { api_key: TMDB_API_KEY }
        });
        res.json(response.data);
    } catch (error) {
        console.error('TMDB Details Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch movie details' });
    }
});

// --- API: Get TV Show Details ---
app.get('/api/tv/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/tv/${req.params.id}`, {
            params: { api_key: TMDB_API_KEY }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch TV details' });
    }
});

// --- API: Get TV Season Episodes ---
app.get('/api/tv/:id/season/:season_number', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/tv/${req.params.id}/season/${req.params.season_number}`, {
            params: { api_key: TMDB_API_KEY }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch Season details' });
    }
});

// --- API: Find Torrents via Prowlarr ---
app.get('/api/torrents', async (req, res) => {
    const query = req.query.q; // The movie title
    const year = req.query.year; // The movie year (helps filter Prowlarr)

    if (!query) return res.status(400).json({ error: 'Movie query required.' });

    try {
        // Prowlarr standard search API
        const prowlarrEndpoint = `${PROWLARR_URL}/api/v1/search`;

        const response = await axios.get(prowlarrEndpoint, {
            headers: { 'X-Api-Key': PROWLARR_API_KEY },
            params: {
                query: `${query} ${year || ''}`.trim(),
                type: 'search',
                limit: 100
            }
        });

        const results = response.data;

        // Filter & Sort Results
        // 1. Must have a magnet URI (we can't handle bare .torrent files as easily without downloading them first)
        // 2. Sort by seeders descending
        const validTorrents = results
            .filter(t => t.magnetUrl || t.downloadUrl)
            // Just map to the essential info the frontend needs
            .map(t => ({
                title: t.title,
                size: t.size,
                seeders: t.seeders,
                leechers: t.leechers,
                indexer: t.indexer,
                // Ensure we have a magnetUrl. If Prowlarr only gives a standard HTTP torrent download
                // URL in downloadUrl, our streamer will need a magnet link technically. 
                // Many indexers convert direct torrent links to magnets natively through Prowlarr.
                magnetUrl: t.magnetUrl || t.downloadUrl
            }))
            .sort((a, b) => b.seeders - a.seeders);

        res.json(validTorrents);
    } catch (error) {
        console.error('Prowlarr Search Error:', error.message);
        res.status(500).json({ error: 'Failed to search Prowlarr' });
    }
});

// --- Phase 2 API: Authentication with local Jellyfin ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    try {
        // As per user spec, Jellyfin is running at 192.168.2.54:1000
        const jellyfinAuthUrl = `http://192.168.2.54:1000/Users/AuthenticateByName`;

        const response = await axios.post(jellyfinAuthUrl, {
            Username: username,
            Pw: password
        }, {
            headers: {
                'Authorization': 'MediaBrowser Client="StreamHub", Device="Web", DeviceId="123", Version="1.0.0"',
                'Content-Type': 'application/json'
            }
        });

        // If Jellyfin accepts it, it returns a 200 with user Session/Token data. We just need to signal success.
        res.json({ success: true, user: response.data.User, token: response.data.AccessToken });
    } catch (error) {
        console.error('Jellyfin Auth Error:', error.message);
        // Jellyfin returns 400 or 401 on bad credentials
        res.status(401).json({ error: 'Invalid Jellyfin credentials' });
    }
});

// --- Phase 5 API: Check if Media Exists in Jellyfin ---
app.get('/api/jellyfin/check', async (req, res) => {
    const { title, tmdbId } = req.query;
    if (!title) return res.json({ exists: false });

    if (!process.env.JELLYFIN_API_KEY) {
        console.warn('JELLYFIN_API_KEY is not set. Deep linking disabled.');
        return res.json({ exists: false });
    }

    try {
        const jfUrl = (process.env.JELLYFIN_URL || 'http://192.168.2.54:1000').replace(/\/$/, '');
        const jfExternalUrl = (process.env.JELLYFIN_EXTERNAL_URL || jfUrl).replace(/\/$/, '');

        const queryUrl = `${jfUrl}/Items?IncludeItemTypes=Movie,Series&Recursive=true&searchTerm=${title}&Fields=ProviderIds`;
        const response = await axios.get(queryUrl, { headers: { 'X-Emby-Token': process.env.JELLYFIN_API_KEY } });

        let match = null;

        if (response.data.Items && response.data.Items.length > 0) {
            // 1. Strict TMDB ID matching explicitly on the Node backend dictionary to bypass Jellyfin proxy parameter bugs
            if (tmdbId) {
                match = response.data.Items.find(item => item.ProviderIds && item.ProviderIds.Tmdb === tmdbId.toString());
            }

            // 2. Fallback to strict exact-string equivalency
            if (!match) {
                match = response.data.Items.find(item => item.Name.toLowerCase() === title.toLowerCase());
            }
        }

        if (match) {
            return res.json({
                exists: true,
                id: match.Id,
                url: `${jfExternalUrl}/web/index.html#!/details?id=${match.Id}`
            });
        }
        res.json({ exists: false });
    } catch (error) {
        console.error('Jellyfin check error:', error.message);
        res.status(500).json({ error: 'Failed to verify Jellyfin status' });
    }
});

// Jellyseerr Media Requests Integration
app.get('/api/jellyseerr/options', async (req, res) => {
    if (!process.env.JELLYSEERR_API_KEY || !process.env.JELLYSEERR_URL) {
        return res.json({ configured: false });
    }

    try {
        const baseUrl = process.env.JELLYSEERR_URL.replace(/\/$/, '') + '/api/v1';
        const apiKey = process.env.JELLYSEERR_API_KEY;

        const [radarrRes, sonarrRes] = await Promise.all([
            axios.get(`${baseUrl}/settings/radarr`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] })),
            axios.get(`${baseUrl}/settings/sonarr`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] }))
        ]);

        const radarr = radarrRes.data.length > 0 ? radarrRes.data[0] : null;
        const sonarr = sonarrRes.data.length > 0 ? sonarrRes.data[0] : null;

        if (radarr) {
            const [profiles, folders] = await Promise.all([
                axios.get(`${baseUrl}/settings/radarr/${radarr.id}/profiles`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] })),
                axios.get(`${baseUrl}/settings/radarr/${radarr.id}/directories`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] }))
            ]);
            radarr.profiles = profiles.data;
            radarr.rootFolders = folders.data;
        }

        if (sonarr) {
            const [profiles, folders] = await Promise.all([
                axios.get(`${baseUrl}/settings/sonarr/${sonarr.id}/profiles`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] })),
                axios.get(`${baseUrl}/settings/sonarr/${sonarr.id}/directories`, { headers: { 'X-Api-Key': apiKey } }).catch(() => ({ data: [] }))
            ]);
            sonarr.profiles = profiles.data;
            sonarr.rootFolders = folders.data;
        }

        res.json({
            configured: true,
            radarr,
            sonarr
        });
    } catch (e) {
        console.error('Jellyseerr Options Error:', e.message);
        res.status(500).json({ error: 'Failed to fetch Overseerr endpoints' });
    }
});

app.post('/api/jellyseerr/request', async (req, res) => {
    if (!process.env.JELLYSEERR_API_KEY || !process.env.JELLYSEERR_URL) return res.status(500).json({ error: 'Not configured' });

    try {
        const baseUrl = process.env.JELLYSEERR_URL.replace(/\/$/, '') + '/api/v1';
        const apiKey = process.env.JELLYSEERR_API_KEY;
        const { mediaId, mediaType, serverId, profileId, rootFolder, requestUser } = req.body;

        let userId = 1; // Default to admin
        if (requestUser) {
            try {
                const reqUserLower = requestUser.toLowerCase();
                const usersRes = await axios.get(`${baseUrl}/user`, { headers: { 'X-Api-Key': apiKey } });
                if (usersRes.data && usersRes.data.results) {
                    const match = usersRes.data.results.find(u =>
                        (u.username && u.username.toLowerCase() === reqUserLower) ||
                        (u.displayName && u.displayName.toLowerCase() === reqUserLower) ||
                        (u.email && u.email.toLowerCase().includes(reqUserLower))
                    );
                    if (match) userId = match.id;
                }
            } catch (e) {
                console.error('Failed to map Overseerr user:', e.message);
            }
        }

        // Overseerr dynamically merges payload objects
        const payload = { mediaId, mediaType, userId };
        if (serverId !== undefined) payload.serverId = serverId;
        if (profileId !== undefined) payload.profileId = profileId;
        if (rootFolder !== undefined) payload.rootFolder = rootFolder;

        const response = await axios.post(`${baseUrl}/request`, payload, {
            headers: { 'X-Api-Key': apiKey }
        });

        res.json({ success: true, data: response.data });
    } catch (e) {
        console.error('Jellyseerr Post Request Error:', e.response ? e.response.data : e.message);
        const errMsg = e.response && e.response.data && e.response.data.message ? e.response.data.message : 'Failed to push request to Jellyseerr';
        res.status(500).json({ success: false, error: errMsg });
    }
});

// --- Phase 2 API: Trending Movies (Pills) ---
app.get('/api/trending', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/trending/movie/day`, {
            params: { api_key: TMDB_API_KEY }
        });

        // Return top 10 trending movies
        const trending = response.data.results.slice(0, 10).map(m => ({
            id: m.id,
            title: m.title
        }));

        res.json(trending);
    } catch (error) {
        console.error('TMDB Trending Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch trending movies' });
    }
});

// --- Phase 2 API: Dynamic Background Grid ---
app.get('/api/grid', async (req, res) => {
    try {
        // Fetch a random page of popular movies to ensure the grid changes on refresh
        const randomPage = Math.floor(Math.random() * 5) + 1;
        const response = await axios.get(`https://api.themoviedb.org/3/movie/popular`, {
            params: {
                api_key: TMDB_API_KEY,
                page: randomPage
            }
        });

        // Return 18 movie posters for a 6x3 grid
        const posters = response.data.results
            .filter(m => m.poster_path)
            .slice(0, 18)
            .map(m => `https://image.tmdb.org/t/p/w200${m.poster_path}`);

        res.json(posters);
    } catch (error) {
        console.error('TMDB Grid Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch grid posters' });
    }
});

// --- API: Provide the Streamer Node URL to the Frontend (Deprecated, now using proxy) ---
app.get('/api/stream-url', (req, res) => {
    res.json({ url: STREAMER_URL });
});

// --- API: Proxy Video Stream to bypass HTTPS Mixed Content blocking ---
app.use(createProxyMiddleware({
    target: STREAMER_URL,
    changeOrigin: true,
    proxyTimeout: 0, // No timeout for streaming
    timeout: 0,
    pathFilter: '/api/stream',
    pathRewrite: {
        '^/api/stream': '/stream', // rewrite /api/stream to /stream on target
    },
    on: {
        proxyRes: function (proxyRes, req, res) {
            // Ensure CORS headers are passed downstream
            proxyRes.headers['Access-Control-Allow-Origin'] = '*';
        }
    }
}));

// --- API: Securely Convert Local Prowlarr .torrent to Magnet (Bypasses VPN blocks) ---
app.get('/api/get-magnet', async (req, res) => {
    const torrentUrl = req.query.url;
    if (!torrentUrl) return res.status(400).json({ error: 'URL is required' });

    try {
        if (torrentUrl.startsWith('magnet:')) {
            return res.json({ magnetUrl: torrentUrl });
        }

        console.log(`[Hub] Fetching local torrent: ${torrentUrl}`);
        const response = await axios.get(torrentUrl, {
            headers: { 'X-Api-Key': PROWLARR_API_KEY },
            responseType: 'arraybuffer',
            maxRedirects: 0 // Prevent axios from following magnet: redirects and crashing
        });

        // If it didn't redirect, it's a real .torrent file buffer
        const pt = await import('parse-torrent');
        const parseTorrent = pt.default;

        const torrentBuffer = Buffer.from(response.data);
        const parsed = await parseTorrent(torrentBuffer);
        const magnetUri = pt.toMagnetURI(parsed);

        console.log(`[Hub] Converted to Magnet String: ${magnetUri.substring(0, 50)}...`);
        res.json({ magnetUrl: magnetUri });

    } catch (e) {
        // Intercept HTTP 301/302 Redirects (Some Prowlarr indexers redirect directly to a magnet URI)
        if (e.response && e.response.status >= 300 && e.response.status < 400) {
            const location = e.response.headers.location || e.response.headers.Location;
            if (location && location.startsWith('magnet:')) {
                console.log(`[Hub] Successfully intercepted Magnet URL redirect from Prowlarr!`);
                return res.json({ magnetUrl: location });
            }
        }

        console.error('Magnet Generation Error:', e.message);
        res.status(500).json({ error: 'Failed to parse torrent into magnet' });
    }
});

// --- API: Watch History & Admin ---

// Get Global History (Admin)
app.get('/api/admin/history', (req, res) => {
    db.all(`SELECT * FROM history ORDER BY watched_at DESC LIMIT 200`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// Get history for a user
app.get('/api/history/:userId', (req, res) => {
    const userId = req.params.userId;
    db.all(`SELECT * FROM history WHERE user_id = ? ORDER BY watched_at DESC LIMIT 50`, [userId], (err, rows) => {
        if (err) {
            console.error('History Fetch Error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
});

// Clear Global History (Admin)
app.delete('/api/admin/history', (req, res) => {
    db.run(`DELETE FROM history`, function (err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true });
    });
});

// Add history record
app.post('/api/history', (req, res) => {
    const { user_id, tmdb_id, media_type, title, poster_path } = req.body;
    if (!user_id || !tmdb_id || !title || !media_type) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if the exact item exists recently (e.g., within 24 hours) for the identical user to avoid duplicate spam,
    // Or just simple upsert (delete old exact match, insert new to bump timestamp)
    db.serialize(() => {
        db.run(`DELETE FROM history WHERE user_id = ? AND tmdb_id = ?`, [user_id, tmdb_id]);

        db.run(`INSERT INTO history (user_id, tmdb_id, media_type, title, poster_path) VALUES (?, ?, ?, ?, ?)`,
            [user_id, tmdb_id, media_type, title, poster_path],
            function (err) {
                if (err) {
                    console.error('History Insert Error:', err);
                    return res.status(500).json({ error: 'Database record error' });
                }
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

// Catch-all to serve the frontend SPA
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🎬 UI Hub Server running on port ${PORT}`);
    console.log('====================================================');
});
