# Cast receiver as its own output (Phase 5 spec)

Status: **in progress** (updated 2026-10-14). PR A shipped (#113–#115, with
#118 and #122); PRs B–E are next. No receiver code is written until the probe
below has run on the device matrix. Background and the full design: [playback_sessions.md](playback_sessions.md)
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

### B. Receiver credentials (server only) — next

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
- Contract tests as in Phase 1: wrong `sid` denied everywhere, a replaced grant
  refused, a refresh cannot revive one, no access to other sessions or
  playlists.

### C. Sender hands the receiver its credential (sender only)

- When sync is on and the receiver advertises `session-follow` (PR D), the
  sender claims the output for the receiver and puts `{ sessionId,
  receiverToken }` in the LOAD `customData`.
- While connected, it pushes a fresh token over `aurora.status`
  (`aurora.auth.refresh`, acked) on every wake.
- A receiver without the capability gets exactly today's LOAD.
- The second-sender rules (#119/#123: a device joining a Cast session another
  device casts leaves it again) must also recognise a `receiver` output: its
  `castSessionId` is the Cast session the receiver runs in.
- **Kill switch:** an admin server setting, `castReceiverSessionFollow`
  (default off), decides whether senders hand over credentials at all.
  Switching it off reverts every new Cast session to today's path without
  redeploying the receiver.

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
- **Expiry** (401/`OUTPUT_GRANT_REPLACED` on its own calls): stop following,
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

## Live checks before PR D (probe, no product change)

`removeItems`, reorder and current-entry deletion have never been tried on a
sender-loaded queue, and Castlite (B&O) may lack `EventSource` or `fetch`. A
**probe build** of the receiver answers this per device before any product
code:

- `EventSource` to `/api/v1/events` with a test `sse` token: does it connect,
  and how long does it survive idle?
- `fetch` polling of the same endpoint.
- `insertItems`, `removeItems` and reorder on a queue loaded by the phone,
  checking the receiver's status after each.
- Results go to `/api/cast/log` as `receiver-probe` markers.

Devices: NAD Forstærker, Stue TV, Beoplay A9, and one speaker group.

**How the probe ships** is the one decision this spec needs (below). It must
not touch the receiver app that everyone uses.

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

- **PR C kill switch:** turning `castReceiverSessionFollow` off reverts new
  sessions to today's path at once.
- **PR D:** redeploying the previous `receiver.html` (`deploy-prod.sh
  --rollback`). The receiver page is fetched on each Cast launch, so a
  rollback reaches the next session.
- **PRs A and B:** additive API; unused when C is off.

## Decisions for Andreas

Settled since the draft: the order (A first: shipped), and what Play means
("Play where?" asks, and remembers the answer while that device plays).

Still open:
1. **Probe and receiver-next app.** Register a second, unpublished Cast app ID
   in the Google Cast console, pointing at `receiver-next.html` and limited to
   your registered test devices. The probe and PR D are tried there first, and
   041FEA05 only moves once the device matrix passes. *Recommended.* The
   alternative is a query-string flag in the one receiver, which puts the new
   code on the app everyone uses.
2. **Receiver self-renewal** (open question 5 in the design): keep the default,
   no. Expiry after 12 h without any device waking ends in the idle state.
3. **Kill switch** `castReceiverSessionFollow` as an admin server setting, next
   to "Sync playback across devices" (Settings → System → Service).
