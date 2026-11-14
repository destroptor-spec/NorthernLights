/** @jest-environment node */
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../workers/workerLog', () => ({ workerLog: jest.fn() }));
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { extractAudioFeatures } from './audioExtraction.service';

class PythonChild extends EventEmitter {
  killed = false;
  stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: jest.fn((_line: string, _callback: (error?: Error) => void) => true),
  });
  kill = jest.fn(() => { this.killed = true; return true; });
  reply(features: unknown) {
    const call = this.stdin.write.mock.calls.at(-1)!;
    const { id } = JSON.parse(call[0]);
    this.stdout.emit('data', JSON.stringify({ id, audioFeatures: features }) + '\n');
  }
}
const features = () => ({ bpm: 120, acoustic_vector: Array(8).fill(.5), embedding_vector: [1, ...Array(1279).fill(0)], style_scores: Array(400).fill(0.01), analysis_windows: '3x15s@20/50/80%', is_simulated: false, feature_version: 3 });
let children: PythonChild[] = [];
beforeEach(() => {
  children = [];
  jest.mocked(spawn).mockImplementation(() => {
    const child = new PythonChild(); children.push(child);
    return child as unknown as ReturnType<typeof spawn>;
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  children.at(-1)?.emit('exit', 0, null);
  jest.restoreAllMocks();
});

test('valid vectors are returned, malformed or non-finite vectors become explicit fallbacks', async () => {
  const valid = extractAudioFeatures('valid.wav');
  children[0].reply(features());
  await expect(valid).resolves.toMatchObject({ is_simulated: false, feature_version: 3, style_scores: expect.any(Array) });
  for (const invalid of [
    { ...features(), acoustic_vector: [1] },
    { ...features(), embedding_vector: Array(1280).fill(0) },
    { ...features(), bpm: NaN },
    { ...features(), feature_version: 2 },
    { ...features(), style_scores: undefined },
    { ...features(), style_scores: Array(399).fill(0.1) },
    { ...features(), style_scores: [1.5, ...Array(399).fill(0.1)] },
  ]) {
    const result = extractAudioFeatures('bad.wav');
    children[0].reply(invalid);
    await expect(result).resolves.toMatchObject({ is_simulated: true, feature_version: 3, style_scores: null });
  }
});

test('the stored duration reaches the Python job so it can skip ffprobe; the worker gets the models folder', async () => {
  const withDuration = extractAudioFeatures('long.flac', { trackId: 't1', durationSeconds: 241.5 });
  expect(JSON.parse(children[0].stdin.write.mock.calls.at(-1)![0])).toMatchObject({ filePath: 'long.flac', durationSeconds: 241.5 });
  children[0].reply(features());
  await withDuration;
  const withoutDuration = extractAudioFeatures('unknown.flac', { trackId: 't2', durationSeconds: null });
  expect(JSON.parse(children[0].stdin.write.mock.calls.at(-1)![0])).not.toHaveProperty('durationSeconds');
  children[0].reply(features());
  await withoutDuration;
  const args = jest.mocked(spawn).mock.calls[0][1] as string[];
  expect(args.slice(-2)).toEqual(['--worker', expect.stringMatching(/server[\\/]models$/)]);
});

test('input error fails pending work and a delayed exit cannot clobber the replacement worker', async () => {
  const first = extractAudioFeatures('first.wav');
  children[0].stdin.emit('error', new Error('EPIPE'));
  await expect(first).resolves.toMatchObject({ is_simulated: true });
  const second = extractAudioFeatures('second.wav');
  expect(children).toHaveLength(2);
  children[0].emit('exit', 1, null);
  children[1].reply(features());
  await expect(second).resolves.toMatchObject({ is_simulated: false });
});
