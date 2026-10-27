# Listen together (Phase 6)

**Status:** spec, not started. Andreas's direction 2026-10-27; open
questions at the end. Builds on [playback_sessions.md](playback_sessions.md)
(Phases 0–5) and [cast-receiver-output.md](cast-receiver-output.md).

## What it is

**Local listen together:** everyone is in the same place, listening to the same
music from one device: the owner's computer or phone, or a Cast device such as
the NAD. Other people on the same server join the owner's playback session from
their own phones and control it. Their phones play nothing.

**Remote listen together** (each participant plays the audio on their own
device, in different places) is a later phase and not covered here. Nothing below should
rule it out.

## Decided (Andreas, 2026-10-27)

- **One owner, for good.** The owner is the user who started the session. No
  one else can become owner.
- **The owner alone** decides where the audio plays (their own devices or
  Cast), ends the session, manages participants, and sets visibility.
- **Guests** control playback: start, pause, skip, play next, reorder, start
  something new, and remove from the queue. Everything about *what* plays, nothing
  about *where*.
- **Invites** work only between users on the same server.
- **Visibility:** private (default, as today), invite only, or discoverable
  by other online users in the same location.
- **An invite** prompts the invitee if they are online, and always gives a
  join URL.
- **Per-guest scopes** (queue, play/pause, change music) are preferred if they
  don't blow up scope and tests; not required for the MVP. See
  [Permissions](#permissions): storing and checking them costs little, so the
  server gets them in the MVP and the UI can follow.

## Model

### Owner and members

A session keeps its owner (`playback_sessions.user_id`, unchanged). Guests are
rows in a new table:

```
playback_session_members
  session_id   UUID → playback_sessions ON DELETE CASCADE
  user_id      UUID → users ON DELETE CASCADE
  permissions  TEXT[]  -- subset of {transport, queue, replace}
  invited_by   UUID → users ON DELETE SET NULL
  joined_at    TIMESTAMPTZ
  PRIMARY KEY (session_id, user_id)
```

The owner is never a member row; ownership stays the existing column. A user
can be a guest in at most one session at a time (joining another leaves the
first).

### Visibility

`playback_sessions.visibility TEXT NOT NULL DEFAULT 'private'`, one of
`private | invite | discoverable`.

- `private`: no guests can join. Turning a session private does **not**
  remove guests already in it; the owner removes them, or ends listening
  together.
- `invite`: joining needs an invite.
- `discoverable`: online users in the same location see it and can join
  without an invite (see [Discovery](#discovery)).

### Invites

```
playback_session_invites
  id            UUID PRIMARY KEY            -- also the join URL's token
  session_id    UUID → playback_sessions ON DELETE CASCADE
  invitee_id    UUID → users ON DELETE CASCADE
  permissions   TEXT[]
  created_by    UUID → users
  created_at, expires_at (24 h), accepted_at, declined_at, revoked_at
```

An invite names one user. Its URL (`/listen/<id>`) works only for that user,
signed in on this server; for anyone else it says the invite isn't theirs. It
is spent when accepted, and dies when it expires, is revoked, or listening
together ends.

All three tables are additive. Prod shares its database with the dev channel,
so the schema needs Andreas's sign-off before it lands.

## Permissions

Three scopes, checked on the server for every request a guest makes:

| Scope | Covers |
|---|---|
| `transport` | play, pause, seek, next, previous, jump to an entry |
| `queue` | insert, play next, move, remove; repeat and shuffle |
| `replace` | start something new (replace the queue, `load`), Infinity on/off |

- **Owner:** everything, plus what no guest can do: claim the output (play
  here, Cast, transfer to a device), end listening together, change
  visibility, invite, remove guests.
- **Guest:** the invite's scopes. The MVP UI offers one preset, "Can
  control playback" (all three). Per-invite toggles are a later UI change; the
  server enforces scopes from day one.

Why it stays small to test: every session operation maps to exactly one scope
in one table (`sessionOperationScope`), and one authorisation function decides
for every route (`authorizeSession(userId, sessionId, need)`). The tests are
one table-driven matrix (operation × owner/guest-with/guest-without/stranger),
not a test per route per role.

## Discovery

"The same location" needs a definition the server can check. Proposal: **the
same public IP address** as one of the owner's devices that has an open event
stream (`getTrustedClientIp`, which already honours `TRUSTED_PROXY_MODE`).

- **Who sees a discoverable session:** online users on this server whose event
  stream comes from that same address.
- **What they see before joining:** the owner's display name and the playing
  device's name, not the queue.
- **Limits:**
  - a phone on mobile data, or behind a VPN, won't see it;
  - carrier-grade NAT could show it to a user of this server elsewhere.

  Both are acceptable, because only users of this server are involved.
- **Invites ignore location,** so "invite only" works wherever the guest is,
  even though they hear nothing there.

## Joining, leaving, ending

- **Joining:** accepting an invite, or joining a discoverable session, makes
  the user a member.
  - The device they joined on shows the shared session: queue, what plays,
    controls.
  - If that device was playing the guest's own session, it pauses. Their own
    session stays as it was, to return to.
  - The guest's other devices show "Listening with {owner}" in Connect, with
    "Open" to switch to the shared session.
- **Leaving:** a guest leaves from Connect. Their devices return to their own
  session, paused.
- **Removing:** the owner removes a guest. For that guest it's the same as
  leaving, with a short notice ("{owner} removed you").
- **Ending:** the owner ends listening together. Every guest is removed,
  pending invites die, and visibility goes back to private. The music plays on
  for the owner (see open question 2).
- **Owner away:** the owner's devices may close while the NAD plays
  (Phase 5: the receiver follows the session itself). Guests keep control;
  inviting and removing wait until the owner is back.

## Where the audio plays

The owner alone holds the output, as today.

- Claim, transfer and receiver handover are refused for guests
  (`403 SESSION_OWNER_ONLY`).
- A guest device never plays the shared session. Its Play, Pause and the rest
  go as session commands (`POST /playback-sessions/:id/commands`, which
  already exists for remote control) to whichever device holds the output:
  the owner's browser, the owner's casting browser, or the receiver.
- Queue edits go as patches (`PATCH /playback-sessions/:id`). Revisions already
  serialise concurrent edits, so nothing new is needed for several people
  editing.
- **The guest's Connect card:**
  - shows the playing device, marked;
  - shows who they're listening with, and "Leave";
  - has no Cast row, no "This device" and no other devices for the shared
    session. Where it plays isn't theirs to choose.

## Events

Today `/events` goes per user. A shared session's events must reach every
member's stream as well as the owner's.
- **Changes on a shared session** go to all of them: patches, reports,
  commands, handoffs, and the new member events.
- **New event types:**
  - `playbackSession.memberJoined`, `playbackSession.memberLeft` (with the
    reason: left, removed, ended), `playbackSession.visibilityChanged` and
    `playbackSession.togetherEnded`;
  - to the invitee: `playbackSession.invited` and `playbackSession.inviteRevoked`;
  - to users nearby: `playbackSession.discoverable`, which says that one appeared
    or went.
- **A guest's stream** carries the shared session's events, and nothing else
  of the owner's (not their devices, and not their own other sessions).

## Plays, history, Infinity

- **Plays and scrobbles** count for the owner only, as today, from the output's
  reports. Counting them for guests too is an option for later (open question 4).
- **Infinity** draws on the session's seeds and the owner's settings. A guest
  can switch it on or off with `replace`.
- **Loves and ratings** are per user already: a guest loving the playing track
  loves it for themselves.

## API v1

All of it is in v1, for the future first-party apps; nothing goes on legacy
routes. Sessions a user can see are their own, plus the one they're a guest in.

| Method and path | Who | Does |
|---|---|---|
| `GET /playback-sessions` | any | own sessions + the shared one (with `role: owner \| guest` and `permissions`) |
| `PATCH /playback-sessions/:id/sharing` `{visibility}` | owner | set visibility |
| `GET /playback-sessions/:id/members` | owner, guests | owner and guests with names and scopes |
| `DELETE /playback-sessions/:id/members/:userId` | owner (anyone), guest (self) | remove / leave |
| `POST /playback-sessions/:id/invites` `{userId, permissions?}` | owner | invite: returns the invite and its join URL |
| `DELETE /playback-sessions/:id/invites/:inviteId` | owner | revoke |
| `GET /session-invites` | any | my pending invites |
| `POST /session-invites/:id/accept` · `/decline` | invitee | join / say no |
| `GET /playback-sessions/nearby` | any | discoverable sessions in my location |
| `POST /playback-sessions/:id/join` | any nearby | join a discoverable session |
| `POST /playback-sessions/:id/together/end` | owner | end listening together |
| `GET /users/online` | any | users of this server with an open event stream (names only), for the invite picker |

New errors:
- `403 SESSION_OWNER_ONLY`;
- `403 SESSION_SCOPE_DENIED`, with `details.need`;
- `404 SESSION_INVITE_NOT_FOUND`, which is also the answer for someone else's
  invite, so nothing leaks;
- `409 SESSION_NOT_JOINABLE`.

## UI

- **Owner, in Connect:** a "Listen together" row after the other devices. It
  opens a sheet with:
  - visibility (Private / Invite only / Nearby can join);
  - "Invite", a list of online users;
  - the guests, each with Remove;
  - "End listening together".
- **Invitee:** a prompt with Join and Not now. It's an action, so text is
  fine here. `/listen/<id>` shows the same choice.
- **Guest:**
  - Connect is headed "Listening with {owner}", lists the playing device
    (marked) and offers "Leave";
  - the player and queue look as for remote control today;
  - controls without the scope are disabled, with no text.
- **Nearby:** a user who sees a discoverable session gets a row in their
  Connect card: "{owner} is listening nearby · Join".

No status text while things work (as everywhere): joining, leaving and
commands just take effect, with text only when they fail.

## Security

- **Authorisation:** every session read and write goes through
  `authorizeSession`. A stranger gets 404, not 403, so session IDs don't
  confirm that a session exists. Guests never receive output credentials or
  receiver tokens.
- **Before guests can join (prerequisites from playback_sessions.md, "Before
  building"):**
  1. **Media tokens on the Cast session.** Every sender on it can read the
     owner's 30-day media token from item URLs. With guests in the room, their
     phones can join the Cast session (Chrome's picker, Android's media
     controls).
     - **Fix:** the receiver streams with a short-lived media token bound to
       the session, renewed with its receiver credential, never the owner's
       login token.
     - Also confirm no client still falls back to the full session token for
       media (`mediaAccessToken: data.mediaToken || data.token`).
  2. **Handover from any sender.** A guest's phone on the Cast session could
     point the receiver at its own session.
     - **Fix:** the receiver checks a handover against the session's current
       output grant before it switches, and says which session it follows (an
       opaque ID) in `aurora.status`.
- **Discovery** shows names only: no queue, no artwork, until someone joins.
- **Invites and joins** are rate-limited per user. An invite URL is useless to
  anyone but its invitee.

## Plan

One PR each, in this order:

1. **6a: Cast trust boundary.** The two security prerequisites. Sender and
   receiver, one issue per PR with the usual Cast care (sender-side where
   possible); verify on the NAD and the A9.
2. **6b: Members and permissions on the server.**
   - Schema (needs sign-off), `authorizeSession`, `sessionOperationScope` and
     the guest refusals;
   - event fan-out to members, and the matrix tests.
   - No UI: shared sessions can't exist yet outside tests.
3. **6c: Invites.** API, events, the invite prompt, `/listen/<id>`, and the
   owner's sheet (visibility Private / Invite only, invite, remove, end).
4. **6d: The guest client.** The shared session on the guest's device, the
   guest Connect card, and controls by scope.
5. **6e: Nearby.** Discoverable sessions by public IP, and the "Join" row.
6. **6f (optional): per-invite scope toggles** in the invite sheet.

**Done when** (from the migration plan): two accounts edit one queue playing on
the NAD.

On devices, that means:
- the guest's phone controls the NAD with the owner's phone locked;
- the owner removes the guest, and the guest's controls stop at once;
- ending listening together leaves the owner's music playing.

## Open questions

1. **"Same location"** = same public IP as one of the owner's online devices?
   Or something else, such as the same Cast device?
2. **Ending:** does "End listening together" only stop sharing (music plays
   on), or should the owner also get "Stop" there?
3. **Guests and Infinity / repeat / shuffle:** are they part of "anything
   related to playing" (as proposed: Infinity under `replace`; repeat and
   shuffle under `queue`)?
4. **Plays and scrobbles for guests:** owner only (proposed), or also for each
   guest who opts in?
5. **Invite URL:** bound to the invitee (proposed), or usable by anyone on the
   server who has it, like a share link?
6. **Before joining a discoverable session:** names only (proposed), or also
   what's playing?
7. **The guest's own music when joining:** pause it (proposed), or leave it
   playing on that device?
