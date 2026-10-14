# Cast receiver as its own output (Phase 5 spec)

Status: **in progress** (updated 2026-10-14). PR A shipped (#113–#115, with
#118 and #122); B and C are in review (#131, #132), the probe is built, and D
and E follow. No receiver product code is written until the probe below has
run on the device matrix. Background and the full design: [playback_sessions.md](playback_sessions.md)
(Cast receiver as an output, Receiver authentication, Phase 5). Care rules:
[cast-design-checklist.md](cast-design-checklist.md) and the receiver
regression caution (one issue per PR, sender-side first, receiver only when
provably needed).

## Why

Prod, 2026-10-13: the phone cast to the NAD, and Play on the idle desktop
started local playback there while the phone paused the NAD. Andreas expected
the music to stay on the NAD with the desktop in control. Today only the
device that started casting can drive the receiver, and only while it is
awake. Since #113–#128 an idle device can control the NAD through the phone
("Play where?" → the NAD), but only while the phone is awake: locked, it
relays late or not at all, Infinity stops topping up, and nothing can stop
the NAD from another device (prod 2026-10-14).

**Goal:** the NAD is the session's output. Any of the user's devices controls
it through the server, the phone may sleep or leave, and the receiver keeps
playing and reporting on its own.

## What the listener sees

- Phone casts to the NAD. The desktop shows "Playing on NAD Forstærker" with
  live progress (works today).
- On the desktop, "Play where?" → the NAD makes it a remote for the NAD, as
  today, but the commands go to the receiver itself, not through the phone.
- "On this device" moves playback to the desktop, and the NAD stops (as #128
  does for a casting phone today).
- A queue edit on any device (Play next, remove, reorder) reaches the NAD
  within a second or two.
- The phone can be locked or closed for an hour; the NAD plays on.
- If no device has refreshed the receiver's credential for 12 h, the NAD plays
  out what it already has, then shows *Open Aurora to keep playing*.

## Plan: five PRs, receiver last

Each ships alone and leaves today's behaviour intact. Only PR D touches
`public/receiver.html`.

### A. Remote commands for browser outputs (no receiver) — **shipped**

Built as #113 (server), #114 (the output carries commands out) and #115
("Play where?"), with #118 (commands reach only an output whose event stream
is open: `409 OUTPUT_UNREACHABLE`; a stream names its device with `clientId`)
and #122. The receiver in PR D must therefore keep an `/events` stream open,
naming its own output ID, or commands for it are refused. What follows is the
original plan, kept for reference.

The command path is the same for a browser output and a receiver, so build and
prove it where it is safe first. This is also Phase 3's "remote control".

- `POST /api/v1/playback-sessions/:id/commands` with
  `{ type, requestId, outputGeneration, …args }`. Types: `play`, `pause`,
  `seek {positionMs}`, `next`, `previous`, `jump {entryId}`.
- The server checks the generation (`409 OUTPUT_GRANT_REPLACED` when another
  device has taken over since) and publishes `playbackSession.command` to the
  user's stream. It is transient, like `progress`: a command older than a few
  seconds is never replayed into a reconnecting output.
- The output applies the command and its next report confirms it. The sender
  shows the result from the report, not optimistically, apart from the
  spinner.
- Web app: an idle device following a playing output sends commands instead of
  taking over. The #106 prompt and the Next/Previous prompt go away; "Play
  here" moves to an explicit device menu.
- Guarded by the sync setting (403 `PLAYBACK_SYNC_DISABLED`), like every
  session route.

Verify on prod with two browsers: pause, next and seek on one control the
other.

### B. Receiver credentials (server only) — built (feat/receiver-credentials)

Phase 1's leftover "session-bound receiver tokens".

- A controller claims the output **for a receiver**:
  `POST /playback-sessions/:id/output { kind: "receiver", name }`. This needs
  a new kind. #106's `cast` means "a browser that casts", and stays for
  receivers that do not follow the session.
- The response carries a `receiver` credential: a scoped token with
  `sid`/`oid`/`gen`, 12 h, never minted by `/auth/scoped-token`.
- It is allowed exactly:
  - its own session: `GET`;
  - reports;
  - `/events`, filtered server-side to its own session's events;
  - `POST /tracks/:id/playback` for media URLs;
  - `/recommendations/next`, for Phase 4 later.
- A refresh (`POST …/output/refresh`) re-mints for the same, still-current
  grant only.
- As built: the claim needs `castSessionId` and the output ID is
  `receiver:<castSessionId>`; the credential carries `renewableUntil` (the
  `cap` claim, 24 h after a controller issued it), and the receiver renews it
  itself with `POST …/output/renew` (same cap). Unbound `receiver` tokens from
  `/auth/scoped-token` are gone. The API reference is docs/API.md.
- Contract tests as in Phase 1: wrong `sid` denied everywhere, a replaced grant
  refused, a refresh cannot revive one, no access to other sessions or
  playlists.

### C. Sender hands the receiver its credential (sender only) — built (feat/receiver-handover)

- When sync is on and the receiver advertises `session-follow` (PR D), the
  sender claims the output for the receiver (`kind: "receiver"`, with the
  Cast session ID) and hands it `{ sessionId, outputId, generation, token,
  expiresAt, renewableUntil }` in an acknowledged `aurora.session.follow`
  message on the Aurora channel (`aurora.session.follow.ack` with the
  `requestId` and `ok`). Three tries, five seconds each.
- **Not in the LOAD** (changed while building): the receiver names its caps
  only in `aurora.status`, which it first sends once something is loaded, so
  the sender cannot know at the first LOAD. The sender therefore casts exactly
  as today, as a `cast` output, and switches the claim to the receiver when
  its caps arrive. The same message serves a joined or rejoined session.
- If the receiver does not take it, the sender claims back as `cast` and
  reports as today, and does not try that Cast session again.
- While the receiver holds the output, the sender mirrors queue edits but no
  longer reports (the receiver does). Each renewed credential is handed over
  again with the same message (no separate `aurora.auth.refresh`), and the
  sender refreshes on every wake (at most once a minute), which also renews
  the 24-hour cap.
- When the sender leaves the Cast session, it lets go of the output and the
  receiver plays on; it claims again only when it plays itself.
- A receiver without the capability gets exactly today's LOAD and messages.
- The second-sender rules (#119/#123: a device joining a Cast session another
  device casts leaves it again) also recognise a `receiver` output: its
  `castSessionId` is the Cast session the receiver runs in. The device that
  claimed it (the session's `ownerClientId`) rejoining that Cast session is
  not a second sender. A take-over by a
  `receiver` output on the same Cast device leaves the music alone, and a
  silent `receiver` output stays followed, like a `cast` one.
- Log markers: `receiver-can-follow`, `receiver-session-handover`,
  `sync-receiver-handover-failed`, `sync-receiver-left`; checklist row 20.
- No kill switch (decided): a rollback of the receiver is the way back.

### D. Receiver follows the session (`receiver.html`)

All of it only when the LOAD carries `sessionId` and `receiverToken`. Without
them the receiver runs today's code path, unchanged.

- **Advertise** `session-follow` in `caps` (the existing capability list).
- **Follow** `GET /api/v1/events?token=<receiverToken>`, same origin as the
  receiver page, so there is no CORS. Fall back to polling `GET` on its
  session every 5 s if the stream fails twice (decided per device by the
  probe, below).
- **Reconcile** the CAF window with the session's upcoming entries by
  `queueEntryId`:
  - insert (`queueManager.insertItems`, proven in #56);
  - remove (`removeItems`);
  - reorder (remove + insert);
  - current entry deleted → jump to its successor;
  - refill below 5 remaining, up to the existing count and byte caps;
  - repeat-all by refilling from the head, with CAF repeat off when the window
    is shorter than the queue.
- **Commands** from PR A applied through `playerManager`: play, pause, seek,
  queue jump.
- **Reports** every 10 s and on every change, with its credential, exactly like
  a browser output; also `played`/`skipped`.
- **Handover:** accept `aurora.session.follow` from any connected sender,
  adopt the newest generation's credential, and answer
  `aurora.session.follow.ack`. Advertise `session-follow` only when it can
  actually follow (EventSource or fetch available).
- **Replaced** (`playbackSession.handedOff` to another output, or
  `OUTPUT_GRANT_REPLACED` on its own calls, e.g. "On this device" elsewhere):
  stop, since no sender may be connected to stop it. A take-over by a sender
  in its own Cast session (a `cast` or `receiver` claim naming its Cast
  session) is not a reason to stop.
- **Expiry** (401 on its own calls, past `renewableUntil`): stop following,
  play out the window, then the idle state *Open Aurora to keep playing*.
  Never stop mid-track, never fall back to another credential.
- New log markers: `receiver-session-follow`, `receiver-window-reconciled`,
  `receiver-command-applied`, `receiver-report-failed`,
  `receiver-follow-stopped`.

### E. Sender becomes a pure controller (sender only)

For sessions whose receiver follows the session:
- the sender stops full-reloading queues and mirroring edits with SDK calls;
- it edits through the session API and sends commands like any other device;
- it keeps `aurora.control` only as a low-latency path while connected.

Older receivers keep today's sender behaviour.

## Live checks before PR D (probe, no product change) — built (feat/receiver-probe)

Castlite (B&O) may lack `EventSource` or `fetch`, and how long a stream
survives idle is unknown per device. The probe answers this per device
before any product code.

**How it ships:** in the one receiver app, inside a new `aurora.probe`
message handler that runs only when a sender asks. An older receiver ignores
the message; nothing else in `receiver.html` changes. To run it: turn on
Settings → Playback → Cast diagnostics, cast, then **Run probe** (shown only
while casting). The sender mints a 15-minute `sse` token and sends it in
`aurora.probe`; the receiver acknowledges (`aurora.probe.ack`, `accepted`
false while a probe still runs) and logs to `/api/cast/log`:

- `receiver-probe start`, then `receiver-probe env`: `eventSource`, `fetch`,
  `readableStream`, `abortController`, the queue APIs it has (`queueApis=`),
  whether `QUEUE_REORDER` exists, and the user agent;
- `receiver-probe fetch`: a streaming fetch of `/api/v1/events` (status, ms to
  headers, first chunk; the server's keepalive is every 20 s);
- `receiver-probe eventsource`: an EventSource held for ten minutes, logging
  open, every error (with `readyState`), reopen, and the close with
  `heldMs`/`opens`/`errors`/`events`.

The sender logs `receiver-probe-sent result=started|busy|unanswered`. The
stream registers as client `receiver-probe`, which nothing sends commands to.

**Not probed: queue edits.** The original plan inserted, removed and
reordered items on the live queue. That is unsafe today: every inserted item
uses up a CAF item ID, and the sender predicts the IDs of the items it
inserts by counting (castQueueWindow.ts, `assignInsertedItemIds`). After a
probe its Play Next and refills would map to the wrong items until
contradicted (wrong-track jumps, failed mirrored edits, "Cast queue update
unconfirmed"). An item inserted next could also be played. So the probe only
lists which queue APIs exist; real `removeItems`/reorder behaviour is
verified with PR D.

**Consequence for PR D (and E):** once the receiver edits its own queue,
the sender's item-ID prediction is wrong too. Before PR D ships, either the
receiver reports its next item ID in `aurora.status` (and the sender
corrects or drops its predictions), or the sender stops managing the
window for a session whose receiver follows it (PR E's direction).

Devices: NAD Forstærker, Stue TV, Beoplay A9, and one speaker group.

## Verification (Phase 5 "done when", from the design)

Per device in the matrix:
- playback continues for at least 1 hour with the phone asleep;
- a queue edit from a second device reaches the receiver;
- a command from a second device takes effect within 2 s;
- a takeover by another Cast app leaves the session's queue intact;
- token expiry with no phone ends in the idle state, not mid-track.

`npm run verify:cast` gains the new markers. Every existing checklist row is
re-run, because PR D changes the receiver.

## Rollback

- **PR C:** a sender rollback stops handing over credentials, so new sessions
  use today's path.
- **PR D:** redeploying the previous `receiver.html` (`deploy-prod.sh
  --rollback`). The receiver page is fetched on each Cast launch, so a
  rollback reaches the next session.
- **PRs A and B:** additive API; unused when C is off.

## Decisions for Andreas

Settled since the draft: the order (A first: shipped), and what Play means
("Play where?" asks, and remembers the answer while that device plays).

Decided 2026-10-14 (Andreas):
1. **No second Cast app ID.** The current app (041FEA05) is tied to this
   server and Andreas is its only user for now, so the probe and PR D are built
   there. The new receiver code still only runs when a sender asks for it (LOAD
   `customData`), and `deploy-prod.sh --rollback` is the way back.
2. **Self-renewal up to 24 h.** While it is the session's active output, the
   receiver may renew its own credential. Each renewal lasts at most 12 h and
   never beyond 24 h after a controller last gave it a credential (the `cap`
   claim). With no device waking for 24 h it plays out its window and idles.
3. **No kill switch.**
