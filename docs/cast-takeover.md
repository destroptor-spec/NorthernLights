# Cast takeover (spec)

**Status:** spec for Andreas's approval, revised 2026-11-02 around his
"grandma test". Nothing is built. It replaces #211's fallback (stop, then
Cast again) for everything except the rarest cases, and needs
`receiver-follow.js` and `receiver.html` changes. So the Cast care rules
apply: one issue per PR, and each PR tested on the NAD, the A9 and Stue TV.

## The outcome (Andreas, 2026-11-02)

I cast to my speaker. Another person casts to it and takes it over.

- **For them** it is seamless and quick, like casting any other app.
  - One press in the picker, and their music plays on the speaker within
    about 5 seconds, a normal cast's time.
  - Their app shows an ordinary cast: the Cast icon is lit, the device is
    named, play, pause, skip, seek and volume work, and Stop casting works.
  - Chrome's own Cast dialog agrees with the app.
- **For me** my app just goes back to not casting, paused here on the track
  and position the speaker was at. There's no toast and no message (logged
  only).
  - The same holds if my phone was locked or closed during the takeover. When
    it comes back it does not take on the other person's music.
  - My other devices show nothing playing on the speaker any more, and
    nothing about who took it: that's a different user (Andreas,
    2026-11-02).
- **Unchanged:** another device of mine casting to the same speaker still
  becomes its remote (`cast-join-left`). I never take over from myself.

## Why it isn't simple

- **Same app joins.** A Cast device already running Aurora's receiver hands a
  joining sender that running instance. Spotify is replaced in one press only
  because it's a different app.
- **The join is deaf.** Desktop Chrome joining a session another device
  started gets a one-way connection (2026-10-13, 2026-10-27, 2026-10-30,
  2026-11-02). Its messages reach the receiver, nothing comes back.
- **Chrome is deaf to the end too.** After a deaf join, stopping or leaving
  ends the session for the app, but Chrome's own Cast dialog keeps "casting
  to the NAD" for about 1.5 minutes. Its picker is refused until then
  (2026-11-02 21:42 and 21:47). So the new caster must not leave and pick
  again: it has to stay connected.
- **The receiver doesn't start on its own.** A receiver that starts following
  a session while nothing is loaded loads nothing ("nothing to line up" in
  `reconcile`).

## Design

The new caster keeps the Cast connection it got and hands the receiver its
own session through it. That direction always works. Its status then comes
through the server, where the receiver reports. That's the Phase 5 path, and
it doesn't care whether the connection is deaf.

### 1. Deciding, as the session connects

The new caster (B) decides at once, without waiting for the receiver:

1. **One of my own devices casts there** (sync on: my session's output is
   this device, by name, active or quiet): leave and become its remote, as
   today (`cast-join-left`, including #211's name check).
2. **This device's own receiver session** (a reload or recovery rejoining
   it): rejoin as today.
3. **Another account's session plays there:** take over (below). B learns
   this from the server: a new
   `GET /api/v1/cast-sessions/:castSessionId` answers `{ inUse: boolean }`.
   It means "some other account's output is on this Cast session" and
   reveals nothing else. It's additive to API v1, with no schema change: the
   server already knows receiver outputs' Cast session ids, and cast
   outputs' ids in memory.
4. **Nobody's** (a fresh launch, or an idle receiver app): cast as today.
   - **Fresh launch:** LOAD over Cast, then the Phase 5 handover after the
     first LOAD.
   - **Deaf join of an idle receiver app:** the 2026-10-27 case, rare. After
     #211's 5 s ping check, take over instead of stopping. This is the only
     case that waits.

Sync off: there's no session to hand over, so today's behaviour and #211's
stop and Cast again stay.

### 2. The takeover (B's side)

- **Claim and hand over.** B claims a receiver output for its own session on
  this Cast session, as the phone does after its first load today. It then
  sends `aurora.session.follow` with `takeover: true` and its position: where
  it was locally when it started casting, as a cast does today (Andreas,
  2026-11-02). No acknowledgement is awaited; it's sent up to three times.
- **Confirmed through the server:** the receiver's first report on B's grant.
- **B stays connected and casts "through the server".** The Cast icon and
  device name show as for any cast.
  - **Commands:** play, pause, skip, seek, queue taps and volume go to the
    receiver output through the server (the Phase 5 commands, #208 for
    volume).
  - **State and progress:** from the receiver's reports.
  - **Switched off:** Cast-media watchdogs, playback confirmation and
    transport recovery. In this mode silence on the Cast connection is
    expected.
- **Stop casting (the app's or Chrome's dialog):** reaches the receiver over
  the same connection. B goes back to playing locally, paused, as for any
  stop.
- **No confirmation within 10 s:** #211's stop and Cast again, the last
  fallback.

### 3. The receiver

On a handover with `takeover: true`:
1. **End the old session:** if it follows another session (A's), report a
   final `stopped` with reason `taken-over` on A's grant, then stop following
   it.
2. **Start the new one:** follow B's session and load its current entry at
   the given position. That's needed because an idle receiver doesn't start
   by itself.
3. **Say whose it is:** `aurora.status` carries the followed session's id
   (`followSessionId`, opaque), so any sender can tell whose session plays
   there.

A handover without `takeover` keeps today's 6a-1 check: it's refused while
another session still plays there. A background refresh, a renewal or a
stale claim can never take a receiver.

### 4. The replaced phone (A's side)

- **While attached and hearing:** when `aurora.status` names a
  `followSessionId` that isn't A's session, A's phone
  - leaves the Cast session (`endCurrentSession(false)`, never a stop, since
    B's music plays there now);
  - goes back to local, paused on the track and position the receiver was
    at (today's paused handoff, as when a cast is stopped elsewhere,
    checklist row 12);
  - clears every casting sign;
  - logs `cast-taken-over`, with no toast.
- **When it wakes or reloads later:**
  - A's session output already ended with `taken-over` (server).
  - A rejoin finds the receiver following another session.
  - Either way A leaves the same way and doesn't hydrate the receiver's
    media.
- **A's other devices:** they see A's output stop through the server, as for
  any stop.

## Speed budget

Picker to SESSION_STARTED is about 1.5 s. Then the in-use check takes about
0.2 s, the claim and handover about 0.5 s, and the receiver reading the
session and loading about 2 s. That's music in roughly 4–5 s, the same as a
fresh cast today (picker about 2 s, join wait 1.5 s, load about 3 s).

## PRs, in order

1. **Server:** `GET /api/v1/cast-sessions/:castSessionId`, with tests,
   `docs/API.md` and `api:generate`. Changes nothing by itself.
2. **Receiver:** `takeover: true` (final report on the old grant, follow,
   load at the position), plus `followSessionId` in `aurora.status`. Tests in
   `receiverFollow.test.ts`. Changes nothing by itself: no sender sets the
   flag.
3. **Replaced phone (A):** leave on another `followSessionId`, live and on
   wake. Paused locally, no toast.
4. **New caster (B):** the in-use check, the takeover, casting through the
   server, and the deaf-idle case. #211's fallback stays last.

## Grandma checks

| # | Steps | B (new caster) | A (replaced) |
|---|---|---|---|
| T1 | A's phone (account A) casts to the NAD. On the desktop (account B), pick the NAD | B's music plays within about 5 s. The desktop shows casting to the NAD; pause, skip, seek and volume work; Chrome's dialog says casting | The phone shows not casting, paused on its track, with no toast |
| T2 | T1 with A's phone locked; unlock it a minute later | As T1 | On unlock the phone shows not casting and paused, not B's music |
| T3 | After T1, B taps Stop casting (app, or Chrome's dialog) | The NAD stops; the desktop shows not casting, paused | — |
| T4 | Same account: the phone casts and the desktop picks the NAD | As today: the desktop becomes the remote, the phone plays on | — |
| T5 | The idle receiver app (the phone stopped casting less than 5 minutes ago), then the desktop picks the NAD | B's music plays within about 8 s, with no Cast again | — |
| T6 | T1 on the A9 and on Stue TV | As T1 (the A9 may take a few seconds longer) | As T1 |

## Decided (Andreas, 2026-11-02)

- **Where B starts:** at the position B was at locally when it started
  casting, as a cast does today.
- **Who took over:** not shown anywhere. It's a different user, and A's
  devices treat it as such: the speaker simply isn't playing A's music any
  more.
