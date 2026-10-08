import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlaylistDetail } from '../PlaylistDetail';
import { usePlayerStore } from '../../../store';

/**
 * The detail page shows each control only where the shared rule
 * (shared/playlistPermissions.ts) allows it — the same rule the server
 * enforces. It used to show every control to the owner of any non-system
 * playlist, so on AI playlists they failed as "read-only".
 */
type Kind = 'manual' | 'custom' | 'hub' | 'system';
const kinds: Record<Kind, Record<string, unknown>> = {
  manual: { isSystem: false, isLlmGenerated: false, generationSource: 'manual' },
  custom: { isSystem: false, isLlmGenerated: true, generationSource: 'custom' },
  hub: { isSystem: false, isLlmGenerated: true, generationSource: 'hub' },
  system: { isSystem: true, isLlmGenerated: false, generationSource: 'daylist' },
};

const track = { id: 't1', title: 'Song', artist: 'Artist', album: 'Album', duration: 200, url: '/x', path: 'p' };

function renderKind(kind: Kind) {
  usePlayerStore.setState({
    playlists: [{ id: 'p1', title: 'My list', description: 'About it', tracks: [track], isOwner: true, pinned: false, ...kinds[kind] }],
  } as never);
  render(
    <MemoryRouter initialEntries={['/playlists/p1']}>
      <Routes><Route path="/playlists/:playlistId" element={<PlaylistDetail />} /></Routes>
    </MemoryRouter>,
  );
}

const controls = () => ({
  rename: screen.queryAllByLabelText('Edit playlist name').length > 0,
  share: !!screen.queryByRole('button', { name: 'Create a public share link' }),
  privacy: !!screen.queryByRole('button', { name: /Hide this playlist from others|Make this playlist discoverable/ }),
});

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }), headers: { get: () => null } }) as never;
});

test.each([
  ['manual', { rename: true, share: true, privacy: true }],
  ['custom', { rename: true, share: true, privacy: true }],
  ['hub', { rename: false, share: true, privacy: true }],
  ['system', { rename: false, share: false, privacy: false }],
] as const)('%s playlist shows exactly the allowed controls', (kind, expected) => {
  renderKind(kind);
  expect(controls()).toEqual(expected);
});

test('suggestions are fetched from API v1', () => {
  renderKind('manual');
  const urls = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
  expect(urls).toContain('/api/v1/playlists/p1/suggestions');
  expect(urls.some((u) => u.startsWith('/api/playlists'))).toBe(false);
});
