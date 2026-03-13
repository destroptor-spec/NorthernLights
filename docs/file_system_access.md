# File System Access Details

## Server-Side Mapping
- **Absolute Paths**: The application uses a Node.js companion server to bypass browser sandbox limitations. Users provide absolute server-side paths (e.g., `/home/user/Music`) which the backend maps for scanning.
- **Recursive Scanning**: The Node server uses `fs.readdir` recursively to traverse directories and locate supported audio formats (MP3, FLAC, M4A, etc.).

## Metadata Extraction
- **Server-Side Parsing**: Metadata is extracted directly on the host machine using libraries like `music-metadata`, which supports ID3, Vorbis, and ASF tags.
- **Library Persistence**: Once scanned, track metadata and absolute paths are persisted in a local `library.db` (SQLite3) file, allowing for instant loading on subsequent app launches.

## Audio Streaming
- **Partial Content**: The server serves audio files via an `/api/stream` endpoint with full support for HTTP `Range` headers, enabling efficient browser-side buffering and random-access seeking.
