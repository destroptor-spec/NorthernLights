# Mobile music-video backgrounds

Backgrounds require the YouTube integration and mobile video-background setting,
local playback, and a matched, embeddable video. Cover art remains the fallback.
The YouTube player is muted; local audio remains authoritative.

## Matching and cache

The matcher inspects up to 100 recent uploads from the artist's linked YouTube
channel. It does not search all of YouTube. Normalized song titles group album
copies together, while live, acoustic and remix qualifiers remain significant.
Official video titles rank above audio and lyric uploads.

`artist_video_uploads` stores the reusable channel catalog and
`track_video_matches` associates each library copy with its selected video.
Artist rails show each video once. The additive schema retains legacy
`artist_music_videos` results until that artist's first successful refresh.

The successful-fetch timestamp controls the configured TTL (14 days by default).
Existing matches return immediately while freshness is checked in the background.
Provider failures preserve the catalog and successful timestamp, and set a
separate 60-second retry deadline. Concurrent lookups share one job per artist.
Changed artist links invalidate a cached miss; changed library track IDs/titles
trigger local rematching against the cached uploads without spending API quota.

Missing artist links trigger a targeted MusicBrainz relationship lookup when an
artist or track MusicBrainz ID is available and that integration is enabled. Its
15-second deadline includes waiting in the provider queue. An unresolved
prerequisite is pending, not a successful empty channel fetch.

`GET /api/providers/external/track-video/:trackId` returns `{ video, status,
retryAfterMs? }`, with status `matched`, `pending`, `no-match`, `temporary-error`
or `disabled`. Responses and client requests use `no-store`. Cold lookups wait
up to one second for shared work before returning pending. The client makes at
most four attempts per mounted track lookup, uses increasing pending delays
(at least 2/4/8 seconds), and honors longer server retry delays up to 60 seconds.
Retries pause while hidden and cancel when the track or settings change.
Confirmed misses do not poll. A later visit starts a new lookup.

## Timestamp synchronization

Readiness, explicit local seeks (including zero), play/pause and foreground
return synchronize the video to the local audio timestamp. During visible
playback, drift is checked once per second and corrected above 0.75 seconds,
with at least two seconds between automatic corrections. Buffering does not
cause repeated corrective seeks. These are correction thresholds, not a
guarantee of subsecond alignment across YouTube buffering and network delays.

A shorter video ends into cover art rather than looping. Seeking the audio back
inside the video's duration permits it to resume. Hidden pages pause the video;
foreground return rechecks the current audio state and time.

Video intros, scene breaks and alternate edits can differ from the audio file.
This is an accepted tradeoff: no content offsets, calibration or alignment
controls are applied. See [logging.md](./logging.md) for local video diagnostics.
