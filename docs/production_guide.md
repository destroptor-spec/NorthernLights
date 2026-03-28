# Comprehensive Production Setup Guide for NorthernLights (v3)

This guide focuses on setting up NorthernLights for **Production** (stable, long-term use). We’ve designed this to be clear even if you aren’t a software developer.

## 1. Prerequisites (Tools You'll Need)

Before we start, you need to install a few "helper" programs on your server:

*   **Node.js (v18 or higher):** The engine that runs the app. [Download it here](https://nodejs.org/).
*   **Git:** To download and update the app's code. [Download it here](https://git-scm.com/).
*   **FFmpeg:** Required for non-native audio (like WMA). Install via `sudo apt install ffmpeg` (Linux) or `brew install ffmpeg` (macOS).
*   **Podman or Docker:** For the automatic database.
    *   **Podman (Recommended for Linux):** `sudo apt install podman`
    *   **Docker:** [Download Docker Desktop](https://www.docker.com/products/docker-desktop/).

---

## 2. Downloading & Preparing

1.  **Download the code:**
    ```bash
    git pull
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Configure `.env`:**
    *   Copy `.env.example` to `.env`.
    *   Set `ALLOWED_ORIGINS` to your server's domain or IP (e.g., `http://your-server-ip:3001`).

---

## 3. Building for Production

Unlike development mode, production requires a "Build" step to make the app fast and stable.

```bash
npm run build
```
*What this does:* It takes all the React code and compresses it into a folder called `dist/`. The server will then use this folder to show you the interface.

---

## 4. Running the Server

In production, you want the app to keep running even if you close your terminal. We recommend using `pm2` for this.

1.  **Install PM2 (Process Manager):**
    ```bash
    sudo npm install -g pm2
    ```
2.  **Start the Server:**
    ```bash
    pm2 start "npx tsx server/index.ts" --name northernlights
    ```
3.  **Save the state:**
    ```bash
    pm2 save
    ```

> [!TIP]
> **Prefer Systemd?** If you are on Linux and prefer using `systemd` instead of PM2, go to **Settings > System** in the app. It provides a copy-paste template for a user-level service that handles auto-starting for you.

*What this does:* It starts the "brain" of the app. Because you ran the "build" step earlier, the server will now automatically host the visual interface at your server's address.

---

## 5. Network Access & Security

By default, the built-in server runs on port `3001`. To access the interface from other devices on your network or the internet, you must ensure this port is open on your server's firewall.

*   **Ubuntu/Debian (UFW):** `sudo ufw allow 3001/tcp`
*   **CentOS/RHEL (firewalld):** `sudo firewall-cmd --add-port=3001/tcp --permanent` followed by `sudo firewall-cmd --reload`

> [!TIP]
> **Recommended: Reverse Proxy & HTTPS**
> Exposing Node directly is fine for home networks, but for internet-facing production, we highly recommend putting a **Reverse Proxy** (like Nginx, Caddy, or Cloudflare Tunnels) in front of NorthernLights. This handles secure `https://` connections (SSL) and routes traffic cleanly from standard web ports (80/443) back to port 3001.

---

## 6. First-Time Setup Wizard

Open your browser and go to your server's address (e.g., **`http://your-server-ip:3001`**).

You will first see the **Database Control** screen showing "Database Not Found". This is expected.

1.  **Create the Database:** Click the green **"Create Database"** button. The app will pull the PostgreSQL image and start a container via Podman or Docker. This may take a minute on first run.
2.  **Setup Wizard:** Once the database is online, the app will automatically advance to the Setup Wizard. Create your admin account.
3.  **Add Music:** In Settings (gear icon ⚙️), enter the absolute path to your music folder (e.g., `/home/user/Music`).

---

## 7. Ongoing Maintenance (Updates)

Keeping NorthernLights updated is safe and won't delete your database or user settings. To update to the latest version, go to your app folder and run:

```bash
git pull
npm install
npm run build
pm2 restart northernlights
```
*(If you used the Systemd helper instead of PM2, run `systemctl --user restart aurora.service` instead of the pm2 command.)*

---

## 8. Troubleshooting & Logs

### Viewing Live Logs (Observability)
If the app crashes or isn't behaving as expected, looking at the server logs is the fastest way to find the issue.
*   **PM2 Users:** Run `pm2 logs northernlights` to see a live feed of activity.
*   **Systemd Users:** Run `journalctl --user -u aurora.service -f` to tail the logs.

### "The site is blank or showing directory listing"
*   **Fix:** Ensure you ran `npm run build` in Step 3. The server needs that `dist/` folder to show the UI.

### "CORS Error" or "API Connection Failed"
*   **Fix:** Check your `.env` file. The `ALLOWED_ORIGINS` must match the exact URL you are using to access the app in your browser (including `http://` or `https://`).

### "Database container keeps stopping"
*   **Fix:** Ensure Podman or Docker has enough permissions to create and write to the `./postgres-data` folder in your app directory.

### "Database Error" with no Create button
*   **Fix:** The server can't find Podman or Docker. Install one of them (`sudo apt install podman` or `sudo apt install docker.io`) and restart the app.

### "Out of memory" or server crashing during scans
*   **Cause:** The server runs Node.js, PostgreSQL, and a container runtime simultaneously. 2GB RAM is not enough for all components plus metadata scanning.
*   **Recommended RAM:**

    | Use Case | RAM |
    |---|---|
    | Minimum (small library, no AI) | 4GB |
    | Comfortable (medium library, AI features) | 8GB |
    | Large library (10k+ tracks, AI) | 16GB |

*   **Workaround on low-memory VMs:** Add these to your `.env` to limit resource usage:
    ```bash
    NODE_OPTIONS=--max-old-space-size=512
    SCAN_CONCURRENCY=2
    ```

---

**Need more help?** Check the `README.md` or the [Deployment Docs](file:///home/andreas/VS%20Code/Music%20App/docs/architecture_overview.md).
