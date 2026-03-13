import * as mm from "music-metadata";
import { fromBuffer, type ITokenizerOptions } from 'strtok3';

// Metadata format detection and parsing for different audio formats

/**
 * File signature (magic numbers) for various audio formats
 */
const FILE_SIGNATURES = {
  FLAC: [0x66, 0x4C, 0x61, 0x43],      // "fLaC"
  MP3: [0x49, 0x44, 0x33],             // "ID3" or frame sync: 0xFF 0xFB / 0xFF 0xF3
  WMA: [0x30, 0x26, 0xB2, 0x75],       // ASF header signature
  OGG: [0x4F, 0x67, 0x67, 0x53],       // "OggS"
  WAV: [0x52, 0x49, 0x46, 0x46],       // "RIFF"
  AAC: [0xFF, 0xF1],                     // ADTS header (first frame)
  M4A: [0x66, 0x74, 0x79, 0x70],       // "ftyp" (ISO base media file format)
} as const;

/**
 * Detect audio format from file content
 */
export function detectAudioFormat(data: Uint8Array): 'FLAC' | 'MP3' | 'WMA' | 'OGG' | 'WAV' | 'AAC' | 'M4A' | 'unknown' {
  if (data.length < 4) return 'unknown';

  // Check FLAC signature at start
  if (data[0] === FILE_SIGNATURES.FLAC[0] &&
    data[1] === FILE_SIGNATURES.FLAC[1] &&
    data[2] === FILE_SIGNATURES.FLAC[2] &&
    data[3] === FILE_SIGNATURES.FLAC[3]) {
    return 'FLAC';
  }

  // Check MP3 ID3v2 header at start
  if (data[0] === FILE_SIGNATURES.MP3[0] &&
    data[1] === FILE_SIGNATURES.MP3[1] &&
    data[2] === FILE_SIGNATURES.MP3[2]) {
    return 'MP3';
  }

  // Check for MP3 frame sync (0xFF 0xFB, 0xFF 0xF3, etc.)
  if (data.length >= 2 && (data[0] & 0xFF) === 0xFF && ((data[1] >> 4) === 0x0F || (data[1] >> 4) === 0x03)) {
    return 'MP3';
  }

  // Check WMA/ASF signature
  if (data[0] === FILE_SIGNATURES.WMA[0] &&
    data[1] === FILE_SIGNATURES.WMA[1] &&
    data[2] === FILE_SIGNATURES.WMA[2] &&
    data[3] === FILE_SIGNATURES.WMA[3]) {
    return 'WMA';
  }

  // Check OGG signature
  if (data[0] === FILE_SIGNATURES.OGG[0] &&
    data[1] === FILE_SIGNATURES.OGG[1] &&
    data[2] === FILE_SIGNATURES.OGG[2] &&
    data[3] === FILE_SIGNATURES.OGG[3]) {
    return 'OGG';
  }

  // Check WAV/RIFF signature
  if (data[0] === FILE_SIGNATURES.WAV[0] &&
    data[1] === FILE_SIGNATURES.WAV[1] &&
    data[2] === FILE_SIGNATURES.WAV[2] &&
    data[3] === FILE_SIGNATURES.WAV[3]) {
    return 'WAV';
  }

  // Check M4A/MP4 signature
  if (data[0] === FILE_SIGNATURES.M4A[0] &&
    data[1] === FILE_SIGNATURES.M4A[1] &&
    data[2] === FILE_SIGNATURES.M4A[2] &&
    data[3] === FILE_SIGNATURES.M4A[3]) {
    return 'M4A';
  }

  // Check AAC ADTS header (typically not at start for streams, but check anyway)
  if (data.length >= 2 && (data[0] & 0xFF) === 0xFF && (data[1] >> 4) === 0x0F) {
    return 'AAC';
  }

  return 'unknown';
}

/**
 * Extract metadata from FLAC files using Vorbis Comments
 * FLAC uses OGG container with Vorbis comments for metadata
 */
export async function parseFlacMetadata(arrayBuffer: ArrayBuffer): Promise<mm.IAudioMetadata> {
  const tokenizer = fromBuffer(new Uint8Array(arrayBuffer), { fileInfo: { size: arrayBuffer.byteLength } });
  return await mm.parseFromTokenizer(tokenizer, { duration: true });
}

/**
 * Extract metadata from MP3 files (ID3 tags)
 */
export async function parseMp3Metadata(arrayBuffer: ArrayBuffer): Promise<mm.IAudioMetadata> {
  const tokenizer = fromBuffer(new Uint8Array(arrayBuffer), { fileInfo: { size: arrayBuffer.byteLength } });
  return await mm.parseFromTokenizer(tokenizer, { duration: true });
}

/**
 * Extract metadata from WMA files (ASF format)
 * WMA uses Advanced Systems Format with proprietary metadata tags
 */
export async function parseWmaMetadata(arrayBuffer: ArrayBuffer): Promise<mm.IAudioMetadata> {
  const tokenizer = fromBuffer(new Uint8Array(arrayBuffer), { fileInfo: { size: arrayBuffer.byteLength } });
  return await mm.parseFromTokenizer(tokenizer, { duration: true });
}

/**
 * Extract metadata from OGG files (Vorbis comments)
 */
export async function parseOggMetadata(arrayBuffer: ArrayBuffer): Promise<mm.IAudioMetadata> {
  const tokenizer = fromBuffer(new Uint8Array(arrayBuffer), { fileInfo: { size: arrayBuffer.byteLength } });
  return await mm.parseFromTokenizer(tokenizer, { duration: true });
}

/**
 * Extract metadata from WAV files
 */
export async function parseWavMetadata(arrayBuffer: ArrayBuffer): Promise<mm.IAudioMetadata> {
  const tokenizer = fromBuffer(new Uint8Array(arrayBuffer), { fileInfo: { size: arrayBuffer.byteLength } });
  return await mm.parseFromTokenizer(tokenizer, { duration: true });
}

/**
 * Extract metadata from M4A/MP4 files
 */
export async function parseM4aMetadata(arrayBuffer: ArrayBuffer): Promise<mm.IAudioMetadata> {
  const tokenizer = fromBuffer(new Uint8Array(arrayBuffer), { fileInfo: { size: arrayBuffer.byteLength } });
  return await mm.parseFromTokenizer(tokenizer, { duration: true });
}

/**
 * Extract metadata from AAC files
 */
export async function parseAacMetadata(arrayBuffer: ArrayBuffer): Promise<mm.IAudioMetadata> {
  const tokenizer = fromBuffer(new Uint8Array(arrayBuffer), { fileInfo: { size: arrayBuffer.byteLength } });
  return await mm.parseFromTokenizer(tokenizer, { duration: true });
}

/**
 * Format-specific metadata parser mapping
 */
export const FORMAT_PARSERS: Record<string, (buffer: ArrayBuffer) => Promise<mm.IAudioMetadata>> = {
  FLAC: parseFlacMetadata,
  MP3: parseMp3Metadata,
  WMA: parseWmaMetadata,
  OGG: parseOggMetadata,
  WAV: parseWavMetadata,
  M4A: parseM4aMetadata,
  AAC: parseAacMetadata,
};

/**
 * Get parser for a given format
 */
export function getParserForFormat(format: string): (buffer: ArrayBuffer) => Promise<mm.IAudioMetadata> | undefined {
  return FORMAT_PARSERS[format];
}
