# Cast takeover in one press (spec)

**Status:** spec for Andreas's approval, 2026-10-30. Nothing is built.
It follows #211 (the deaf-join safety net) and needs `receiver.html` and
`receiver-follow.js` changes, so it follows the Cast care rules: one issue
per PR, sender side first, and each PR tested on the NAD, the A9 and Stue TV.

## Why

Picking the NAD on the desktop while another Aurora cast plays there (another
account's phone, or an idle receiver app left running) takes two presses
today, even with #211: the cast is stopped, then "Cast again" opens the
picker. Spotify takes one press: picking a device that plays Spotify closes
Spotify and starts Aurora.

The difference is the Cast platform, not the app.
- **Different apps:** the Cast device stops Spotify and launches Aurora's
  receiver.
- **Same app:** a device already running Aurora's receiver hands the joining
  sender that running instance. Chrome joins it, and a sender can't force a
  fresh launch.
- **The join is deaf:** desktop Chrome joining a session another device
  started gets a one-way connection (2026-10-13, 2026-10-27,
  2026-10-30 21:03 and 21:40). Everything it sends reaches the receiver. The
  pings, loads and stops all arrived. Nothing the receiver sends comes back.
- **A new cast needs the picker:** Chrome starts one only from its picker,
  opened by a tap. Opening it without one left Chrome's dialog half open
  (21:40:21).

## Goal (Andreas, 2026-10-30)

"As if a different app would cast: end cast, start the new one." One press:
whoever picked the device last plays there. The cast it replaces ends
gracefully. Its phone logs the takeover and gets **no toast**: it stops
playing and drops every "casting" sign in the UI.

## Idea

The deaf direction doesn't matter if the joining device never needs to hear
the receiver. Since Phase 5 a receiver can play a playback session on its own:
- **Commands** reach it through the server.
- **Reports** go back through the server.
- **The handover** is a single sender-to-receiver message
  (`aurora.session.follow`).

So the joining device can use the one-way connection to hand the receiver its
own session, then leave the Cast session and control the NAD through the
server, like your phone does when the NAD plays on its own.

## Flow

The desktop (account B) picks the NAD. The NAD's receiver app runs, either
idle or following account A's session.

1. **Join and detect deafness.** Chrome joins; the desktop pings and hears
   nothing for 5 s (#211's `cast-join-deaf`). A join that hears the receiver
   is unchanged.
2. **Claim.** Instead of stopping the receiver, the desktop claims a receiver
   output for its own session, as the phone does after its first load today:
   `kind: 'receiver'`, the joined Cast session's id, and a receiver
   credential.
3. **Hand over, with `takeover: true`.** The desktop sends
   `aurora.session.follow`, which reaches the receiver.
   - The new flag is set only on this path: right after the user picked the
     device in the picker and the join proved deaf.
   - No acknowledgement will come back. The desktop sends it up to three
     times, as today, and doesn't wait for an ack.
4. **Receiver takes over.**
   - **If it follows another session (A's):** it reports a final
     `state: 'stopped', reason: 'taken-over'` on A's grant, which ends A's
     output on the server. It broadcasts `aurora.follow.replaced`
     `{ sessionId: A's }` on the Aurora channel, then starts following B's
     session.
   - **If it follows nothing (the 2026-10-27 idle case):** it simply starts.
   - **Today's 6a-1 check stays for every handover without `takeover`.** A
     refresh or a retried claim still can't take a receiver from a session
     that plays there.
5. **The desktop confirms through the server.** The first report from the
   receiver on B's grant, seen in B's session (`playbackSession.progress` or
   the session read), is the confirmation. Then the desktop leaves the Cast
   session (`endCurrentSession(false)`, which Chrome handles; see #211 v2) and
   becomes the NAD's remote: B's session plays on `receiver:<castSessionId>`,
   and "Play where?" is already answered.
6. **A's phone, still a sender in that Cast session, hears
   `aurora.follow.replaced`** with its own session id. It:
   - leaves the Cast session (`endCurrentSession(false)`: never stops it,
     B's music plays there now);
   - pauses, with no handoff to local playback;
   - clears every casting sign: the Cast icon, "Playing on NAD", the device
     strip and Now Playing's device line;
   - logs `cast-taken-over`, with no toast.

   A's other devices see A's output stop through the server (step 4's final
   report), as for any stop.

## Fallbacks

- **No confirmation within 10 s** (the receiver refused, is too old, or the
  claim failed): fall back to #211 v3. The desktop stops the receiver, leaves,
  and offers "Cast again".
- **The receiver predates the takeover flag:** it refuses (6a-1) and the
  fallback applies. The receiver ships before the senders use the flag, so
  this only happens on a stale receiver page.
- **The desktop's own other device casts there** (sync on, own account): the
  existing `cast-join-left` path (leave, become the remote) still comes first,
  so nothing changes for one account.

## Safety

- **Same reach as Cast itself.** Only a device on the same network that
  picked the NAD in Chrome's picker can send the handover, and it carries a
  credential for the sender's own session. A takeover from another account is
  what Cast allows Spotify today: whoever casts last plays.
- **6a-1's guard holds.** A handover without `takeover` (a background
  refresh, a credential renewal, a stale claim) is checked with the server
  and refused while another session plays there, as today.
- **A's session is never changed by B.** A's queue stays as it was. Only A's
  output ends, reported by the receiver on A's own grant.

## PRs, in order

1. **Receiver** (`receiver-follow.js`, `receiver.html`):
   - `takeover: true` skips the other-session check: report
     `stopped`/`taken-over` on the old grant, then start the new one.
   - Broadcast `aurora.follow.replaced` with the old session id.
   - Markers: `receiver-follow-taken-over`, `receiver-handover-takeover`.
   - Unit tests in `receiverFollow.test.ts`.
   - On its own this PR changes nothing for users, because no sender sends the
     flag yet.
2. **The replaced phone** (`CastManager`): on `aurora.follow.replaced` for its
   own session, leave, pause, clear the Cast state, and log `cast-taken-over`,
   with no toast. Testable with PR 1 by casting from B's phone (its join hears
   the receiver), so the takeover is forced from a test build or console.
3. **The joining desktop** (`CastManager`, `SessionMirror`):
   - On `cast-join-deaf`: claim, hand over with `takeover`, confirm through
     the server, leave, and become the remote.
   - Fall back to v3 after 10 s without confirmation.
   - Markers: `cast-takeover-sent`, `cast-takeover-confirmed`,
     `cast-takeover-fallback`.

No server or schema change: receiver claims, reports with `reason` and
`playbackSession.progress` exist. API v1 is unchanged. The receiver's message
is Aurora-channel only.

## Checks on devices

- **Another account, one press:** A's phone casts to the NAD; on the desktop
  (B), pick the NAD.
  - The NAD switches to B's music within about 8 s.
  - A's phone stops casting with no toast.
  - The desktop shows "Playing on NAD" and its controls work.
- **Idle receiver app, one press:** the 2026-10-27 case. Cast from the phone,
  stop casting, then pick the NAD on the desktop within 5 minutes. B's music
  starts, with no "Cast again".
- **Same account:** with sync on, the phone casts and the desktop picks the
  NAD. As today: `cast-join-left`, the desktop becomes the remote.
- **Receivers:** the same on the A9 (slower) and Stue TV.
- **Fallback:** a receiver page from before PR 1. You get "Cast again" after
  about 15 s, nothing stuck.

## Open questions

- **Wait time.** The 5 s deafness wait plus the takeover: is about 8 s from
  picking the NAD to B's music acceptable, or should the ping wait be shorter
  for the NAD, with a longer one kept for the A9?
- **Root cause.** Why desktop Chrome is deaf on these joins is still unknown.
  One suspect is the desktop's "Failed to initialize Google Cast API …
  AutoJoinPolicy" error at startup. If that ever gets fixed, the takeover
  still works, because it never needs the receiver's replies.
