// DOM Elements
const loginView = document.getElementById('login-view');
const searchView = document.getElementById('search-view');
const detailsView = document.getElementById('movie-details-view');
const playerView = document.getElementById('player-view');

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

        showMainApp();
    } catch (err) {
        errText.classList.remove('hidden');
        btn.innerHTML = 'Sign In <i class="fa-solid fa-arrow-right"></i>';
    }
});

document.getElementById('btn-logout').addEventListener('click', () => {
    // Delete cookie by expiring it immediately
    document.cookie = "jellyfinUser=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    location.reload();
});

function showMainApp() {
    loginView.classList.add('hidden');

    // Load Dynamic UI Elements
    loadNetflixGrid();
    loadTrendingPills();

    // Check current URL to support direct links or reloads
    const path = window.location.pathname;
    if (path.startsWith('/movie/')) {
        const id = path.split('/')[2];
        history.replaceState({ view: 'details', id }, "Movie Details", path);
        loadMovieDetails(id, false);
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
    searchView.classList.remove('hidden');
    searchInput.value = '';
    backdrop.style.backgroundImage = 'none';
    currentMovieId = null; // reset so revisiting details reloads
}

// Global active state tracking
let currentMovieId = null;

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
        detailsView.classList.remove('hidden');
        loadMovieDetails(e.state.id, false);
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

    results.slice(0, 5).forEach(movie => {
        const item = document.createElement('div');
        item.className = 'search-item';

        // TMDB Image Base URL
        const posterUrl = movie.poster_path
            ? `https://image.tmdb.org/t/p/w92${movie.poster_path}`
            : 'https://via.placeholder.com/92x138?text=No+Poster';

        const year = movie.release_date ? movie.release_date.split('-')[0] : 'N/A';

        item.innerHTML = `
            <img src="${posterUrl}" alt="Poster">
            <div class="search-item-info">
                <strong>${movie.title}</strong>
                <span>${year} • <i class="fa-solid fa-star text-gold" style="color: #f1c40f; margin-right: 2px;"></i> ${movie.vote_average.toFixed(1)}</span>
            </div>
        `;

        item.addEventListener('click', () => loadMovieDetails(movie.id));
        autocompleteDropdown.appendChild(item);
    });

    autocompleteDropdown.classList.remove('hidden');
}

// Load Details Page
async function loadMovieDetails(id, pushHistory = true) {
    if (pushHistory) {
        history.pushState({ view: 'details', id }, "Movie Details", `/movie/${id}`);
    }

    // Hide search view, show details view
    autocompleteDropdown.classList.add('hidden');
    searchView.classList.add('hidden');
    playerView.classList.add('hidden');
    detailsView.classList.remove('hidden');

    if (currentMovieId == id) return; // Already rendered this movie
    currentMovieId = id;

    // Reset Details UI
    document.getElementById('sources-grid').classList.add('hidden');
    document.getElementById('sources-loader').classList.remove('hidden');
    document.getElementById('sources-grid').innerHTML = '';

    try {
        // Fetch full TMDB info
        const res = await fetch(`/api/movie/${id}`);
        const data = await res.json();

        // Extract title and year for Prowlarr
        const fetchedTitle = data.title;
        const fetchedYear = data.release_date ? data.release_date.split('-')[0] : '';

        // Update UI
        document.getElementById('detail-title').innerText = fetchedTitle;
        document.getElementById('detail-year').innerText = fetchedYear;
        document.getElementById('detail-rating').innerHTML = `<i class="fa-solid fa-star"></i> ${data.vote_average.toFixed(1)}`;
        document.getElementById('detail-overview').innerText = data.overview;

        if (data.poster_path) {
            document.getElementById('detail-poster').src = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
        }

        // Set dynamic backdrop High-Res
        if (data.backdrop_path) {
            backdrop.style.backgroundImage = `url(https://image.tmdb.org/t/p/original${data.backdrop_path})`;
        }

        // Now Background Query Prowlarr
        fetchSources(fetchedTitle, fetchedYear);

    } catch (e) {
        console.error(e);
        alert('Failed to load movie details');
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
            grid.innerHTML = '<p style="grid-column: 1/-1;">No streaming sources found on Prowlarr. Try a different release.</p>';
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
    playerView.classList.remove('hidden');

    const video = document.getElementById('video-element');
    const overlay = document.getElementById('player-overlay');

    // We get the Machine B IP from the same host, but wait, the video src needs the raw URL.
    // The cleanest way is Machine A provides an endpoint that redirects, or returns the IP.
    // We'll fetch the streamer IP from an endpoint we will add to the Hub quickly.

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
            video.play().catch(e => console.error("Autoplay prevented:", e));

            video.onplaying = () => {
                overlay.style.opacity = '0';
                setTimeout(() => overlay.style.display = 'none', 500);
            };

            video.onwaiting = () => {
                overlay.style.display = 'flex';
                overlay.style.opacity = '1';
                overlay.querySelector('p').innerText = "Buffering from peers...";
            };
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
