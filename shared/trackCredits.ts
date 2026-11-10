// Order of credit roles wherever a track's credits are listed (the track
// menu's credits panel, "Aurora rays from {title}"). Roles not listed follow
// in the order they come.
export const CREDIT_ROLE_ORDER = [
  // The billed artists of the track ("A feat. B"), from its artist tags.
  'artist', 'featured',
  'performer', 'composer', 'conductor', 'lyricist', 'producer', 'remixer',
  'arranger', 'engineer', 'mixer', 'dj-mixer', 'writer', 'original-artist',
] as const;

export function creditRoleRank(role: string): number {
  const index = (CREDIT_ROLE_ORDER as readonly string[]).indexOf(role);
  return index === -1 ? CREDIT_ROLE_ORDER.length : index;
}
