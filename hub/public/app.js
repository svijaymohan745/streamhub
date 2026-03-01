// ─── DOM References ────────────────────────────────────────────────────────────
const loginView = document.getElementById('login-view');
const searchView = document.getElementById('search-view');
const detailsView = document.getElementById('movie-details-view');
const playerView = document.getElementById('player-view');
const historyView = document.getElementById('history-view');
const searchInput = document.getElementById('movie-search');
const autocomplete = document.getElementById('autocomplete-results');
const spinner = document.getElementById('search-spinner');
const backdrop = document.getElementById('backdrop');

// ─── State ────────────────────────────────────────────────────────────────────
let progressInterval = null;
let hlsInstance = null;
let activeSessionId = null;
let currentMovieId = null;
let currentMediaType = 'movie';
let jellyseerrConfig = null;

// ─── Browser detection ────────────────────────────────────────────────────────
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) || IS_IOS;

// ─── Cookie helpers ───────────────────────────────────────────────────────────
function setCookie(name, value, days) {
    const d = new Date(); d.setTime(d.getTime() + days * 86400000);
    document.cookie = `${name}=${value || ''}; expires=${d.toUTCString()}; path=/; SameSite=Strict`;
}
function getCookie(name) {
    const eq = name + '=';
    for (let c of document.cookie.split(';')) { c = c.trim(); if (c.indexOf(eq) === 0) return c.substring(eq.length); }
    return null;
}

// ─── Startup ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    if (getCookie('jellyfinUser')) showMainApp();
    else { history.replaceState({ view: 'login' }, 'Login', '/'); loginView.classList.remove('hidden'); searchView.classList.add('hidden'); }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-login');
    const err = document.getElementById('login-error');
    const u = document.getElementById('jellyfin-username').value;
    const p = document.getElementById('jellyfin-password').value;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Authenticating...';
    err.classList.add('hidden');
    try {
        const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        if (!res.ok) throw new Error();
        const data = await res.json();
        setCookie('jellyfinUser', data.user.Name, 30);
        if (data.token) setCookie('jellyfinToken', data.token, 30);
        if (data.user?.Id) setCookie('jellyfinUserId', data.user.Id, 30);
        if (data.user?.Policy?.IsAdministrator) setCookie('isAdmin', 'true', 30);
        showMainApp();
    } catch { err.classList.remove('hidden'); btn.innerHTML = 'Sign In <i class="fa-solid fa-arrow-right"></i>'; }
});

document.getElementById('btn-logout').addEventListener('click', () => {
    ['jellyfinUser', 'jellyfinToken', 'isAdmin'].forEach(k => { document.cookie = `${k}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`; });
    location.reload();
});

function showMainApp() {
    loginView.classList.add('hidden');
    if (getCookie('isAdmin') === 'true') document.getElementById('btn-admin').classList.remove('hidden');
    loadNetflixGrid(); loadTrendingPills();
    fetch('/api/jellyseerr/options').then(r => r.json()).then(d => { jellyseerrConfig = d; }).catch(() => { });
    const p = window.location.pathname;
    if (p.startsWith('/movie/') || p.startsWith('/tv/')) {
        const parts = p.split('/');
        history.replaceState({ view: 'details', id: parts[2], mediaType: parts[1] }, 'Details', p);
        loadMovieDetails(parts[2], parts[1], false);
    } else { history.replaceState({ view: 'search' }, 'Search', '/'); showSearchView(); }
}

function showSearchView() {
    detailsView.classList.add('hidden'); playerView.classList.add('hidden'); historyView.classList.add('hidden');
    document.getElementById('admin-view')?.classList.add('hidden');
    searchView.classList.remove('hidden'); searchInput.value = ''; backdrop.style.backgroundImage = 'none'; currentMovieId = null;
}
function showHistoryView() {
    searchView.classList.add('hidden'); detailsView.classList.add('hidden'); playerView.classList.add('hidden');
    document.getElementById('admin-view')?.classList.add('hidden');
    historyView.classList.remove('hidden'); backdrop.style.backgroundImage = 'none'; loadWatchHistory();
}

// ─── Grid & Pills ──────────────────────────────────────────────────────────────
async function loadNetflixGrid() {
    const gc = document.getElementById('grid-container');
    try { let p = await (await fetch('/api/grid')).json(); p = [...p, ...p, ...p, ...p]; gc.innerHTML = p.map(u => `<img src="${u}" class="grid-poster">`).join(''); } catch { }
}
async function loadTrendingPills() {
    const pc = document.getElementById('trending-pills');
    try { const t = await (await fetch('/api/trending')).json(); pc.innerHTML = t.map(m => `<span class="pill" onclick="searchMovie('${m.title.replace(/'/g, "\\'")}')">${m.title}</span>`).join(''); } catch { }
}
window.searchMovie = (title) => { searchInput.value = title; searchInput.dispatchEvent(new Event('input')); };

// ─── Search Autocomplete ───────────────────────────────────────────────────────
let searchTimeout;
searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length < 3) { autocomplete.classList.add('hidden'); return; }
    spinner.classList.remove('hidden');
    searchTimeout = setTimeout(() => {
        fetch(`/api/search?q=${encodeURIComponent(q)}`).then(r => r.json()).then(results => { spinner.classList.add('hidden'); renderAutocomplete(results); }).catch(() => spinner.classList.add('hidden'));
    }, 500);
});

function renderAutocomplete(results) {
    autocomplete.innerHTML = '';
    if (!results.length) { autocomplete.innerHTML = '<div class="search-item">No movies found.</div>'; autocomplete.classList.remove('hidden'); return; }
    results.slice(0, 5).forEach(m => {
        const item = document.createElement('div'); item.className = 'search-item';
        const poster = m.poster_path ? `https://image.tmdb.org/t/p/w92${m.poster_path}` : 'https://via.placeholder.com/92x138?text=No+Poster';
        const year = (m.release_date || m.first_air_date || '').split('-')[0] || 'N/A';
        const title = m.title || m.name;
        const icon = m.media_type === 'tv' ? '<i class="fa-solid fa-tv"></i>' : '<i class="fa-solid fa-film"></i>';
        item.innerHTML = `<img src="${poster}" alt="Poster"><div class="search-item-info"><strong>${title}</strong><span>${icon} ${year} • <i class="fa-solid fa-star" style="color:#f1c40f;"></i> ${m.vote_average.toFixed(1)}</span></div>`;
        item.addEventListener('click', () => loadMovieDetails(m.id, m.media_type));
        autocomplete.appendChild(item);
    });
    autocomplete.classList.remove('hidden');
}
document.addEventListener('click', (e) => { if (!e.target.closest('.search-container')) autocomplete.classList.add('hidden'); });

// ─── Movie Details ─────────────────────────────────────────────────────────────
async function loadMovieDetails(id, mediaType = 'movie', pushHistory = true) {
    if (pushHistory) history.pushState({ view: 'details', id, mediaType }, 'Media Details', `/${mediaType}/${id}`);
    autocomplete.classList.add('hidden');
    searchView.classList.add('hidden'); playerView.classList.add('hidden');
    detailsView.classList.remove('hidden');
    if (currentMovieId == id && currentMediaType === mediaType) return;
    currentMovieId = id; currentMediaType = mediaType;

    document.getElementById('sources-grid').classList.add('hidden');
    document.getElementById('sources-loader').classList.remove('hidden');
    document.getElementById('sources-grid').innerHTML = '';
    document.getElementById('tv-season-section').classList.add('hidden');

    try {
        const res = await fetch(`/api/${mediaType === 'tv' ? 'tv' : 'movie'}/${id}`);
        const data = await res.json();
        const title = data.title || data.name;
        const year = (data.release_date || data.first_air_date || '').split('-')[0];
        document.getElementById('detail-title').innerText = title;
        document.getElementById('detail-year').innerText = year;
        document.getElementById('detail-rating').innerHTML = `<i class="fa-solid fa-star"></i> ${data.vote_average.toFixed(1)}`;
        document.getElementById('detail-overview').innerText = data.overview;
        if (data.poster_path) document.getElementById('detail-poster').src = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
        if (data.backdrop_path) backdrop.style.backgroundImage = `url(https://image.tmdb.org/t/p/original${data.backdrop_path})`;

        const jellyfinBtn = document.getElementById('btn-jellyfin');
        const requestBtn = document.getElementById('btn-request');
        if (jellyfinBtn) jellyfinBtn.classList.add('hidden');
        if (requestBtn) requestBtn.classList.add('hidden');

        try {
            const jfData = await (await fetch(`/api/jellyfin/check?title=${encodeURIComponent(title)}&tmdbId=${data.id}`)).json();
            if (jfData.exists && jfData.url && jellyfinBtn) { jellyfinBtn.href = jfData.url; jellyfinBtn.classList.remove('hidden'); }
            else if (jellyseerrConfig?.configured && requestBtn) {
                requestBtn.style.background = '#8b5cf6'; requestBtn.style.pointerEvents = 'auto';
                requestBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up" style="margin-right:12px;font-size:1.2rem;"></i><span>${mediaType === 'movie' ? 'Request Movie to H-TV' : 'Request Show to H-TV'}</span>`;
                requestBtn.classList.remove('hidden'); requestBtn.onclick = () => openRequestModal(data, mediaType);
            }
        } catch { }

        if (mediaType === 'movie') {
            fetchSources(title, year);
        } else {
            document.getElementById('sources-loader').classList.add('hidden');
            const tvSection = document.getElementById('tv-season-section');
            const seasonDropdown = document.getElementById('season-selector');
            tvSection.classList.remove('hidden');
            seasonDropdown.innerHTML = '';
            data.seasons.filter(s => s.season_number > 0).forEach(s => {
                const opt = document.createElement('option'); opt.value = s.season_number;
                opt.innerText = `Season ${s.season_number}${s.air_date ? ` (${s.air_date.split('-')[0]})` : ''}`;
                seasonDropdown.appendChild(opt);
            });
            seasonDropdown.onchange = () => loadTvEpisodes(id, seasonDropdown.value, title);
            if (data.seasons.length > 0) seasonDropdown.onchange();
        }
    } catch (e) { console.error(e); alert('Failed to load details'); }
}

async function loadTvEpisodes(tvId, seasonNumber, showTitle) {
    const grid = document.getElementById('episodes-grid');
    grid.classList.remove('hidden'); grid.innerHTML = '<div style="color:var(--text-secondary);width:100%;">Loading episodes...</div>';
    try {
        const data = await (await fetch(`/api/tv/${tvId}/season/${seasonNumber}`)).json();
        grid.innerHTML = '';
        data.episodes.forEach(ep => {
            const btn = document.createElement('div'); btn.className = 'episode-btn'; btn.innerText = `E${ep.episode_number}`; btn.title = ep.name;
            btn.onclick = () => {
                document.querySelectorAll('.episode-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
                const sStr = seasonNumber.toString().padStart(2, '0'); const eStr = ep.episode_number.toString().padStart(2, '0');
                document.getElementById('sources-grid').innerHTML = ''; document.getElementById('sources-grid').classList.add('hidden'); document.getElementById('sources-loader').classList.remove('hidden');
                fetchSources(`${showTitle} S${sStr}E${eStr}`, '');
            };
            grid.appendChild(btn);
        });
    } catch { }
}

async function fetchSources(title, year) {
    const loader = document.getElementById('sources-loader');
    const grid = document.getElementById('sources-grid');
    try {
        const sources = await (await fetch(`/api/torrents?q=${encodeURIComponent(title)}&year=${year}`)).json();
        loader.classList.add('hidden');
        if (!sources.length) { grid.innerHTML = '<p style="grid-column:1/-1;">No streaming sources found.</p>'; grid.classList.remove('hidden'); return; }
        sources.forEach(source => {
            const card = document.createElement('div'); card.className = 'source-card';
            const sizeGB = (source.size / 1024 / 1024 / 1024).toFixed(2);
            card.innerHTML = `<div class="source-title">${source.title}</div><div class="source-meta"><span>🎬 ${source.indexer}</span><span>💾 ${sizeGB} GB</span><span class="seeders">🌱 ${source.seeders}</span></div>`;
            card.addEventListener('click', () => startStream(source.magnetUrl));
            grid.appendChild(card);
        });
        grid.classList.remove('hidden');
    } catch { loader.innerHTML = '<span style="color:#ff6b6b;"><i class="fa-solid fa-triangle-exclamation"></i> Error querying Prowlarr.</span>'; }
}

// ─── Stream Entry Point ───────────────────────────────────────────────────────
async function startStream(magnetUri, pushToHistory = true) {
    if (pushToHistory) history.pushState({ view: 'player', magnetUri }, 'Playing', '/play');
    detailsView.classList.add('hidden'); historyView.classList.add('hidden');
    playerView.classList.remove('hidden');
    saveToHistory();

    const video = document.getElementById('video-element');
    const overlay = document.getElementById('player-overlay');
    const statusText = document.getElementById('buffer-status-text');
    const pctText = document.getElementById('buffer-percentage');
    const barCont = document.getElementById('buffer-bar-container');
    const barFill = document.getElementById('buffer-bar-fill');

    stopCurrentStream();
    overlay.style.display = 'flex'; overlay.style.opacity = '1';
    statusText.innerText = 'Resolving torrent...';
    pctText.innerText = ''; barCont.style.display = 'none'; barFill.style.width = '0%';

    // Touch video to satisfy iOS Safari autoplay requirement
    video.play().catch(() => { });

    try {
        // Step 1: Resolve magnet
        const magnetData = await (await fetch(`/api/get-magnet?url=${encodeURIComponent(magnetUri)}`)).json();
        if (magnetData.error) throw new Error(magnetData.error);
        const magnet = magnetData.magnetUrl;

        // Step 2: Probe codec with retry (streamer may still be fetching metadata)
        statusText.innerText = 'Checking stream compatibility...';
        const probe = await probeWithRetry(magnet, 6, 5000);
        console.log('[Player] Probe:', probe);

        if (probe.canDirectPlay) {
            startDirectPlay(magnet, video, overlay, statusText, pctText, barCont, barFill);
        } else {
            await startHLSStream(magnet, probe, video, overlay, statusText);
        }
    } catch (err) {
        console.error('[Player] Stream error:', err);
        alert('Failed to start stream: ' + err.message);
        closePlayer();
    }
}

async function probeWithRetry(magnet, maxAttempts, delayMs) {
    const safari = IS_SAFARI ? '1' : '0';
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(`/api/probe?magnet=${encodeURIComponent(magnet)}&safari=${safari}`);
            const data = await res.json();
            if (data.status === 'ready' || data.status === 'error') return data;
            console.log(`[Player] Probe pending (${i + 1}/${maxAttempts})...`);
        } catch (e) { console.warn('[Player] Probe error:', e.message); }
        await new Promise(r => setTimeout(r, delayMs));
    }
    console.warn('[Player] Probe timed out — defaulting to direct play');
    return { status: 'error', canDirectPlay: !IS_SAFARI, codec: 'unknown', container: 'unknown' };
}

// ─── Direct Play ──────────────────────────────────────────────────────────────
function startDirectPlay(magnet, video, overlay, statusText, pctText, barCont, barFill) {
    console.log('[Player] Direct play ✓');
    statusText.innerText = 'Connecting to stream...';
    barCont.style.display = 'block';
    startProgressPolling(magnet, statusText, pctText, barFill);

    video.src = `/api/stream?magnet=${encodeURIComponent(magnet)}`;
    video.load();
    video.play().catch(e => console.warn('Autoplay blocked:', e));

    setupVideoCallbacks(video, overlay, false);
    reportStreamStart(false, 'h264', null);
}

// ─── HLS Transcoded Play ──────────────────────────────────────────────────────
async function startHLSStream(magnet, probe, video, overlay, statusText) {
    console.log(`[Player] HLS transcode — codec:${probe.codec}`);
    statusText.innerText = 'Starting transcoder...';

    const startRes = await fetch('/api/hls/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet, codec: probe.codec, resolution: probe.resolution }),
    });
    if (!startRes.ok) throw new Error('Failed to start HLS transcode');
    const session = await startRes.json();
    activeSessionId = session.sessionId;

    statusText.innerText = 'Waiting for first segments...';

    const playlistUrl = session.playlistUrl;

    // The playlist endpoint long-polls (up to 30s) — we just fire the request and wait
    // Don't set video.src until we know the playlist exists (first fetch will wait on server)

    if (IS_IOS || (IS_SAFARI && video.canPlayType('application/vnd.apple.mpegurl') !== '')) {
        // Safari/iOS: native HLS player — set src directly after playlist is confirmed ready
        console.log('[Player] Native HLS (Safari/iOS)');
        statusText.innerText = 'Preparing stream...';
        // Pre-fetch the playlist (triggers server long-poll — waits until first segment ready)
        const plRes = await fetch(playlistUrl);
        if (!plRes.ok) throw new Error('Transcode failed to produce segments');

        // Setup overlay callbacks BEFORE setting src (fixes mobile overlay blocking player)
        setupVideoCallbacks(video, overlay, true);

        video.src = playlistUrl;
        video.load();
        video.play().catch(e => console.warn('Autoplay blocked:', e));

        // Seek handler for native HLS: restart ffmpeg from the seeked position
        let seekDebounce = null;
        video.onseeking = () => {
            if (!activeSessionId) return;
            clearTimeout(seekDebounce);
            seekDebounce = setTimeout(async () => {
                const seekTime = video.currentTime;
                console.log(`[Player] Safari seek → ${seekTime.toFixed(1)}s`);
                try {
                    await fetch(`/api/hls/seek/${activeSessionId}`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ seekTime }),
                    });
                    // Native player will retry segments automatically after the seek
                } catch (e) { console.warn('[Player] Seek request failed:', e.message); }
            }, 400); // debounce 400ms to avoid mid-scrub requests
        };
    } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        console.log('[Player] hls.js');
        // Destroy existing hls instance first
        if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

        // Setup video callbacks BEFORE attaching hls.js (no cloning!)
        setupVideoCallbacks(video, overlay, true);

        hlsInstance = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 90,
            // Retry aggressively for the first manifest (server long-polls up to 60s)
            manifestLoadingTimeOut: 65000,
            manifestLoadingMaxRetry: 3,
            manifestLoadingRetryDelay: 1000,
            // Retry for segments that haven't been transcoded yet (forward-seeking)
            levelLoadingTimeOut: 65000,
            fragLoadingTimeOut: 65000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
        });

        hlsInstance.loadSource(playlistUrl);
        hlsInstance.attachMedia(video);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('[hls.js] Manifest parsed — starting playback');
            statusText.innerText = 'Buffering...';
            video.play().catch(e => console.warn('Autoplay blocked:', e));
        });

        hlsInstance.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) console.error('[hls.js] Fatal error:', data.type, data.details);
        });

        // Seek handler: restart ffmpeg from seeked position then reload hls.js
        let seekDebounce = null;
        video.onseeking = () => {
            if (!activeSessionId) return;
            clearTimeout(seekDebounce);
            seekDebounce = setTimeout(async () => {
                const seekTime = video.currentTime;
                console.log(`[Player] hls.js seek → ${seekTime.toFixed(1)}s`);
                try {
                    statusText.innerText = 'Seeking...';
                    overlay.style.display = 'flex'; overlay.style.opacity = '1';
                    await fetch(`/api/hls/seek/${activeSessionId}`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ seekTime }),
                    });
                    // Force hls.js to reload from the new position
                    if (hlsInstance) {
                        hlsInstance.stopLoad();
                        hlsInstance.startLoad(seekTime);
                    }
                } catch (e) { console.warn('[Player] Seek request failed:', e.message); }
            }, 400); // debounce 400ms to avoid rapid-fire seeks
        };
    } else {
        throw new Error('HLS not supported on this browser');
    }

    reportStreamStart(true, probe.codec, activeSessionId);
}

// ─── Video Callbacks (no cloning!) ───────────────────────────────────────────
// This stores the current callbacks so they can be replaced without cloning the element
let _videoPlayingHandler = null;
let _videoWaitingHandler = null;
let _videoTimeupdateHandler = null;

function setupVideoCallbacks(video, overlay, isTranscoding) {
    // Remove previous listeners
    if (_videoPlayingHandler) video.removeEventListener('playing', _videoPlayingHandler);
    if (_videoWaitingHandler) video.removeEventListener('waiting', _videoWaitingHandler);
    if (_videoTimeupdateHandler) video.removeEventListener('timeupdate', _videoTimeupdateHandler);

    _videoPlayingHandler = () => {
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 500);
        document.getElementById('buffer-percentage').innerText = '';
        document.getElementById('buffer-bar-container').style.display = 'none';
    };

    _videoWaitingHandler = () => {
        overlay.style.display = 'flex'; overlay.style.opacity = '1';
        document.getElementById('buffer-status-text').innerText = isTranscoding ? 'Buffering (transcoded)...' : 'Buffering from peers...';
    };

    let lastProgressEmit = 0;
    _videoTimeupdateHandler = () => {
        if (socket && video.duration > 0) {
            const now = Date.now();
            if (now - lastProgressEmit > 5000) {
                lastProgressEmit = now;
                socket.emit('update_progress', { progress: (video.currentTime / video.duration) * 100 });
            }
        }
    };

    video.addEventListener('playing', _videoPlayingHandler);
    video.addEventListener('waiting', _videoWaitingHandler);
    video.addEventListener('timeupdate', _videoTimeupdateHandler);

    // Skip controls
    document.getElementById('btn-skip-back').onclick = () => { video.currentTime = Math.max(0, video.currentTime - 10); };
    document.getElementById('btn-skip-forward').onclick = () => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); };
}

// ─── Progress polling (direct play) ───────────────────────────────────────────
function startProgressPolling(magnet, statusText, pctText, barFill) {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(async () => {
        try {
            const data = await (await fetch(`/api/status?magnet=${encodeURIComponent(magnet)}`)).json();
            if (data && typeof data.progress === 'number') {
                const pct = (data.progress * 100).toFixed(1);
                pctText.innerText = `${pct}%`;
                barFill.style.width = `${pct}%`;
                const mbps = (data.downloadSpeed / 1024 / 1024).toFixed(1);
                statusText.innerText = `Buffering: ${mbps} MB/s (${data.numPeers} peers)`;
            }
        } catch { }
    }, 1000);
}

// ─── Admin: report stream start ───────────────────────────────────────────────
function reportStreamStart(transcoding, codec, sessionId) {
    if (!socket) return;
    const title = document.getElementById('detail-title').innerText;
    const ua = navigator.userAgent;
    let device = 'Desktop';
    if (/iPhone/.test(ua)) device = 'iPhone'; else if (/iPad/.test(ua)) device = 'iPad';
    else if (/Android/.test(ua)) device = 'Android'; else if (/Macintosh/.test(ua)) device = 'Mac';
    else if (/Windows/.test(ua)) device = 'Windows';
    socket.emit('start_stream', { user_id: getCookie('jellyfinUser'), title, device });
    socket.emit('update_transcode', { transcoding, codec: codec || 'h264', resolution: '', sessionId });
}

// ─── Stop and cleanup ─────────────────────────────────────────────────────────
function stopCurrentStream() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    if (activeSessionId) { fetch(`/api/hls/stop/${activeSessionId}`, { method: 'POST' }).catch(() => { }); activeSessionId = null; }
    const video = document.getElementById('video-element');
    video.onseeking = null; // clear seek handler
    video.pause(); video.removeAttribute('src'); video.load();
}

function closePlayer() {
    stopCurrentStream();
    if (socket) socket.emit('stop_stream');
    const overlay = document.getElementById('player-overlay');
    overlay.style.display = 'flex'; overlay.style.opacity = '1';
    document.getElementById('buffer-status-text').innerText = 'Buffering from peers...';
    playerView.classList.add('hidden');
}

// ─── Navigation ───────────────────────────────────────────────────────────────
window.addEventListener('popstate', (e) => {
    if (!e.state) return;
    const wasInPlayer = !playerView.classList.contains('hidden');
    if (wasInPlayer && e.state.view !== 'player') closePlayer();
    if (e.state.view === 'search') showSearchView();
    else if (e.state.view === 'details') {
        searchView.classList.add('hidden'); playerView.classList.add('hidden'); historyView.classList.add('hidden');
        detailsView.classList.remove('hidden');
        loadMovieDetails(e.state.id, e.state.mediaType || 'movie', false);
    } else if (e.state.view === 'player' && e.state.magnetUri) startStream(e.state.magnetUri, false);
    else if (e.state.view === 'login') location.reload();
});

document.getElementById('btn-back').addEventListener('click', () => history.back());
document.getElementById('btn-close-player').addEventListener('click', () => { stopCurrentStream(); history.back(); });
document.getElementById('btn-history').addEventListener('click', () => { history.pushState({ view: 'history' }, 'History', '/history'); showHistoryView(); });
document.getElementById('btn-back-history').addEventListener('click', () => history.back());
document.getElementById('btn-back-admin').addEventListener('click', () => history.back());

// ─── Watch History ────────────────────────────────────────────────────────────
async function saveToHistory() {
    const username = getCookie('jellyfinUser');
    if (!username || !currentMovieId) return;
    const title = document.getElementById('detail-title').innerText;
    const posterSrc = document.getElementById('detail-poster').src;
    const rawPath = posterSrc.includes('/w500') ? posterSrc.split('/w500')[1] : posterSrc;
    try {
        await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: username, tmdb_id: currentMovieId, media_type: currentMediaType, title, poster_path: rawPath }) });
    } catch { }
}

async function loadWatchHistory() {
    const grid = document.getElementById('history-grid'); const loader = document.getElementById('history-loader'); const empty = document.getElementById('history-empty');
    grid.innerHTML = ''; grid.classList.add('hidden'); empty.classList.add('hidden'); loader.classList.remove('hidden');
    const username = getCookie('jellyfinUser'); if (!username) return;
    try {
        const data = await (await fetch(`/api/history/${username}`)).json();
        loader.classList.add('hidden');
        if (!data?.length) { empty.classList.remove('hidden'); return; }
        data.forEach(item => {
            const card = document.createElement('div'); card.className = 'source-card'; card.style.cursor = 'pointer';
            const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : 'https://via.placeholder.com/200x300';
            const d = new Date(item.watched_at + 'Z');
            card.innerHTML = `<div style="position:relative;width:100%;aspect-ratio:2/3;margin-bottom:10px;overflow:hidden;border-radius:8px;"><img src="${posterUrl}" style="width:100%;height:100%;object-fit:cover;"></div><div class="source-title" style="text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.title}</div><div class="source-meta" style="justify-content:center;opacity:0.7;"><span>⏳ ${d.toLocaleDateString()}</span></div>`;
            card.addEventListener('click', () => { if (item.media_type === 'movie') loadMovieDetails(item.tmdb_id); });
            grid.appendChild(card);
        });
        grid.classList.remove('hidden');
    } catch { loader.innerHTML = '<span style="color:#ff6b6b;"><i class="fa-solid fa-triangle-exclamation"></i> Error loading history.</span>'; }
}

// ─── Admin Panel ──────────────────────────────────────────────────────────────
let socket = null;
if (typeof io !== 'undefined') {
    socket = io();
    socket.on('active_streams', renderAdminLiveGrid);
    socket.on('remote_action', (data) => {
        const video = document.getElementById('video-element'); if (!video) return;
        if (data.action === 'pause') video.pause();
        else if (data.action === 'stop') document.getElementById('btn-close-player').click();
    });
}
window.emitAdminAction = (socketId, action) => { if (socket) socket.emit('admin_action', { socketId, action }); };

function showAdminView() {
    searchView.classList.add('hidden'); detailsView.classList.add('hidden'); playerView.classList.add('hidden'); historyView.classList.add('hidden');
    document.getElementById('admin-view').classList.remove('hidden'); backdrop.style.backgroundImage = 'none'; loadAdminHistory();
}
document.getElementById('btn-admin').addEventListener('click', () => { history.pushState({ view: 'admin' }, 'Admin', '/admin'); showAdminView(); });
document.getElementById('btn-clear-history').addEventListener('click', async () => { if (confirm('Wipe global watch history?')) { await fetch('/api/admin/history', { method: 'DELETE' }); loadAdminHistory(); } });

async function loadAdminHistory() {
    const grid = document.getElementById('admin-history-grid'); grid.innerHTML = '<p style="color:var(--text-secondary);">Loading...</p>';
    try {
        const data = await (await fetch('/api/admin/history')).json();
        if (!data?.length) { grid.innerHTML = '<p style="color:var(--text-secondary);">No history yet.</p>'; return; }
        grid.innerHTML = data.map(item => {
            const d = new Date(item.watched_at + 'Z');
            return `<div style="background:rgba(255,255,255,0.05);padding:10px;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;"><div><span style="color:var(--accent);font-weight:bold;margin-right:10px;">${item.user_id}</span><span style="color:#fff;">${item.title}</span></div><div style="font-size:0.85rem;color:#888;">${d.toLocaleString()}</div></div>`;
        }).join('');
    } catch { grid.innerHTML = '<span style="color:#ff6b6b;">Error loading history.</span>'; }
}

function renderAdminLiveGrid(streams) {
    const grid = document.getElementById('admin-live-grid'); if (!grid) return;
    if (!streams?.length) { grid.innerHTML = '<p style="color:var(--text-secondary);">No active streams.</p>'; return; }
    grid.innerHTML = '';
    streams.forEach(s => {
        const item = document.createElement('div');
        const minutes = Math.floor((Date.now() - s.startTime) / 60000);
        const prog = s.progress ? s.progress.toFixed(1) : 0;
        const isTC = s.transcoding;
        const modeBadge = isTC
            ? `<span style="background:rgba(255,71,87,0.2);border:1px solid #ff4757;border-radius:10px;padding:2px 8px;font-size:0.72rem;color:#ff6b78;margin-left:8px;"><i class="fa-solid fa-microchip" style="margin-right:4px;"></i>NVENC ${s.codec?.toUpperCase() || ''}</span>`
            : `<span style="background:rgba(35,134,54,0.2);border:1px solid var(--accent);border-radius:10px;padding:2px 8px;font-size:0.72rem;color:#4caf50;margin-left:8px;"><i class="fa-solid fa-play" style="margin-right:4px;"></i>Direct</span>`;
        item.style.cssText = 'background:rgba(255,255,255,0.05);padding:10px;border-radius:8px;border-left:4px solid #ff4757;';
        item.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div>
                    <div style="font-weight:bold;color:#fff;">${s.user_id} <span style="font-size:0.75rem;color:#aaa;">(${s.device || 'Unknown'})</span>${modeBadge}</div>
                    <div style="font-size:0.9rem;color:#aaa;margin-top:4px;">${s.title}</div>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="admin-action-btn" style="font-size:0.8rem;" onclick="window.emitAdminAction('${s.socketId}','pause')"><i class="fa-solid fa-pause"></i> Pause</button>
                    <button class="admin-action-btn" style="font-size:0.8rem;border-color:#ff4757;color:#ff4757;" onclick="window.emitAdminAction('${s.socketId}','stop')"><i class="fa-solid fa-stop"></i> Stop</button>
                </div>
            </div>
            <div style="width:100%;height:4px;background:rgba(255,255,255,0.1);margin-top:12px;margin-bottom:8px;border-radius:2px;overflow:hidden;">
                <div style="width:${prog}%;height:100%;background:#ff4757;transition:width 0.5s;"></div>
            </div>
            <div style="font-size:0.8rem;color:#666;display:flex;justify-content:space-between;"><span>IP: ${s.ip?.replace('::ffff:', '') || '-'}</span><span>${minutes}m ago</span></div>`;
        grid.appendChild(item);
    });
}

// ─── Jellyseerr Request Modal ──────────────────────────────────────────────────
function openRequestModal(data, type) {
    const modal = document.getElementById('request-modal'); modal.classList.remove('hidden');
    document.getElementById('request-modal-title').innerText = type === 'movie' ? 'Request Movie' : 'Request Show';
    document.getElementById('request-item-title').innerText = data.title || data.name;
    document.getElementById('request-poster').src = `https://image.tmdb.org/t/p/w200${data.poster_path}`;
    const profileSelect = document.getElementById('request-profile'); const folderSelect = document.getElementById('request-folder');
    profileSelect.innerHTML = ''; folderSelect.innerHTML = '';
    const config = type === 'movie' ? jellyseerrConfig.radarr : jellyseerrConfig.sonarr;
    if (config) {
        (config.profiles || []).forEach(p => { const s = p.id === config.activeProfileId ? 'selected' : ''; profileSelect.innerHTML += `<option value="${p.id}" ${s}>${p.name}${s ? ' (Default)' : ''}</option>`; });
        (config.rootFolders || []).forEach(f => { const s = f.path === config.activeDirectory ? 'selected' : ''; folderSelect.innerHTML += `<option value="${f.path}" ${s}>${f.path}${s ? ' (Default)' : ''}</option>`; });
    } else { profileSelect.innerHTML = '<option>N/A</option>'; folderSelect.innerHTML = '<option>N/A</option>'; }
    document.getElementById('btn-submit-request').onclick = async () => {
        const btn = document.getElementById('btn-submit-request'); btn.innerText = 'Requesting...'; btn.disabled = true;
        try {
            const payload = { mediaId: data.id, mediaType: type, requestUser: getCookie('jellyfinUser') };
            if (config) { payload.serverId = config.id; payload.profileId = parseInt(profileSelect.value); payload.rootFolder = folderSelect.value; }
            const r = await (await fetch('/api/jellyseerr/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
            if (r.success) {
                modal.classList.add('hidden');
                const rb = document.getElementById('btn-request');
                rb.style.background = '#4a5568'; rb.style.pointerEvents = 'none';
                rb.innerHTML = '<i class="fa-solid fa-check" style="margin-right:12px;font-size:1.2rem;"></i><span>Requested Successfully</span>';
            } else alert('Request failed. ' + (r.error || ''));
        } catch { alert('Request error.'); } finally { btn.innerText = 'Request'; btn.disabled = false; }
    };
    document.getElementById('btn-cancel-request').onclick = () => modal.classList.add('hidden');
    document.getElementById('btn-close-request').onclick = () => modal.classList.add('hidden');
}
