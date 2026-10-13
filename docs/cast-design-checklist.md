# Cast Design Compliance Checklist

Source of truth for Google Cast compliance across Aurora.

## Checklist Matrix

| Column | Description |
|--------|-------------|
| Checklist item | Specific compliance requirement |
| Required behavior | What must happen to satisfy the check |
| Current status | Compliant / Non-compliant / In Progress |
| Implementation file | Code location addressing this item |
| Verification step | How to test/verify the fix |
| Notes or platform limitation | Known constraints or exceptions |

## Google Cast Categories

1. Cast basics
2. Cast button
3. Cast dialog
4. Cast autoplay and queue
5. Sender app
6. Non-touch receiver app

---

## Phase 1: Compliance Tracker Setup

Establish the checklist matrix and map all categories above into a living tracking document.

---

## Phase 2: Cast Button Compliance

| Item | Details |
|------|---------|
| Current risk | Using Lucide Cast icon instead of official web Cast launcher behavior/state rendering |
| Implementation | Replace custom Cast buttons with reusable `CastButton` component; use `<google-cast-launcher>` where possible, wrapped in Aurora styling |
| Placement | Consistent placement across desktop `PlayerControls`, mobile `MobileNowPlaying`, and any playable screens without global controls |

### States to Implement

| State | Visual treatment |
|-------|-----------------|
| Unavailable | Hidden or greyed out |
| Disconnected | Outline icon |
| Connecting | Visibly distinct (animated/pulsing) |
| Connected | Device name label + filled/active icon |

### First-Time Education

- Small one-time coach mark when receivers first become available
- Persist dismissal in `idb-keyval` local storage

### Files to Modify

- `src/components/CastButton.tsx`
- `src/components/PlayerControls.tsx`
- `src/components/MobileNowPlaying.tsx`
- `src/components/MobileMiniPlayer.tsx`

### Acceptance Criteria

- [x] Cast button visible on all playable views when receivers are available
- [x] Connecting state is visibly distinct from other states
- [x] Connected state shows device name and filled/active visual treatment
- [x] First-time users get a short Cast explanation (coach mark)

Implementation note: `src/components/cast/CastButton.tsx` is the implemented path, not the original flat `src/components/CastButton.tsx` path listed above.

---

## Phase 3: Cast Dialog Compliance

| Item | Details |
|------|---------|
| Current state | SDK dialog used through `requestSession()` — correct |
| Implementation | Keep SDK dialog as the only receiver picker; ensure sender UI never duplicates custom receiver list |

### Wording & Error Handling

- Use "Disconnect" wording (not "Stop Casting") unless intentionally stopping receiver playback
- Add defensive UI states for: `session_error`, `cancel`, `invalid_parameter`

### Files to Modify

- `src/utils/CastManager.ts`
- `src/components/CastButton.tsx`

### Acceptance Criteria

- [ ] Cancel does not show error toast
- [ ] Real errors show concise recovery message
- [ ] Disconnect action matches Google wording and behavior

---

## Phase 4: Sender Controller Compliance

| Item | Details |
|------|---------|
| Current risk | Desktop, mobile mini, and mobile now-playing can drift if Cast controls are implemented as separate chrome |
| Implementation | Consolidate Cast control into existing `PlayerControls`, `ProgressBar`, `MobileMiniPlayer`, and `MobileNowPlaying` surfaces |

### Display Elements

- Artwork, title, artist, album, device name
- Playback state, progress, queue position
- Up Next, repeat state, volume slider

### Behavior Requirements

- Mobile Cast volume slider when casting
- Existing mini player reflects Cast device context while browsing the app
- Existing desktop and mobile player controls route play/pause/seek/next/previous/repeat/volume through Cast while connected
- Navigation away from Now Playing never stops casting

### Files to Modify

- `src/components/PlayerControls.tsx`
- `src/components/MobileMiniPlayer.tsx`
- `src/components/MobileNowPlaying.tsx`

### Acceptance Criteria

- [x] User can control play, pause, seek, next, previous, queue, repeat, and volume from sender while casting
- [x] Mobile mini player is the single compact playback surface while casting
- [x] Desktop controls show connected device context without opening a duplicate Cast modal

Implementation note: Cast sender controls are intentionally folded into the existing desktop and mobile player controls. Separate Cast mini players and Cast-only expanded controller modals were removed to avoid duplicate playback chrome.

---

## Phase 5: Queue & Autoplay Compliance

| Item | Details |
|------|---------|
| Current state | Runtime queue mutation exists — UX compliance incomplete |
| Implementation | Add explicit "Up Next" sender notification/toast before track transition when queue is active |

### Queue UX

- "Added to queue" toast with undo for Play Next / Add to Queue
- Queue controls: reorder, remove, clear all
- Queue history section or "Recently played in this session"

### Technical Requirements

- Keep Cast queue mutation APIs — do not reload the queue for simple edits
- Add retry/recovery UI when stale Cast transport recovery runs

### Files to Modify

- `src/store/index.ts`
- `src/components/PlaylistSidebar.tsx`
- `src/utils/CastManager.ts`

### Acceptance Criteria

- [x] Add, play next, remove, reorder, clear all work while casting
- [x] User gets visible confirmation and undo where appropriate
- [x] Cast playback is not interrupted by queue edits

Implementation note: queue mutation actions keep Cast queue API paths for append, Play Next, remove, and reorder. User-initiated Play Next/Add to Queue now show undoable toasts, auto-advance shows a compact `Up next` sender notification, and `PlaylistSidebar` keeps remove/clear undo.

---

## Phase 6: Receiver UI Compliance — Impeccable Pass

### Design Direction

| Attribute | Specification |
|-----------|--------------|
| Scene | TV or speaker display across a living room; user glances from several meters away, often in dim ambient light |
| Strategy | Restrained dark Aurora surface, matte glass only where it clarifies hierarchy, large readable metadata, minimal motion |
| Performance | Keep CPU/GPU light for Chromecast Gen 2 and Google TV |

### Receiver States

| State | UI behavior |
|-------|-------------|
| App loading | Aurora mark + spinner |
| Idle | App identity, "Ready to cast", subtle rotating tips or artwork every 30–60 s |
| Content loading | Title/artwork + spinner |
| Playback | Current title, artist, artwork, progress, app logo |
| Seeking | Temporary "Seeking" overlay + updated position |
| Paused | Pause icon + progress position; after 5 s fade non-essential UI, keep pause icon/title/artwork |
| Buffering | Show spinner only after short delay, then show content title if buffering continues |
| Error | Short friendly message + diagnostic log |

### Burn-In Protection

| Condition | Timeout behavior |
|-----------|-----------------|
| Idle receiver | Stops after 5 minutes |
| Paused receiver | Stops after 20 minutes (after saving position) |
| Long idle states | Slight low-frequency layout/palette shift |

### Technical Notes

- Keep CAF default player suppressed or remove `<cast-media-player>` entirely if Google TV still overlays it

### Files to Modify

- `public/receiver.html`
- `src/utils/CastManager.ts` (if receiver stop/resume signaling needs sender coordination)

### Acceptance Criteria

- [x] Receiver visibly identifies app in idle/loading/paused states
- [x] Loading and buffering states include animated spinner
- [x] Paused state includes pause icon, title/artwork, and position
- [x] Receiver stops after required idle/paused thresholds

Implementation note: `public/receiver.html` now starts in an explicit app-loading state, uses pending media metadata during LOAD, delays the buffering banner, shows an error state instead of collapsing to idle, fades non-essential UI after 5 seconds paused, rotates low-frequency idle tips/burn-in offsets, stops idle receivers after 5 minutes, and stops paused receivers after 20 minutes while logging the saved position.

---

## Phase 7: Notifications & Lock Screen

| Item | Details |
|------|---------|
| Current state | Media Session exists — needs audit while casting |
| Implementation | Audit Media Session metadata while casting |

### Requirements

- Ensure title, artist, artwork, duration, position, playback state, and actions are updated from Cast state
- Confirm Android PWA notification and lock screen controls work as much as browser permits
- Document browser limitations below

### Files to Modify

- `src/utils/PlaybackManager.ts`
- `src/utils/CastManager.ts`

### Browser Limitations

- Chrome/Android PWA has the best Media Session support: metadata, artwork, play/pause, previous/next, seek actions, and position state are exposed when the browser decides to surface a media notification.
- Safari/iOS Media Session support is partial and may ignore some action handlers or position updates. Aurora still sets metadata/actions defensively and degrades without errors.
- Browser Media Session is sender-side only. If the PWA/tab is fully killed by the OS, lock-screen controls may disappear even though the Cast receiver continues playback. Reopening Aurora should hydrate sender state from Cast and refresh metadata.
- Artwork rendering in OS notifications is browser-controlled and may be cached, cropped, or replaced by app icons depending on platform policy.

### Acceptance Criteria

- [x] Android PWA notification identifies content and exposes basic controls when supported
- [x] Lock screen metadata matches receiver
- [x] Unsupported browsers degrade cleanly

Implementation note: `PlaybackManager` now exposes a Media Session sync API for Cast snapshots and uses routed Cast time/duration for seek actions while casting. `CastManager` pushes current Cast media title, artist, album, artwork, duration, position, and playback state into the browser Media Session during session hydration, media-status changes, and receiver queue auto-advance.

---

## Phase 8: Reliability & Diagnostics

| Item | Details |
|------|---------|
| Current state | Strong foundation — add compliance-level observability |
| Implementation | Add checklist-specific log markers |

### Log Markers

- `cast-button-state`
- `receiver-state`
- `receiver-idle-timeout`
- `receiver-paused-timeout`
- `stale-transport-recovered`

Keep JWT redaction in logs. Add debug toggle in Settings > System or Playback for Cast diagnostics verbosity.

### Files to Modify

- `src/utils/CastManager.ts`
- `src/components/cast/CastButton.tsx`
- `src/components/settings/PlaybackTab.tsx`
- `src/store/index.ts`
- `public/receiver.html`
- `server/routes/media.routes.ts`

### Acceptance Criteria

- [x] `logs/cast-receiver.log` can reconstruct sender, receiver, queue, and lifecycle state

Implementation note: sender components emit checklist markers for Cast button state and stale transport recovery. The receiver emits `receiver-state`, `receiver-idle-timeout`, and `receiver-paused-timeout` markers independent of verbose network logging. Playback settings now expose separate Browser playback diagnostics and Cast diagnostics switches; Cast diagnostics updates capable active receivers over the Aurora namespace and retains Cast `customData` for initial loads and older receivers. `/api/cast/log` also performs server-side JWT/token/Bearer redaction and newline cleanup before writing to `logs/cast-receiver.log`.

---

## Phase 9: Verification Script

Current status: Completed — manual checklist plus repeatable log verifier.

### Manual Test Cases

Run these against at least one Chromecast and one Google TV target when available. Keep Playback > Cast diagnostics enabled for the full pass.

| # | Case | Expected result | Key log evidence |
|---|------|-----------------|------------------|
| 1 | First-time Cast button education | Cast launcher appears when receivers are available and the coach mark can be dismissed without affecting the SDK dialog | `cast-button-state` |
| 2 | Cast from desktop | Custom NorthernLights receiver opens, HLS starts, existing desktop player controls remain usable | `cast-button-state`, `receiver-state` |
| 3 | Cast from Android PWA | Android can connect to the custom receiver and maintain sender control after background/foreground | `cast-button-state`, `receiver-state` |
| 4 | Put phone away, reopen, change track | Sender hydrates from remote session and changes the active Cast track without snapping back to stale local state | hydration/reconcile log lines plus `receiver-state` |
| 5 | Add queue item while casting | Queue item is inserted/appended without full playback interruption | queue mutation log lines plus `receiver-state` |
| 6 | Reorder queue while casting | Receiver keeps playing and sender queue order remains controllable | queue move log lines |
| 7 | Pause for 5 seconds | Receiver shows paused state and fades non-essential UI without stopping | `receiver-state from=PLAYING to=PAUSED` |
| 8 | Pause for 20 minutes | Receiver stops itself after paused timeout | `receiver-paused-timeout` |
| 9 | Idle for 5 minutes | Idle receiver stops itself for burn-in/session hygiene | `receiver-idle-timeout` |
| 10 | Stop casting from this device while playing ("Stop casting" button, or the Cast icon's dialog on the phone) | Sender disconnects cleanly, receiver stops, and playback continues on this device on the same track from the Cast position, and nothing pauses it again right after | `User opened Cast dialog while connected` (dialog), `cast-ended-handoff play=true`, then `hydrate-skipped-no-session` (not a `Hydrated sender … sid=none`) |
| 11 | Receiver interruption and sender rejoin | Stale `PresentationConnection` recovery or retry path restores sender control when possible. When the transport cannot be brought back, the sender says so once (`stale-transport-dead`, one error toast with Retry) instead of reporting a recovery; lifecycle reconcile bursts stand down while recovery is in flight (#39) | `stale-transport-recovered` (or `stale-transport-dead` when unrecoverable) |
| 12 | Cast session ended elsewhere while playing (Google Home, TV off, another phone) | This device leaves Cast mode paused on the Cast track at its position, starts no sound by itself, and Play continues from there | `cast-ended-handoff play=false` |
| 13 | Second device joins a Cast session that another device plays (pick the playing NAD in the desktop's Cast dialog while the phone casts) | The joining device takes on the receiver's track, position and play state; nothing is reloaded and the music does not jump to the joiner's own queue | `cast-join-adopted` from the joiner's `sender=`, and no `Auto-casting current local queue` |
| 14 | Two devices attached to one Cast session (row 13), then stop casting from one device's Cast dialog | Only that device continues locally; the other leaves Cast mode paused on the track. "This device" means its dialog was opened in the last 20 s and its page is on screen | one `cast-ended-handoff play=true` (its `sender=`, `visible=true`, `dialogAgoMs` under 20000) and one `play=false` from the other `sender=` |
| 15 | With sync on: the phone casts to the NAD, then pick the NAD in the desktop's Cast dialog | The desktop does not stay a second Cast sender: it leaves the Cast session again, the NAD keeps playing untouched, and the desktop shows "Playing on NAD Forstærker" and controls it (no "Play where?" needed); no "Cast device disconnected" toast (Chrome's own dialog may still list the NAD as casting, from the phone) | `cast-join-left` and `cast-ended-handoff skipped reason=left-joined-session` from the desktop's `sender=`; no `Auto-casting` or `Queue load requested` from it |

### Automated Log Verification

Run after the manual cases:

```bash
npm run verify:cast
```

Optional alternate log path:

```bash
npm run verify:cast -- --log logs/cast-receiver.log
```

The verifier checks that every Phase 8 marker appears in `logs/cast-receiver.log` and fails if unredacted query tokens, Bearer tokens, or JWT-shaped values are present.

### Files to Update

- `docs/cast-design-checklist.md`
- `TASKS.md`
- `package.json`
- `scripts/verify-cast-design-checklist.mjs`

### Acceptance Criteria

- [x] Manual Cast test matrix is documented
- [x] `npm run verify:cast` audits required markers
- [x] Verifier fails on missing markers or unredacted auth material

---

## Recommended Build Order

1. Cast Button & Sender Controller Compliance — Foundation layer
2. Mobile Cast Volume & Expanded Controller — Core UX controls
3. Receiver State Machine & Impeccable UI Pass — Receiver experience
4. Idle/Paused Timeout Behavior — Burn-in protection
5. Queue UX Polish — Feature completion
6. Checklist Doc & Final Verification Pass — Compliance sign-off

Logging scope, persistence, receiver compatibility, and HLS retention are documented in [logging.md](./logging.md).
