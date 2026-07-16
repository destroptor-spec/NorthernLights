jest.mock('./debugLogger.service', () => ({
  writeDebugLog: jest.fn(),
}));

import { logAuthEvent } from './authLog.service';
import { writeDebugLog } from './debugLogger.service';

const mockWriteDebugLog = writeDebugLog as jest.Mock;

describe('logAuthEvent', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    mockWriteDebugLog.mockReset();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('emits one parseable JSON line to console.warn and logs/auth.log for failures', () => {
    logAuthEvent({ event: 'login', outcome: 'bad_password', ip: '1.2.3.4', username: 'andreas' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0];
    expect(JSON.parse(line)).toMatchObject({
      type: 'auth',
      event: 'login',
      outcome: 'bad_password',
      ip: '1.2.3.4',
      username: 'andreas',
    });
    expect(typeof JSON.parse(line).ts).toBe('string');
    expect(mockWriteDebugLog).toHaveBeenCalledWith('auth.log', line);
  });

  it('uses console.log for successes', () => {
    logAuthEvent({ event: 'login', outcome: 'success', ip: '1.2.3.4', username: 'andreas' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('truncates long usernames and drops non-string ones', () => {
    logAuthEvent({ event: 'login', outcome: 'unknown_user', ip: '1.2.3.4', username: 'a'.repeat(300) });
    expect(JSON.parse(warnSpy.mock.calls[0][0]).username).toHaveLength(80);

    logAuthEvent({ event: 'login', outcome: 'unknown_user', ip: '1.2.3.4', username: { evil: true } });
    expect(JSON.parse(warnSpy.mock.calls[1][0]).username).toBeUndefined();
  });

  it('neutralizes newline injection attempts via JSON encoding', () => {
    logAuthEvent({ event: 'login', outcome: 'unknown_user', ip: '1.2.3.4', username: 'a\n{"fake":"line"}' });
    const line = warnSpy.mock.calls[0][0];
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).username).toBe('a\n{"fake":"line"}');
  });

  it('survives a failing log file write', () => {
    mockWriteDebugLog.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => logAuthEvent({ event: 'login', outcome: 'bad_password', ip: '1.2.3.4' })).not.toThrow();
  });
});
