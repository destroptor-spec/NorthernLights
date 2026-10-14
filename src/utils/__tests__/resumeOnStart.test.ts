import { shouldResumeOnStart } from '../resumeOnStart';

/**
 * Prod 2026-10-14 20:01:13: the phone had been closed while playing; the
 * desktop started playing meanwhile; reopening the phone resumed it there and
 * took playback from the desktop.
 */
describe('shouldResumeOnStart', () => {
  it('resumes as before without sync', async () => {
    const sessionRead = jest.fn(async () => undefined);
    expect(await shouldResumeOnStart({ syncOn: false, sessionRead, anotherDevicePlaying: () => true })).toBe(true);
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it('does not resume while another device plays the session', async () => {
    const log = jest.fn();
    expect(await shouldResumeOnStart({ syncOn: true, sessionRead: async () => undefined, anotherDevicePlaying: () => true, log })).toBe(false);
    expect(log).toHaveBeenCalledWith(false);
  });

  it('resumes when nobody else plays (a reload mid-playback)', async () => {
    expect(await shouldResumeOnStart({ syncOn: true, sessionRead: async () => undefined, anotherDevicePlaying: () => false })).toBe(true);
  });

  it('decides only once the session has been read', async () => {
    let read = false;
    const decided = shouldResumeOnStart({
      syncOn: true,
      sessionRead: () => new Promise((resolve) => setTimeout(() => { read = true; resolve(); }, 10)),
      anotherDevicePlaying: () => read,
    });
    expect(await decided).toBe(false);
  });
});
