import { AuroraApiError } from '../../api/auroraApi';
import type * as sessionApi from '../../api/playbackSessions';
import { sendRemoteAction } from '../sessionRemote';
import type { FollowedOutput } from '../sessionFollow';

const target: FollowedOutput = {
  sessionId: 's1', outputId: 'desktop', name: 'NAD Forstærker', kind: 'cast', generation: 7,
  state: 'playing', entryId: null, positionMs: 0, anchorMs: 0,
};

function deps(revision: number | null = 12) {
  const api = {
    issuePlaybackCommand: jest.fn(async () => ({ accepted: true })),
    patchPlaybackSession: jest.fn(async () => ({ revision: 13 })),
  };
  return { api, deps: { api: api as unknown as Pick<typeof sessionApi, 'issuePlaybackCommand' | 'patchPlaybackSession'>, auth: { Authorization: 'Bearer t' }, sessionRevision: () => revision } };
}

it('sends a transport command to the output it means', async () => {
  const { api, deps: d } = deps();
  expect(await sendRemoteAction({ type: 'pause' }, target, d)).toBe('sent');
  expect(await sendRemoteAction({ type: 'seek', seconds: 61.25 }, target, d)).toBe('sent');
  expect(api.issuePlaybackCommand.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
    { requestId: expect.any(String), outputId: 'desktop', outputGeneration: 7, command: { type: 'pause' } },
    { requestId: expect.any(String), outputId: 'desktop', outputGeneration: 7, command: { type: 'seek', positionMs: 61_250 } },
  ]);
});

it('jumps by queue entry', async () => {
  const { api, deps: d } = deps();
  await sendRemoteAction({ type: 'jump', track: { id: 't', path: 'p', queueEntryId: 'e-3' } }, target, d);
  expect((api.issuePlaybackCommand.mock.calls[0] as unknown[])[2]).toMatchObject({ command: { type: 'jump', entryId: 'e-3' } });
});

it('starts something new there: replaces the session queue, then loads it at the new revision', async () => {
  const { api, deps: d } = deps();
  const tracks = [{ id: 'x', path: 'x' }, { id: 'y', path: 'y' }];
  expect(await sendRemoteAction({ type: 'load', tracks, startIndex: 1 }, target, d)).toBe('sent');
  const patch = (api.patchPlaybackSession.mock.calls[0] as unknown[])[2] as { expectedRevision: number; operations: Array<{ entryIds: string[] }> };
  expect(patch).toMatchObject({ expectedRevision: 12, operations: [{ type: 'replaceQueue', trackIds: ['x', 'y'], currentIndex: 1 }] });
  const entryIds = patch.operations[0].entryIds;
  expect((api.issuePlaybackCommand.mock.calls[0] as unknown[])[2]).toMatchObject({ command: { type: 'load', revision: 13, entryId: entryIds[1] } });
});

it('replaces the queue anyway when the playing device moved on meanwhile', async () => {
  const { api, deps: d } = deps();
  api.patchPlaybackSession
    .mockRejectedValueOnce(new AuroraApiError('conflict', 409, 'REVISION_CONFLICT', undefined, { current: { revision: 15, queue: [] } }))
    .mockResolvedValueOnce({ revision: 16 });
  expect(await sendRemoteAction({ type: 'load', tracks: [{ id: 'x', path: 'x' }], startIndex: 0 }, target, d)).toBe('sent');
  expect(((api.patchPlaybackSession.mock.calls[1] as unknown[])[2] as { expectedRevision: number }).expectedRevision).toBe(15);
  expect((api.issuePlaybackCommand.mock.calls[0] as unknown[])[2]).toMatchObject({ command: { type: 'load', revision: 16 } });
});

it('says when that device no longer plays, or could not be reached', async () => {
  const { api, deps: d } = deps();
  api.issuePlaybackCommand.mockRejectedValueOnce(new AuroraApiError('gone', 409, 'OUTPUT_GRANT_REPLACED'));
  expect(await sendRemoteAction({ type: 'next' }, target, d)).toBe('replaced');
  api.issuePlaybackCommand.mockRejectedValueOnce(new AuroraApiError('idle', 409, 'OUTPUT_NOT_ACTIVE'));
  expect(await sendRemoteAction({ type: 'next' }, target, d)).toBe('replaced');
  api.issuePlaybackCommand.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  expect(await sendRemoteAction({ type: 'next' }, target, d)).toBe('failed');
  // Without a session read yet there is nothing to replace.
  expect(await sendRemoteAction({ type: 'load', tracks: [{ id: 'x', path: 'x' }], startIndex: 0 }, target, deps(null).deps)).toBe('failed');
});
