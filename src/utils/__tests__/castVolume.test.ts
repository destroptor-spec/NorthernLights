import { CastVolumeGate, HOLD_MS, SEND_INTERVAL_MS } from '../castVolume';

describe('CastVolumeGate', () => {
  let clock = 0;
  let sent: number[];
  let settled: number;
  let gate: CastVolumeGate;

  const advance = (ms: number) => {
    clock += ms;
    jest.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 1_000_000;
    sent = [];
    settled = 0;
    gate = new CastVolumeGate((level) => sent.push(level), () => { settled += 1; }, () => clock);
  });

  afterEach(() => {
    gate.dispose();
    jest.useRealTimers();
  });

  it('sends a single change at once', () => {
    gate.set(0.4);
    expect(sent).toEqual([0.4]);
  });

  it('sends a drag at most every interval, always ending on the last level', () => {
    for (const level of [0.31, 0.32, 0.33, 0.34, 0.35]) {
      gate.set(level);
      advance(20);
    }
    expect(sent).toEqual([0.31]);
    advance(SEND_INTERVAL_MS);
    expect(sent).toEqual([0.31, 0.35]);
  });

  it("ignores the receiver's reports of earlier steps while dragging (the rubberband)", () => {
    gate.set(0.3);
    advance(40);
    gate.set(0.5);
    // The receiver confirms the first step while the second is still on its way.
    expect(gate.receiverReports(0.3)).toBe(false);
    advance(SEND_INTERVAL_MS);
    expect(gate.receiverReports(0.3)).toBe(false);
    expect(gate.receiverReports(0.5)).toBe(false); // its own level: nothing to change
    // Settled: a change from elsewhere (Google Home, the TV remote) shows again.
    expect(gate.receiverReports(0.2)).toBe(true);
    expect(settled).toBe(0);
  });

  it("doesn't take the level while a newer step still waits to be sent", () => {
    gate.set(0.3);
    advance(10);
    gate.set(0.6);
    gate.set(0.3);
    expect(gate.receiverReports(0.3)).toBe(false);
    advance(SEND_INTERVAL_MS);
    expect(sent).toEqual([0.3, 0.3]);
    expect(gate.receiverReports(0.3)).toBe(false);
    expect(gate.receiverReports(0.7)).toBe(true);
  });

  it("hands over the receiver's own level when it never gets there", () => {
    gate.set(0.9);
    expect(gate.receiverReports(0.6)).toBe(false);
    advance(HOLD_MS);
    expect(settled).toBe(1);
    expect(gate.receiverReports(0.6)).toBe(true);
  });

  it('passes everything through when this sender changed nothing', () => {
    expect(gate.receiverReports(0.42)).toBe(true);
    expect(sent).toEqual([]);
  });
});
