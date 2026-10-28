// Listen together's words, shared by the store and the UI (no imports, so
// the store can use them without a cycle).

/** "Andreas' Gig", "Bo's Gig": what guests call a shared session (Andreas, 2026-10-29). */
export function sessionTitle(ownerName: string): string {
  return `${ownerName}${/s$/i.test(ownerName) ? "'" : "'s"} Gig`;
}

type Scope = 'transport' | 'queue' | 'replace';

/**
 * The guests' levels, stacked: each includes the ones below it
 * (docs/listen-together.md, Permissions; Andreas, 2026-10-29).
 */
export const GIG_LEVELS: ReadonlyArray<{ level: 1 | 2 | 3; name: string; scopes: Scope[] }> = [
  { level: 1, name: 'Queue Editor', scopes: ['queue'] },
  { level: 2, name: 'Playback Control', scopes: ['queue', 'transport'] },
  { level: 3, name: 'Music Manager', scopes: ['queue', 'transport', 'replace'] },
];

/** The highest level `scopes` fully cover (1 when they cover none). */
export function gigLevelOf(scopes: readonly string[] | null | undefined): 1 | 2 | 3 {
  let found: 1 | 2 | 3 = 1;
  for (const { level, scopes: needed } of GIG_LEVELS) if (needed.every((scope) => scopes?.includes(scope))) found = level;
  return found;
}

/** What screen readers hear for a preview's avatars: no guest names. */
export function previewLabel(ownerName: string, guests: number): string {
  if (guests === 0) return ownerName;
  return `${ownerName} and ${guests} ${guests === 1 ? 'other' : 'others'}`;
}
