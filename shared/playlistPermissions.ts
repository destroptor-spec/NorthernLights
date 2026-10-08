/**
 * What the owner of a playlist may do with it — the one rule shared by the
 * server (API v1 and OpenSubsonic enforce it) and the web client (which uses
 * it to decide which controls to show), so the two cannot drift apart again.
 *
 * They had: the web UI let owners edit, share, pin and delete AI-generated
 * playlists and pin system ones, following the legacy routes, while API v1
 * refused every change to either. After the web client moved its playlist
 * edits onto v1, those controls stayed visible and failed as "read-only".
 *
 * Decided 2026-10-08:
 *
 * | Kind                         | rename / edit tracks | share | pin | privacy | delete |
 * |------------------------------|----------------------|-------|-----|---------|--------|
 * | manual (made by the listener)| yes                  | yes   | yes | yes     | yes    |
 * | custom AI mix (from a prompt)| yes                  | yes   | yes | yes     | yes    |
 * | Hub collection (AI, rebuilt) | no — would be lost   | yes   | yes | yes     | yes    |
 * | system (Daylist, radio, …)   | no                   | no    | yes | no      | no     |
 * | someone else's               | no                   | no    | no  | no      | no     |
 *
 * A Hub collection is rebuilt on a schedule under the same id, so a rename or
 * track edit would be silently overwritten; deleting one only lasts until the
 * next rebuild. Pinning only reorders the owner's own list, so it is allowed
 * even on system playlists.
 */
export interface PlaylistPermissions {
  rename: boolean;
  editTracks: boolean;
  share: boolean;
  pin: boolean;
  setPrivacy: boolean;
  delete: boolean;
}

export interface PlaylistKind {
  isOwner: boolean;
  isSystem: boolean;
  isLlmGenerated: boolean;
  generationSource?: string | null;
}

const NONE: PlaylistPermissions = { rename: false, editTracks: false, share: false, pin: false, setPrivacy: false, delete: false };
const ALL: PlaylistPermissions = { rename: true, editTracks: true, share: true, pin: true, setPrivacy: true, delete: true };

export function playlistPermissions(playlist: PlaylistKind): PlaylistPermissions {
  if (!playlist.isOwner) return { ...NONE };
  if (playlist.isSystem) return { ...NONE, pin: true };
  if (playlist.isLlmGenerated) {
    // Only a prompt-made mix is the listener's own to reshape. Anything else
    // AI-generated — including rows from before generation_source existed —
    // is treated as a Hub collection, the more conservative reading.
    if (playlist.generationSource === 'custom') return { ...ALL };
    return { ...ALL, rename: false, editTracks: false };
  }
  return { ...ALL };
}
