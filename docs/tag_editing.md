# Tag Editing
- Use music-metadata-browser for reading tags and jsmediatags for writing tags, or vice versa depending on format support.
- Provide UI modal with fields for common tags (title, artist, album, genre, year, track number).
- For FLAC/ID3 tags, write back to the file using File System Access API if we have a writable handle.
- Use undo stack: keep previous tag values and allow revert.
