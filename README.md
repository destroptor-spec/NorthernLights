# NorthernLights (Aurora Media Server)

A modern, self-hosted web music player built with React, Vite, Tailwind CSS, and Express. Stream your beautifully organized local music library from anywhere over the web.

## Features

- **Blazing Fast Frontend**: Built using React, Vite, and Zustand for state management.
- **Robust Backend**: Node.js & Express server parsing metadata with `music-metadata` and persisting to an SQLite database (`libraryDB`).
- **Gapless Playback**: Custom `PlaybackManager` supporting HTTP range requests to seamlessly stream high-quality audio files from your server to your browser.
- **Dynamic User Interface**: Premium "glassy" design system with frosted glass effects and interactive pill buttons. Features a custom **Canvas-based Waveform Progress Bar** that decodes audio peaks on-the-fly.
- **Rich External Metadata**: Native integrations with the **Last.fm** and **Genius** APIs to automatically fetch missing album artwork, high-resolution artist hero imagery, and rich biographies seamlessly on the frontend.
- **Theme Parity**: Native Light and Dark mode support with carefully tuned contrast and theme-aware UI components.
- **Cross-Device Ready**: Progressive Web App (PWA) compatible with fully responsive layouts down to mobile sizes.
- **Production Secure**: Features path sanitization, express-based security policies, and Basic API Authentication to safely put your library on the public internet.

## Tech Stack

### Frontend
- React 18
- Vite
- Zustand (with Persist Middleware)
- Tailwind CSS & Framer Motion
- Lucide React (Icons)

### Backend
- Node.js & Express
- SQLite3
- music-metadata (Tag parsing)
- Basic Auth Middleware (Secure streaming)

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- `npm` or `yarn`

### Setup

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd "Music App"
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   - Copy `.env.example` to `.env`
   ```bash
   cp .env.example .env
   ```
   - Edit the `.env` file and **change the `VITE_AUTH_PASSWORD` and `AUTH_PASSWORD` variables** to secure your application.

4. **Running Locally (Development):**
   ```bash
   npm run dev
   ```
   This will concurrently start the Vite frontend server on `http://localhost:3000` and the Express backend on port `3001` (or whichever port specified in `.env`).

## Settings & Integrations

Once the app is running:
1. Open the **Settings Modal** using the gear icon.
2. Under "Library Paths", enter the absolute path to your music folders on your server/computer to index them.
3. Under "External Providers", input your **Last.fm API Key** and **Genius Access Token** to automatically enrich your artists and genres with high-quality images and bios.

## Deployment

*(See `docs/deployment.md` or `implementation_plan.md` for complete production strategies)*

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
