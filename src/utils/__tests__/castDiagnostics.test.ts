import { CastDiagnosticsSync } from '../castDiagnostics';
import { AURORA_STATUS_NAMESPACE, getAuroraStatusNamespace } from '../castNamespace';

const capable = { caps: ['diagnostics'], diagnosticsVerbose: false };

test('live update requires a matching receiver acknowledgement, with bounded retries', () => {
  const sync = new CastDiagnosticsSync();
  const session = { sendMessage: jest.fn().mockResolvedValue(undefined) };
  const log = jest.fn();
  sync.sync(session, true, capable, log, 0);
  const request = session.sendMessage.mock.calls[0][1];
  expect(session.sendMessage).toHaveBeenCalledWith(AURORA_STATUS_NAMESPACE, expect.objectContaining({ type: 'aurora.diagnostics', enabled: true }));
  sync.acknowledge(session, request.requestId + 1, true, log);
  sync.sync(session, true, capable, log, 5000);
  expect(session.sendMessage).toHaveBeenCalledTimes(2);
  sync.acknowledge(session, request.requestId, true, log);
  sync.sync(session, true, capable, log, 10000);
  expect(session.sendMessage).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith('ok', expect.stringContaining('confirmed'));
});

test('does not send to old receivers, and stops after three unconfirmed attempts', () => {
  const sync = new CastDiagnosticsSync();
  const session = { sendMessage: jest.fn().mockResolvedValue(undefined) };
  const log = jest.fn();
  sync.sync(session, true, { caps: ['control'] }, log, 0);
  expect(session.sendMessage).not.toHaveBeenCalled();
  for (const time of [0, 1000, 5000, 10000, 15000, 20000]) sync.sync(session, true, capable, log, time);
  expect(session.sendMessage).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('not confirmed'));
});

test('late acknowledgements cannot overwrite a changed preference or new session', () => {
  const sync = new CastDiagnosticsSync();
  const session = { sendMessage: jest.fn().mockResolvedValue(undefined) };
  const log = jest.fn();
  sync.sync(session, true, capable, log, 0);
  const oldId = session.sendMessage.mock.calls[0][1].requestId;
  sync.reset();
  sync.sync(session, false, { caps: ['diagnostics'] }, log, 1);
  sync.acknowledge(session, oldId, true, log);
  expect(log).not.toHaveBeenCalled();
  sync.sync(session, false, capable, log, 5001);
  expect(session.sendMessage).toHaveBeenCalledTimes(3);
  const newSession = { sendMessage: jest.fn().mockResolvedValue(undefined) };
  sync.sync(newSession, true, capable, log, 6000);
  sync.acknowledge(session, oldId, true, log);
  expect(log).not.toHaveBeenCalled();
  expect(newSession.sendMessage).toHaveBeenCalledTimes(1);
});

test('send failures stay within diagnostics and preserve the retry budget', async () => {
  const sync = new CastDiagnosticsSync();
  const session = { sendMessage: jest.fn().mockRejectedValue('channel_error') };
  const log = jest.fn();
  sync.sync(session, true, capable, log, 0);
  await Promise.resolve();
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Could not send'));
});

test('namespace discovery supports running legacy receivers without deployment constants', () => {
  const oldNamespace = 'urn:x-cast:example.aurora.status';
  expect(getAuroraStatusNamespace({ getApplicationMetadata: () => ({ namespaces: [oldNamespace] }) })).toBe(oldNamespace);
  expect(getAuroraStatusNamespace({ getApplicationMetadata: () => ({ namespaces: [oldNamespace, AURORA_STATUS_NAMESPACE] }) })).toBe(AURORA_STATUS_NAMESPACE);
  expect(getAuroraStatusNamespace({})).toBe(AURORA_STATUS_NAMESPACE);
});
