export interface MusicVideoMatch {
  video_id: string;
  title: string | null;
  thumbnail_url: string | null;
}

export interface TrackVideoLookup {
  video: MusicVideoMatch | null;
  status: 'matched' | 'pending' | 'no-match' | 'temporary-error' | 'disabled';
  retryAfterMs?: number;
}
