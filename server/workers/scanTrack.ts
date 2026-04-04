import * as mm from 'music-metadata';

// Protocol: Each line on stdin: { id, filePathBase64, nameStr }
// Each line on stdout: { id, metadata: { ... } } or { id, error }

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: { id: string; filePathBase64: string; nameStr: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    try {
      const utf8Path = Buffer.from(msg.filePathBase64, 'base64').toString('utf8');

      // parseFile() accepts a plain string path — no Buffer hacks needed.
      const metadata = await mm.parseFile(utf8Path, { skipCovers: true, skipPostHeaders: true });
      
      process.stdout.write(JSON.stringify({ 
        id: msg.id, 
        metadata: {
            artist: metadata.common.artist || metadata.common.albumartist || null,
            albumartist: metadata.common.albumartist || null,
            title: metadata.common.title || null,
            artists: metadata.common.artists || null,
            album: metadata.common.album || null,
            genre: metadata.common.genre || null,
            duration: metadata.format.duration || 0,
            trackNumber: metadata.common.track.no || null,
            year: metadata.common.year || null,
            releaseType: metadata.common.releasetype ? metadata.common.releasetype[0] : null,
            isCompilation: metadata.common.compilation || false,
            bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
            format: metadata.format.container || metadata.format.codec || null,
            isrc: metadata.common.isrc?.[0] || null,
            mbRecordingId: metadata.common.musicbrainz_recordingid || null,
            mbTrackId: metadata.common.musicbrainz_trackid || null,
            mbAlbumId: metadata.common.musicbrainz_albumid || null,
            mbArtistId: Array.isArray(metadata.common.musicbrainz_artistid) ? metadata.common.musicbrainz_artistid[0] : (metadata.common.musicbrainz_artistid || null),
            mbAlbumArtistId: Array.isArray(metadata.common.musicbrainz_albumartistid) ? metadata.common.musicbrainz_albumartistid[0] : (metadata.common.musicbrainz_albumartistid || null),
            mbReleaseGroupId: metadata.common.musicbrainz_releasegroupid || null,
            mbWorkId: metadata.common.musicbrainz_workid || null
        }
      }) + '\n');
    } catch (err: any) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: err?.message || String(err) }) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
