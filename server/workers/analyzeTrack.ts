import fs from 'fs';
import { extractAudioFeatures } from '../services/audioExtraction.service';

// Long-running analysis process: reads JSON commands from stdin, outputs results to stdout.
// Protocol: each line on stdin is a JSON object with { id, filePathBase64 }
// Each line on stdout is a JSON object with { id, audioFeatures } or { id, error }

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: { id: string; filePathBase64: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    try {
      const filePathBuf = Buffer.from(msg.filePathBase64, 'base64');
      const audioFeatures = await extractAudioFeatures(filePathBuf);
      process.stdout.write(JSON.stringify({ id: msg.id, audioFeatures }) + '\n');
    } catch (err: any) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: err?.message || String(err) }) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
