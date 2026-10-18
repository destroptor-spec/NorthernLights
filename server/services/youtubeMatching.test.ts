import { matchVideoUploads } from './youtubeMatching';
import type { VideoUpload } from '../database/musicVideos';
const upload = (videoId: string, title: string, position = 0): VideoUpload => ({ videoId, title, position, thumbnailUrl: null, publishedAt: null });

test('matches album copies and remasters but not live, remix or acoustic versions', () => {
  const tracks = ['Song', 'Song (Remastered)', 'Song (Live)', 'Song (Acoustic)', 'Song (Club Remix)'].map((title, i) => ({ id: String(i), title }));
  expect(matchVideoUploads([upload('official', 'Artist - Song (Official Video)')], tracks).map(m => m.trackId)).toEqual(['0', '1']);
  expect(matchVideoUploads([upload('live', 'Artist - Song (Official Live Video)')], tracks)).toEqual([]);
});

test('prefers official video over audio and lyrics independently of library order', () => {
  const videos = [upload('lyrics', 'Artist - Song (Lyric Video)'), upload('audio', 'Artist - Song (Official Audio)', 1), upload('video', 'Artist - Song (Official Video)', 2)];
  const tracks = [{ id: 'b', title: 'Song' }, { id: 'a', title: 'Song' }];
  expect(matchVideoUploads(videos, tracks).map(m => m.videoId)).toEqual(['video', 'video']);
});
