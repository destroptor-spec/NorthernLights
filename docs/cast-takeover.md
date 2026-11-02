# Cast takeover (spec)

**Status:** spec for Andreas's approval, reworked 2026-11-02 around a status
relay. Nothing is built. It replaces #211's fallback (stop, then Cast again),
and needs `receiver.html` changes. So the Cast care rules apply: one issue per
PR, and each PR tested on the NAD, the A9 and Stue TV.

## The outcome (Andreas, 2026-11-02)

I cast to my speaker. Another person casts to it and takes it over.

- **For them** it is seamless and quick, like casting any other app.
  - One press in the picker, and their music plays on the speaker from where
    they were, in about a normal cast's time.
  - Their app shows an ordinary cast: the Cast icon is lit, the device is
    named, play, pause, skip, seek and volume work, and Stop casting works.
  - Chrome's own Cast dialog agrees with the app.
- **For me** my app just goes back to not casting, paused here on the track
  and position the speaker was at. There's no toast and no message (logged
  only), and nothing about who took over: that's a different user.
  - The same holds if my phone was locked or closed during the takeover.
  - My other devices show nothing playing on the speaker any more.
- **Sync on, my own devices:** unchanged. Another device of mine picking the
  same speaker becomes its remote (`cast-join-left`, #211's name check
  included). I never take over from myself.
- **Sync off:** every device counts as a different user (Andreas,
  2026-11-02). The last device to cast wins, and the device it replaces
  steps back as above.

## Why it isn't simple

- **Same app joins.** A Cast device already running Aurora's receiver hands a
  joining sender that running instance. Spotify is replaced in one press only
  because it's a different app.
- **The join is often deaf.** Desktop Chrome joining a session another device
  started gets a one-way connection (2026-10-13, 10-27, 10-30, 11-02). Its
  loads and commands reach the receiver, nothing comes back, and its next
  load restarts the track because it never heard the first one play.
- **Leaving doesn't help.** Chrome is deaf to the end too. After stopping or
  leaving, its own Cast dialog keeps "casting to the NAD" for about 1.5
  minutes and refuses the picker (11-02 21:42 and 21:47). So the new caster
  must stay connected.

## Design: last caster wins, the receiver says whose cast it is, and the server relays what the receiver says

### 1. The receiver knows whose cast plays

- **Every load carries its sender.** Every Aurora load carries the sending
  device's id (`castingClientId`, the app's `getAuroraClientId`) in its
  customData, next to the token it already carries.
- **The receiver remembers it** and puts `castingClientId` in every
  `aurora.status`.
  - While following a session (Phase 5), the casting device is the one that
    handed it over.
- **A load from another device takes over.**
  - **While following another device's session:** the receiver stops
    following it, after a final report on the old grant (`stopped`, reason
    `taken-over`), so that session's devices see it end.
  - **Loads the receiver builds itself** (`auroraFollow`) and loads from the
    same device change nothing.

### 2. The relay: the receiver's status, also through the server

- **What's sent:** alongside each `aurora.status` broadcast, the receiver
  posts the same status to the server (`POST /api/cast/status`), signed with
  the media token of what it plays, like `/api/cast/log` today. It carries
  its Cast session id (`getApplicationData().sessionId`). It's limited to
  one post a second, and while playing every 5 s, the status channel's own
  rhythm.
- **Who gets it:** the server passes it on as a live-only `cast.status` event
  `{ castSessionId, status }` on `/api/v1/events`, to that token's user only.
  `/events` works with sync off; only `/playback-sessions` is switched off.
- **Telling the replaced user:** when a takeover changes the token, the
  receiver posts one last status with the previous token, naming the new
  `castingClientId`. So the replaced user's devices hear that they were
  replaced even if they're deaf.
- **What it adds:** additive to API v1 (a new event type on `/events`), no
  schema change. Only the caster's own user ever sees its status.

### 3. The new caster (B)

- **Sync on and my own device casts there:** `cast-join-left`, as today.
- **Otherwise B loads its own queue from where it was.** That's after the
  usual 1.5 s join wait, the same as a fresh cast. A join no longer adopts
  media that another device put there; that's checklist rows 13–14 changing.
  Only media this device loaded itself (a reload rejoining its own cast) is
  taken on as today.
- **Why this is fair:** another account's B never hears the relay before
  loading, because the relay goes to whoever's token plays. So "load mine"
  is exactly last caster wins.
- **If B's join is deaf** (#211's ping goes unanswered), B listens for the
  relay. `cast.status` for its own Cast session id is treated exactly like an
  `aurora.status` heard on the Cast connection. That status covers the
  current entry, state, position, queue window, volume and `following`, so
  playback confirmation, the watchdogs and the Phase 5 handover see the
  receiver as alive.
  - **Commands still go over the Cast connection**, which works one way:
    play, pause, seek, queue inserts (`aurora.queue.insert`) and volume.
  - **With sync on, the Phase 5 handover follows as today**, after B's first
    load: the receiver no longer follows A, so it accepts. The relay carries
    its `following: true` to B.
  - **#211's stop and Cast again goes.** Silence on a deaf connection is
    expected now, not a failure. It stays only when no relay arrives at all
    within 10 s of the load (an old receiver page).
- **Listening with sync off:** B opens the event stream for `cast.status`
  even with sync off. Today the app opens it only with sync on.

### 4. The replaced device (A)

- **When it happens:** a status (heard directly or relayed) names a
  `castingClientId` other than this device while it casts, and, with sync on,
  not another device of the same user.
- **What A does:**
  - leaves the Cast session (`endCurrentSession(false)`, never a stop, since
    B's music plays there);
  - goes back to local, paused on the track and position from the last
    status of its own media (today's paused handoff, checklist row 12);
  - clears every casting sign;
  - logs `cast-taken-over`, with no toast.
- **Waking later:** the first status it hears names B, so it steps back the
  same way before hydrating anything. It never takes on B's music.
  - With sync on, A's session output has also ended with `taken-over`.

## Speed

Picker to SESSION_STARTED is about 1.5 s, the join wait 1.5 s, and the load
2–3 s. That's music in about 5–6 s, a fresh cast's time today. No step waits
for the deaf check.

## PRs, in order

1. **Server:** `POST /api/cast/status` (media-token auth, rate limited) and
   the `cast.status` event, with tests and `docs/API.md` (`api:generate`).
   Changes nothing by itself.
2. **Receiver:** `castingClientId` (from loads and handovers) in
   `aurora.status`; the takeover by another device's load; the relay posts,
   including the last one to the previous token. ES5, tests in
   `receiverFollow.test.ts` and a receiver harness. Changes nothing by
   itself: no sender sends `castingClientId` yet.
3. **Replaced device (A):** step back on another `castingClientId`, live and
   on wake, with no toast. Testable with PR 2 from a phone, whose joins hear.
4. **New caster (B):** `castingClientId` on loads, last caster wins on join
   (no adopting another device's media), the relay listener (also with sync
   off), and the relay counting as evidence of life. #211's stop and Cast
   again stays last.

## Grandma checks

| # | Steps | B (new caster) | A (replaced) |
|---|---|---|---|
| T1 | A's phone (account A) casts to the NAD. On the desktop (account B), pick the NAD | B's music plays from where B was, within about 6 s. The desktop shows casting to the NAD; pause, skip, seek and volume work; Chrome's dialog says casting | The phone shows not casting, paused on its track, with no toast |
| T2 | T1 with A's phone locked; unlock it a minute later | As T1 | On unlock the phone shows not casting and paused, not B's music |
| T3 | After T1, B taps Stop casting (app, or Chrome's dialog) | The NAD stops; the desktop shows not casting, paused | — |
| T4 | Sync on, same account: the phone casts and the desktop picks the NAD | As today: the desktop becomes the remote, the phone plays on | — |
| T5 | The idle receiver app (the phone stopped casting less than 5 minutes ago), then the desktop picks the NAD | B's music plays within about 6 s, with no Cast again | — |
| T6 | T1 on the A9 and on Stue TV | As T1 (the A9 may take a few seconds longer) | As T1 |
| T7 | Sync off: T1 between two devices of the same account | As T1 | As T1 |
| T8 | Sync off: T2 between two devices of the same account | As T2 | As T2 |

## Decided (Andreas, 2026-11-02)

- **Where B starts:** at the position B was at locally when it started
  casting, as a cast does today.
- **Who took over:** not shown anywhere. It's a different user.
- **Sync off:** every device counts as a different user.

## Risks

- **The relay depends on the server.** When the server is down or
  restarting, a deaf caster hears nothing. Playback goes on, but its progress
  and buttons only catch up when the server is back.
- **Adopting goes.** Rows 13–14, where one device takes on another's cast
  with sync off, change on purpose. Anyone used to joining a cast from a
  second device with sync off will now replace it instead.
