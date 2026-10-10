/** @jest-environment node */
jest.mock('./boundedDiagnosticLog', () => ({ BoundedDiagnosticLog: jest.fn().mockImplementation(() => ({ append: jest.fn() })) }));
import { BoundedDiagnosticLog } from './boundedDiagnosticLog';
import { writeHlsServerLog, writeHlsSessionLog } from './debugLogger.service';
import { applyLoggingSettings } from './loggingConfig';

test('file verbosity changes immediately; normal failures and FFmpeg remain independent', () => {
  const append = jest.mocked(BoundedDiagnosticLog).mock.results[0].value.append as jest.Mock;
  append.mockClear();
  applyLoggingSettings({ hlsLoggingEnabled: false, ffmpegLoggingEnabled: false });
  writeHlsServerLog('session failed');
  writeHlsSessionLog('track', '128k', 'aac', 'missing segment');
  writeHlsServerLog('playlist', 'detailed');
  writeHlsSessionLog('track', '128k', 'aac', 'stderr', 'ffmpeg');
  expect(append).toHaveBeenCalledTimes(2);
  applyLoggingSettings({ hlsLoggingEnabled: true });
  writeHlsServerLog('playlist', 'detailed');
  writeHlsSessionLog('track', '128k', 'aac', 'segment', 'detailed');
  writeHlsServerLog('stderr', 'ffmpeg');
  expect(append).toHaveBeenCalledTimes(4);
  applyLoggingSettings({ hlsLoggingEnabled: false, ffmpegLoggingEnabled: true });
  writeHlsServerLog('playlist', 'detailed');
  writeHlsSessionLog('track', '128k', 'aac', 'stderr', 'ffmpeg');
  expect(append).toHaveBeenCalledTimes(5);
});
