import { addToQueueIndex, nextFromLabel, queuedAfterMove, queueSections } from '../queueSections';

// c = context (what was started), q = queued by hand, i = Infinity.
const queue = (spec: string) => spec.split('').map((kind) => ({
  ...(kind === 'q' ? { queued: true } : {}),
  ...(kind === 'i' ? { isInfinity: true } : {}),
}));

describe('queueSections', () => {
  it('splits the upcoming queue: current, queued by hand, the rest, Infinity; played tracks left out', () => {
    // played, played, current, q, q, c, c, i, i
    expect(queueSections(queue('cccqqccii'), 2)).toEqual({
      current: 2, queued: [3, 4], context: [5, 6], infinity: [7, 8],
    });
  });

  it('has no queued section when nothing was queued by hand', () => {
    expect(queueSections(queue('cccc'), 0)).toEqual({ current: 0, queued: [], context: [1, 2, 3], infinity: [] });
  });

  it('keeps play order: Infinity picks before other tracks stay in the rest', () => {
    expect(queueSections(queue('cicc'), 0)).toEqual({ current: 0, queued: [], context: [1, 2, 3], infinity: [] });
  });

  it('with nothing playing, the queued run starts at the top', () => {
    expect(queueSections(queue('qqc'), null)).toEqual({ current: null, queued: [0, 1], context: [2], infinity: [] });
  });
});

describe('addToQueueIndex', () => {
  it('goes behind the tracks queued by hand, before the rest of the album', () => {
    expect(addToQueueIndex(queue('cqqcc'), 0)).toBe(3);
  });
  it('goes right after the current track when nothing is queued', () => {
    expect(addToQueueIndex(queue('cccc'), 1)).toBe(2);
  });
  it('goes to the end of a queue that is all queued tracks', () => {
    expect(addToQueueIndex(queue('cqq'), 0)).toBe(3);
  });
});

describe('queuedAfterMove (the queue after the move)', () => {
  // current at 0, run q q at 1–2, then context.
  it('a track dropped inside the run is queued', () => {
    expect(queuedAfterMove(queue('cqcqcc'), 0, 2, false)).toBe(true);
  });
  it('a track dropped at the top of the run is queued', () => {
    expect(queuedAfterMove(queue('ccqqcc'), 0, 1, false)).toBe(true);
  });
  it('a queued track dragged into the rest is not queued any more', () => {
    expect(queuedAfterMove(queue('cqccqc'), 0, 4, true)).toBe(false);
  });
  it('at the lower edge of the run a track keeps what it was', () => {
    expect(queuedAfterMove(queue('cqqqcc'), 0, 3, true)).toBe(true);
    expect(queuedAfterMove(queue('cqqccc'), 0, 3, false)).toBe(false);
  });
  it('right after the current track with nothing queued, it keeps what it was', () => {
    expect(queuedAfterMove(queue('cccc'), 0, 1, false)).toBe(false);
  });
  it('among the played tracks, nothing is queued', () => {
    expect(queuedAfterMove(queue('qccc'), 1, 0, true)).toBe(false);
  });
});

describe('nextFromLabel', () => {
  it('names the source', () => {
    expect(nextFromLabel({ kind: 'album', name: 'Kid A' }, [])).toBe('Next from: Kid A');
    expect(nextFromLabel({ kind: 'playlist', name: 'Road trip' }, [])).toBe('Next from: Road trip');
    expect(nextFromLabel({ kind: 'radio', name: 'ATB' }, [])).toBe('Next from: ATB radio');
  });
  it('without a name: the album the tracks share, else "Next up"', () => {
    expect(nextFromLabel(null, [{ album: 'Kid A' }, { album: 'Kid A' }])).toBe('Next from: Kid A');
    expect(nextFromLabel({ kind: 'album' }, [{ album: 'Kid A' }, { album: 'Amnesiac' }])).toBe('Next up');
    expect(nextFromLabel(null, [])).toBe('Next up');
  });
});
