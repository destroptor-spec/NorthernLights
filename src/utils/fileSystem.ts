import { openDB } from "idb";
import * as mm from "music-metadata";
import { fromBuffer, type ITokenizerOptions } from 'strtok3';

// Import format detection and caching utilities
import { detectAudioFormat, getParserForFormat } from "./metadataFormat";
import { metadataCache } from "./metadataCache";

// Added type extensions for modern File System Access API methods missing from default dom lib
declare global {
  interface FileSystemHandle {
    queryPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
    requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  }
}

// Type for embedded picture data from music-metadata
interface EmbeddedPicture {
  data: ArrayBuffer;
  format: string;
}

export interface TrackInfo {
  id: string;
  path: string;
  title?: string;
  artist?: string;
  albumArtist?: string;
  artists?: string[] | string;
  album?: string;
  genre?: string;
  duration?: number;
  trackNumber?: number;
  year?: number;
  releaseType?: string;
  isCompilation?: boolean | number;
  bitrate?: number;
  format?: string;
  
  // Entity IDs for navigation
  artistId?: string;
  albumId?: string;
  genreId?: string;
  
  // Legacy / UI fields
  fileHandle?: FileSystemFileHandle;
  url?: string;
  artUrl?: string;
  _pictureData?: { data: string; format: string };
  _format?: string;
  isInfinity?: boolean;
}

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
        db.createObjectStore(FOLDERS_STORE, { keyPath: "name" });
      }
    },
  });
}

export async function readDirRecursive(dirHandle: FileSystemDirectoryHandle): Promise<FileSystemFileHandle[]> {
  const files: FileSystemFileHandle[] = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      files.push(entry as FileSystemFileHandle);
    } else if (entry.kind === "directory") {
      files.push(...(await readDirRecursive(entry as FileSystemDirectoryHandle)));
    }
  }
  return files;
}

// Convert ArrayBuffer to base64 string
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert base64 string back to Blob
function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

// Helper function to detect and skip ID3v2 headers
function findAudioStart(arrayBuffer: ArrayBuffer): number {
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
  let tagSize: number;
  if (majorVersion === 2) {
    // ID3v2.2 uses 3-byte synchsafe integer
    tagSize = (bytes[6] & 0x7F) << 14 | (bytes[7] & 0x7F) << 7 | (bytes[8] & 0x7F);
  } else {
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
    } else {
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

export async function extractMetadata(fileHandle: FileSystemFileHandle): Promise<TrackInfo | null> {
  try {
    const file = await fileHandle.getFile();

    // Read the file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // Detect audio format from file content
    const firstBytes = new Uint8Array(arrayBuffer.slice(0, 16));
    const detectedFormat = detectAudioFormat(firstBytes);

    // Check cache first using file name as key
    const cachedMetadata = metadataCache.get(file.name);
    let metadata: mm.IAudioMetadata;

    if (cachedMetadata) {
      // Use cached metadata
      metadata = cachedMetadata;
    } else {
      // music-metadata-browser has built-in support for ID3v2 in FLAC files
      // First, try parsing with the full buffer - let the library handle ID3 automatically
      const fullTokenizer = fromBuffer(new Uint8Array(arrayBuffer), {
        fileInfo: { mimeType: file.type, size: arrayBuffer.byteLength }
      });

      try {
        metadata = await mm.parseFromTokenizer(fullTokenizer, { duration: true });
      } catch (fullParseError) {
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
    let artUrl: string | undefined = undefined;
    let pictureData: { data: string; format: string } | undefined = undefined;

    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const picture = metadata.common.picture[0];
      // Convert Buffer to ArrayBuffer for storage
      const buffer = (typeof SharedArrayBuffer !== 'undefined' && picture.data.buffer instanceof SharedArrayBuffer
        ? new Uint8Array(picture.data).slice().buffer
        : picture.data.buffer.slice(picture.data.byteOffset, picture.data.byteOffset + picture.data.byteLength)) as ArrayBuffer;

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
    } as unknown as TrackInfo; // Bypass for now, this may be removed entirely soon.
  } catch (e) {
    console.warn("Failed to extract metadata for", fileHandle.name, e);
    return null;
  }
}

// Helper function to check if data starts with FLAC signature
function isFlacStart(data: Uint8Array): boolean {
  // FLAC signature is "fLaC" (0x66 0x4C 0x61 0x43)
  return data.length >= 4 &&
    data[0] === 0x66 && data[1] === 0x4C &&
    data[2] === 0x61 && data[3] === 0x43;
}

export const importFolderFallback = (onFilesSelected: (files: File[]) => void) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.setAttribute('webkitdirectory', '');
  input.setAttribute('directory', '');
  input.multiple = true;

  input.onchange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const files = target.files;
    document.body.removeChild(input);
    if (!files) return;

    // Convert to array and filter immediately
    const fileArray = Array.from(files).filter(f =>
      f.name.match(/\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i)
    );
    onFilesSelected(fileArray);
  };

  input.style.display = 'none';
  document.body.appendChild(input);
  input.click();
};

/**
 * Get the detected format for a track (stored in _format property)
 */
export function getTrackFormat(track: TrackInfo): string | undefined {
  return track._format;
}

/**
 * Clear metadata cache (useful when library is rescanned)
 */
export function clearMetadataCache(): void {
  metadataCache.clear();
}
