import { handOverToReceiver, ReceiverFollowAcks, type ReceiverFollowMessage } from '../receiverSessionFollow';

const handover = {
  sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 3,
  token: 'receiver-token', expiresAt: '2026-10-15T10:00:00.000Z', renewableUntil: '2026-10-15T22:00:00.000Z',
};

function harness(answer: (message: ReceiverFollowMessage, acks: ReceiverFollowAcks) => void | Promise<void>) {
  const acks = new ReceiverFollowAcks();
  let requestId = 10;
  const sent: ReceiverFollowMessage[] = [];
  const send = jest.fn(async (message: ReceiverFollowMessage) => {
    sent.push(message);
    await answer(message, acks);
  });
  return { acks, sent, send, run: () => handOverToReceiver(handover, { send, acks, nextRequestId: () => ++requestId, timeoutMs: 5_000 }) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('sends the session and credential and settles on the receiver ack', async () => {
  const { sent, run } = harness((message, acks) => acks.acknowledge({ type: 'aurora.session.follow.ack', requestId: message.requestId, ok: true }));
  await expect(run()).resolves.toEqual({ ok: true, attempts: 1, outcome: 'acked' });
  expect(sent).toEqual([{ type: 'aurora.session.follow', requestId: 11, ...handover }]);
});

it('stops at a refusal', async () => {
  const { send, run } = harness((message, acks) => acks.acknowledge({ requestId: message.requestId, ok: false }));
  await expect(run()).resolves.toEqual({ ok: false, attempts: 1, outcome: 'refused' });
  expect(send).toHaveBeenCalledTimes(1);
});

it('tries three times when nothing answers, each with a new requestId', async () => {
  const { sent, run } = harness(() => undefined);
  const result = run();
  await jest.advanceTimersByTimeAsync(15_000);
  await expect(result).resolves.toEqual({ ok: false, attempts: 3, outcome: 'unanswered' });
  expect(sent.map((message) => message.requestId)).toEqual([11, 12, 13]);
});

it('ignores an ack for another request', async () => {
  const { run } = harness((message, acks) => {
    acks.acknowledge({ requestId: message.requestId + 100, ok: true });
    if (message.requestId === 12) acks.acknowledge({ requestId: 12, ok: true });
  });
  const result = run();
  await jest.advanceTimersByTimeAsync(5_000);
  await expect(result).resolves.toEqual({ ok: true, attempts: 2, outcome: 'acked' });
});

it('says when the message could not be sent at all', async () => {
  const { run } = harness(() => { throw new Error('channel closed'); });
  const result = run();
  await jest.advanceTimersByTimeAsync(15_000);
  await expect(result).resolves.toEqual({ ok: false, attempts: 3, outcome: 'send-failed' });
});
