const loginView = document.getElementById('login-view');
const searchView = document.getElementById('search-view');
const detailsView = document.getElementById('movie-details-view');
const playerView = document.getElementById('player-view');
const historyView = document.getElementById('history-view');

const searchInput = document.getElementById('movie-search');
const autocompleteDropdown = document.getElementById('autocomplete-results');
const spinner = document.getElementById('search-spinner');
const backdrop = document.getElementById('backdrop');

// --- Authentication & Startup ---
// Cookie Helper Functions
function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        let date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Strict";
}

function getCookie(name) {
    let nameEQ = name + "=";
    let ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

document.addEventListener('DOMContentLoaded', () => {
    const user = getCookie('jellyfinUser');
    if (user) {
        // Already logged in
        showMainApp();
    } else {
        // Force Login
        history.replaceState({ view: 'login' }, "Login", "/");
        loginView.classList.remove('hidden');
        searchView.classList.add('hidden');
    }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-login');
    const errText = document.getElementById('login-error');
    const u = document.getElementById('jellyfin-username').value;
    const p = document.getElementById('jellyfin-password').value;

    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Authenticating...';
    errText.classList.add('hidden');

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });

        if (!res.ok) throw new Error('Invalid credentials');

        const data = await res.json();

        // Ensure user stays logged in for 30 days via cookies
        setCookie('jellyfinUser', data.user.Name, 30);
        if (data.token) setCookie('jellyfinToken', data.token, 30);
        if (data.user && data.user.Id) setCookie('jellyfinUserId', data.user.Id, 30);
        if (data.user && data.user.Policy && data.user.Policy.IsAdministrator) {
            setCookie('isAdmin', 'true', 30);
        }

        showMainApp();
    } catch (err) {
        errText.classList.remove('hidden');
        btn.innerHTML = 'Sign In <i class="fa-solid fa-arrow-right"></i>';
    }
});

document.getElementById('btn-logout').addEventListener('click', () => {
    // Delete cookie by expiring it immediately
    document.cookie = "jellyfinUser=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    document.cookie = "jellyfinToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    document.cookie = "isAdmin=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    location.reload();
});

function showMainApp() {
    loginView.classList.add('hidden');

    if (getCookie('isAdmin') === 'true') {
        document.getElementById('btn-admin').classList.remove('hidden');
    }

    // Load Dynamic UI Elements
    loadNetflixGrid();
    loadTrendingPills();

    // Check current URL to support direct links or reloads
    const path = window.location.pathname;
    if (path.startsWith('/movie/')) {
        const id = path.split('/')[2];
        history.replaceState({ view: 'details', id }, "Movie Details", path);
        loadMovieDetails(id, false);
    } else if (path === '/history') {
        history.replaceState({ view: 'history' }, "Watch History", "/history");
        showHistoryView();
    } else if (path === '/play') {
        history.replaceState({ view: 'search' }, "Search", "/");
        showSearchView();
    } else {
        history.replaceState({ view: 'search' }, "Search", "/");
        showSearchView();
    }
}

function showSearchView() {
    detailsView.classList.add('hidden');
    playerView.classList.add('hidden');
    historyView.classList.add('hidden');
    const adminView = document.getElementById('admin-view');
    if (adminView) adminView.classList.add('hidden');
    searchView.classList.remove('hidden');
    searchInput.value = '';
    backdrop.style.backgroundImage = 'none';
    currentMovieId = null; // reset so revisiting details reloads
}

function showHistoryView() {
    searchView.classList.add('hidden');
    detailsView.classList.add('hidden');
    playerView.classList.add('hidden');
    const adminView = document.getElementById('admin-view');
    if (adminView) adminView.classList.add('hidden');
    historyView.classList.remove('hidden');
    backdrop.style.backgroundImage = 'none';
    loadWatchHistory();
}

let jellyseerrConfig = null; // Global fetch config

// Pre-fetch Jellyseerr configurations on app startup
fetch('/api/jellyseerr/options')
    .then(r => r.json())
    .then(d => { jellyseerrConfig = d; })
    .catch(e => console.error("Jellyseerr init error:", e));

// Global active state tracking
let currentMovieId = null;
let currentMediaType = 'movie'; // 'movie' or 'tv'

// Handle Browser Back/Forward Buttons
window.addEventListener('popstate', (e) => {
    if (!e.state) return;

    // Stop video if leaving player view
    if (!playerView.classList.contains('hidden') && e.state.view !== 'player') {
        const video = document.getElementById('video-element');
        video.pause();
        video.removeAttribute('src');
        video.load();
        playerView.classList.add('hidden');

        if (typeof socket !== 'undefined' && socket) {
            socket.emit('stop_stream');
        }

        // Reset overlay for next time
        const overlay = document.getElementById('player-overlay');
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
    }

    if (e.state.view === 'search') {
        showSearchView();
    } else if (e.state.view === 'details') {
        searchView.classList.add('hidden');
        playerView.classList.add('hidden');
        historyView.classList.add('hidden');
        detailsView.classList.remove('hidden');
        loadMovieDetails(e.state.id, e.state.mediaType || 'movie', false);
    } else if (e.state.view === 'player' && e.state.magnetUri) {
        startStream(e.state.magnetUri, false);
    } else if (e.state.view === 'login') {
        // If user hits back to login screen
        location.reload();
    }
});

async function loadNetflixGrid() {
    const gridContainer = document.getElementById('grid-container');
    try {
        const res = await fetch('/api/grid');
        let posters = await res.json();

        // Duplicate the poster list to ensure it gracefully fills massive viewports
        posters = [...posters, ...posters, ...posters, ...posters];

        // Populate the expanded background grid
        gridContainer.innerHTML = posters.map(url => `<img src="${url}" class="grid-poster">`).join('');
    } catch (e) { console.error('Grid failed:', e); }
}

async function loadTrendingPills() {
    const pillsContainer = document.getElementById('trending-pills');
    try {
        const res = await fetch('/api/trending');
        const trending = await res.json();

        pillsContainer.innerHTML = trending.map(m =>
            `<span class="pill" onclick="searchMovie('${m.title.replace(/'/g, "\\'")}')">${m.title}</span>`
        ).join('');
    } catch (e) { console.error('Pills failed:', e); }
}

// Global hook for pills
window.searchMovie = function (title) {
    searchInput.value = title;
    // Trigger the input event to invoke autocomplete debounce
    searchInput.dispatchEvent(new Event('input'));
};

// Search Input Debouncing & Autocomplete
let timeoutId;
searchInput.addEventListener('input', (e) => {
    clearTimeout(timeoutId);
    const query = e.target.value.trim();

    if (query.length < 3) {
        autocompleteDropdown.classList.add('hidden');
        autocompleteDropdown.innerHTML = '';
        searchInput.placeholder = "Search for a movie...";
        return;
    }

    spinner.classList.remove('hidden');
    searchInput.placeholder = "Searching...";

    timeoutId = setTimeout(() => {
        fetch(`/api/search?q=${encodeURIComponent(query)}`)
            .then(res => res.json())
            .then(results => {
                spinner.classList.add('hidden');
                searchInput.placeholder = "Search for a movie...";
                renderAutocomplete(results);
            })
            .catch(err => {
                console.error(err);
                spinner.classList.add('hidden');
                searchInput.placeholder = "Search for a movie...";
            });
    }, 500); // 500ms debounce
});

function renderAutocomplete(results) {
    autocompleteDropdown.innerHTML = '';

    if (results.length === 0) {
        autocompleteDropdown.innerHTML = '<div class="search-item">No movies found.</div>';
        autocompleteDropdown.classList.remove('hidden');
        return;
    }

    results.slice(0, 5).forEach(m => {
        const item = document.createElement('div');
        item.className = 'search-item';

        const posterUrl = m.poster_path
            ? `https://image.tmdb.org/t/p/w92${m.poster_path}`
            : 'https://via.placeholder.com/92x138?text=No+Poster';

        const rawDate = m.release_date || m.first_air_date || '';
        const year = rawDate ? rawDate.split('-')[0] : 'N/A';
        const title = m.title || m.name;
        const icon = m.media_type === 'tv' ? '<i class="fa-solid fa-tv"></i>' : '<i class="fa-solid fa-film"></i>';

        item.innerHTML = `
            <img src="${posterUrl}" alt="Poster">
            <div class="search-item-info">
                <strong>${title}</strong>
                <span>${icon} ${year} • <i class="fa-solid fa-star text-gold" style="color: #f1c40f; margin-right: 2px;"></i> ${m.vote_average.toFixed(1)}</span>
            </div>
        `;

        item.addEventListener('click', () => loadMovieDetails(m.id, m.media_type));
        autocompleteDropdown.appendChild(item);
    });

    autocompleteDropdown.classList.remove('hidden');
}

// Load Details Page
async function loadMovieDetails(id, mediaType = 'movie', pushHistory = true) {
    if (pushHistory) {
        // Technically URLs could be /tv/id, but /movie/id is legacy compatible in our router block
        history.pushState({ view: 'details', id, mediaType }, "Media Details", `/${mediaType}/${id}`);
    }

    // Hide search view, show details view
    autocompleteDropdown.classList.add('hidden');
    searchView.classList.add('hidden');
    playerView.classList.add('hidden');
    detailsView.classList.remove('hidden');

    if (currentMovieId == id && currentMediaType === mediaType) return; // Already rendered
    currentMovieId = id;
    currentMediaType = mediaType;

    // Reset Details UI
    document.getElementById('sources-grid').classList.add('hidden');
    document.getElementById('sources-loader').classList.remove('hidden');
    document.getElementById('sources-grid').innerHTML = '';

    const tvSection = document.getElementById('tv-season-section');
    tvSection.classList.add('hidden');

    try {
        // Fetch full TMDB info based on media type
        const apiBase = mediaType === 'tv' ? '/api/tv' : '/api/movie';
        const res = await fetch(`${apiBase}/${id}`);
        const data = await res.json();

        // Extract title and year for Prowlarr
        const fetchedTitle = data.title || data.name;
        const fetchedYear = (data.release_date || data.first_air_date || '').split('-')[0];

        // Update UI
        document.getElementById('detail-title').innerText = fetchedTitle;
        document.getElementById('detail-year').innerText = fetchedYear;
        document.getElementById('detail-rating').innerHTML = `<i class="fa-solid fa-star"></i> ${data.vote_average.toFixed(1)}`;
        document.getElementById('detail-overview').innerText = data.overview;

        // Check Jellyfin for deep link
        const jellyfinBtn = document.getElementById('btn-jellyfin');
        const requestBtn = document.getElementById('btn-request');

        if (jellyfinBtn) jellyfinBtn.classList.add('hidden');
        if (requestBtn) requestBtn.classList.add('hidden');

        if (jellyfinBtn) {
            jellyfinBtn.href = "#";
            try {
                // Pass exactly URI encoded TMDB title + Explicit TMDB ID for strict provider matching
                const jfRes = await fetch(`/api/jellyfin/check?title=${encodeURIComponent(fetchedTitle)}&tmdbId=${data.id}`);
                const jfData = await jfRes.json();

                if (jfData.exists && jfData.url) {
                    jellyfinBtn.href = jfData.url;
                    jellyfinBtn.classList.remove('hidden');
                } else if (jellyseerrConfig && jellyseerrConfig.configured && requestBtn) {
                    // Show Jellyseerr Request Button if missing from Jellyfin
                    requestBtn.style.background = '#8b5cf6';
                    requestBtn.style.pointerEvents = 'auto';
                    requestBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up" style="margin-right: 12px; font-size: 1.2rem;"></i> <span id="btn-request-text">${mediaType === 'movie' ? 'Request Movie to H-TV' : 'Request Show to H-TV'}</span>`;
                    requestBtn.classList.remove('hidden');

                    // Attach modal handler
                    requestBtn.onclick = () => openRequestModal(data, mediaType);
                }
            } catch (e) { console.error("Jellyfin check failed:", e); }
        }

        if (data.poster_path) {
            document.getElementById('detail-poster').src = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
        }

        // Set dynamic backdrop High-Res
        if (data.backdrop_path) {
            backdrop.style.backgroundImage = `url(https://image.tmdb.org/t/p/original${data.backdrop_path})`;
        }

        if (mediaType === 'movie') {
            // Background Query Prowlarr instantly for Movies
            fetchSources(fetchedTitle, fetchedYear);
        } else {
            // For TV Shows, populate Seasons, wait for Episode click
            document.getElementById('sources-loader').classList.add('hidden');
            tvSection.classList.remove('hidden');

            const seasonDropdown = document.getElementById('season-selector');
            seasonDropdown.innerHTML = '';

            // Populate Dropdown
            // Omit specials (season 0) if desired, but we'll include all valid seasons
            data.seasons.filter(s => s.season_number > 0).forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.season_number;
                const dateMeta = s.air_date ? ` (${s.air_date.split('-')[0]})` : '';
                opt.innerText = `Season ${s.season_number}${dateMeta}`;
                seasonDropdown.appendChild(opt);
            });

            // Create listener (replace old to avoid duplicates)
            seasonDropdown.onchange = () => {
                loadTvEpisodes(id, seasonDropdown.value, fetchedTitle);
            };

            // Auto-load first Season selected
            if (data.seasons.length > 0) {
                seasonDropdown.onchange();
            }
        }

    } catch (e) {
        console.error(e);
        alert('Failed to load details');
    }
}

async function loadTvEpisodes(tvId, seasonNumber, showTitle) {
    const grid = document.getElementById('episodes-grid');
    grid.classList.add('hidden');
    grid.innerHTML = '<div style="color:var(--text-secondary); width:100%;">Loading episodes...</div>';
    grid.classList.remove('hidden');

    try {
        const res = await fetch(`/api/tv/${tvId}/season/${seasonNumber}`);
        const data = await res.json();

        grid.innerHTML = '';
        data.episodes.forEach(ep => {
            const btn = document.createElement('div');
            btn.className = 'episode-btn';
            btn.innerText = `E${ep.episode_number}`;
            btn.title = ep.name;

            btn.onclick = () => {
                // Remove active class from all
                document.querySelectorAll('.episode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Format query for Prowlarr: "Show Title S01E03"
                const sString = seasonNumber.toString().padStart(2, '0');
                const eString = ep.episode_number.toString().padStart(2, '0');
                const queryStr = `${showTitle} S${sString}E${eString}`;

                document.getElementById('sources-grid').innerHTML = '';
                document.getElementById('sources-grid').classList.add('hidden');
                document.getElementById('sources-loader').classList.remove('hidden');
                fetchSources(queryStr, '');
            };
            grid.appendChild(btn);
        });
    } catch (e) {
        console.error("Failed to load episodes details:", e);
    }
}

async function fetchSources(title, year) {
    const loader = document.getElementById('sources-loader');
    const grid = document.getElementById('sources-grid');

    try {
        const res = await fetch(`/api/torrents?q=${encodeURIComponent(title)}&year=${year}`);
        const sources = await res.json();

        loader.classList.add('hidden');

        if (sources.length === 0) {
            grid.innerHTML = '<p style="grid-column: 1/-1;">No streaming sources found. Try a different release.</p>';
            grid.classList.remove('hidden');
            return;
        }

        sources.forEach(source => {
            const card = document.createElement('div');
            card.className = 'source-card';

            const sizeGB = (source.size / 1024 / 1024 / 1024).toFixed(2);

            card.innerHTML = `
                <div class="source-title">${source.title}</div>
                <div class="source-meta">
                    <span>🎬 ${source.indexer}</span>
                    <span>💾 ${sizeGB} GB</span>
                    <span class="seeders">🌱 ${source.seeders}</span>
                </div>
            `;

            card.addEventListener('click', () => startStream(source.magnetUrl));
            grid.appendChild(card);
        });

        grid.classList.remove('hidden');

    } catch (e) {
        console.error("Prowlarr error:", e);
        loader.innerHTML = '<span style="color: #ff6b6b;"><i class="fa-solid fa-triangle-exclamation"></i> Error querying Prowlarr.</span>';
    }
}

// Start Video Streaming
function startStream(magnetUri, pushHistory = true) {
    if (pushHistory) {
        history.pushState({ view: 'player', magnetUri }, "Playing", `/play`);
    }

    detailsView.classList.add('hidden');
    historyView.classList.add('hidden');
    playerView.classList.remove('hidden');

    // 1. SILENTLY SAVE TO WATCH HISTORY
    saveToHistory();

    const video = document.getElementById('video-element');
    const overlay = document.getElementById('player-overlay');

    // Synchronously "touch" the video element to satisfy iOS Safari click-to-play rules
    video.play().catch(() => { });

    overlay.style.opacity = '1';

    // First, resolve the potential torrent direct-link into a valid Magnet URI
    fetch(`/api/get-magnet?url=${encodeURIComponent(magnetUri)}`)
        .then(res => res.json())
        .then(magnetData => {
            if (magnetData.error) {
                alert(`Error generating magnet: ${magnetData.error}`);
                closePlayer();
                return;
            }
            const finalMagnet = magnetData.magnetUrl;

            // Stream via the Hub's secure Proxy endpoint to avoid HTTPS Mixed-Content blocking
            video.src = `/api/stream?magnet=${encodeURIComponent(finalMagnet)}`;
            video.load();
            video.play().catch(e => console.error("Autoplay prevented:", e));

            video.onplaying = () => {
                overlay.style.opacity = '0';
                setTimeout(() => overlay.style.display = 'none', 500);

                if (typeof socket !== 'undefined' && socket) {
                    const tTitle = document.getElementById('detail-title').innerText;

                    let deviceName = 'Desktop';
                    const ua = navigator.userAgent;
                    if (/iPhone/.test(ua)) deviceName = 'iPhone';
                    else if (/iPad/.test(ua)) deviceName = 'iPad';
                    else if (/Android/.test(ua)) deviceName = 'Android';
                    else if (/Macintosh/.test(ua)) deviceName = 'Mac';
                    else if (/Windows/.test(ua)) deviceName = 'Windows';
                    else if (/Linux/.test(ua)) deviceName = 'Linux';

                    socket.emit('start_stream', { user_id: getCookie('jellyfinUser'), title: tTitle, device: deviceName });
                }
            };

            video.onwaiting = () => {
                overlay.style.display = 'flex';
                overlay.style.opacity = '1';
                overlay.querySelector('p').innerText = "Buffering from peers...";
            };

            video.addEventListener('timeupdate', () => {
                if (typeof socket !== 'undefined' && socket && video.duration > 0) {
                    const pct = (video.currentTime / video.duration) * 100;
                    const now = Date.now();
                    if (!video.lastProgressEmit || now - video.lastProgressEmit > 5000) {
                        video.lastProgressEmit = now;
                        socket.emit('update_progress', { progress: pct });
                    }
                }
            });
        })
        .catch(e => {
            alert('Magnet resolution failed.');
            closePlayer();
        });
}

// Navigation Back Buttons
document.getElementById('btn-back').addEventListener('click', () => {
    history.back();
});

document.getElementById('btn-close-player').addEventListener('click', () => {
    history.back();
});

document.getElementById('btn-history').addEventListener('click', () => {
    history.pushState({ view: 'history' }, "Watch History", "/history");
    showHistoryView();
});

document.getElementById('btn-back-history').addEventListener('click', () => {
    history.back();
});

// --- History API Logic ---
async function saveToHistory() {
    const username = getCookie('jellyfinUser');
    if (!username || !currentMovieId) return;

    const title = document.getElementById('detail-title').innerText;
    const posterSrc = document.getElementById('detail-poster').src;
    let rawPath = posterSrc;
    if (posterSrc.includes('/w500')) rawPath = posterSrc.split('/w500')[1];

    try {
        await fetch('/api/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: username,
                tmdb_id: currentMovieId,
                media_type: currentMediaType,
                title: title,
                poster_path: rawPath
            })
        });
    } catch (e) { console.error("History save failed:", e); }
}

async function loadWatchHistory() {
    const grid = document.getElementById('history-grid');
    const loader = document.getElementById('history-loader');
    const emptyState = document.getElementById('history-empty');

    grid.innerHTML = '';
    grid.classList.add('hidden');
    emptyState.classList.add('hidden');
    loader.classList.remove('hidden');

    const username = getCookie('jellyfinUser');
    if (!username) return;

    try {
        const res = await fetch(`/api/history/${username}`);
        const historyData = await res.json();

        loader.classList.add('hidden');

        if (!historyData || historyData.length === 0) {
            emptyState.classList.remove('hidden');
            return;
        }

        historyData.forEach(item => {
            const card = document.createElement('div');
            card.className = 'source-card';
            card.style.cursor = 'pointer';

            const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : 'https://via.placeholder.com/200x300';
            const dateObj = new Date(item.watched_at + 'Z');

            card.innerHTML = `
                <div style="position:relative; width:100%; aspect-ratio:2/3; margin-bottom: 10px; overflow:hidden; border-radius:8px;">
                     <img src="${posterUrl}" alt="Poster" style="width: 100%; height:100%; object-fit:cover;">
                </div>
                <div class="source-title" style="text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.title}</div>
                <div class="source-meta" style="justify-content:center; opacity:0.7;">
                    <span>⏳ ${dateObj.toLocaleDateString()}</span>
                </div>
            `;

            card.addEventListener('click', () => {
                if (item.media_type === 'movie') {
                    loadMovieDetails(item.tmdb_id);
                }
            });
            grid.appendChild(card);
        });

        grid.classList.remove('hidden');
    } catch (e) {
        console.error("History fetch error:", e);
        loader.innerHTML = '<span style="color: #ff6b6b;"><i class="fa-solid fa-triangle-exclamation"></i> Error loading history.</span>';
    }
}

// Clicking outside dropdown closes it
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
        autocompleteDropdown.classList.add('hidden');
    }
});

// Custom Video Controls
document.getElementById('btn-skip-back').addEventListener('click', () => {
    const video = document.getElementById('video-element');
    video.currentTime = Math.max(0, video.currentTime - 10);
});

document.getElementById('btn-skip-forward').addEventListener('click', () => {
    const video = document.getElementById('video-element');
    video.currentTime = Math.min(video.duration, video.currentTime + 10);
});

// --- ADMIN DASHBOARD LOGIC ---
let socket = null;
if (typeof io !== 'undefined') {
    socket = io();
    socket.on('active_streams', (streams) => {
        renderAdminLiveGrid(streams);
    });
    socket.on('remote_action', (data) => {
        const video = document.getElementById('video-element');
        if (!video) return;
        if (data.action === 'pause') {
            video.pause();
        } else if (data.action === 'stop') {
            video.pause();
            document.getElementById('btn-close-player').click();
        }
    });
}

window.emitAdminAction = function (socketId, action) {
    if (socket) socket.emit('admin_action', { socketId, action });
};

function renderAdminLiveGrid(streams) {
    const grid = document.getElementById('admin-live-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!streams || streams.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-secondary);">No active streams running on the server.</p>';
        return;
    }

    streams.forEach(s => {
        const item = document.createElement('div');
        item.style.background = 'rgba(255,255,255,0.05)';
        item.style.padding = '10px';
        item.style.borderRadius = '8px';
        item.style.borderLeft = '4px solid #ff4757';

        const minutes = Math.floor((Date.now() - s.startTime) / 60000);
        const prog = s.progress ? s.progress.toFixed(1) : 0;

        item.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                    <div style="font-weight:bold; color:#fff;">${s.user_id} <span style="font-size:0.75rem; color:#aaa; font-weight:normal;">(${s.device || 'Unknown'})</span></div>
                    <div style="font-size:0.9rem; color:#aaa;"><i class="fa-solid fa-play" style="font-size:0.7rem; margin-right:5px; color:#ff4757;"></i>${s.title}</div>
                </div>
                <div style="display:flex; gap: 8px;">
                    <button class="admin-action-btn" style="font-size:0.8rem;" onclick="window.emitAdminAction('${s.socketId}', 'pause')"><i class="fa-solid fa-pause"></i> Pause</button>
                    <button class="admin-action-btn" style="font-size:0.8rem; border-color:#ff4757; color:#ff4757;" onclick="window.emitAdminAction('${s.socketId}', 'stop')"><i class="fa-solid fa-stop"></i> Stop</button>
                </div>
            </div>
            
            <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.1); margin-top: 12px; margin-bottom: 8px; border-radius:2px; overflow:hidden;">
                <div style="width: ${prog}%; height: 100%; background: #ff4757; transition: width 0.5s;"></div>
            </div>

            <div style="font-size:0.8rem; color:#666; margin-top:5px; display:flex; justify-content:space-between;">
                <span>IP: ${s.ip.replace('::ffff:', '')}</span>
                <span>${minutes}m ago</span>
            </div>
        `;
        grid.appendChild(item);
    });
}

function showAdminView() {
    searchView.classList.add('hidden');
    detailsView.classList.add('hidden');
    playerView.classList.add('hidden');
    historyView.classList.add('hidden');
    document.getElementById('admin-view').classList.remove('hidden');
    backdrop.style.backgroundImage = 'none';
    loadAdminHistory();
}

document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (confirm("Are you sure you want to completely wipe the global watch history?")) {
        try {
            await fetch('/api/admin/history', { method: 'DELETE' });
            loadAdminHistory();
        } catch (e) {
            console.error('Failed to clear history');
        }
    }
});

async function loadAdminHistory() {
    const grid = document.getElementById('admin-history-grid');
    grid.innerHTML = '<p style="color:var(--text-secondary);">Loading global history...</p>';

    try {
        const res = await fetch('/api/admin/history');
        const data = await res.json();

        grid.innerHTML = '';

        if (!data || data.length === 0) {
            grid.innerHTML = '<p style="color:var(--text-secondary);">No global watch history recorded yet.</p>';
            return;
        }

        data.forEach(item => {
            const row = document.createElement('div');
            row.style.background = 'rgba(255,255,255,0.05)';
            row.style.padding = '10px';
            row.style.borderRadius = '8px';
            row.style.marginBottom = '8px';
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';

            const dateObj = new Date(item.watched_at + 'Z');

            row.innerHTML = `
                <div>
                   <span style="color:var(--accent); font-weight:bold; margin-right:10px;">${item.user_id}</span>
                   <span style="color:#fff;">${item.title}</span>
                </div>
                <div style="font-size:0.85rem; color:#888;">
                   ${dateObj.toLocaleString()}
                </div>
            `;
            grid.appendChild(row);
        });
    } catch (e) {
        console.error("Admin History Fetch Error:", e);
        grid.innerHTML = '<span style="color: #ff6b6b;">Error loading admin history.</span>';
    }
}

document.getElementById('btn-admin').addEventListener('click', () => {
    history.pushState({ view: 'admin' }, "Admin Dashboard", "/admin");
    showAdminView();
});

document.getElementById('btn-back-admin').addEventListener('click', () => {
    history.back();
});

// --- Jellyseerr Request Modal Logic ---
function openRequestModal(data, type) {
    const modal = document.getElementById('request-modal');
    modal.classList.remove('hidden');

    document.getElementById('request-modal-title').innerText = type === 'movie' ? 'Request Movie' : 'Request Show';
    document.getElementById('request-item-title').innerText = data.title || data.name;
    document.getElementById('request-poster').src = `https://image.tmdb.org/t/p/w200${data.poster_path}`;

    const config = type === 'movie' ? jellyseerrConfig.radarr : jellyseerrConfig.sonarr;

    document.getElementById('btn-submit-request').onclick = async () => {
        try {
            document.getElementById('btn-submit-request').innerText = 'Requesting...';
            document.getElementById('btn-submit-request').disabled = true;

            const payload = {
                mediaId: data.id,
                mediaType: type,
                requestUser: getCookie('jellyfinUser')
            };

            if (config) {
                payload.serverId = config.id;
                if (config.activeProfileId !== undefined) payload.profileId = config.activeProfileId;
                if (config.activeDirectory !== undefined) payload.rootFolder = config.activeDirectory;
            }

            const res = await fetch('/api/jellyseerr/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();

            if (result.success) {
                modal.classList.add('hidden');
                const reqBtn = document.getElementById('btn-request');
                reqBtn.style.background = '#4a5568';
                reqBtn.style.pointerEvents = 'none';
                reqBtn.innerHTML = '<i class="fa-solid fa-check" style="margin-right: 12px; font-size: 1.2rem;"></i><span>Requested Successfully</span>';
            } else {
                alert('Request failed. ' + (result.error || 'Overseerr declined interaction.'));
            }
        } catch (e) {
            console.error(e);
            alert('Request error. Service may be unreachable.');
        } finally {
            document.getElementById('btn-submit-request').innerText = 'Request';
            document.getElementById('btn-submit-request').disabled = false;
        }
    };

    // Close Triggers
    document.getElementById('btn-cancel-request').onclick = () => modal.classList.add('hidden');
    document.getElementById('btn-close-request').onclick = () => modal.classList.add('hidden');
}
