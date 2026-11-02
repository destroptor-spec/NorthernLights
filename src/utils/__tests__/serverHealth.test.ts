import { pollDecision, UNREACHABLE_POLLS_BEFORE_NOTICE } from '../serverHealth';

describe('pollDecision', () => {
  it('believes a server that says its database is down at once', () => {
    expect(pollDecision('down', { connected: true, unreachableStreak: 0 }))
      .toEqual({ connected: false, reachable: true, unreachableStreak: 0 });
  });

  it('keeps a connected app as it is through a few polls without an answer', () => {
    // Prod 2026-10-18: two slow health answers put the app on the recovery screen mid-song.
    let state = { connected: true as boolean | null, unreachableStreak: 0 };
    for (let poll = 1; poll < UNREACHABLE_POLLS_BEFORE_NOTICE; poll += 1) {
      const next = pollDecision('unreachable', state);
      expect(next).toMatchObject({ connected: true, reachable: true });
      state = next;
    }
    expect(pollDecision('unreachable', state).reachable).toBe(false);
  });

  it('never reads a server that stops answering as a database outage', () => {
    // Prod 2026-11-02: a one-minute outage in front of the server showed "no database".
    let state = { connected: true as boolean | null, unreachableStreak: 0 };
    for (let poll = 0; poll < UNREACHABLE_POLLS_BEFORE_NOTICE + 5; poll += 1) {
      state = pollDecision('unreachable', state);
      expect(state.connected).toBe(true);
    }
    expect(pollDecision('connected', state)).toEqual({ connected: true, reachable: true, unreachableStreak: 0 });
  });

  it('starts counting again after an answer', () => {
    const afterOne = pollDecision('unreachable', { connected: true, unreachableStreak: 0 });
    const answered = pollDecision('connected', afterOne);
    expect(answered).toEqual({ connected: true, reachable: true, unreachableStreak: 0 });
    expect(pollDecision('unreachable', answered).reachable).toBe(true);
  });

  it('does not wait out the grace polls for an app that was not connected', () => {
    expect(pollDecision('unreachable', { connected: false, unreachableStreak: 0 }))
      .toEqual({ connected: false, reachable: false, unreachableStreak: 1 });
    expect(pollDecision('unreachable', { connected: null, unreachableStreak: 0 }))
      .toEqual({ connected: null, reachable: false, unreachableStreak: 1 });
  });
});
