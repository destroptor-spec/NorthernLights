# Listen together (Phase 6)

**Status:** spec, not started. Andreas's direction and answers 2026-10-27.
Builds on [playback_sessions.md](playback_sessions.md)
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
- **Invites** work only between users on the same server. An invite prompts
  the users the owner picks, if they are online, and always gives a join URL.
- **The join URL works for anyone on the server** who has it, like a share
  link.
- **Visibility:** private (default, as today), invite only, or discoverable
  by other online users in the same location.
- **"The same location"** is the same public IP address. Invites work
  wherever the invitee is.
- **Before joining,** a user sees "{owner}'s session" and the members as
  avatars: the owner's set apart, the guests' stacked. Nobody's name but the
  owner's, and nothing about what plays.
- **Joining** ends the guest's own playback.
- **Ending** the session (owner only) removes everyone else from it. The
  music keeps playing.
- **Guests' scopes include** repeat, shuffle and Infinity.
- **Plays and scrobbles** count for the owner only.
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
- `invite`: joining needs the session's join URL.
- `discoverable`: online users in the same location see it and can join
  without an invite (see [Discovery](#discovery)).

### Invites

```
playback_session_invites
  token         TEXT PRIMARY KEY            -- the join URL's token (random, 32 bytes)
  session_id    UUID → playback_sessions ON DELETE CASCADE
  permissions   TEXT[]                      -- what joining through it grants
  created_by    UUID → users
  created_at, revoked_at
```

An invite is a link, not a person (Andreas: the join URL works for anyone on
the server).
- **Who can use it:** anyone signed in on this server who opens
  `/listen/<token>` can join, as many people as want to.
- **Prompts:** inviting online users sends each of them the same link as a
  prompt (an event, no row of its own).
- **How it ends:** it works until the owner revokes it or ends the session;
  a new link replaces the old one.
- **More than one:** the owner can hold several links with different scopes,
  once per-invite scopes have a UI (6f).

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
- **What they see before joining:** see [Before joining](#before-joining).
- **Limits:**
  - a phone on mobile data, or behind a VPN, won't see it;
  - carrier-grade NAT could show it to a user of this server elsewhere.

  Both are acceptable, because only users of this server are involved.
- **Invites ignore location** (decided): a join URL works wherever the guest
  is, even though they hear nothing there.

## Before joining

The same preview everywhere: the invite prompt, `/listen/<token>`, and the
nearby row in Connect.
- **Title:** "{owner}'s session", from the owner's username ("Andreas'
  session" for names ending in s).
- **Avatars:** the owner's avatar on its own, then the guests' avatars
  stacked (overlapping, "+N" past four).
  - Users have no pictures yet; an avatar is the username's first letter, as
    on the account page (Andreas, 2026-10-27: fine for now; Gravatar or
    uploaded pictures later).
- **Nothing else:**
  - no guest names (not even on hover or to screen readers, which hear
    "{owner} and {n} others");
  - not what's playing, the queue, or the device.

The preview's API answer carries only what the screen shows: the owner's
name, and for each member a user ID and an avatar.

### Avatars in API v1

Pictures come later, so v1 describes an avatar in a way that won't have to
change. One shape (`UserAvatar`) is used wherever a user is shown: the
preview, members, the online-users picker.

```
UserAvatar { userId, initial, pictureUrl: string | null }
```

- **Now:** `pictureUrl` is always null, and clients draw the initial.
- **Later:** Gravatar or uploaded pictures fill `pictureUrl`. A client that
  shows `pictureUrl` when present and falls back to the initial works before
  and after.
- **Pictures go through the server:** the URL will point at Aurora (for
  example `/api/v1/users/:id/avatar`), never straight at Gravatar. Clients
  then don't leak who looks at whom to a third party, and the service worker
  doesn't need cross-origin images.

## Joining, leaving, ending

- **Joining:** joining through a link, or joining a discoverable session, makes
  the user a member.
  - The device they joined on shows the shared session: queue, what plays,
    controls.
  - The guest's own playback ends (decided): whichever of their devices plays
    their own session stops it, and stops casting it. Their own queue stays,
    to return to.
  - The guest's other devices show "Listening with {owner}" in Connect, with
    "Open" to switch to the shared session.
- **Leaving:** a guest leaves from Connect. Their devices return to their own
  session, with nothing playing.
- **Removing:** the owner removes a guest. For that guest it's the same as
  leaving, with a short notice ("{owner} removed you").
- **Ending** (decided): the owner ends the session. Every guest is removed,
  every invite link dies, and visibility goes back to private. The music
  keeps playing for the owner.
- **Owner away:** the owner's devices may close while the NAD plays
  (Phase 5: the receiver follows the session itself). Guests keep control,
  and existing links still let people join; new links, prompts and removals
  wait until the owner is back.

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
  - to each prompted user: `playbackSession.invitePrompt`, with the link and the
    preview;
  - to users nearby: `playbackSession.discoverable`, which says that one appeared
    or went.
- **A guest's stream** carries the shared session's events, and nothing else
  of the owner's (not their devices, and not their own other sessions).

## Plays, history, Infinity

- **Plays and scrobbles** count for the owner only (decided), as today, from
  the output's reports.
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
| `GET /playback-sessions/:id/invites` | owner | the working links, newest first |
| `POST /playback-sessions/:id/invites` `{permissions?}` | owner | create a join link: returns its token and URL |
| `DELETE /playback-sessions/:id/invites/:token` | owner | revoke a link |
| `POST /playback-sessions/:id/invites/:token/prompt` `{userIds}` | owner | prompt online users with the link |
| `GET /session-invites/:token` | any | the preview (see [Before joining](#before-joining)) |
| `POST /session-invites/:token/join` | any | join through the link |
| `GET /playback-sessions/nearby` | any | discoverable sessions in my location |
| `POST /playback-sessions/:id/join` | any nearby | join a discoverable session |
| `POST /playback-sessions/:id/together/end` | owner | end listening together |
| `GET /users/online` | any | users of this server with an open event stream (names only), for the invite picker |

New errors:
- `403 SESSION_OWNER_ONLY`;
- `403 SESSION_SCOPE_DENIED`, with `details.need`;
- `404 SESSION_INVITE_NOT_FOUND`, for a revoked link or an ended session;
- `409 SESSION_NOT_JOINABLE`.

## UI

- **Owner, in Connect:** a "Listen together" row after the other devices. It
  opens a sheet with:
  - visibility (Private / Invite only / Nearby can join);
  - "Invite": copy the join link, or prompt users from a list of who's
    online;
  - the guests, each with Remove;
  - "End listening together".
- **Invitee:** a prompt with the preview, Join and Not now. It's an action,
  so text is fine here. "Not now" only closes it. `/listen/<token>` shows the
  same preview and choice.
- **Guest:**
  - Connect is headed "Listening with {owner}", lists the playing device
    (marked) and offers "Leave";
  - the player and queue look as for remote control today;
  - controls without the scope are disabled, with no text.
- **Nearby:** a user who sees a discoverable session gets a row in their
  Connect card with the preview and "Join".

No status text while things work (as everywhere): joining, leaving and
commands just take effect, with text only when they fail.

## Security

- **Authorisation:** every session read and write goes through
  `authorizeSession`. A stranger gets 404, not 403, so session IDs don't
  confirm that a session exists. Guests never receive output credentials or
  receiver tokens.
- **Before guests can join (prerequisites from playback_sessions.md, "Before
  building"):**
  1. **Media tokens on the Cast session.** Every sender on it, and anything on
     the network that can see the Cast session (Android's Cast media controls
     on a visitor's phone), can read the owner's 30-day media token from item
     URLs, `customData` and artwork URLs.
     - **What the token opens:** only streams, artwork and the Cast log, since
       scoped tokens are enforced per endpoint.
     - **Guests gain nothing from it:** they are users of the server and
       already stream the whole library with their own token.
     - **The real exposure:** people who are not users.
     - **Fix**, done before Phase 6 anyway (Andreas, 2026-10-27):
       - 6a-2: a short-lived Cast media token, renewed with the receiver's
         credential, and no fallback to the login token anywhere
         (`mediaAccessToken: data.mediaToken || data.token`);
       - 6a-3: no token in anything Cast broadcasts; the receiver adds it to
         each request itself;
       - 6a-4: signed per-image artwork links (built 2026-10-27).
  2. **Handover from any sender.** A guest's phone on the Cast session could
     point the receiver at its own session. Cast itself lets anyone on the
     network take the speaker over; this was a quieter way, where the owner's
     session still believed the receiver played for it.
     - **Fix (6a-1):** a handover for another session waits for a check with
       the server, and is taken only once the receiver's own session no
       longer plays there.
- **Joining a Cast session that's already running ("deaf joiner"),** to settle
  before guests use Cast. Known since 2026-10-13, and seen again on prod
  2026-10-27 12:33.
  - **What happens:** desktop Chrome joining a Cast session a phone started
    gets a one-way connection. Its commands reach the receiver, but no media
    status, `aurora.status` or load acknowledgement comes back. The sender
    believes nothing plays, so it loads again, which restarts the track, and
    ends with `playback-unconfirmed`.
  - **Today's guard doesn't always apply:** the joining device leaves
    (`cast-join-left`) only while another of the same user's devices holds
    the output. On 2026-10-27 the phone had dropped off in a server restart,
    the receiver app kept running, and the desktop joined it.
  - **With guests:** a guest never casts the shared session (the owner
    chooses where it plays), but a guest's phone joining the owner's Cast
    session from Chrome's picker is exactly this case. 6d should keep guest
    devices out of the owner's Cast session (leave on join, as
    `cast-join-left` does). The owner's own devices need a fix for a joined
    session that never answers: leave it and start a new one.
- **Before joining,** discovery and links show only the preview: the
  owner's name and initials.
- **A join link is a bearer link within the server** (decided): anyone on the
  server who gets it can join with its scopes.
  - The owner sees who joined, and can remove them or revoke the link.
  - Links are random 32-byte tokens, never logged.
  - Joins are rate-limited per user.

## Plan

One PR each, in this order:

1. **6a: Cast trust boundary**, four PRs, each verified on the NAD and the A9
   before the next:
   - 6a-1, the handover check;
   - 6a-2, the short-lived Cast media token, with no login-token fallback;
   - 6a-3, no token in anything broadcast (capability-gated, so receivers
     already running during a deploy keep working);
   - 6a-4, signed artwork links.
2. **6b: Members and permissions on the server.** Built 2026-10-27. The schema was signed off by Andreas the same day:
   - `visibility`;
   - `playback_session_members`, one session per guest;
   - `playback_session_invites`.

   He also decided that guests see their own loves, and that a guest's sync follows the owner's setting.
   - Schema (needs sign-off), `authorizeSession`, `sessionOperationScope` and
     the guest refusals;
   - event fan-out to members, and the matrix tests.
   - No UI: shared sessions can't exist yet outside tests.
3. **6c: Invites.** API, events, join links, the prompt with its preview,
   `/listen/<token>`, and the owner's sheet (visibility Private / Invite
   only, invite, remove, end). Two PRs:
   - 6c-1, the server API and events (built 2026-10-27, no schema change;
     `sessionMembers.service.ts`). A prompt for a session that went private
     is refused like a join;
   - 6c-2, the web UI: the owner's sheet in Connect, the invite prompt, and the
     `/listen/<token>` page.
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

## Answered (2026-10-27)

1. **"Same location"** is the same public IP; invites work from anywhere.
2. **Ending** removes everyone else; the music keeps playing.
3. **Repeat, shuffle and Infinity** are guest controls (under `queue` and
   `replace`).
4. **Plays and scrobbles** count for the owner only.
5. **The join URL** works for anyone on the server.
6. **Before joining:** "{owner}'s session" with avatars, the owner's set
   apart and the guests' stacked; no guest names, nothing about what plays.
7. **The guest's own playback** ends when they join.

## Later

- **User pictures** (Gravatar or uploads): separate work after Phase 6
  (Andreas, 2026-10-27). v1's `UserAvatar.pictureUrl` is already in place for
  them.
