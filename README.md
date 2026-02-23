# StreamHub 🎬
A beautiful, Google-style movie search interface that streams high-quality WebTorrents seamlessly. 

## Features
- **Netflix-style Dynamic Grid:** Auto-updates with trending movies.
- **Glassmorphic UI:** Smooth animations, pill-shaped buttons, and responsive design.
- **SPA Routing:** Seamless browser back/forward navigation using History API.
- **Advanced Player:** Native HTML5 streaming with custom +10s / -10s skip controls.
- **Auto-Cleanup:** Inactive streams are automatically killed and wiped from the server to save disk space.

---

## 🚀 Deployment (Docker & Portainer)

The easiest way to deploy the UI Hub is via Docker. Machine A (The Hub) pulls the image directly from the GitHub Container Registry.

### 1. Prerequisites
- Docker and Docker-Compose installed on Machine A.
- Portainer installed on Machine A (optional, but recommended).
- Prowlarr running locally for torrent search.
- Machine B (Windows) running the `streamer/start.bat` script.

### 2. Deploy via Portainer
1. Open your Portainer Web UI.
2. Go to **Stacks** > **Add stack**.
3. Name it `streamhub`.
4. Choose **Web editor**.
5. Copy and paste the following `docker-compose.yml`:

```yaml
version: '3.8'

services:
  hub:
    image: ghcr.io/svijaymohan745/streamhub:latest
    container_name: streamhub-ui
    ports:
      - "3000:3000"
    environment:
      - TMDB_API_KEY=${TMDB_API_KEY}
      - PROWLARR_URL=${PROWLARR_URL}
      - PROWLARR_API_KEY=${PROWLARR_API_KEY}
      - STREAMER_URL=${STREAMER_URL}
    restart: unless-stopped
```

6. In the **Environment variables** section below the editor, add the required keys:
   - `TMDB_API_KEY` (Your TMDB v3 Key)
   - `PROWLARR_URL` (e.g., `http://192.168.1.10:9696`)
   - `PROWLARR_API_KEY` (Your Prowlarr API Key)
   - `STREAMER_URL` (e.g., `http://192.168.1.15:6987` - The IP of Machine B running the Streamer)
7. Click **Deploy the stack**. 

### 3. Deploy via Command Line (Standard Docker-Compose)
If you aren't using Portainer, you can simply run it from the command line:

1. Create a directory named `streamhub` and enter it.
2. Create a `docker-compose.yml` file with the content above.
3. Create a `.env` file based on the sample:
   ```env
   TMDB_API_KEY=your_key
   PROWLARR_URL=http://your_prowlarr_ip:9696
   PROWLARR_API_KEY=your_key
   STREAMER_URL=http://your_windows_machine_ip:6987
   ```
4. Run `docker-compose up -d`.

### 💻 Machine B Setup (The WebTorrent Streamer)
*Machine B handles downloading the torrent over the VPN and streaming the file bytes down to the Hub's frontend player.*

1. Install Node.js on the Windows VPN machine.
2. Copy the `streamer` folder to that machine.
3. Run `npm install` inside the folder.
4. Run `start.bat`.
5. Note the IP Address of Machine B. This goes in your `STREAMER_URL` environment variable for the Hub.
