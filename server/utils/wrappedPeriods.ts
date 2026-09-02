// The Wrapped period model: which year/season recaps exist, and when each one
// counts as complete. Pure date arithmetic, deliberately kept out of
// smartHub.service so it can be tested without dragging the DB/LLM import
// graph into the test run.

export type WrappedSeason = 'winter' | 'spring' | 'summer' | 'autumn';

export const WRAPPED_SEASON_LABEL: Record<WrappedSeason, string> = {
  winter: 'Winter', spring: 'Spring', summer: 'Summer', autumn: 'Autumn',
};

export const WRAPPED_SEASONS: readonly WrappedSeason[] = ['winter', 'spring', 'summer', 'autumn'];

export interface WrappedPeriod {
  isYear: boolean;
  suffix: string;         // id suffix: `${year}` or `${year}_${season}`
  title: string;          // "2025 Wrapped" | "Summer 2024"
  descLabel: string;      // "2025" | "summer of 2024"
  startYm: string;        // 'YYYY-MM-01'
  endYmExclusive: string; // 'YYYY-MM-01' (first month AFTER the period)
  limit: number;
  sortKey: number;        // period end (ms), for newest-first ordering
}

export function wrappedYm(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/**
 * 'YYYY-MM-01' → local midnight, in ms.
 *
 * Period bounds are calendar months in the deployment's own timezone — the play
 * buckets are plain DATEs with no zone attached. `new Date('2026-09-01')`
 * parses a date-only string as *UTC* midnight, which is strictly later in
 * absolute time than the same month's local start in any zone east of UTC. Compared
 * against a locally-built month start, that pushed every completed period a
 * full month late there: on UTC+2, Summer 2026 (ending 2026-09-01) wasn't
 * enumerated until 1 October. Zones at or west of UTC happened to compare
 * correctly, which is why it went unnoticed. Build both sides from local
 * components.
 */
export function wrappedYmToLocalMs(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).getTime();
}

export function wrappedSeasonRange(y: number, s: WrappedSeason): { startYm: string; endYmExclusive: string } {
  switch (s) {
    case 'winter': return { startYm: wrappedYm(y - 1, 12), endYmExclusive: wrappedYm(y, 3) }; // Dec(y-1)–Feb(y)
    case 'spring': return { startYm: wrappedYm(y, 3), endYmExclusive: wrappedYm(y, 6) };
    case 'summer': return { startYm: wrappedYm(y, 6), endYmExclusive: wrappedYm(y, 9) };
    case 'autumn': return { startYm: wrappedYm(y, 9), endYmExclusive: wrappedYm(y, 12) };
  }
}

// Every completed year+season period that could hold data, newest-first. A
// period is "complete" once its last month is strictly before the current month.
export function enumerateCompletedWrappedPeriods(now: Date, earliest: Date): WrappedPeriod[] {
  const nowMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const earliestMonthStart = new Date(earliest.getFullYear(), earliest.getMonth(), 1).getTime();
  const out: WrappedPeriod[] = [];

  const consider = (p: Omit<WrappedPeriod, 'sortKey'>) => {
    const endMs = wrappedYmToLocalMs(p.endYmExclusive);
    if (endMs <= nowMonthStart && endMs > earliestMonthStart) {
      out.push({ ...p, sortKey: endMs });
    }
  };

  for (let y = now.getFullYear(); y >= earliest.getFullYear(); y--) {
    consider({
      isYear: true, suffix: String(y), title: `${y} Wrapped`, descLabel: String(y),
      startYm: wrappedYm(y, 1), endYmExclusive: wrappedYm(y + 1, 1), limit: 50,
    });
    for (const s of WRAPPED_SEASONS) {
      const r = wrappedSeasonRange(y, s);
      consider({
        isYear: false, suffix: `${y}_${s}`, title: `${WRAPPED_SEASON_LABEL[s]} ${y}`,
        descLabel: `${WRAPPED_SEASON_LABEL[s].toLowerCase()} of ${y}`,
        startYm: r.startYm, endYmExclusive: r.endYmExclusive, limit: 30,
      });
    }
  }
  out.sort((a, b) => b.sortKey - a.sortKey);
  return out;
}
