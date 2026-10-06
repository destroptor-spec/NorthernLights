import { infinitySettingsSchema, type NextRecommendationRequest } from '../../shared/api/v1';
import { getUserSetting } from '../database';
import { getSessionHistory } from '../state';
import { calculateNextInfinityTrack } from './recommendation.service';

const SETTING_KEYS = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit'] as const;

/** Shared by the listener API and the legacy browser compatibility adapter. */
export async function getNextInfinityTrackForUser(userId: string | undefined, input: NextRecommendationRequest) {
  const { sessionHistoryTrackIds: clientHistory = [], exclude = [], seedTrackIds = [], settings = {} } = input;
  const serverHistory = userId ? getSessionHistory(userId) : [];
  // Playback-start context is newer than threshold-gated telemetry. This merge
  // is request-local: never manufacture play counts or rewrite another session.
  const history = [
    ...serverHistory.filter(id => !clientHistory.includes(id)),
    ...clientHistory,
  ].slice(-50);

  const saved: Partial<Record<typeof SETTING_KEYS[number], number>> = {};
  if (userId) {
    await Promise.all(SETTING_KEYS.map(async key => {
      const parsed = infinitySettingsSchema.shape[key].safeParse(await getUserSetting(userId, key));
      if (parsed.success && parsed.data !== undefined) saved[key] = parsed.data;
    }));
  }
  // The queue tail steers when a client sends it; history alone is the
  // fallback for clients that predate seeds or hold no queue.
  return calculateNextInfinityTrack(history, { ...saved, ...settings }, {
    excludeTrackIds: exclude,
    ...(seedTrackIds.length > 0 && { seedTrackIds }),
  });
}
