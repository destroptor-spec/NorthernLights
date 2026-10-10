# Logging controls

System → Logging contains administrator settings for the whole server. Changes
save immediately, apply to running jobs, and survive a restart. Environment
variables supply defaults until an administrator saves an override.

| Control | Scope |
| --- | --- |
| HLS diagnostics: Normal | HLS failures, session creation/cleanup, transcoder exit status, format probes |
| HLS diagnostics: Detailed | Normal plus playlist snapshots, prewarm details and individual segment requests in HLS files; additional HLS console output |
| FFmpeg output | Verbose transcoder console output and HLS stderr records, independently of HLS level |
| Library scanner / Audio analyzer / Loudness computation | Existing server console diagnostics for those jobs |

The existing `hlsLoggingEnabled` boolean remains the API/storage contract:
`false` means Normal, `true` means Detailed. `LOG_HLS` remains its environment
default; `LOG_FFMPEG` supplies the independent FFmpeg default. Known FFmpeg error
and warning text and process failures remain recorded when verbosity is off.

Playback contains two independent browser-local preferences:

- **Browser playback diagnostics** controls local playback/prewarm console output
  and the playback telemetry readout.
- **Cast diagnostics** controls verbose receiver diagnostics. Receiver failures
  and basic lifecycle markers remain enabled. New receivers accept changes during
  playback without reloading media; running older receivers apply the setting
  on the next media load.

The former combined preference migrates to both switches on first rehydration.
Once a Cast preference is saved explicitly, browser diagnostics no longer change
it. Neither preference changes the server-wide HLS setting.

## Receiver protocol

The receiver advertises `diagnostics` on `urn:x-cast:aurora.status`. The sender
sends `aurora.diagnostics` with a boolean `enabled` and a `requestId`. An
`aurora.diagnostics.ack` with matching request ID and value confirms application.
Delivery is bounded to three attempts spaced at least five seconds apart, driven
by receiver status updates. Transport failure never starts or reloads playback.
An explicit new choice or a new session resets the retry budget. A live receiver
choice survives auto-advance through queue items containing older preferences.

No deployment domain is embedded in this protocol. For receivers already running
an older build, the sender discovers an advertised namespace ending in
`.aurora.status`. Deploy sender and receiver together; older sender pages must be
refreshed to use the new domain-neutral receiver channel.

## Files and retention

- `logs/hls-server.log`: pipeline and session diagnostics.
- `logs/hls-sessions/<track>--<quality>--<codec>.log`: per-track variant details,
  including missing-segment and missing-session errors.
- `logs/cast-receiver.log`: sender/receiver events, with verbose receiver events
  controlled from Playback.

New diagnostic writes redact query tokens, Bearer credentials, JSON token fields,
and JWT-shaped values. Existing historical files are **not** rewritten or scrubbed.

HLS files rotate at 5 MiB with one `.1` backup. While HLS records are being
written, maintenance runs at most once a minute: per-track logs older than seven
days are removed, then the oldest are removed until the session-log directory
is at most 100 MiB. The budget can temporarily be exceeded between maintenance
passes. Individual messages are truncated after redaction. Logging I/O failures
do not interrupt playback. Cast-file retention is unchanged.

## What this does not establish

This change controls existing diagnostics; it does not implement a new HTTP
request tracing system. “Serving segment” records the start of streaming, not
successful delivery. Response completion, transfer aborts, authentication failures
before routing, and shared receiver/request correlation IDs remain follow-up work
for diagnosing issue #72. Collect production reverse-proxy logs as well as both
HLS log locations when investigating a playback interruption.
