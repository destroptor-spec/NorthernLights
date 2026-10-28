// Listen together's words, shared by the store and the UI (no imports, so
// the store can use them without a cycle).

/** "Andreas' session", "Bo's session". */
export function sessionTitle(ownerName: string): string {
  return `${ownerName}${/s$/i.test(ownerName) ? "'" : "'s"} session`;
}

/** What screen readers hear for a preview's avatars: no guest names. */
export function previewLabel(ownerName: string, guests: number): string {
  if (guests === 0) return ownerName;
  return `${ownerName} and ${guests} ${guests === 1 ? 'other' : 'others'}`;
}
