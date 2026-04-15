# File System Access Details

## Server-Side Mapping
- **Absolute Paths**: The application uses a Node.js companion server to bypass browser sandbox limitations. Users provide absolute server-side paths (e.g., `/home/user/Music`) which the backend maps for scanning.
- **Recursive Scanning**: The scanner performs a deep recursive walk of all mapped directories to locate supported audio formats (MP3, FLAC, M4A, WAV, AAC, WMA, etc.).

## Metadata Extraction
- **Server-Side Parsing**: Metadata is extracted directly on the host machine using the `music-metadata` library, ensuring high-speed parsing of ID3v1/v2, Vorbis Comments, and ASF tags.
- **Library Persistence**: Once scanned, metadata and file paths are persisted in **PostgreSQL**. This ensures the library is available instantly across different devices and browser sessions.

## Audio Streaming
- **Adaptive Streaming**: Audio is served via an HLS (HTTP Live Streaming) pipeline, which supports quality switching and efficient seeks.
- **Range Header Support**: For formats not using HLS, the server provides full HTTP `Range` header support for efficient buffering.

## Path Encoding & Database Safety
- **Base64 Storage**: File paths are strictly stored in the PostgreSQL `tracks` table database (`id` and `path` columns) as **Base64 strings** rather than raw UTF-8 text. 
- **Rationale**: Audio collections frequently contain malformed character encodings, multi-byte UTF-8 sequences (e.g., Danish `ø`, em-dashes `—`), or unexpected characters that can cause issues with standard SQL string matching.
- **Raw Buffer Handling**: On the backend, paths are manipulated as **Node.js Buffers** to preserve precisely the bytes present on the file system.
- **Non-ASCII Workaround**: When passing paths to external tools like `ffmpeg` or `extractor.py`, the system creates temporary symlinks in `/tmp/am-*/` with simple ASCII names to ensure compatibility while maintaining a link to the original raw path.
