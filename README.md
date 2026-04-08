# NorthernLights (Aurora Media Server)

A modern, self-hosted web music player built with React, Vite, Tailwind CSS, and Express. Stream your beautifully organized local music library from anywhere over the web.

> 📖 **Deploying to a Server?** Read the comprehensive [Production Setup Guide](docs/production_guide.md) for step-by-step instructions on PM2, Systemd, reverse proxies, and firewall configurations.

## One-Liner Install (Ubuntu/Debian)

Installs everything — Node.js, Podman, FFmpeg, PM2 — and starts the server:

```bash
curl -fsSL https://raw.githubusercontent.com/destroptor-spec/NorthernLights/main/install.sh | bash
```

Then open the URL it prints to finish setup in the browser.

> **Other systems (Fedora, macOS, Windows):** See [Getting Started](#getting-started) below for manual setup.

## Quick Setup (Manual)

If you prefer to install manually or are on a non-Debian system:

Just want the raw commands to get the app running immediately in production?

```bash
git clone https://github.com/destroptor-spec/NorthernLights.git
npm install
cp .env.example .env
npm run build
pm2 start "npx tsx server/index.ts" --name northernlights
# Then open http://<your-server-ip>:3001 to finish setup in the UI Wizard
```

## Features

- **URL-Based Navigation & Deep Linking**: Full React Router integration with meaningful URLs (`/library/artist/:id`, `/library/album/:id`, `/library/genre/:id`). Browser back/forward navigation works natively. Bookmark or share direct links to any artist, album, or genre page.
- **UUID Entity System**: Artists, albums, and genres each have unique UUIDs with proper database tables. Multi-artist tracks (e.g. "Skrillex ft. Metallica") are split into individual artist entities, each with their own page showing where they appear.
- **Modular Settings Architecture**: A fully refactored settings interface deconstructed into domain-specific modules (Account, Library, Database, Playback, AI). Features encapsulated polling and logic instantiation per-tab for optimized performance and a snappier user experience.
- **Reactive Scanner UI**: Real-time library scanning feedback with reactive phase transitions (Walk → Metadata → Analysis). Monitor exactly what the server is processing with zero UI lag, powered by a dedicated SSE status stream.
- **Gapless Playback**: Custom `PlaybackManager` supporting HTTP range requests to seamlessly stream high-quality audio files from your server to your browser.
- **AI-Driven Playlists & Vector Recommendations**: Connect to local or cloud LLMs (like LM Studio or OpenAI) to generate hyper-personalized playlists via natural language. Uses rigorous **21-Dimensional PGVector** similarity searches (**8D acoustic semantic** + 13D Timbre MFCC) and a **Dynamic Hierarchical Genre Taxonomy** imported from **MusicBrainz**. Hierarchical "Hop-Costs" are calculated using Lowest Common Ancestor (LCA) tree traversal for natural sonic progression. Optimized with SQL-side aggregation and BPM-aware rhythm extraction. Fully tunable — adjust playlist diversity, genre coherence, track count, and number of playlists per cycle in Settings.
- **MusicBrainz Integration**: Native support for importing the official MusicBrainz genre ontology (~2,000+ genres). Includes a 3-step categorization pipeline (Direct SQL Match, LLM Batch Processing, and KNN/Artist Fallback) to map your library's tags to a standardized global hierarchy with zero token cost for core traversal.
- **Playlist Management**: Create and delete playlists manually or via AI generation. Drag-and-drop track reordering with persistent queue state. **Pin** AI-generated playlists to protect them from auto-cleanup.
- **Global Search**: Instant search across artists, albums, and tracks with clickable results that navigate directly to entity pages.
- **Advanced Play Queue & Context Menus**: Drag-and-drop track reordering, global "Play Next" and "Add to Playlist" context menus anywhere a track is visible.
- **Rich External Metadata**: Native integrations with the **Last.fm** and **Genius** APIs to automatically fetch missing album artwork, high-resolution artist hero imagery, and rich biographies seamlessly on the frontend.
- **Dynamic User Interface**: Premium "glassy" design system with frosted glass effects and interactive pill buttons. Features a custom **Canvas-based Waveform Progress Bar** that decodes audio peaks on-the-fly.
- **Theme Parity**: Native Light and Dark mode support with carefully tuned contrast and theme-aware UI components.
- **Cross-Device Ready**: Progressive Web App (PWA) compatible with a mobile-first design — edge-to-edge mini player, bottom tab navigation, full-screen Now Playing view with swipe gestures, and safe-area support for notched devices. Desktop keeps the premium floating player pill. **Google Cast (Chromecast)** support for streaming audio to cast devices.
- **Production Secure**: Features path sanitization, express-based security policies, Basic API Authentication, and graceful Database failure handling to safely put your library on the public internet.
- **Universal Format Support**: Native support for **MP3, FLAC, OGG, M4A, AAC, and WAV**. Seamless on-the-fly transcoding for **WMA (Windows Media Audio)** using FFmpeg.


## Tech Stack

### Frontend
- React 18
- Vite
- React Router DOM (URL-based routing)
- Zustand (with Persist Middleware)
- Tailwind CSS & Framer Motion
- Lucide React (Icons)

### Backend
- Node.js & Express
- PostgreSQL (`pg` + `pgvector` via Podman/Docker)
- music-metadata (Tag parsing)
- MusicBrainz (Hierarchical Taxonomy)
- Basic Auth Middleware (Secure streaming)

## Supported Formats

| Format | Support Type | Notes |
| :--- | :--- | :--- |
| **MP3** | Native | Full range/seek support |
| **FLAC** | Native | Lossless, full range/seek support |
| **OGG** | Native | Vorbis/Opus, full range/seek support |
| **M4A / AAC** | Native | Full range/seek support |
| **WAV** | Native | Full range/seek support |
| **WMA** | Transcoded | **Requires FFmpeg** on server. Seek support currently disabled. |


## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- `npm` or `yarn`
- **FFmpeg** (v4.0+ recommended) — *Required for on-the-fly transcoding of non-native formats like WMA.*
- **Podman** or **Docker** — *Required for the automatic PostgreSQL database container. The app auto-detects which is available (Podman preferred).*

### Setup

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd "Music App"
   ```

2. **Database Container:**
   - NorthernLights automatically manages its own PostgreSQL container using Podman or Docker. 
   - No manual setup is required; the server will attempt to connect and start the container automatically on boot. 
   - If the container does not exist, you can create it with a single click in the UI Setup Wizard.

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Configure Environment Variables:**
   - Copy `.env.example` to `.env`
   ```bash
   cp .env.example .env
   ```
   - Edit the `.env` file to set your PostgreSQL connection details and CORS origins.

5. **Running Locally (Development):**
   ```bash
   npm run dev
   ```
   This will concurrently start the Vite frontend server on `http://localhost:3000` and the Express backend on port `3001` (or whichever port specified in `.env`).

6. **First-Time Setup:**
   - Open the app in your browser. The Setup Wizard will guide you through creating your first admin account.
   - After setup, use the Settings gear icon to manage your library, invite users, and configure integrations.

## Settings & Integrations

Once the app is running:
1. Open the **Settings Modal** using the gear icon.
2. Under "Library Paths", enter the absolute path to your music folders on your server/computer to index them.
3. Under "External Providers", input your **Last.fm API Key** and **Genius Access Token** to automatically enrich your artists and genres with high-quality images and bios.

## Deployment

*(See the [Production Setup Guide](docs/production_guide.md) for complete production strategies)*

To safely host NorthernLights on a public domain:
1. Ensure your `.env` contains secure credentials.
2. Ensure `ALLOWED_ORIGINS` in your `.env` lists your public domain URL (e.g., `https://music.yourdomain.com`).
3. Build the frontend:
   ```bash
   npm run build
   ```
   This compiles everything into a `dist/` directory.
4. Serve the application using `pm2` or Docker to keep the Express server running eternally:
   ```bash
   npx tsx server/index.ts
   ```
