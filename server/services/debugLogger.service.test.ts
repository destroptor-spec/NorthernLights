/** @jest-environment node */
jest.mock('./boundedDiagnosticLog', () => ({ BoundedDiagnosticLog: jest.fn().mockImplementation(() => ({ append: jest.fn() })) }));
const serverLogWrite = jest.fn();
jest.mock('./logFiles', () => ({
  logPolicy: { dir: '/tmp/aurora-test-logs', maxFileBytes: 1, keepFiles: 1, retentionMs: 1 },
  logFile: jest.fn(() => ({ write: serverLogWrite })),
}));
import { BoundedDiagnosticLog } from './boundedDiagnosticLog';
import { logFile } from './logFiles';
import { writeHlsServerLog, writeHlsSessionLog } from './debugLogger.service';
import { applyLoggingSettings } from './loggingConfig';

test('file verbosity changes immediately; normal failures and FFmpeg remain independent', () => {
  // hls-server.log goes to its rotating file, session logs to the bounded session folder.
  const sessionAppend = jest.mocked(BoundedDiagnosticLog).mock.results[0].value.append as jest.Mock;
  const writes = () => serverLogWrite.mock.calls.length + sessionAppend.mock.calls.length;
  sessionAppend.mockClear();
  serverLogWrite.mockClear();
  applyLoggingSettings({ hlsLoggingEnabled: false, ffmpegLoggingEnabled: false });
  writeHlsServerLog('session failed');
  writeHlsSessionLog('track', '128k', 'aac', 'missing segment');
  writeHlsServerLog('playlist', 'detailed');
  writeHlsSessionLog('track', '128k', 'aac', 'stderr', 'ffmpeg');
  expect(writes()).toBe(2);
  expect(jest.mocked(logFile)).toHaveBeenCalledWith('hls-server.log');
  applyLoggingSettings({ hlsLoggingEnabled: true });
  writeHlsServerLog('playlist', 'detailed');
  writeHlsSessionLog('track', '128k', 'aac', 'segment', 'detailed');
  writeHlsServerLog('stderr', 'ffmpeg');
  expect(writes()).toBe(4);
  applyLoggingSettings({ hlsLoggingEnabled: false, ffmpegLoggingEnabled: true });
  writeHlsServerLog('playlist', 'detailed');
  writeHlsSessionLog('track', '128k', 'aac', 'stderr', 'ffmpeg');
  expect(writes()).toBe(5);
});
