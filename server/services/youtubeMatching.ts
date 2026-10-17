import { getSongDedupKey } from './candidatePool.service';
import { videoTitleCandidates } from './youtubeTitle';
import type { VideoAssociation, VideoUpload } from '../database/musicVideos';

export function matchVideoUploads(uploads: VideoUpload[], tracks: { id: string; title?: string }[]): VideoAssociation[] {
  const byTitle = new Map<string, string[]>();
  for (const track of tracks) {
    const key = getSongDedupKey({ title: track.title });
    if (key.endsWith(':')) continue;
    byTitle.set(key, [...(byTitle.get(key) ?? []), track.id]);
  }
  const best = new Map<string, { videoId: string; score: number }>();
  for (const video of [...uploads].sort((a, b) => a.position - b.position || a.videoId.localeCompare(b.videoId))) {
    const title = video.title.toLowerCase();
    const score = (/\bofficial\b/.test(title) ? 2 : 0) + (/\bvideo\b/.test(title) ? 2 : 0)
      - (/\blyrics?\b/.test(title) ? 1 : 0) - (/\baudio\b/.test(title) ? 1 : 0);
    for (const candidate of videoTitleCandidates(video.title)) {
      const ids = byTitle.get(getSongDedupKey({ title: candidate }));
      if (!ids) continue;
      for (const id of ids) if (!best.has(id) || score > best.get(id)!.score) best.set(id, { videoId: video.videoId, score });
      break;
    }
  }
  return Array.from(best, ([trackId, video]) => ({ trackId, videoId: video.videoId }));
}
