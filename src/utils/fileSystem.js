import { openDB } from "idb";
import * as mm from "music-metadata";
import { fromBuffer } from 'strtok3';
// Import format detection and caching utilities
import { detectAudioFormat } from "./metadataFormat";
import { metadataCache } from "./metadataCache";
const DB_NAME = "MusicPlayerDB";
const STORE_NAME = "tracks";
const FOLDERS_STORE = "folders";
async function getDB() {
    return openDB(DB_NAME, 2, {
        upgrade(db, oldVersion) {
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "fileHandle" });
            }
            if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
                // Store directory handles by their unique name or id
                db.createObjectStore(FOLDERS_STORE, { keyPath: "name" });
            }
        },
    });
}
export async function readDirRecursive(dirHandle) {
    const files = [];
    for await (const entry of dirHandle.values()) {
        if (entry.kind === "file") {
            files.push(entry);
        }
        else if (entry.kind === "directory") {
            files.push(...(await readDirRecursive(entry)));
        }
    }
    return files;
}
// Convert ArrayBuffer to base64 string
function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
// Convert base64 string back to Blob
function base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}
// Helper function to detect and skip ID3v2 headers
function findAudioStart(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    // Check for ID3v2 header at the start (ID3v2.2, .3, or .4)
    // ID3v2 signature: "ID3" followed by version bytes
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
        return 0; // No ID3 header
    }
    const majorVersion = bytes[3];
    const minorVersion = bytes[4];
    const flags = bytes[5];
    // Synchsafe encoding: 7 bits per byte (MSB is 0)
    // For ID3v2.3 and v2.4: size bytes 6-9
    // For ID3v2.2: size bytes 6-8 (only 3 bytes)
    let tagSize;
    if (majorVersion === 2) {
        // ID3v2.2 uses 3-byte synchsafe integer
        tagSize = (bytes[6] & 0x7F) << 14 | (bytes[7] & 0x7F) << 7 | (bytes[8] & 0x7F);
    }
    else {
        // ID3v2.3 and ID3v2.4 use 4-byte synchsafe integer
        tagSize = (bytes[6] & 0x7F) << 21 | (bytes[7] & 0x7F) << 14 | (bytes[8] & 0x7F) << 7 | (bytes[9] & 0x7F);
    }
    // Calculate total ID3 header size (header + tag data)
    const headerSize = majorVersion === 2 ? 6 : 10;
    let id3HeaderSize = headerSize + tagSize;
    // Check for extended header (bit 5 of flags)
    if (flags & 0x40) {
        if (majorVersion === 2) {
            // ID3v2.2: extended header size is 1 byte at position 9
            const extendedHeaderSize = bytes[9];
            id3HeaderSize += 1 + extendedHeaderSize;
        }
        else {
            // ID3v2.3/v2.4: extended header size is synchsafe at position 10
            const extendedBytes = new Uint8Array(arrayBuffer, 10, 4);
            const extendedHeaderSize = (extendedBytes[0] & 0x7F) << 21 |
                (extendedBytes[1] & 0x7F) << 14 |
                (extendedBytes[2] & 0x7F) << 7 |
                (extendedBytes[3] & 0x7F);
            id3HeaderSize += 4 + extendedHeaderSize;
        }
    }
    // Check for footer (bit 4 of flags) - only in ID3v2.3 and earlier
    if (flags & 0x20 && majorVersion <= 3) {
        id3HeaderSize += 10; // Footer is 10 bytes
    }
    return id3HeaderSize;
}
export async function extractMetadata(fileHandle) {
    try {
        const file = await fileHandle.getFile();
        // Read the file as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        // Detect audio format from file content
        const firstBytes = new Uint8Array(arrayBuffer.slice(0, 16));
        const detectedFormat = detectAudioFormat(firstBytes);
        // Check cache first using file name as key
        const cachedMetadata = metadataCache.get(file.name);
        let metadata;
        if (cachedMetadata) {
            // Use cached metadata
            metadata = cachedMetadata;
        }
        else {
            // music-metadata-browser has built-in support for ID3v2 in FLAC files
            // First, try parsing with the full buffer - let the library handle ID3 automatically
            const fullTokenizer = fromBuffer(new Uint8Array(arrayBuffer), {
                fileInfo: { mimeType: file.type, size: arrayBuffer.byteLength }
            });
            try {
                metadata = await mm.parseFromTokenizer(fullTokenizer, { duration: true });
            }
            catch (fullParseError) {
                // If full buffer parsing fails, try slicing to skip ID3 header
                console.debug("Full buffer parsing failed, trying sliced buffer:", fullParseError);
                let startIndex = findAudioStart(arrayBuffer);
                // For FLAC files, search for fLaC signature if not found at start
                const first4Bytes = new Uint8Array(arrayBuffer.slice(0, 4));
                const isFlacFile = file.name.toLowerCase().endsWith('.flac') || file.type === 'audio/flac';
                if (isFlacFile && !isFlacStart(first4Bytes)) {
                    // Search for fLaC signature after the ID3 header position
                    for (let i = startIndex; i < arrayBuffer.byteLength - 4; i++) {
                        const dataView = new DataView(arrayBuffer, i, 4);
                        if (dataView.getUint32(0, false) === 0x664C6143) { // "fLaC"
                            startIndex = i;
                            break;
                        }
                    }
                }
                // Parse with sliced buffer as fallback
                const audioData = new Uint8Array(arrayBuffer.slice(startIndex));
                const slicedTokenizer = fromBuffer(audioData, {
                    fileInfo: { mimeType: file.type, size: arrayBuffer.byteLength - startIndex }
                });
                metadata = await mm.parseFromTokenizer(slicedTokenizer, { duration: true });
            }
            // Cache the parsed metadata for future use
            metadataCache.set(file.name, metadata);
        }
        // Extract embedded album art if available
        let artUrl = undefined;
        let pictureData = undefined;
        if (metadata.common.picture && metadata.common.picture.length > 0) {
            const picture = metadata.common.picture[0];
            // Convert Buffer to ArrayBuffer for storage
            const buffer = (typeof SharedArrayBuffer !== 'undefined' && picture.data.buffer instanceof SharedArrayBuffer
                ? new Uint8Array(picture.data).slice().buffer
                : picture.data.buffer.slice(picture.data.byteOffset, picture.data.byteOffset + picture.data.byteLength));
            // Store as base64 for persistence across reloads
            pictureData = {
                data: bufferToBase64(buffer),
                format: picture.format,
            };
            // Also create a blob URL for immediate display
            const blob = new Blob([buffer], { type: picture.format });
            artUrl = URL.createObjectURL(blob);
        }
        return {
            fileHandle,
            title: metadata.common.title,
            artist: metadata.common.artist,
            album: metadata.common.album,
            duration: metadata.format.duration,
            artUrl,
            _pictureData: pictureData,
            // Store detected format for future reference
            _format: detectedFormat,
        }; // Bypass for now, this may be removed entirely soon.
    }
    catch (e) {
        console.warn("Failed to extract metadata for", fileHandle.name, e);
        return null;
    }
}
// Helper function to check if data starts with FLAC signature
function isFlacStart(data) {
    // FLAC signature is "fLaC" (0x66 0x4C 0x61 0x43)
    return data.length >= 4 &&
        data[0] === 0x66 && data[1] === 0x4C &&
        data[2] === 0x61 && data[3] === 0x43;
}
export const importFolderFallback = (onFilesSelected) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.multiple = true;
    input.onchange = (e) => {
        const target = e.target;
        const files = target.files;
        document.body.removeChild(input);
        if (!files)
            return;
        // Convert to array and filter immediately
        const fileArray = Array.from(files).filter(f => f.name.match(/\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i));
        onFilesSelected(fileArray);
    };
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
};
/**
 * Get the detected format for a track (stored in _format property)
 */
export function getTrackFormat(track) {
    return track._format;
}
/**
 * Clear metadata cache (useful when library is rescanned)
 */
export function clearMetadataCache() {
    metadataCache.clear();
}
