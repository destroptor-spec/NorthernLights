# Comprehensive Production Setup Guide for Aurora Media Server

This guide focuses on setting up **Aurora Media Server** for production. Designed to be clear for both developers and high-end audio enthusiasts.

## 1. Prerequisites (Core Tools)

Before starting, install these dependencies on your server:

*   **Node.js (v20+):** The primary runtime engine.
*   **Python (3.9 - 3.11):** Required for high-fidelity audio analysis (MusiCNN + EffNet).
*   **FFmpeg:** Essential for audio decoding, HLS transcoding, and analysis.
*   **PostgreSQL Container Runtime:**
    *   **Podman (Recommended):** `sudo apt install podman`
    *   **Docker:** [Download Docker Engine](https://docs.docker.com/engine/install/).
*   **System Utilities:** `curl`, `bzip2`, `tar` (for MBDB taxonomy ingestion).

## 2. Dependency Management

1.  **Node.js Setup:**
    ```bash
    npm install
    npm run build
    ```
2.  **Python ML Setup:**
    Ensure you have `python3-venv` installed, then create the analysis environment:
    ```bash
    python3 -m venv .venv
    source .venv/bin/activate
    pip install tensorflow-cpu essentia numpy
    ```
    *Note: The server will automatically download the required .pb model files (MusiCNN, EffNet) on first run.*

## 3. Deployment (PM2)

We recommend using `pm2` to ensure Aurora stays online and restarts automatically.

1.  **Start the Server:**
    ```bash
    pm2 start "npx tsx server/index.ts" --name aurora
    ```
2.  **Persist Process:** 
    ```bash
    pm2 startup
    pm2 save
    ```

## 4. Hardware Recommendations

The machine-learning pipeline (Discogs-EffNet) is CPU and RAM intensive.

| Library Size | Recommended RAM | CPU Threads |
|---|---|---|
| < 2,000 tracks | 4 GB | 2+ |
| 2,000 - 10,000 tracks | 8 GB | 4+ |
| 10,000+ tracks | 16 GB | 8+ |

> [!IMPORTANT]
> **SWAP Space:** If running on a 4GB VPS, ensure you have at least **4GB of SWAP** enabled to prevent the Python ML workers from being OOM-killed during deep scans.

## 5. First-Launch Checklist

1.  **Database Initializer:** Open `http://your-server:3001` and click **"Create Database"**.
2.  **Setup Wizard:** Create your admin credentials.
3.  **Genre Taxonomy:** Import the MusicBrainz ontology (requires ~5GB temp space).
4.  **Audio Analysis:** In Settings, adjust the **"Audio Analysis Workers"** based on your CPU count. Max workers = faster scans, but higher memory usage.
