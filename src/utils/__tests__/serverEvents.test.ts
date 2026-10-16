class EventSourceStub {
  static instances: EventSourceStub[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = jest.fn();
  constructor(readonly url: string) { EventSourceStub.instances.push(this); }
}

const originalEventSource = globalThis.EventSource;
beforeEach(() => {
  jest.resetModules();
  EventSourceStub.instances = [];
  globalThis.EventSource = EventSourceStub as unknown as typeof EventSource;
});
afterEach(() => { globalThis.EventSource = originalEventSource; });

it('closes all status streams and resumes their current callbacks after failure', async () => {
  const { ServerEventStream, suspendServerEvents } = await import('../serverEvents');
  const first = new ServerEventStream('/api/library/scan/status');
  const second = new ServerEventStream('/api/admin/mbdb/status');
  const message = jest.fn();
  const error = jest.fn();
  first.onmessage = message;
  first.onerror = error;
  const [oldFirst, oldSecond] = EventSourceStub.instances;
  const release = suspendServerEvents();
  expect(oldFirst.close).toHaveBeenCalledTimes(1);
  expect(oldSecond.close).toHaveBeenCalledTimes(1);
  oldFirst.onmessage?.(new MessageEvent('message'));
  oldFirst.onerror?.(new Event('error'));
  expect(message).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  release();
  release();
  expect(EventSourceStub.instances).toHaveLength(4);
  EventSourceStub.instances[2].onmessage?.(new MessageEvent('message', { data: 'resumed' }));
  EventSourceStub.instances[2].onerror?.(new Event('error'));
  expect(message).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1);
  first.close();
  second.close();
});

it('does not open new streams or revive unmounted views during a handoff', async () => {
  const { ServerEventStream, suspendServerEvents } = await import('../serverEvents');
  const original = new ServerEventStream('/original');
  const release = suspendServerEvents();
  const mounted = new ServerEventStream('/new');
  original.close();
  expect(EventSourceStub.instances).toHaveLength(1);
  release();
  expect(EventSourceStub.instances.map(s => s.url)).toEqual(['/original', '/new']);
  mounted.close();
});

it('waits for every suspension to end and never reopens a permanently closed stream', async () => {
  const { ServerEventStream, suspendServerEvents } = await import('../serverEvents');
  const stream = new ServerEventStream('/status');
  const first = suspendServerEvents();
  const second = suspendServerEvents();
  first();
  expect(EventSourceStub.instances).toHaveLength(1);
  stream.close();
  second();
  stream.resume();
  expect(EventSourceStub.instances).toHaveLength(1);
});

it('pauses before sending skipWaiting and reconnects on rejection so Retry can work', async () => {
  const { ServerEventStream } = await import('../serverEvents');
  const { setPwaUpdateHandler, applyPendingPwaUpdate } = await import('../pwaUpdate');
  const stream = new ServerEventStream('/status');
  const handler = jest.fn(async () => {
    expect(EventSourceStub.instances.at(-1)?.close).toHaveBeenCalledTimes(1);
    throw new Error('activation timeout');
  });
  setPwaUpdateHandler(handler);
  const first = applyPendingPwaUpdate();
  expect(applyPendingPwaUpdate()).toBe(first);
  await expect(first).rejects.toThrow('activation timeout');
  expect(EventSourceStub.instances).toHaveLength(2);
  await expect(applyPendingPwaUpdate()).rejects.toThrow('activation timeout');
  expect(EventSourceStub.instances).toHaveLength(3);
  expect(handler).toHaveBeenCalledTimes(2);
  stream.close();
});

it('keeps streams closed through a successful reload', async () => {
  const { ServerEventStream } = await import('../serverEvents');
  const { setPwaUpdateHandler, applyPendingPwaUpdate } = await import('../pwaUpdate');
  const stream = new ServerEventStream('/status');
  setPwaUpdateHandler(async () => {});
  await applyPendingPwaUpdate();
  expect(EventSourceStub.instances[0].close).toHaveBeenCalledTimes(1);
  const mounted = new ServerEventStream('/during-navigation');
  expect(EventSourceStub.instances).toHaveLength(1);
  stream.close();
  mounted.close();
});
