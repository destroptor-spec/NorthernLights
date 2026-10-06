/** @jest-environment node */
jest.mock('../database', () => ({ getSystemSetting: jest.fn() }));
import { getSystemSetting } from '../database';
import { SERVER_LOGGING_SETTINGS } from '../../shared/logging';
import { applyLoggingSettings, getLoggingSettings, loadLoggingSettingsFromDB, logScanner, logAnalyzer, logLoudness } from './loggingConfig';

beforeEach(() => {
  applyLoggingSettings(Object.fromEntries(Object.keys(SERVER_LOGGING_SETTINGS).map(key => [key, false])));
  jest.mocked(getSystemSetting).mockReset();
});
afterEach(() => jest.restoreAllMocks());

test('processing channels toggle independently at runtime', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  logScanner('scan'); logAnalyzer('analysis'); logLoudness('loudness');
  expect(log).not.toHaveBeenCalled();
  applyLoggingSettings({ scannerLoggingEnabled: true, loudnessLoggingEnabled: true });
  logScanner('scan'); logAnalyzer('analysis'); logLoudness('loudness');
  expect(log.mock.calls).toEqual([['scan'], ['loudness']]);
  applyLoggingSettings({ scannerLoggingEnabled: false, analyzerLoggingEnabled: true });
  logScanner('scan'); logAnalyzer('analysis');
  expect(log.mock.calls.at(-1)).toEqual(['analysis']);
});

test('reloads saved overrides while leaving unset defaults intact', async () => {
  applyLoggingSettings({ scannerLoggingEnabled: true, analyzerLoggingEnabled: true });
  jest.mocked(getSystemSetting).mockImplementation(async key => key === 'scannerLoggingEnabled' ? false : key === 'loudnessLoggingEnabled' ? true : null);
  await loadLoggingSettingsFromDB();
  expect(getLoggingSettings()).toMatchObject({ scannerLoggingEnabled: false, analyzerLoggingEnabled: true, loudnessLoggingEnabled: true });
});

test('environment defaults are available before the database connects', () => {
  const previous = process.env.LOG_ANALYZER;
  process.env.LOG_ANALYZER = 'true';
  try {
    jest.isolateModules(() => {
      const config: typeof import('./loggingConfig') = require('./loggingConfig');
      expect(config.getLoggingSettings().analyzerLoggingEnabled).toBe(true);
    });
  } finally {
    if (previous === undefined) delete process.env.LOG_ANALYZER;
    else process.env.LOG_ANALYZER = previous;
  }
});
