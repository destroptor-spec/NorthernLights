import { auroraApiRequest } from '../api/auroraApi';

/**
 * Save the play queue as a new playlist through API v1: create it, then set
 * its tracks. If setting the tracks fails, the just-created playlist is
 * deleted again — the legacy flow left an empty playlist behind.
 *
 * Track ids are de-duplicated: a queue may repeat a track, a playlist holds it
 * once, and v1 caps the list it accepts before de-duplicating.
 */
export async function saveQueueAsPlaylist(
  title: string,
  queueTrackIds: Array<string | undefined | null>,
  authHeaders: Record<string, string>,
): Promise<{ id: string; trackCount: number }> {
  const trackIds = Array.from(new Set(queueTrackIds.filter((id): id is string => Boolean(id))));
  if (trackIds.length === 0) throw new Error('Queue is empty.');

  const created = await auroraApiRequest<{ id: string }>('/playlists', authHeaders, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      description: `Saved from play queue with ${trackIds.length} ${trackIds.length === 1 ? 'track' : 'tracks'}.`,
    }),
  });
  if (!created?.id) throw new Error('Failed to create playlist.');

  try {
    await auroraApiRequest(`/playlists/${encodeURIComponent(created.id)}/tracks`, authHeaders, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackIds }),
    });
  } catch (error) {
    await auroraApiRequest(`/playlists/${encodeURIComponent(created.id)}`, authHeaders, { method: 'DELETE' })
      .catch((cleanupError: unknown) => console.warn('Could not remove the empty playlist after a failed save', cleanupError));
    throw error;
  }
  return { id: created.id, trackCount: trackIds.length };
}
