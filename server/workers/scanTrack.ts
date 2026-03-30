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
      const filePathBuf = Buffer.from(msg.filePathBase64, 'base64');
      
      // We must emulate the exact File Buffer Hack used by the original scanner
      // because native music-metadata struggles natively resolving extension off buffers.
      const fileBufHack = Buffer.from(filePathBuf) as any;
      fileBufHack.lastIndexOf = (search: string) => msg.nameStr.lastIndexOf(search);
      fileBufHack.substring = (start: number, end?: number) => msg.nameStr.substring(start, end);
      fileBufHack.toLowerCase = () => msg.nameStr.toLowerCase();

      // Optimize metadata extraction slightly since we only need ID3 tags and not cover images right now
      const metadata = await mm.parseFile(fileBufHack, { skipCovers: true, skipPostHeaders: true });
      
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
            format: metadata.format.container || metadata.format.codec || null
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
