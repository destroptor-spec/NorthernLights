import { buildPenaltyIds } from './recommendation.service';

/**
 * `buildPenaltyIds` unions two different concerns, and the distinction is the
 * point: recent *heard* history is relaxable (the engine halves penaltySize on
 * each failed attempt to widen the pool), while tracks the caller already has
 * queued but unheard are not — widening the pool is useful, re-recommending
 * something already in the queue never is.
 */
describe('buildPenaltyIds', () => {
  const history = ['h1', 'h2', 'h3', 'h4', 'h5'];

  it('takes the most recent slice of history', () => {
    expect(buildPenaltyIds(history, 2)).toEqual(['h4', 'h5']);
  });

  // slice(-0) returns the whole array, so a penaltySize of 0 previously applied
  // the maximum penalty instead of none — inverting the relaxation exactly when
  // the engine was trying to widen its search.
  it('treats a penaltySize of zero as no history penalty, not total penalty', () => {
    expect(buildPenaltyIds(history, 0)).toEqual([]);
    expect(buildPenaltyIds(history, 0, ['q1'])).toEqual(['q1']);
  });

  it('survives the relaxation loop halving down to zero', () => {
    let penaltySize = 4;
    const seen: string[][] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      seen.push(buildPenaltyIds(history, penaltySize, ['q1', 'q2']));
      penaltySize = Math.max(0, Math.floor(penaltySize / 2));
    }
    // History shrinks as intended...
    expect(seen[0]).toEqual(['h2', 'h3', 'h4', 'h5', 'q1', 'q2']);
    expect(seen[1]).toEqual(['h4', 'h5', 'q1', 'q2']);
    expect(seen[2]).toEqual(['h5', 'q1', 'q2']);
    // ...and the queued exclusions are present in every attempt.
    for (const ids of seen) expect(ids).toEqual(expect.arrayContaining(['q1', 'q2']));
  });

  it('unions exclusions with history and de-duplicates the overlap', () => {
    expect(buildPenaltyIds(history, 2, ['h5', 'q1'])).toEqual(['h4', 'h5', 'q1']);
  });

  it('handles an empty history and absent exclusions', () => {
    expect(buildPenaltyIds([], 50)).toEqual([]);
    expect(buildPenaltyIds([], 50, [])).toEqual([]);
    expect(buildPenaltyIds([], 0, ['q1', 'q1'])).toEqual(['q1']);
  });

  it('does not mutate its inputs', () => {
    const h = [...history];
    const ex = ['q1'];
    buildPenaltyIds(h, 3, ex);
    expect(h).toEqual(history);
    expect(ex).toEqual(['q1']);
  });
});
