# Playback Sessions: The Server as Source of Truth

**Status:** Proposed, 2026-10-11; revised 2026-10-12 after review (phase
dependencies, windowing, entry-anchored ops, report ordering, receiver auth,
playback confirmation), then for patch idempotency keys, evidence-only
termination of an unreachable output, and server-side output grants. Nothing here is implemented beyond what
[What exists today](#what-exists-today) lists.
**Related:** #56 (receiver-driven Infinity, PRs A–C merged), #72 (mid-song 310),
#39, #40, [API.md § Durable playback sessions](API.md).

Today every Aurora client owns its own queue, and the phone or desktop that
started a Cast session also has to keep the Cast device supplied. This proposal
makes the server's playback session the single source of truth for *what is
queued and what is playing*. Every client and every Cast receiver becomes a
participant that reads that session and sends changes to it. This is the model
Spotify Connect and Tidal Connect present to users. It is also the foundation
"Listen together" and party playlists would need.

Much of the server half already exists and is unused (see below). So this is
mostly a proposal to adopt and finish what is there, not to build from scratch.

## Why

### What broke on 2026-10-10/11 (production, phone PWA, NAD and Stue TV)

| Local time | What the listener experienced | Root cause | Structural? |
| --- | --- | --- | --- |
| Oct 11 13:35–13:39 | Music stopped after one song | The sender loads the **entire** local queue in one Cast message. Across all 504 loads since April, every load of ≤33 items succeeded and every load of ≥53 failed with `invalid_parameter` (11/11). The fallback then loads a single track. | Partly: the sender owns the whole queue |
| Oct 11 15:33 | Music stopped at the end of the queue | Infinity appends one track, only when `remaining < 1`, and only from the sender. The one append that day came 1 s after the phone was foregrounded; nothing was appended while it slept. | **Yes**: playback depends on the phone being awake |
| Oct 11 15:55 | Progress bar jumped to ~100% | The sender's position source preferred the SDK RemotePlayer, which still held the previous track's end position. | Yes: the sender reconstructs state it does not own |
| Oct 11 16:08 | Music cut off mid-song | Another device took over the NAD. When the phone returned it could only detect a dead transport. | Partly: no shared record of what was playing |
| Oct 10 17:31 | TV restarted with a different song | A second client started a new Cast session and auto-cast *its* local queue over the one playing. | **Yes**: each client believes its own queue |

Each of these can be patched one by one (Phase 0 below does the cheap ones). But
four of the five come from one design decision: **the queue lives on a device,
and the device that started casting must keep the receiver fed**. A backgrounded
PWA is frozen by Chrome, so that dependency fails by design, not by bug. #56 has
documented the same pattern since September: six successive fixes each
repaired one way of reading an unreliable sender-side view.

### How Spotify and Tidal avoid this

Their internals are not public, but their observable behaviour and public APIs
are consistent with this model. Spotify's Web API can read playback state, add
to the queue and transfer playback for *any* of a user's devices, which is only
possible if the session lives server-side.

- The session (queue, current item, position, active device) lives in the cloud.
- Every app is a client of it. The phone is a remote control: it sends intents
  and renders state pushed back to it.
- When casting, the Cast receiver fetches from the service itself. The phone can
  sleep or die and playback continues.
- A browser tab is never responsible for keeping playback going elsewhere. If
  Chrome freezes it, nothing breaks; on wake it re-reads state.
- Shared sessions (Spotify Jam) are the same session with more editors. The
  server serialises their edits.

## Goals

1. Playback on any output, especially a Cast device, continues when the device
   that started it sleeps, closes or loses network.
2. All of a user's devices see the same queue and now-playing state, and can
   change it.
3. Reconnecting, takeover by another app, and a second phone joining are safe.
   No client ever overwrites a running session with stale local state.
4. Local browser playback stays instant (no server round trip before audio
   responds) and works offline.
5. A clean foundation for **Listen together**: a session shared with invited
   household members, per [PRODUCT.md](../PRODUCT.md) (secondary users are
   "household members or invited listeners").

## Non-goals

- **Sample-synchronised multi-room playback** (several outputs in lockstep).
  That is the "Multi-Room Sync" backlog item and a different problem; Cast
  speaker groups already cover it.
- **Public or social sessions.** Feeds and public profiles are product
  non-goals. Shared sessions are private and invite-only.
- **Replacing the CAF queue with `QueueBase`.** #56 Stage 0 proved on the NAD that
  `queueManager.insertItems` works on a sender-loaded queue. The receiver keeps
  a short local CAF queue and feeds it.
- **Multi-process server.** The server stays a single Node process. Several
  in-memory structures (HLS sessions, event replay, rate limits) assume it.

## What exists today

| Piece | State | Where |
| --- | --- | --- |
| Durable playback sessions | **Built, unused by first-party clients.** DB-backed session plus ordered entries with UUID `queueEntryId`s; `revision` with optimistic concurrency (`expectedRevision`, row `FOR UPDATE`); patch ops `replaceQueue`, `insert`, `remove`, `move`, `setTransport` (≤50 per patch, queue ≤2000); `handoff`; 409 `REVISION_CONFLICT` / `PLAYBACK_SESSION_NOT_OWNER` / `TRACKS_UNAVAILABLE`. | `server/services/playbackSession.service.ts`, `server/routes/apiV1.routes.ts` (`/playback-sessions`), `shared/api/v1.ts` (`playbackSessionSchema`), tables `playback_sessions` + `playback_session_entries` |
| Per-user event stream | **Built, unused by the web app.** `GET /api/v1/events` (SSE) with `Last-Event-ID` replay from a 200-event in-memory buffer per user; `resync.required` when the id has aged out. Events: `playbackSession.created/updated/handedOff/deleted`, `playlist.changed`, `annotation.changed`, `library.revision`. Invalidation only: carries `{sessionId, revision}`, not the state. | `server/services/apiV1Events.service.ts` |
| Playback reports | **Used** for `played`/`skipped`. The schema also accepts `nowPlaying` with `positionMs`, but the server ignores the position and stores no now-playing state. | `POST /api/v1/playback/reports` |
| Server Infinity groundwork | **Built** (#56 PRs A–C). Scope enforcement (#61); recommendations exclude queued tracks and resolve settings server-side when omitted (#62); a narrow `receiver` token scope (`POST /recommendations/next`, `POST /tracks/:id/playback`, `POST /playback/reports`, `GET /preferences`), mintable for up to 12 h (#63). Nothing mints or uses `receiver` yet. | `server/middleware/apiV1Auth.ts` (`SCOPE_ALLOWED_ENDPOINTS`), `server/services/infinityRequest.service.ts` |
| Receiver ⇄ sender channel | **Built and in use.** `urn:x-cast:aurora.status`: receiver status broadcast (state change plus every 5 s, carrying `queueEntryId`); `aurora.control` (play/pause/seek, acked); `aurora.queue.insert` (≤20 items, `next`/`end`, acked); `aurora.diagnostics`. Caps are advertised so older receivers degrade. | `public/receiver.html`, `src/utils/CastManager.ts` |
| Client queue | **Local only.** Zustand `playlist`, `currentIndex`, `shuffle`, `repeat`, persisted to localStorage (`player-store`) plus a continuity snapshot. Infinity tops up one track when the current track is last. Cast receives the whole queue in one `LoadRequest`. | `src/store/index.ts`, `src/utils/queue.ts`, `src/utils/playbackContinuity.ts` |

### Gaps in what exists

These must be resolved before a first-party client can rely on the session API:

1. **Entry-id formats don't match.** The server requires UUID `queueEntryId`s. The
   web client generates `queue-<base36>-<random>` (`src/utils/queue.ts`).
2. **Ownership is all-or-nothing.** Only the owner client may `PATCH`
   (`playbackSession.service.ts`: `owner_client_id !== clientId` → 409). That
   prevents a second device, or a listen-together guest, from adding a track
   without first taking over playback. See [Roles](#roles-controllers-and-the-output).
   *Fixed in Phase 1, PR 3: the session belongs to its user; any of their devices
   may change it, and the output role moves by claiming a grant.*
3. **No live position.** `setTransport` stores a position, but nothing reports it
   periodically, and `nowPlaying.positionMs` is discarded.
   *Fixed in Phase 1, PR 4: the output reports to
   `POST /playback-sessions/:id/reports`.*
4. **Queue writes rewrite every row.** Queue changes delete and re-insert entries
   one row at a time, which is too slow for a 2,000-entry queue under frequent
   Infinity top-ups. *Fixed in Phase 1, PR 1: only entries whose position
   changed are written, in one statement.*
5. **Missing tracks leave gaps.** `serializeSession` silently drops entries whose
   track no longer exists, so `position` values can have holes. *Fixed in
   Phase 1, PR 1: positions are renumbered when served and when written.*
6. **Session history is in memory.** The rolling 50-track history Infinity relies
   on (`server/state.ts`, `userSessionHistory`) is lost on every restart.
7. **Shuffle has no order.** The client picks `Math.random()` at each skip, so
   there is nothing to store, sync or preload.
8. **`receiver` tokens can't read sessions, and aren't bound to one.** The scope
   does not include `/playback-sessions` or `/events` (the allowlist test denies
   `receiver` `GET /events` on purpose). Scoped tokens carry only
   `userId`/`username`/`role`/`scope` (`scopedToken.service.ts`), so a
   `receiver` token could not be limited to one session even if it were allowed
   in. See [Receiver authentication](#receiver-authentication).
9. **Queue ops are index-based and IDs are server-assigned.** `insert` takes a
   numeric `index`, `move` takes a `toIndex`, and the server generates every
   `queueEntryId` (`shared/api/v1.ts`, `queueInsertOperation` /
   `queueMoveOperation`). An index is only meaningful at one revision, so these
   ops cannot be rebased, and an optimistic client has no ID for an entry it just
   inserted until the server answers. See [Sync protocol](#sync-protocol).
   *Fixed in Phase 1, PR 2: `afterEntryId` anchors, client-proposed `entryIds`
   and a per-patch `requestId`.*
10. **Reports have no ordering or output identity.** `playbackReportSchema` has
    `eventId`, `trackId`, `kind` and `positionMs`, but nothing that identifies
    which output sent it or orders it against other reports. See
    [Position and progress](#position-and-progress).
    *Fixed in Phase 1, PR 4: identity from the output credential, `seq` per grant.*

## Proposed model

### Session

One **playback session** per user to start with; the existing table already
supports several. It holds:

- the **queue**: ordered entries with stable UUID `queueEntryId`s;
- the **current entry** and **transport** (`playing` / `paused` / `stopped`, plus a
  position snapshot `{positionMs, at}`);
- **mode**: repeat, shuffle (with an explicit stored order), Infinity on/off and
  its settings;
- the **output**: which client currently produces audio (a browser, or a Cast
  receiver with its device name);
- a monotonically increasing **revision**.

### Roles: controllers and the output

**Ownership belongs to the user, never to a device** (Andreas, 2026-10-13):
"If I start casting, I will own that cast session end to end." A session never
changes owner. It can change *device*: the phone dies, the PWA on the computer
resumes it, and which device holds the queue is seamless and invisible to the
listener, with no takeover prompt. Other people only take part as guests the
owner lets in ([Listen together](#listen-together-later)); they may add tracks
but not take playback or delete the session.

The single device-level "owner" therefore splits into two roles:

- **Controllers** are any authorised client: the user's devices, later invited
  members. They may change the queue and send transport *intents*
  (play/pause/seek/skip) with `expectedRevision`.
- **The output** is the one client playing audio. Only it reports **observed
  transport**: what is actually playing, at what position. Transport intents from
  controllers are relayed to the output, which executes them and then reports.
  Over the server for a browser output; for a Cast output, over the existing
  `aurora.control` channel or via the server, see [Cast receiver](#cast-receiver-as-an-output).

`handoff` keeps its meaning, now as a new output grant (see
[Position and progress](#position-and-progress)): it moves the **output** role ("play on this device
instead"). It no longer gates queue edits. `PLAYBACK_SESSION_NOT_OWNER` becomes
specific to transport *reports* from a client that is not the output.

### Sync protocol

The revision and conflict mechanics work as is, but the op shapes need a
contract change first (gap 9):

- **Entry-anchored ops.** `insert` gains `afterEntryId` (`null` means the head
  of the queue) and `move` gains `afterEntryId` in place of `toIndex`. An anchor
  still means the same thing after other edits; an index does not. If the anchor
  was removed concurrently, the server answers `409 ANCHOR_NOT_FOUND` and the
  client rebases like any other conflict. The index forms stay accepted for
  existing API v1 clients but are never used by first-party clients.
- **Client-proposed entry IDs.** `insert` and `replaceQueue` accept a UUID per
  track from the client. The server uses it if it is unused in the session, and
  rejects the whole patch (`409 ENTRY_ID_CONFLICT`) if it is not. The optimistic
  local entry and the confirmed server entry then have the same ID from the
  start, so there is no temporary-to-confirmed ID map to keep. The server keeps
  generating IDs when a client omits them. The duplicate-ID check is a safety
  net against double insertion, not a retry mechanism; see the next point.
- **A request key per patch.** Every `PATCH` carries a client-generated
  `requestId` (UUID) covering the whole patch. This is the same pattern
  `/playback/reports` already uses for `eventId`. The server records
  `(sessionId, requestId) → {request hash, resulting revision}` **in the same
  transaction** that applies the patch, and checks the key **before** the
  revision check:
  - **Same key, same body:** the patch is not applied again. The server returns
    the original success with the revision it produced, plus the current
    session. Without this, a retry after a lost response would hit
    `REVISION_CONFLICT` against its own first attempt, or `ENTRY_ID_CONFLICT`
    against its own entries, and the client would treat a success as a failure.
  - **Same key, different body:** `422 IDEMPOTENCY_KEY_REUSED`; nothing applied.
  - **Rejected patches are not recorded.** A `409` leaves no key behind, so
    after rebasing the client sends a new `requestId`.
  - **Retention:** keys are kept for 24 h and capped per session, which is far
    longer than any client retry window, including an offline journal replay
    (see [Offline](#offline)). An expired key is treated as new, and the
    duplicate-ID check still stops double insertion.

The protocol:

1. A controller applies a change **optimistically** to its local copy and sends a
   `PATCH` with `expectedRevision`.
2. On success the server bumps `revision` and publishes `playbackSession.updated`.
3. On `409 REVISION_CONFLICT` the response already carries the current session.
   The client rebases its intent onto it. With anchored ops this is mechanical:
   an insert after a surviving entry, or a removal of an entry that still
   exists, applies unchanged; an op whose target is gone is dropped. It then
   retries once; if that fails, it adopts the server state.
4. Every client keeps one SSE connection to `/api/v1/events`. On an update whose
   revision is newer than the local one it re-fetches the session. On
   `resync.required` (replay window lost, e.g. after a server restart) it re-fetches
   unconditionally.

The optimistic local apply keeps the UI instant, as it is today.

### Position and progress

The output reports
`{outputId, outputGeneration, seq, queueEntryId, positionMs, state, at}`:

- **`outputId`** names the output (a browser client ID, or the Cast receiver
  bound to this session).
- **`outputGeneration`** is issued by the server each time an output *claims*
  the output role: first start, `handoff`, or a receiver launch. The server
  rejects reports from any generation other than the current one. A delayed
  report from the phone after playback moved to the NAD, or from a receiver that
  was replaced, can't overwrite the new output's state.
- **Both come from a server-side grant, not from the report body.** Claiming
  the output role (`POST /playback-sessions/:id/output`, by a controller)
  creates an **output grant** `{sessionId, outputId, generation}`. The server
  stores it and returns an **output credential** whose claims carry `sid`,
  `oid` and `gen`. Reports must be sent with that credential. The server reads
  `outputId` and `outputGeneration` *from the credential*. If the body repeats
  them, they must match, and a mismatch is rejected. A caller that merely knows
  or guesses the current generation number cannot report as the output: it does
  not hold that grant's credential. For a Cast receiver the output credential is
  its `receiver` token (see [Receiver authentication](#receiver-authentication)).
  A browser output gets one from the same claim call and keeps it in memory
  only.
- **`seq`** increases with every report within one generation. The server drops
  any report whose `seq` is not greater than the last one it accepted. That
  covers what `queueEntryId` alone cannot: a delayed report from *before* a seek
  within the same track.

When it reports:

- on every state change and track change;
- every ~10 s while playing;
- as a heartbeat every ~30 s while paused or buffering. Without one, a paused
  output is indistinguishable from a dead one.

The server stores the latest accepted report. Controllers interpolate between
reports from `positionMs + (now - at)` while playing. The sender already does
this for Cast (#68).

**Position is always bound to a `queueEntryId`.** A report for any entry other
than the current one is never shown as the current track's progress. That
removes the 15:55 "progress jumps to the end" class of bug by construction.

**Silence means "unreachable", not "stopped".** When heartbeats stop, the server
marks the output **unreachable**, with the last known state kept as it was. A
phone in a lift, a receiver behind a flaky Wi‑Fi link, and a killed receiver all
look the same from the server, and they keep looking the same for as long as
the silence lasts. So the output stays unreachable **until positive evidence**
arrives:

- **Termination:** the output itself reports `stopped`, `idle`, an unrecoverable
  error, or a best-effort shutdown report (below), on its own grant.
- **Replacement:** a new output grant for the session (a handoff, or a new
  receiver launch from one of the user's devices), which bumps the generation.
- **Recovery:** a report on the current grant clears the unreachable state.

Missing heartbeats, a dead sender transport and a failed rejoin are all *absence
of evidence*, so none of them, alone or combined, ends the output.

### Playback confirmation

"Connected", "load acknowledged" and "load request resolved" never mean
*playing*. Every start, skip, resume and handoff is confirmed:

- **Confirmed** when the output reports `PLAYING` for the *requested*
  `queueEntryId`, and its position has advanced past where it started (two
  reports with increasing `positionMs`, or one ≥ 1 s past the start position).
  For Cast that is the receiver's `aurora.status`. The SDK's media status
  (RemotePlayer or media session) counts only when it carries the requested
  entry's identity: without that it carried the previous track's state at
  15:55. With it, receivers that predate `aurora.status` still confirm instead
  of hanging on *Starting…*.
- **Paused on the device** (Google Home, a TV remote, another sender) for the
  requested entry ends confirmation without a retry: the start happened and
  someone paused it. A pause on the phone while the LOAD is in flight lets the
  LOAD land, then pauses the media it created.
- **Until then** the UI shows the requested track at its start position and
  the play button's spinner. No surface shows text for a start in progress and
  the Cast icon is left alone; only a start that fails says anything.
- **Bounded failure path:** if no confirmation arrives within a deadline (15 s,
  above the slowest successful start in the prod logs; tune it from those
  logs), retry once by re-requesting the same entry at the same position. If the
  retry does not confirm either, show an error toast with Retry
  (`CastHealthToasts`) and keep the queue and position untouched. Never silently
  advance to another track. If the requested entry is already visibly starting
  at the first deadline (`PLAYING` or `BUFFERING` for it, a slow LOAD ack or a
  cold transcode), the retry is skipped and only the second deadline remains: a
  reload would restart it.
- **A LOAD acknowledgement timeout is not a failure.** The ack can arrive after
  the receiver has started. After 12 s the sender stops waiting for it,
  records the window as sent, and lets receiver evidence decide. It never sends
  the same LOAD again on a timeout alone.
- Log markers `playback-confirmed` and `playback-unconfirmed` (with the entry,
  the elapsed time and the attempt) make this verifiable from
  `cast-receiver.log`.

This is a sender-side rule, so it ships in Phase 0. It applies unchanged once
the session is authoritative.

### Infinity, owned by the server

Infinity becomes a server policy, not a client loop:

- When the output reports a track change, and the session has Infinity on with
  fewer than **K upcoming entries** (proposed K = 3), the server asks the
  recommendation engine for more and appends them. It uses the session's own
  history and settings.
- Appends are ordinary queue revisions, so every client and the output see them
  through the normal sync path.
- Exactly one owner: clients stop calling `ensureInfinityQueue` once the session
  is authoritative, which removes the duplicate-append risk.
- Session history moves from the in-memory `userSessionHistory` to durable
  storage. Either persist it per session, or derive it from the `played` reports
  already written.

Running K ahead also means one failed recommendation call no longer ends
playback.

**Delivery to a Cast receiver is a separate problem from deciding what comes
next.** A server append only reaches a Cast device if something forwards it.
Until the receiver follows the session itself (Phase 5), that something is the
sender, which is frozen when the phone sleeps. So:

- From Phase 4 the server is the only component that *chooses* Infinity tracks.
  The sender stops calling `/recommendations/next` once the session is
  authoritative.
- The sender keeps *forwarding* upcoming session entries to the receiver
  (`aurora.queue.insert`, as Phase 0's window replenishment does) for every Cast
  session whose receiver does not advertise the session-follow capability.
- Sender forwarding is retired per session, only when the receiver advertises
  that capability **and** has reported for this session. Older receivers and
  devices where Phase 5 is not enabled keep sender forwarding indefinitely.

Phase 4 therefore improves browser playback and multi-device consistency.
"Infinity continues on the Cast device with the phone asleep" is a Phase 5
outcome.

### Cast receiver as an output

This is #56's PRs D/E/F, reframed around the session instead of a
receiver-private queue:

- **Launch:** the sender's `LOAD` carries the `sessionId` and a session-bound
  `receiver` token (see [Receiver authentication](#receiver-authentication)).
  The queue it sends is a **window**: the current entry plus the next N, capped
  both by count (N ≤ 20) and by serialised size (the same byte budget as
  [Phase 0](#phase-0-windowed-cast-loads)).
- **Feeding:** the receiver follows the session through its event stream, or by
  polling `GET` on its session if SSE proves unreliable on a device. On each new
  revision it reconciles its CAF window against the session's upcoming entries,
  by `queueEntryId`:
  - **insertion** of new entries inside the window: `queueManager.insertItems`
    (proven in #56 Stage 0); URLs resolved via `POST /tracks/:id/playback`;
  - **removal** of window entries that left the session: `removeItems`;
  - **reorder** within the window: remove and re-insert. The receiver-side
    `QueueManager` API is built around `insertItems`/`removeItems`/`updateItems`;
    check whether each device's CAF version also offers a direct reorder before
    relying on one;
  - **current entry deleted** in the session: the receiver does not let it play
    out. It jumps to the entry that now follows the deleted one's anchor,
    matching what a local player does when the playing track is removed;
  - **refill**: when fewer than a low-water mark (5) of window items remain
    after the current one, append the next session entries up to the cap.
  Removal, reorder and current-entry deletion on a *sender-loaded* queue are not
  proven on any device yet. They need the same Stage 0-style live check that
  `insertItems` had before Phase 5 relies on them.
- **Repeat and shuffle across the window boundary:** the receiver keeps CAF
  repeat **off** whenever the window is shorter than the queue, and implements
  repeat-all by refilling from the head of the session queue after the last
  entry. CAF `REPEAT_ALL` would loop only the window. Repeat-one maps to CAF
  `REPEAT_SINGLE` unchanged. Shuffle uses the session's stored shuffle order
  (gap 7), so "upcoming entries" is always a well-defined list for the window to
  follow.
- **Reporting:** it sends `played`/`skipped` and position reports itself, with
  its `receiver` token, which carries its output grant. This advances server history
  and drives Infinity with no sender attached.
- **The sender becomes a pure controller:** it renders the session and the
  receiver's `aurora.status`. It edits through the session API and keeps
  `aurora.control` for low-latency play/pause/seek. It no longer full-loads
  queues on every skip, and no longer mirrors each edit with fire-and-forget
  SDK calls (whose remove/move paths are likely dead, because the SDK relay
  strips `customData`).

Receiver changes are the highest-risk part of this design. They take effect only
on new Cast sessions and can only be verified on real devices.

### Receiver authentication

The receiver has no user, no login and, with the phone asleep, no one to renew
its credentials. Its token is therefore narrow, bound and finite:

- **Session and grant binding.** A `receiver` token is the receiver's *output
  credential*. It is minted only by claiming the output role for a receiver
  (`POST /playback-sessions/:id/output` with `kind: "cast"`, called by a
  controller of that session). It carries `sid`, `oid` and `gen` claims naming
  exactly one session and one output grant, plus a `jti`. It is never minted
  from the generic `POST /auth/scoped-token`, which keeps refusing
  `scope: "receiver"` once this lands. Every `receiver` request is checked
  against the claims in the middleware next to `SCOPE_ALLOWED_ENDPOINTS`, not
  in each route. Report identity comes from the claims, never from the body.
- **What it may do**, beyond #63's recommendation and track-playback endpoints:
  - `GET /playback-sessions/:sid` for its own session only;
  - `GET /events`, filtered server-side to that session's events. Other
    sessions, playlists, annotations and library revisions never reach it;
  - `POST /playback/reports` for its own session only, and only while its
    grant is the session's current one.
  It may never mutate the queue, read or write other sessions, or write
  preferences.
- **How SSE and the token reconcile.** The web app's event stream keeps using
  `sse` tokens only (see [Security](#security)). The receiver's stream uses its
  `receiver` token. Both are scoped capabilities in the `?token=` query string,
  because `EventSource` cannot set headers, and neither is ever a full session
  JWT. This replaces the earlier "SSE accepts only `sse` tokens" wording: `/events`
  accepts an `sse` token (all of the user's events) or a `receiver` token (one
  session's events).
- **Lifetime.** 12 h, as #63 allows. The token does not renew itself, so a
  stolen one expires on its own. Any sender that connects to the session pushes
  a fresh token over `urn:x-cast:aurora.status` (`aurora.auth.refresh`, acked),
  so in normal use the token is refreshed every time the phone wakes up. A
  refresh re-mints for the **same, still-current grant** (same `oid` and `gen`).
  It cannot revive a grant that has been replaced; for that, the sender must
  claim a new grant. That is a new generation on the server, but invisible to
  the listener (see [Roles](#roles-controllers-and-the-output)).
- **Expiry with no phone.** When the token expires and nobody has refreshed it,
  the receiver stops following the session. It plays out the items already in
  its CAF window; their media URLs carry their own tokens. Then it shows an idle
  state: *Open Aurora to keep playing*. It does not stop mid-track, and it does
  not fall back to any other credential. The session on the server is
  untouched, so opening Aurora resumes from it. Whether a receiver may exchange
  its own token for a fresh one while it is the session's active output, under
  an absolute cap, is an [open question](#open-questions). The default is no.
- **Revocation.** Handing the output to another device, or deleting the
  session, replaces or deletes the grant. The old receiver's token still
  verifies, but its `gen` is no longer current, so every report and session
  read it makes is rejected, even before the token expires.

### Reconnect, takeover and second devices

- **Joining clients never push.** A client that opens, reloads or reconnects reads
  the session first. Auto-cast of a local queue happens only when there is no
  active session output, which fixes the 2026-10-10 17:31 overwrite.
- **Takeover:** when another app takes the Cast device, our receiver is often
  killed without a word. The server marks the output **unreachable** after ~2×
  the heartbeat interval without reports, and clients show *Can't reach NAD
  Forstærker*. A failed rejoin or `stale-transport-dead` on the phone does not
  change that: a Wi‑Fi drop produces the same evidence as a takeover. The output
  stays unreachable until one of the positive signals in
  [Position and progress](#position-and-progress) arrives. To make the common
  case positive, the receiver (Phase 5) sends a best-effort `stopped` report
  with `reason: shutdown` from its CAF shutdown event. It does not handle that
  event today. That report may not get out before the app is killed, so it can
  only *confirm* a stop, never be required for one. Being unreachable never
  blocks the listener: the UI offers *Resume here* and *Reconnect* while
  unreachable. Choosing *Resume here* claims a new output grant, which is itself
  the replacement evidence. The session (queue and last position) survives
  throughout.
- **A dead sender transport no longer matters for playback.** It only means that
  controller re-syncs over HTTP/SSE. This is the case #86 now reports honestly.

### Local browser playback

A browser output follows the same model. Audio starts locally at once;
reports flow to the server in the background. Preloading (`prepareNextUrl`,
`PreloadManager`) reads the *next entry in session order*. That also fixes
today's shuffle and repeat-all waste, where it always targets `currentIndex + 1`.

### Offline

The server cannot be the source of truth for a client that cannot reach it:

- Offline, the client runs **local-only** on its last known session copy (today's
  behaviour) and journals its queue ops.
- On reconnect it compares revisions. If the server is unchanged since it went
  offline, it replays the journal as normal `PATCH`es. If the server moved on
  (another device played or edited), **the server wins**, and the local queue is
  offered as a one-tap "Restore the queue from this device" (the existing undo
  pattern) rather than merged silently.

### Listen together (later)

A session gains **members** (user ids) with a role (`editor` or `listener`).
Invited household members join through the existing invite system or a
session-scoped link. Edits are already serialised by revision, so no new
concurrency model is needed. This is invite-only and private; there are no
public sessions or feeds.

## Security

- **No new long-lived credentials.** The receiver gets a 12 h `receiver` token
  bound to one session, with no self-renewal (see
  [Receiver authentication](#receiver-authentication)). #63's reasoning (do not
  make URL-transport `media` tokens exchangeable) still holds.
- **`/events` never sees a full session JWT.** It accepts an `sse` token (the
  web app: all of the user's events) or a session-bound `receiver` token (one
  session's events). Today the web app falls back to the full session JWT in the
  `?token=` URL when no `sseToken` is present (`App.tsx`). Close that before
  making `/events` an always-on connection. Query-string tokens must stay
  redacted in every log, as `/api/cast/log` already does.
- **Reports are grant-checked.** Output identity and generation come from the
  output credential's claims, checked against the server-side grant. A report
  from a replaced grant, or one whose body disagrees with its credential, is
  rejected. A caller-supplied generation number is never trusted on its own.
- **Membership checks** on every session read and write once shared sessions
  exist. Until then, sessions stay strictly per user, as today.

## Migration plan

Every phase ships on its own and leaves the app working.

| Phase | Scope | Touches receiver? | Done when |
| --- | --- | --- | --- |
| **0. Fixes now** | (a) [Windowed Cast loads](#phase-0-windowed-cast-loads) with replenishment, capped by count and bytes; the `invalid_parameter` fallback loads the window, not one track. (b) Bind sender position and duration to the current `queueEntryId`. (c) Interim Infinity: keep K = 3 tracks ahead instead of 1. (d) [Playback confirmation](#playback-confirmation) with a bounded retry. One PR each. | No | Prod log: no `invalid_parameter` queue loads; a 68+ item queue plays past the first window; no `source=remote-player` position from a different title; no queue run-dry while the phone is backgrounded for the length of K tracks; every start ends in `playback-confirmed` or a visible `playback-unconfirmed` error |
| **1. Server readiness** | Prerequisite: [database export and import](database_export_import.md), so a pre-deploy export exists while the dev channel shares prod's database; schema changes stay additive. Then close the gaps above: UUID entry ids, **entry-anchored `insert`/`move`, client-proposed entry IDs and a per-patch `requestId`** (the contract change in [Sync protocol](#sync-protocol)), controller/output roles, **server-side output grants** with output credentials carrying `sid`/`oid`/`gen`, position reports with `seq` and heartbeats, the unreachable output state (cleared only by positive evidence), **grant-bound `receiver` tokens**, bulk entry writes, durable session history, stored shuffle order, gap-free positions. | No | Contract tests for each op, conflict, anchor-gone and duplicate-ID case and rebase; retry tests (same `requestId` returns the original success, a reused key with a different body gets 422, a rejected patch leaves no key); report tests (replaced grant, body/credential mismatch, guessed generation without the credential, out-of-order `seq`, seek within a track); token tests (wrong `sid` denied on every route, refresh cannot revive a replaced grant); unreachable-state tests (no silence or rejoin failure ends an output); load test with 2,000-entry queues |
| **2. Mirror** | The web client writes its queue through to the server session and subscribes to `/events`. The local queue is still authoritative. Payoff: "continue on this device". | No | Two devices show the same queue within seconds; no behaviour change when offline |
| **3. Authoritative** | Client edits go to the session (optimistic plus rebase); joining clients read before writing; auto-cast only without an active output. | No | Oct 10 17:31 scenario no longer reproducible; conflict test across two devices |
| **4. Server Infinity** | Server keeps K upcoming entries and is the only component choosing Infinity tracks; clients stop calling `/recommendations/next`. **Cast senders keep forwarding** upcoming entries to receivers without the session-follow capability (see [Infinity](#infinity-owned-by-the-server)). | No | No duplicate appends across two devices; Infinity continues in browser playback across a reload or device switch; Cast behaviour unchanged |
| **5. Receiver follows the session** | #56 PRs D/E/F reframed: windowed load, session-bound receiver token, window reconciliation (insert, remove, reorder, current-entry deletion, refill, repeat-all wrap), receiver reports, playback confirmation from the receiver. Additive and capability-gated, so older receivers keep today's behaviour. Sender forwarding retires per session once the receiver advertises the capability and has reported. | **Yes** | Device matrix (NAD, Stue TV, Beoplay A9, a speaker group): playback, *including Infinity*, continues ≥ 1 hour with the phone asleep; a queue edit from a second device reaches the receiver; a takeover leaves the queue preserved; token expiry with no phone ends in the idle state, not mid-track |
| **6. Listen together** | Members, roles, invites, UI. | No (built on 5) | Two accounts edit one queue playing on the NAD |

**Phase 4 depends on Phase 5 for Cast.** Server Infinity cannot keep a Cast
device going with the phone closed until the receiver receives queue changes
and reports progress itself. Until then the sender stays in the delivery path:
Phase 0(c)'s sender refill chooses *and* delivers until Phase 4; from Phase 4
the server chooses and the sender still delivers; from Phase 5 the receiver
fetches for itself.

Phase 5 deserves its own short receiver spec before code
([cast-receiver-output.md](cast-receiver-output.md)). It must cover the
token handling, SSE versus polling on each device, the live checks for
`removeItems` and reorder on a sender-loaded queue, and the Castlite question
in [Open questions](#open-questions).

### Phase 0: windowed Cast loads

Capping the load without a plan for what comes next would just move the
13:35 failure: a 68-track playlist would stop after the window instead of after
one track. The window is a moving view of the local queue, and the sender
keeps it moving. All of this is sender-side; the receiver already supports
everything it needs (`aurora.queue.insert`, CAF queue).

- **Size.** The window is the current entry plus the following entries, up to
  **30 items and 24 KB** of serialised `LoadRequest`, whichever comes first. The
  sender already measures this (`bytesApprox` in the `Queue load requested`
  log). In the prod logs every load ≤ 29.8 KB succeeded and the smallest failure
  was 41.9 KB. The real limit is unknown, so the budget stays under the largest
  observed success rather than near the smallest failure. Long titles and
  artwork URLs make the item count a poor proxy, which is why both caps apply.
- **Identity, not index.** Today `isSessionQueueMatchingTracks` requires the
  receiver queue to have the same *length* as the local queue. With a window
  that check would always fail, and every `ensureQueuePlayback` would trigger a
  full reload (an audible restart). It must compare the receiver's items with
  the expected window slice by `queueEntryId`. Likewise, every place that
  indexes `mediaSession.items` with a local index (the `queueJumpToItem` target
  in `ensureQueuePlayback`, the `metadata.index` fallback in
  `resolveTrackIndexFromSession`) must map through `queueEntryId` or a
  window-relative index.
- **Item IDs and jumps.** The SDK lists only ~3 receiver items, so the sender
  infers the window's item IDs from one known ID (CAF numbers items
  consecutively in queue order): from the fresh SDK Media right after a LOAD,
  cross-checked by stream URL, or from the first `aurora.status`. Every later
  report is checked against them. Jumps go first as `QUEUE_UPDATE` on the media
  channel with the LOAD's media session ID (confirmed on the NAD within
  100–800 ms; the SDK's Media object goes stale or missing once the receiver
  advances by itself), then through the SDK, then as a LOAD at the target, with
  no error shown. A jump counts as failed only if it is still the latest skip
  when its 3 s run out; fast presses coalesce, so only the newest target is
  played after the one in flight.
- **Previous entries.** A LOAD also carries up to **10 entries before** the
  current one, with `startIndex` pointing at the current entry. They count
  toward the 30-item cap (so a fresh load holds 10 behind and up to 20 ahead)
  and the byte budget. Previous on the phone, and the device's own controls
  (Google Home, a TV remote), then step back instead of reloading. The
  device's controls only ever see the receiver's queue: with 2 entries, Google
  Home stopped two tracks before the last track started from the phone (NAD,
  2026-10-12). Going further back than the receiver holds is a LOAD from the
  phone; from Google Home it needs the phone to backfill, or the receiver
  following the session (Phase 5).
- **Replenishment.** When the receiver's current item has fewer than 5 items
  after it, the sender appends the next local entries, up to the cap, with
  `aurora.queue.insert` (`end`, ≤ 20 per message, acked), falling back to the
  SDK queue insert on receivers without that capability. This depends on the
  sender being awake, exactly as today's Infinity top-up does. A 30-item window
  is about two hours of music, far longer than the phone-asleep gaps in the
  Oct 11 log. Removing that dependency is Phase 5.
- **A complete window delivers at once.** When the window already reaches the
  end of the local queue, an append or Play Next is sent to the receiver
  immediately (acked), exactly as before windowing. The low-water wait applies
  only to a *truncated* window, whose next entries are still on the phone. This
  keeps small queues behaving as they did: a track added just before locking
  the phone is already on the device.
- **Edits outside the window** change only the local queue. Replenishment picks
  them up when the window reaches them.
- **Edits inside the window** are mirrored, never reloaded, whenever the
  receiver item IDs involved are known:
  - Play Next: `aurora.queue.insert` with `next` (acked; proven on the NAD in
    #56), falling back to the SDK insert with `insertBefore` on older receivers;
  - remove: SDK `queueRemoveItem` by item ID;
  - move: SDK `queueReorderItems` before the item ID of the entry's new
    successor;
  - repeat change: SDK `queueSetRepeatMode`, using the repeat-all rule below.

  These are item-ID commands, which do not depend on `customData` surviving the
  relay. Only inserts do, which is why inserts prefer `aurora.queue.insert`.
  When an item ID is unknown (the phone slept through the status that carried
  it), or the edit cannot be expressed as one of these commands, the window is
  reloaded at the receiver's entry and position: one short gap, instead of a
  receiver queue that disagrees with the phone. Undo of a queue edit is an edit
  too, and goes through the same path.
- **Played entries** are pruned from the receiver only by item IDs the sender
  actually observed, keeping the last 10 (see *Previous entries*). An entry
  whose ID is unknown stays on the receiver. Pruning never reloads; a few
  extra played entries on the receiver are harmless.
- **Infinity and the low-water mark.** Infinity keeps 3 entries ahead (0(c)),
  below the low-water mark of 5. That is consistent rather than conflicting:
  in Infinity mode the window always holds the whole local tail, so it is
  complete, and each Infinity append is delivered at once as one acked insert.
  The low-water refill matters only for long, finite queues.
- **Rejoin, reload and recovery.** The window survives the sender losing its
  memory or its session object:
  - after every window change, the sender stores the window's entry IDs with
    the Cast session ID (≤ 32 IDs in `localStorage`);
  - when a session is resumed (a PWA reload, a stored-session rejoin, or a
    #86 stale-transport recovery, which creates a new session object), the
    sender **adopts** the stored window only if all of these hold: the session
    ID matches; the receiver's current entry (`aurora.status`) is in the stored
    IDs; the receiver's item count from the current item
    (`queueLength - currentItemIndex`) equals the stored count from that entry;
    and the stored IDs from that entry match the local queue's order from the
    current entry;
  - otherwise it does **not** adopt. It leaves the receiver's queue playing
    untouched (never an automatic reload), logs `queue-window-not-adopted`
    with the failed condition, and falls back to the pre-window per-edit
    mirroring. The next user-initiated load creates a fresh window.
- **Loads and jumps recover a dead transport** through the same
  stale-transport wrapper (`runCastCommand`) as every other Cast command, so a
  tap after the phone wakes recovers and retries instead of failing (#39/#86).
- **Removing the playing entry** jumps the receiver to the next window entry
  (`queueJumpToItem`), then removes the old one.
- **Repeat-all:** when the whole queue fits in the window, CAF `REPEAT_ALL` as
  today. When it does not, the receiver gets repeat **off**, because CAF would
  loop only the window. The sender wraps instead: replenishment continues from
  the head of the local queue. Repeat-one stays CAF `REPEAT_SINGLE`.
- **Shuffle:** Cast auto-advance already follows queue order; only a manual skip
  picks a random index today. A random target outside the window reloads the
  window at that entry. That is a user-initiated skip, so a load there is
  expected. Real shuffle order arrives with gap 7.
- **The `invalid_parameter` fallback** retries with a smaller window (half the
  items, then the current entry plus 5) instead of a single track, and logs
  which size succeeded. That turns each failure into a data point about the
  real limit.

## Testing and verification

- **Unit and contract:** session ops, revision conflicts and rebase (including
  anchor-gone and duplicate client IDs), role checks, Infinity top-up policy,
  position binding, report acceptance (generation and `seq`), the window
  selector and window reconciliation, the playback-confirmation state machine.
  The last four are pure functions, tested in the `castWatchdogPolicy.ts`
  style.
- **Two-client tests:** concurrent edits, reconnect after offline, resync after
  server restart.
- **Production log markers** per phase, in the style of `stale-transport-dead`,
  so each phase is verifiable from `cast-receiver.log`. Examples:
  `session-revision-applied`, `session-resync`, `infinity-topup`,
  `receiver-session-follow`.
- **Cast:** the manual checklist in [cast-design-checklist.md](cast-design-checklist.md)
  plus `npm run verify:cast`, extended with phone-asleep and takeover cases. Every
  receiver phase is tested on each device type before it becomes the default.

## Open questions

1. **Castlite.** B&O speakers (Beoplay A9) are among the Cast partner speakers
   that may run a restricted receiver environment. Does `EventSource` (or `fetch`
   polling) work there? Answer this before Phase 5.
2. **One session or several per user?** Desktop at work and NAD at home at the same
   time is two outputs. The table supports multiple sessions; the UI question is
   which one a newly opened client joins.
3. **Report interval** versus server write load. 10 s per active output seems
   fine for a household, but should be confirmed against the 100k-track target
   environment.
4. **Subsonic clients.** OpenSubsonic `savePlayQueue` / `getPlayQueue` and
   `getNowPlaying` (empty today) could map onto the session, giving Symfonium
   cross-device resume.
5. **Receiver token self-renewal.** Should a receiver that is the session's
   current output be allowed to exchange its token for a fresh one, under an
   absolute cap (say 24 h from the sender's mint), so an all-day party survives
   with no phone? The default in this design is no: expiry ends in the idle
   state.
6. **Confirmation deadline.** 15 s is a starting point. Derive the real number
   from the start-to-first-progress times in `cast-receiver.log`, per device.
7. **Server restarts during playback (#72).** Sessions survive a restart (they're
   in the DB), but in-flight HLS transcode sessions do not. See below.

## Found along the way (not part of this design)

- **Shutdown handler (`server/index.ts`)**: `SIGINT`/`SIGTERM` delete every HLS
  session but never exit or close the server, so the old process can keep
  answering segment requests with an empty session map until the process manager
  kills it. Error 310 with `Missing exact session … active variants=[]` seconds
  after a successful segment is consistent with this during a deploy. That is a
  hypothesis for #72; the pm2 logs will confirm or rule it out.
- **Legacy `POST /api/playback/skip`** lowers the track's star rating by one. No
  current client calls it, but anything that does will silently change ratings.
- **`isInfinityMode` is not persisted** and defaults to `true`, so turning
  Infinity off does not survive a reload.
- **Preload ignores shuffle and repeat-all wrap**: it always prepares
  `currentIndex + 1`.

## Key files

- `server/services/playbackSession.service.ts`: session persistence, revision and ownership
- `server/services/apiV1Events.service.ts`: per-user SSE event bus with replay
- `server/routes/apiV1.routes.ts`: `/playback-sessions`, `/events`, `/playback/reports`, `/recommendations/next`, `/auth/scoped-token`
- `server/middleware/apiV1Auth.ts`: scoped-token allowlist (`receiver`)
- `server/services/infinityRequest.service.ts`, `server/state.ts`: Infinity inputs and in-memory history
- `shared/api/v1.ts`: session, patch and report schemas
- `src/store/index.ts`, `src/utils/queue.ts`, `src/utils/playbackContinuity.ts`: client queue today
- `src/utils/CastManager.ts`, `public/receiver.html`: Cast sender and receiver


## Implementation status — 2026-10-12

Phase 0 is implemented as four stacked draft PRs, in the order listed in the
roadmap. It is not yet validated on physical Cast devices:

- **0(a), #89:** complete-request UTF-8/count budgets, decreasing LOAD retries,
  identity-based navigation, acknowledged refill, bounded receiver queues and
  sender repeat-all wrapping. After review: inside edits are mirrored by item
  ID (Play Next via `aurora.queue.insert`, remove, reorder, repeat), with a
  reload only when an ID is unknown; complete windows deliver appends at once;
  LOADs carry ten previous entries; pruning never reloads; windows are adopted
  after a reload, rejoin or recovery only on proof; loads and jumps recover a
  dead transport through `runCastCommand`. Receiver item IDs are inferred
  from position (CAF numbers items consecutively) and verified against every
  report, so skips and edits deep in the window no longer reload.
- **0(b), #90:** entry-bound position/duration selection, position-event freshness,
  duplicate-URL ambiguity rejection, and entry-bound interpolation/handback.
  Receiver play state still applies when its entry does not match.
- **0(c), #91:** one bounded Infinity worker maintains three upcoming entries;
  exhaustion, duplicate results and queue changes stop the top-up safely. At
  the very end of the queue, a track queued during the fetch plays first.
- **0(d):** matching identity plus advancing PLAYING evidence confirms starts.
  One retry follows the 15-second deadline; another 15 seconds ends in an
  actionable error. A substantially delayed timer after phone suspension does
  not automatically reload the receiver. Late valid evidence can still confirm
  playback. Existing progress surfaces (desktop progress bar and waveform, the
  mobile now-playing sheet, and the mobile mini player's device line) show
  nothing for a start in progress (the play button spins) and show uncertainty, and existing Cast health toasts provide Retry. Session
  changes, stop and seek cancel pending confirmation; a pause defers to the
  in-flight LOAD; a device-side pause settles it. A LOAD ack timeout (12 s) is
  treated as sent, never resent on its own.

Automated validation after the review fixes: typecheck, Vite production build
and the full Jest run on each branch of the stack. Physical devices are not
covered by this result.

Before promoting the drafts: verify the NAD checklist above, a 68+ entry queue
playing beyond its first window, repeat wrap and current-entry removal, edits
inside/outside the window, successful and deliberately failed starts, another
sender taking over, and the installed phone PWA backgrounded for three tracks.
The Phase 1–5 server/session/receiver work remains unimplemented by these PRs.
Issue #72 remains deferred; these changes do not establish the cause of error 310.

## Implementation status — Phase 1

**PR 1 — bulk entry writes and gap-free positions** (no API or schema change):
- `writeEntries` replaces the row-at-a-time rewrite. Entries that kept their
  position are left alone. Removed and moved entries are deleted, and moved and
  new entries are inserted in one `unnest` statement. An Infinity append to a
  2,000-entry queue writes only its new rows.
- `serializeSession` renumbers positions after leaving out entries whose track
  is gone. The next write closes the hole in the stored rows too.
- `server/database/__tests__/playbackSessions.pg.test.ts` is the real-Postgres
  contract suite that later Phase 1 PRs extend. It covers each queue op,
  multi-op patches, revision conflicts (including two concurrent patches),
  unknown tracks and entries, ownership and handoff, user isolation, deleted
  tracks, which rows a write touches (via `xmin`), and a 2,000-entry load test.
  Locally a 2,000-entry write went from about 105 ms to 25 ms for an append and
  about 55 ms for a full reorder; most of the remainder is serializing the
  response.

**PR 2 — entry anchors, proposed entry IDs and request keys** (API contract
change; one new table):
- `insert` and `move` accept `afterEntryId` (`null` = head) as the alternative
  to `index` / `toIndex`; exactly one is required. A missing anchor answers
  `409 ANCHOR_NOT_FOUND` with the current session. Moving a missing entry stays
  a no-op; moving an entry after itself leaves it in place.
- `insert` and `replaceQueue` accept `entryIds`. On `insert`, an ID already in
  the queue rejects the whole patch (`409 ENTRY_ID_CONFLICT`, with the current
  session). On `replaceQueue`, an ID naming an existing entry for the same track
  keeps that entry (and its `addedAt`), since a replacement is idempotent; for
  another track it is a conflict.
- `requestId` is optional in the schema so existing API v1 clients keep
  working; first-party clients will always send it. Keys live in the new
  `playback_session_requests` table (`session_id`, `request_id`, hash,
  resulting revision), are written in the patch transaction, checked after the
  ownership check and before the revision check, kept 24 h and capped at 1,000
  per session. A replay answers `200` with the current session and
  `meta.appliedRevision` / `meta.replayed`; a different body answers
  `422 IDEMPOTENCY_KEY_REUSED`.
- Contract tests cover anchors, anchor-gone, duplicate IDs (including within one
  patch), replacement reuse, replay after a later change, key reuse, rejected
  patches leaving no key, per-session scope, expiry, the cap, and a rebase of an
  anchored insert after a concurrent change.

**PR 3 — the owner is the user; output grants** (API change; additive columns):
- No device-level owner check: any of the user's devices (web session or app
  key) may `PATCH` or `DELETE` a session. `ownerClientId` stays, deprecated,
  recording the client that last created or claimed it.
- The output grant lives on `playback_sessions` (`output_id`, `output_kind`,
  `output_name`, `output_generation`, `output_claimed_at`): one current grant
  per session; the generation only goes up, so any older grant is stale.
- `POST /playback-sessions/:id/output` (`kind: "browser"`; `cast` arrives with
  PR 5's receiver token) makes the calling device the output at any time,
  without a revision check, and returns `{ session, credential }`. The output
  credential is a one-hour JWT with scope `output` and `sid`/`oid`/`gen`/`jti`
  claims. It is refused by every endpoint until PR 4's reports, and the generic
  `/auth/scoped-token` never mints it.
- `POST /playback-sessions/:id/output/refresh` re-mints for the current grant
  only; a replaced one answers `409 OUTPUT_GRANT_REPLACED`.
- `handoff` is a legacy alias: a browser claim by the caller at an expected
  revision.
- Creating a session does not claim the output; a client starting playback
  creates and claims in one step, so the listener never sees two.

**PR 4 — output reports and the unreachable state** (API addition; additive
columns):
- `POST /playback-sessions/:id/reports` accepts only an output credential, and
  only for its own session: the middleware binds the credential's `sid` to the
  path, and the report is checked against the current grant (`409
  OUTPUT_GRANT_REPLACED`). Identity comes from the claims; a body that names
  another output or generation gets `422 OUTPUT_IDENTITY_MISMATCH`. A web
  session or app key gets `403 OUTPUT_CREDENTIAL_REQUIRED`, whatever it knows
  about the grant.
- `seq` must exceed the last accepted one within the grant (reset by each
  claim); older reports are dropped with `{ accepted: false }`.
- The latest report is stored on the session (`output_seq`, `output_state`,
  `output_reason`, `output_entry_id`, `output_position_ms`,
  `output_reported_at`). **Position-only reports change no revision**, so
  controllers' edits never conflict with playback. A track change (to an entry
  still queued) or a play-state change moves `currentEntryId` /
  `playbackState`, bumps the revision and publishes an update. Position stays
  bound to its entry.
- `output.status` is derived on read: `unreachable` after 60 s (two missed
  heartbeats) without a report, `ended` only after the output's own `stopped`,
  `idle` or `error`, otherwise `active`. Silence never ends an output; any
  report on the grant makes it active again, and a new claim replaces it.
- Choices made here: the stored time is the server's receive time, not a
  client `at`, so clock skew between devices doesn't matter. Position-only
  reports publish no event; they would push real changes out of the 200-event
  replay buffer within half an hour. How controllers follow live position
  (polling, or an unbuffered event) is decided in Phase 2.

## Phase 2 — mirror: design (agreed 2026-10-13)

**Behaviour** (Andreas's decisions):
- One session per user; a device reuses the latest one, and starting an album
  replaces its queue instead of creating a session.
- The playing device's local queue is authoritative. `SessionMirror` (a client
  singleton) watches the store, diffs each queue change into anchored ops with
  client-proposed UUID entry IDs and a `requestId`, one PATCH in flight at a
  time. On a conflict the playing device resends its queue as a `replaceQueue`
  (entry IDs reused, so the server writes only what moved).
- Pressing play claims the output; the playing device reports every ~10 s while
  playing and ~30 s while paused. While casting, the phone reports for the Cast
  device.
- **One device plays at a time:** when another device claims, the old output
  pauses at once.
- An idle device follows `/events`: it shows the session's queue, current track
  and live progress with a small "Playing on <device>" line, and silently
  replaces its own older queue. **Play** there continues from the current
  position without asking; **Pause / Next / Previous** ask whether to take over
  here (remote control of the playing device is Phase 3).
- Rollout behind "Sync playback across devices", off by default, because prod
  serves every user. Changed 2026-10-13 (Andreas): this is a server setting
  only admins change, not a per-device one; see PR 5 below.

**PRs:**
1. UUID entry IDs. `createQueueEntryId` produces UUIDs; queues saved before the
   upgrade are re-keyed at boot, but only with no active or stored Cast session
   (the receiver window is matched by entry ID). While casting, old IDs stay and
   that queue is not mirrored until it is replaced.
2. The playing side: session client, mirror writer, claim, reports.
3. The following side: `/events` subscription, adopting the session queue, the
   device line, take-over prompts, pausing the replaced output. Also closes the
   event stream's fallback to the full session JWT (Security).

### Phase 2 — implementation status

**PR 1 (UUID entry IDs):** done, draft PR #101.

**PR 2 (the playing side):**
- Setting: `syncPlaybackAcrossDevices` in the player store, at first persisted
  per device (replaced by the server setting in PR 5).
- `src/api/playbackSessions.ts`: the session calls. `AuroraApiError` now carries
  the error `details`, so a conflict hands back `details.current`.
- `src/utils/sessionQueueDiff.ts`: `planSessionPatch` turns "session queue A,
  device queue B" into anchored operations.
  - Removes come first. Kept entries already in order (a longest increasing
    run) stay put; the rest move after their local predecessor. New entries
    are inserted in runs of at most 200.
  - Repeat and shuffle go in a `setTransport`.
  - It sends one `replaceQueue` instead when fewer than half the local entries
    are already in the session, when an entry ID names another track, or when
    the plan would need 50 operations or more.
  - Tested by a fuzz test against a simulator, and against the real service in
    `playbackSessions.pg.test.ts`.
- `src/utils/SessionMirror.ts`: the singleton, started in `main.tsx`.
  - Playback starting (or the setting turned on while playing) claims the
    output. The device reuses the user's latest session, or creates one if
    there is none. A failed claim is retried every 30 s while still playing.
  - Store changes to the queue, repeat or shuffle are debounced (250 ms) into
    one PATCH at a time, planned from the session the server last confirmed.
  - A conflict re-plans from `details.current`, up to 3 times. A lost answer is
    retried with the same `requestId`. `TRACKS_UNAVAILABLE` stops mirroring
    while those tracks are queued. A queue with legacy entry IDs is not
    mirrored.
  - Reports are the only writer of the current entry and play state. They go
    out on every state, track and buffering change, then every 10 s while
    playing and every 30 s while paused, with position from the shared
    playback-time store (Cast or local).
  - Starting or stopping casting claims again, so the output's name becomes
    the Cast device's or this browser's (`describeThisDevice`, e.g. "Chrome on
    Android").
  - The credential is refreshed 5 minutes before it expires, and at once after
    a 401.
- **Replaced output:** a report or refresh answered with
  `OUTPUT_GRANT_REPLACED` means another device plays now. This device stops
  writing and reporting, and does not claim again until an explicit Play here
  (`resume`, `setPlaylist`, `playAtIndex` → `notePlayIntent`).

**PR 3 (the following side):**
- Server: every accepted report is also published as
  `playbackSession.progress` (`{sessionId, revision, outputId, generation,
  report}`). These events are transient: delivered live, never kept for replay,
  so ten-second heartbeats cannot push the events a reconnecting client needs
  out of the replay window.
- `src/utils/SessionFollower.ts`, started in `main.tsx`, with pure helpers in
  `src/utils/sessionFollow.ts`.
  - It connects to `/api/v1/events` only with the scoped `sse` token. When the
    store has none (it falls back to the session JWT for older streams), it
    does not connect at all, so the event stream never sees a full session
    token (Security). The server already refuses one there.
  - On connect, and on `resync.required`, it reads the user's latest session;
    `created`/`updated`/`handedOff` events fetch it when it is news, and
    `progress` events update the followed device in place.
  - **Idle device** (not playing, not casting, not holding the output): the
    session's queue replaces the local one silently (entry IDs kept), the
    current track is the one the other device plays, and progress is carried
    forward every second between heartbeats. `sessionFollow` in the store
    drives "Playing on <device>" in the desktop player (in place of the
    signal chain), the mobile mini player and the Now Playing heading, shown
    only while that device plays. An output that is `unreachable` or `ended` is
    not followed; after 65 s without a heartbeat the session is read again.
  - **Play** on an idle device continues from where the other device is now
    (`resume` updates the pending start from `sessionFollow`). Playing any
    track here (`playAtIndex`) claims the output again, which also closes the
    queue-row gap from PR 2.
  - **Next / Previous** on an idle device while the other device plays open
    "Play here instead?" (`takeOverPrompt`, `SessionTakeOverPrompt`). Taking
    over plays the next track here, or for Previous restarts the current one
    when the other device was past 3 s. Pause is not offered there: an idle
    device shows Play, and Play never asks.
  - **One device at a time:** a `handedOff` event, or a fetched session, with a
    newer generation from another device goes to `sessionMirror.noteReplaced`.
    It waits for this device's own claim in flight, ignores a claim older than
    its own grant, and otherwise stops this device (`onDisplaced` → `pause`,
    which pauses the Cast device while casting). A device that plays without a
    grant (its claim failed) is stopped too. What was already true when the
    stream connected never counts as a claim. Without the event stream, the
    next report's `OUTPUT_GRANT_REPLACED` does the same within 10 s.
    Exception (prod 2026-10-13 19:50, two devices joined to one Cast
    session): a take-over by a `cast` output named like the Cast device this
    device casts to pauses nothing, since the music never moved
    (`isSameCastDevice`; `handedOff` carries `outputKind`/`outputName`).
  - A casting device never adopts a queue: a Cast receiver's queue is never
    replaced from here.

**Cast handover (decided with Andreas 2026-10-13, after the PR 3 test):** with
the phone casting to the NAD, Play on the idle desktop started local playback
there and the phone paused the NAD. Andreas expected the music to stay on the
NAD, controlled from the desktop. The decision is the receiver as its own
output (Phase 5): the NAD reports to the server and takes commands from any
of the user's devices, so the phone may sleep or leave. Joining the Cast
session from the desktop's Cast SDK, and relaying commands through the phone,
were rejected (Chrome-only and new multi-sender ground; fails whenever the
phone sleeps).

Until then (PR 4): a casting device claims with output `kind: 'cast'`. Play on
an idle device following a `cast` output that is playing asks "Play here
instead?" with "Play here" / "Keep on <Cast device>"; Play still never asks
when the other device plays by itself.

**Device choice and remote control (decided with Andreas 2026-10-13, after
the PR 3–5 tests).** This replaces "Play on an idle device continues there
without asking":
- Any playback action on an idle device while another device plays asks
  **Play where?**, offering the playing device (or the Cast device it casts
  to) or this device: Play, Pause, Next, Previous, tapping a queue track, or
  tapping a song or album elsewhere.
- The answer is remembered **while that device plays**. It resets when another
  device takes over, or playback there stops or goes unreachable. It survives a
  reload, and a device chip next to "Playing on …" changes it.
- With the playing device chosen, the idle device is a **full remote**: its
  controls show and drive that device. A new song or album replaces the
  session queue (`PATCH replaceQueue`), then `load` starts it on that device.
- With this device chosen, it takes over. A device that was casting stops
  casting and follows (rather than staying connected, paused, with a stale
  queue).
- Until Phase 5, controlling a Cast device relays through the device casting
  to it, so that device must be awake.

Reachability (prod test 2026-10-13: the desktop controlled the phone, the
phone's app was closed, and the desktop sent commands into the void for a
minute): the closing device sends a last `stopped` report (`pagehide`,
keepalive; not while casting); the server refuses commands for an output with
no event stream open (`409 OUTPUT_UNREACHABLE`; streams name their device
with `clientId`), and the controller then forgets the choice; and the output
reports right after each command, so a controller hearing nothing for 5 s
says "<device> isn't responding".

No second Cast sender (prod 2026-10-13 21:47:36, Andreas chose this): Chrome
on the desktop joining a Cast session another device started gets a one-way
connection (it sends, but hears no media status, receiver status or load
acknowledgements), so it loaded its own queue and kept re-sending it. With
sync on, when the session says another of the user's devices is casting to
the picked Cast device (`SessionFollower.castingElsewhere`: output kind `cast`,
active, same name, and the same Cast session: a cast claim carries
`castSessionId`, held in server memory per grant, and the device re-claims when
its Cast session changes. Picking the device on Android starts a new Cast
session instead of joining, which must not count; prod 22:16:20), the device leaves the Cast session again
(`endCurrentSession(false)`, `cast-join-left`, no handoff) and remembers that
device as the remote target, so it controls the Cast device through the
device casting to it.

Relay limits (prod 2026-10-14, phone casting and locked, desktop as remote):
Android stretches a background tab's timers, so the playing device reports at
once after a command, not on a timer. A Cast output silent for over a minute
(server: unreachable) stays followed, marked `silent`: nothing is sent to it,
and an action here asks "Play here instead?" rather than starting a second
playback alongside the Cast device, which most likely plays on. Infinity does
not top up the queue on a following device (it is a copy). Infinity
continuing with the phone asleep needs Phase 4/5.

Step 4 (taken over while casting): `actionWhenReplaced` (SessionMirror.ts)
decides. Another device casting to the same Cast device changes nothing. A
take-over that plays elsewhere makes a casting device stop casting
(`castManager.stopCastingBecauseReplaced`: stop + `endCurrentSession(true)`,
`cast-stopped-replaced`, no handoff to this device), so it becomes idle and
follows the new device. With the replacing output unknown it only pauses.

PRs: (1) `POST /playback-sessions/:id/commands` and the live-only
`playbackSession.command` event (server only); (2) the output carries
commands out (`src/utils/sessionCommands.ts`: SessionFollower passes on
commands for the grant this device holds, now; `load` adopts the session
queue with its entry IDs via `playSessionQueue`; while casting, the player
actions reach the Cast device and `session-command` goes to the Cast log); (3) the idle device's choice, remembered target, remote controls
and device chip (store `routeToPlayingDevice`, `remoteControlOutputId`,
`playWherePrompt`/`PlayWherePrompt`, `src/utils/sessionRemote.ts`,
`selectDisplayedPlaying`; queue taps go through `playQueueEntry`, seeks
through `seekTo`; Pause only reaches a chosen device and never asks); (4) a casting device that is taken over stops casting and
follows.

**PR 5 (who turns sync on, decided with Andreas 2026-10-13):** not a per-device
user setting.
- The admin chooses in Settings → System → Service: **Off** (the default),
  **On for everyone**, or **Each user decides** (`playbackSyncMode`, a system
  setting; only admins may write it, every user may read it).
- With "Each user decides", Settings → Playback shows the user's own toggle
  (`playbackSyncEnabled`, a per-user server setting with no admin fallback),
  so the choice is the same on every device they sign in on.
- `shared/playbackSync.ts` holds the rule; the store derives
  `syncPlaybackAcrossDevices` from the two, which is all SessionMirror and
  SessionFollower read. The old per-device flag in local storage is ignored.
- The server enforces it for every API v1 client alike (Andreas: "All API v1
  clients should be treated equally, as PWA and web"). While sync is off for
  the account, every `/api/v1/playback-sessions` route answers
  `403 PLAYBACK_SYNC_DISABLED` (`server/services/playbackSync.service.ts`,
  a path middleware in `apiV1.routes.ts`). Stored sessions are kept.
- Settings stay out of API v1 (Andreas): both keys are written and read only
  through the legacy `/api/settings`. What v1 clients see is the session API's
  availability: the 403 above, and `playbackSync.changed` (`{enabled}`) on
  `/events` after the admin's mode (to every user) or a user's own choice (to
  that user) changes.
- The web app re-reads the two settings on that event, when a session call
  is refused with `PLAYBACK_SYNC_DISABLED` (SessionMirror and SessionFollower
  stop at once, without retrying), and when it returns to the foreground (at
  most every 15 s), since a device with sync off has no event stream.
