/*
 * Aurora Cast receiver: follow the playback session (Phase 5, PR D,
 * docs/cast-receiver-output.md).
 *
 * Runs only after a sender hands the receiver a session and its receiver
 * credential (aurora.session.follow). From then on the receiver:
 * - hears its session's events on /api/v1/events (EventSource; polling the
 *   session every 5 s if the stream fails twice);
 * - keeps its CAF queue window in line with the session's queue, in one batch
 *   per change (remove what no longer follows, insert what is missing), and
 *   never removes the item that plays: it jumps on first;
 * - carries out remote commands (play, pause, seek, next, previous, jump, load);
 * - reports what it plays, and renews its own credential;
 * - stops when another device takes over, and plays out what it has when the
 *   credential runs out, the session is deleted or sync is turned off.
 *
 * Written for the oldest receiver in use (Beoplay A9: Chrome 62): ES5 style,
 * no Promise.prototype.finally, no AbortController, no optional chaining.
 * scripts/check-receiver-syntax.mjs holds the file to that.
 */
(function (root) {
  'use strict';

  var EVENTS_PATH = '/api/v1/events';
  var SESSIONS_PATH = '/api/v1/playback-sessions/';
  var POLL_MS = 5000;
  var STREAM_FAILURES_BEFORE_POLLING = 2;
  var REPORT_PLAYING_MS = 10000;
  var REPORT_PAUSED_MS = 30000;
  var REPORT_SOON_MS = 300;
  var IDLE_SETTLE_MS = 3000;
  var RENEW_BEFORE_EXPIRY_MS = 10 * 60 * 1000;
  var RENEW_RETRY_MS = 60 * 1000;
  var RECONCILE_RETRY_MS = 1500;
  /** Status changes come in bursts (a track change sends several). */
  var RECONCILE_SETTLE_MS = 400;
  /**
   * removeItems/insertItems land a moment later: the same plan within this
   * long is the one already sent, not a new one (prod 2026-10-16 19:46:56:
   * the same 8 items removed three times in a second).
   */
  var SAME_PLAN_MS = 3000;
  /**
   * CAF applies insertItems/removeItems a moment after the call, so the next
   * plan waits (up to this long) until getItems shows the last batch. Planned
   * on the old queue, it inserted the same entries again (prod 2026-10-17
   * 10:29-10:37: removed/inserted grew 1, 2, 3 as a server top-up followed
   * every track change).
   */
  var BATCH_LANDS_MS = 3000;
  var BATCH_POLL_MS = 250;
  /** Upcoming items kept on the receiver after the one that plays. */
  var UPCOMING = 9;
  var FORCED_CODEC = 'aac';
  var DEFAULT_QUALITY = '128k';

  // ── Pure planning (unit-tested) ───────────────────────────────────────

  function entryIdOf(item) {
    return (item && item.media && item.media.customData && item.media.customData.queueEntryId) || null;
  }

  /**
   * The session entries that should follow `currentEntryId` on the receiver:
   * up to `upcoming`, wrapping from the head when the session repeats all
   * (never back onto the current entry).
   */
  function desiredUpcoming(sessionQueue, currentEntryId, repeatMode, upcoming) {
    var index = -1;
    for (var i = 0; i < sessionQueue.length; i++) {
      if (sessionQueue[i].queueEntryId === currentEntryId) { index = i; break; }
    }
    if (index < 0) return null;
    var out = [];
    var limit = repeatMode === 'all' ? Math.min(upcoming, sessionQueue.length - 1) : upcoming;
    for (var step = 1; out.length < limit; step++) {
      var at = index + step;
      if (at >= sessionQueue.length) {
        if (repeatMode !== 'all') break;
        at = at % sessionQueue.length;
      }
      out.push(sessionQueue[at]);
    }
    return out;
  }

  /**
   * One batch that turns the receiver's upcoming items into `desired`: the
   * common prefix stays, every later item goes, and the rest of `desired` is
   * appended. Previous items are left alone.
   *
   * @param items      CAF queue items (with itemId and media.customData.queueEntryId)
   * @param currentIndex index of the item that plays
   * @param desired    session entries ({queueEntryId, track}) to follow it
   * @returns {{ removeItemIds: number[], insert: Array }} insert: session entries to append
   */
  function planWindow(items, currentIndex, desired) {
    var after = items.slice(currentIndex + 1);
    var keep = 0;
    while (keep < after.length && keep < desired.length && entryIdOf(after[keep]) === desired[keep].queueEntryId) keep++;
    var removeItemIds = [];
    for (var r = keep; r < after.length; r++) {
      if (typeof after[r].itemId === 'number') removeItemIds.push(after[r].itemId);
    }
    return { removeItemIds: removeItemIds, insert: desired.slice(keep) };
  }

  /** What the receiver's player state means to the session. */
  function reportState(playerState, idleSettled) {
    if (playerState === 'PLAYING') return 'playing';
    if (playerState === 'PAUSED') return 'paused';
    if (playerState === 'IDLE') return idleSettled ? 'idle' : 'buffering';
    return 'buffering';
  }

  // ── The follower ──────────────────────────────────────────────────────

  /**
   * env: {
   *   playerManager, queueManager, messages (cast.framework.messages),
   *   fetch, EventSource, setTimeout, clearTimeout, now,
   *   mediaToken(): string        the media token the receiver already holds
   *   setMediaToken(token)        a newer one (a handover, a renewal)
   *   origin: string              the receiver page's origin
   *   marker(name, detail)        server log line
   *   onStopped(reason)           UI: following ended (expired, replaced, …)
   * }
   */
  function createFollower(env) {
    var state = null; // { sessionId, outputId, generation, token, expiresAt, renewableUntil, quality, castSessionId }
    var session = null;
    var stream = null;
    var streamFailures = 0;
    var pollTimer = null;
    var reportTimer = null;
    var renewTimer = null;
    var idleTimer = null;
    var reconcileTimer = null;
    var settleTimer = null;
    var lastPlan = { key: '', at: 0 };
    /** The last batch sent: what should follow `anchor` once CAF has applied it. */
    var pendingBatch = null;
    var batchTimer = null;
    var idleSettled = false;
    var seq = 0;
    var loading = false;
    var reconcileQueued = false;
    var fetching = null;
    var lastReportedEntry = null;
    var lastReportedState = null;
    var reportFailures = 0;

    function marker(name, detail) {
      try { env.marker(name, detail || ''); } catch (e) { /* logging never breaks playback */ }
    }

    function clearTimer(timer) {
      if (timer) env.clearTimeout(timer);
      return null;
    }

    function following() {
      return !!state;
    }

    // ── HTTP ────────────────────────────────────────────────────────────

    function request(method, path, body) {
      var init = { method: method, headers: { Authorization: 'Bearer ' + state.token } };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return env.fetch(path, init).then(function (response) {
        return response.json().then(function (payload) { return payload; }, function () { return null; }).then(function (payload) {
          if (response.ok) return payload && payload.data !== undefined ? payload.data : payload;
          var error = new Error((payload && payload.error && payload.error.message) || ('HTTP ' + response.status));
          error.status = response.status;
          error.code = (payload && payload.error && payload.error.code) || '';
          error.details = payload && payload.error && payload.error.details;
          throw error;
        });
      });
    }

    /**
     * Why the session's output is no longer this grant:
     * - superseded: a newer grant for this very receiver (a sender claimed
     *   for it again); its handover follows, and the music plays on;
     * - sender-claimed: a sender in this Cast session claimed as a plain
     *   Cast output; it is in charge of this queue now, and the music plays on;
     * - replaced: another device plays the session; this one stops.
     */
    function replacementOf(output) {
      if (!state) return 'replaced';
      if (output && output.id === state.outputId) return 'superseded';
      var kind = output && (output.kind || output.outputKind);
      if (output && state.castSessionId && output.castSessionId === state.castSessionId && (kind === 'cast' || kind === 'receiver')) {
        return 'sender-claimed';
      }
      return 'replaced';
    }

    /** A refusal that ends following, or false. */
    function stopReasonFor(error) {
      if (!error) return false;
      if (error.code === 'OUTPUT_GRANT_REPLACED') {
        var current = error.details && error.details.current;
        return replacementOf(current && current.output);
      }
      if (error.code === 'PLAYBACK_SYNC_DISABLED') return 'sync-off';
      if (error.code === 'PLAYBACK_SESSION_NOT_FOUND') return 'deleted';
      if (error.status === 401) return 'expired';
      return false;
    }

    // ── Starting and stopping ───────────────────────────────────────────

    /** Takes a handover (or a renewed credential for the same grant). True when taken. */
    function start(handover) {
      if (!handover || typeof handover.sessionId !== 'string' || typeof handover.outputId !== 'string'
        || typeof handover.token !== 'string' || !(handover.generation > 0)) return false;
      // Items need the media token a sender's LOAD brings; without it nothing would play.
      if (!env.mediaToken()) return false;
      if (state && state.sessionId === handover.sessionId && handover.generation < state.generation) return false;
      // The sender's Cast media token, not the login's (6a-2).
      if (typeof handover.mediaToken === 'string' && handover.mediaToken && env.setMediaToken) env.setMediaToken(handover.mediaToken);
      var sameGrant = state && state.sessionId === handover.sessionId && state.generation === handover.generation;
      var castSessionId = handover.outputId.indexOf('receiver:') === 0 ? handover.outputId.slice('receiver:'.length) : '';
      var quality = typeof handover.quality === 'string' && handover.quality ? handover.quality : (state && state.quality) || DEFAULT_QUALITY;
      state = {
        sessionId: handover.sessionId,
        outputId: handover.outputId,
        generation: handover.generation,
        token: handover.token,
        expiresAt: Date.parse(handover.expiresAt) || 0,
        renewableUntil: Date.parse(handover.renewableUntil) || 0,
        quality: quality,
        castSessionId: castSessionId
      };
      scheduleRenew();
      if (sameGrant) {
        marker('receiver-session-follow', 'credential=renewed generation=' + state.generation);
        if (!stream && !pollTimer) openStream();
        return true;
      }
      seq = 0;
      session = null;
      lastReportedEntry = null;
      lastReportedState = null;
      marker('receiver-session-follow', 'started generation=' + state.generation + ' castSession=' + (castSessionId || 'none'));
      openStream();
      fetchSession('start');
      reportSoon();
      return true;
    }

    function stop(reason) {
      if (!state) return;
      var wasReplaced = reason === 'replaced';
      marker('receiver-follow-stopped', 'reason=' + reason + ' generation=' + state.generation);
      closeStream();
      pollTimer = clearTimer(pollTimer);
      reportTimer = clearTimer(reportTimer);
      renewTimer = clearTimer(renewTimer);
      idleTimer = clearTimer(idleTimer);
      reconcileTimer = clearTimer(reconcileTimer);
      settleTimer = clearTimer(settleTimer);
      batchTimer = clearTimer(batchTimer);
      pendingBatch = null;
      state = null;
      session = null;
      // Another device plays now: no sender may be connected to stop this one.
      if (wasReplaced) {
        try { env.playerManager.stop(); } catch (e) { /* already stopped */ }
      }
      try { env.onStopped(reason); } catch (e) { /* UI only */ }
    }

    // ── Events ──────────────────────────────────────────────────────────

    function openStream() {
      closeStream();
      if (!state || typeof env.EventSource !== 'function') {
        startPolling();
        return;
      }
      var opened = false;
      var source;
      try {
        source = new env.EventSource(EVENTS_PATH + '?token=' + encodeURIComponent(state.token));
      } catch (e) {
        startPolling();
        return;
      }
      stream = source;
      source.onopen = function () {
        if (stream !== source) return;
        opened = true;
        streamFailures = 0;
        // Anything missed while it was down.
        fetchSession('stream-open');
      };
      source.onerror = function () {
        if (stream !== source) return;
        if (!opened || source.readyState === 2) {
          streamFailures++;
          closeStream();
          if (streamFailures >= STREAM_FAILURES_BEFORE_POLLING) {
            marker('receiver-session-follow', 'events=polling failures=' + streamFailures);
            startPolling();
          } else {
            env.setTimeout(function () { if (state && !stream && !pollTimer) openStream(); }, POLL_MS);
          }
        }
      };
      ['playbackSession.updated', 'playbackSession.handedOff', 'playbackSession.deleted', 'playbackSession.command',
        'playbackSync.changed', 'resync.required'].forEach(function (type) {
        source.addEventListener(type, function (event) {
          if (stream !== source) return;
          var data = {};
          try { data = (JSON.parse(event.data) || {}).data || {}; } catch (e) { return; }
          onEvent(type, data);
        });
      });
    }

    function closeStream() {
      if (stream) {
        try { stream.close(); } catch (e) { /* closed already */ }
      }
      stream = null;
    }

    function startPolling() {
      pollTimer = clearTimer(pollTimer);
      if (!state) return;
      pollTimer = env.setTimeout(function () {
        pollTimer = null;
        if (!state) return;
        fetchSession('poll');
        startPolling();
      }, POLL_MS);
    }

    function onEvent(type, data) {
      if (!state) return;
      if (type === 'playbackSync.changed') {
        if (data.enabled === false) stop('sync-off');
        return;
      }
      if (type === 'resync.required') {
        fetchSession('resync');
        return;
      }
      if (data.sessionId !== state.sessionId) return;
      if (type === 'playbackSession.deleted') {
        stop('deleted');
      } else if (type === 'playbackSession.handedOff') {
        if (data.outputId === state.outputId && Number(data.generation) <= state.generation) return;
        stop(replacementOf({ id: data.outputId, outputKind: data.outputKind, castSessionId: data.castSessionId }));
      } else if (type === 'playbackSession.command') {
        if (data.outputId !== state.outputId || Number(data.generation) !== state.generation || !data.command) return;
        applyCommand(data.command);
      } else if (!session || Number(data.revision) > session.revision) {
        fetchSession('updated');
      }
    }

    // ── The session and the window ──────────────────────────────────────

    function fetchSession(reason) {
      if (!state) return Promise.resolve(null);
      if (fetching) return fetching;
      var grant = state;
      fetching = request('GET', SESSIONS_PATH + encodeURIComponent(grant.sessionId)).then(function (next) {
        fetching = null;
        if (state !== grant || !next) return null;
        if (!next.output || next.output.id !== grant.outputId || next.output.generation !== grant.generation) {
          if (!next.output || next.output.generation > grant.generation) stop(replacementOf(next.output));
          return null;
        }
        if (!session || next.revision >= session.revision) session = next;
        reconcile(reason);
        return session;
      }, function (error) {
        fetching = null;
        var stopReason = stopReasonFor(error);
        if (stopReason && state === grant) stop(stopReason);
        return null;
      });
      return fetching;
    }

    function currentEntry() {
      var info = env.playerManager.getMediaInformation ? env.playerManager.getMediaInformation() : null;
      return (info && info.customData && info.customData.queueEntryId) || null;
    }

    // No token: the receiver's request handlers add it, so the contentId
    // every sender sees carries none (6a-3).
    function trackUrl(track) {
      return env.origin + '/api/stream/' + encodeURIComponent(track.id) + '/playlist.m3u8'
        + '?quality=' + encodeURIComponent(state.quality) + '&codec=' + FORCED_CODEC;
    }

    function artworkUrl(track) {
      if (!track.artworkUrl) return '';
      var token = env.mediaToken();
      var url = track.artworkUrl.indexOf('http') === 0 ? track.artworkUrl : env.origin + track.artworkUrl;
      return token ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token) : url;
    }

    /** A CAF queue item for a session entry, built like the sender's. */
    function buildItem(entry) {
      var m = env.messages;
      var track = entry.track || {};
      var media = new m.MediaInformation();
      media.contentId = trackUrl(track);
      media.contentType = 'application/vnd.apple.mpegurl';
      media.streamType = m.StreamType.BUFFERED;
      if (m.HlsSegmentFormat) media.hlsSegmentFormat = m.HlsSegmentFormat.TS;
      var metadata = new m.MusicTrackMediaMetadata();
      metadata.title = track.title || 'Unknown Title';
      metadata.songName = metadata.title;
      metadata.artist = track.artist || 'Unknown Artist';
      if (track.album) metadata.albumName = track.album;
      var image = artworkUrl(track);
      if (image) metadata.images = [new m.Image(image)];
      media.metadata = metadata;
      if (track.durationSeconds > 0) media.duration = track.durationSeconds;
      media.customData = { queueEntryId: entry.queueEntryId, codec: FORCED_CODEC, auroraFollow: true };
      var item = new m.QueueItem();
      item.media = media;
      item.autoplay = true;
      item.preloadTime = 20;
      return item;
    }

    function setRepeat(repeatMode) {
      var modes = env.messages.RepeatMode;
      if (!modes || !env.queueManager.setRepeatMode) return;
      // Repeat-all is done by refilling from the head, so the window never loops alone.
      try { env.queueManager.setRepeatMode(repeatMode === 'one' ? modes.REPEAT_SINGLE : modes.REPEAT_OFF); } catch (e) { /* keep */ }
    }

    function queueRetry() {
      if (reconcileTimer) return;
      reconcileTimer = env.setTimeout(function () {
        reconcileTimer = null;
        reconcile('retry');
      }, RECONCILE_RETRY_MS);
    }

    function settleReconcile(reason) {
      settleTimer = clearTimer(settleTimer);
      settleTimer = env.setTimeout(function () {
        settleTimer = null;
        reconcile(reason);
      }, RECONCILE_SETTLE_MS);
    }

    /** True once getItems shows the last batch (or it can no longer, or too long has passed). */
    function batchLanded(items) {
      if (!pendingBatch) return true;
      var at = -1;
      for (var i = 0; i < items.length; i++) {
        if (entryIdOf(items[i]) === pendingBatch.anchor) { at = i; break; }
      }
      var after = at < 0 ? [] : items.slice(at + 1).map(entryIdOf);
      if (at >= 0 && after.join(',') !== pendingBatch.expect.join(',') && env.now() < pendingBatch.until) return false;
      if (at >= 0 && after.join(',') !== pendingBatch.expect.join(',')) {
        marker('receiver-window-reconciled', 'result=batch-not-seen waitedMs=' + BATCH_LANDS_MS);
      }
      pendingBatch = null;
      return true;
    }

    /** Brings the receiver's window in line with the session, in one batch. */
    function reconcile(reason) {
      if (!state || !session) return;
      if (loading) {
        reconcileQueued = true;
        return;
      }
      var items = env.queueManager.getItems ? env.queueManager.getItems() : [];
      if (!batchLanded(items)) {
        // Look again shortly; whatever changed meanwhile is planned then.
        if (!batchTimer) {
          batchTimer = env.setTimeout(function () {
            batchTimer = null;
            reconcile(reason);
          }, BATCH_POLL_MS);
        }
        return;
      }
      var currentIndex = env.queueManager.getCurrentItemIndex ? env.queueManager.getCurrentItemIndex() : -1;
      var playing = currentIndex >= 0 ? entryIdOf(items[currentIndex]) : null;
      setRepeat(session.repeatMode);
      if (!playing) {
        // Nothing loaded yet (or the receiver finished): nothing to line up.
        return;
      }
      var inSession = false;
      for (var i = 0; i < session.queue.length; i++) {
        if (session.queue[i].queueEntryId === playing) { inSession = true; break; }
      }
      if (!inSession) {
        // The entry that plays was removed: move on to the session's current
        // entry (its successor), then line up from there.
        var successor = session.currentEntryId;
        if (successor && successor !== playing) {
          jumpTo(successor, 'removed');
        } else {
          marker('receiver-window-reconciled', 'reason=' + reason + ' result=current-removed-no-successor');
        }
        return;
      }
      var desired = desiredUpcoming(session.queue, playing, session.repeatMode, UPCOMING) || [];
      var plan = planWindow(items, currentIndex, desired);
      if (!plan.removeItemIds.length && !plan.insert.length) return;
      var key = plan.removeItemIds.join(',') + '|' + plan.insert.map(function (entry) { return entry.queueEntryId; }).join(',');
      if (key === lastPlan.key && env.now() - lastPlan.at < SAME_PLAN_MS) return;
      lastPlan = { key: key, at: env.now() };
      try {
        if (plan.removeItemIds.length) env.queueManager.removeItems(plan.removeItemIds);
        if (plan.insert.length) env.queueManager.insertItems(plan.insert.map(buildItem));
        pendingBatch = {
          anchor: playing,
          expect: desired.map(function (entry) { return entry.queueEntryId; }),
          until: env.now() + BATCH_LANDS_MS
        };
        marker('receiver-window-reconciled', 'reason=' + reason + ' removed=' + plan.removeItemIds.length
          + ' inserted=' + plan.insert.length + ' revision=' + session.revision);
      } catch (error) {
        marker('receiver-window-reconciled', 'reason=' + reason + ' result=failed error=' + String((error && error.message) || error));
        queueRetry();
      }
    }

    function findItem(entryId) {
      var items = env.queueManager.getItems ? env.queueManager.getItems() : [];
      for (var i = 0; i < items.length; i++) {
        if (entryIdOf(items[i]) === entryId) return items[i];
      }
      return null;
    }

    function localRequest(request) {
      request.requestId = Math.floor(env.now() % 1000000000);
      env.playerManager.sendLocalMediaRequest(request);
    }

    /** Plays `entryId`: a jump when the receiver has it, else a new window from it. */
    function jumpTo(entryId, why) {
      var item = findItem(entryId);
      if (item && typeof item.itemId === 'number') {
        var update = new env.messages.QueueUpdateRequestData();
        update.currentItemId = item.itemId;
        localRequest(update);
        return Promise.resolve(true);
      }
      return loadFrom(entryId, why);
    }

    /** A fresh window starting at `entryId`, loaded by the receiver itself. */
    function loadFrom(entryId, why) {
      if (!state || !session) return Promise.resolve(false);
      var start = null;
      for (var i = 0; i < session.queue.length; i++) {
        if (session.queue[i].queueEntryId === entryId) { start = session.queue[i]; break; }
      }
      if (!start) return Promise.resolve(false);
      var upcoming = desiredUpcoming(session.queue, entryId, session.repeatMode, UPCOMING) || [];
      var items = [start].concat(upcoming).map(buildItem);
      var m = env.messages;
      var load = new m.LoadRequestData();
      load.media = items[0].media;
      load.autoplay = true;
      load.currentTime = 0;
      var queue = new m.QueueData();
      queue.items = items;
      queue.startIndex = 0;
      load.queueData = queue;
      pendingBatch = null; // a new queue: nothing of the last batch to wait for
      loading = true;
      marker('receiver-window-reconciled', 'reason=' + why + ' result=load items=' + items.length + ' revision=' + session.revision);
      var settle = function (ok) {
        loading = false;
        if (reconcileQueued) {
          reconcileQueued = false;
          reconcile('after-load');
        }
        reportSoon();
        return ok;
      };
      try {
        return Promise.resolve(env.playerManager.load(load)).then(function () { return settle(true); }, function (error) {
          marker('receiver-window-reconciled', 'reason=' + why + ' result=load-failed error=' + String((error && error.message) || error));
          return settle(false);
        });
      } catch (error) {
        return Promise.resolve(settle(false));
      }
    }

    // ── Commands ────────────────────────────────────────────────────────

    function applyCommand(command) {
      var type = command.type;
      var done = function (ok, detail) {
        marker('receiver-command-applied', 'type=' + type + ' ok=' + ok + (detail ? ' ' + detail : ''));
        reportSoon();
      };
      try {
        if (type === 'play') {
          env.playerManager.play();
          done(true);
        } else if (type === 'pause') {
          env.playerManager.pause();
          done(true);
        } else if (type === 'seek') {
          var seconds = Number(command.positionMs) / 1000;
          var duration = env.playerManager.getDurationSec ? env.playerManager.getDurationSec() : 0;
          if (!isFinite(seconds) || seconds < 0 || (duration > 0 && seconds > duration - 1)) {
            done(false, 'invalid-position');
          } else {
            env.playerManager.seek(seconds);
            done(true);
          }
        } else if (type === 'next' || type === 'previous') {
          var current = env.playerManager.getCurrentTimeSec ? env.playerManager.getCurrentTimeSec() : 0;
          if (type === 'previous' && current > 3) {
            env.playerManager.seek(0);
          } else {
            var step = new env.messages.QueueUpdateRequestData();
            step.jump = type === 'next' ? 1 : -1;
            localRequest(step);
          }
          done(true);
        } else if (type === 'jump') {
          jumpTo(command.entryId, 'command-jump').then(function (ok) { done(ok); });
        } else if (type === 'load') {
          var revision = Number(command.revision) || 0;
          // The session update before the command usually started this entry
          // already (its current entry was replaced): then only play.
          var startLoad = function () {
            if (currentEntry() === command.entryId) {
              env.playerManager.play();
              done(true, 'already-current');
              return;
            }
            jumpTo(command.entryId, 'command-load').then(function (ok) { done(ok); });
          };
          if (session && session.revision >= revision) {
            startLoad();
          } else {
            fetchSession('command-load').then(function () {
              if (session && session.revision >= revision) startLoad();
              else done(false, 'revision-not-seen');
            });
          }
        } else {
          done(false, 'unknown');
        }
      } catch (error) {
        done(false, 'error=' + String((error && error.message) || error));
      }
    }

    // ── Reports ─────────────────────────────────────────────────────────

    function playerState() {
      return env.playerManager.getPlayerState ? String(env.playerManager.getPlayerState() || '') : '';
    }

    /** The player changed (MEDIA_STATUS): report, and line up the new current item. */
    function notePlayerChanged() {
      if (!state) return;
      var now = playerState();
      if (now === 'IDLE') {
        if (!idleTimer && !idleSettled) {
          idleTimer = env.setTimeout(function () {
            idleTimer = null;
            if (playerState() === 'IDLE') {
              idleSettled = true;
              reportSoon();
            }
          }, IDLE_SETTLE_MS);
        }
      } else {
        idleTimer = clearTimer(idleTimer);
        idleSettled = false;
      }
      var entry = currentEntry();
      if (entry !== lastReportedEntry || reportState(now, idleSettled) !== lastReportedState) {
        reportSoon();
        if (entry !== lastReportedEntry) settleReconcile('advanced');
      }
    }

    function reportSoon() {
      if (!state) return;
      reportTimer = clearTimer(reportTimer);
      reportTimer = env.setTimeout(report, REPORT_SOON_MS);
    }

    function report() {
      reportTimer = null;
      if (!state) return;
      var grant = state;
      var entry = currentEntry();
      var stateName = reportState(playerState(), idleSettled);
      var position = env.playerManager.getCurrentTimeSec ? env.playerManager.getCurrentTimeSec() : 0;
      seq += 1;
      var body = {
        seq: seq,
        state: stateName,
        queueEntryId: entry,
        positionMs: Math.max(0, Math.round((position || 0) * 1000))
      };
      request('POST', SESSIONS_PATH + encodeURIComponent(grant.sessionId) + '/reports', body).then(function () {
        reportFailures = 0;
        lastReportedEntry = entry;
        lastReportedState = stateName;
      }, function (error) {
        if (state !== grant) return;
        var stopReason = stopReasonFor(error);
        if (stopReason) {
          stop(stopReason);
          return;
        }
        reportFailures += 1;
        if (reportFailures === 1 || reportFailures % 10 === 0) {
          marker('receiver-report-failed', 'code=' + (error.code || error.status || 'network') + ' failures=' + reportFailures);
        }
      }).then(function () {
        if (state !== grant || reportTimer) return;
        var interval = stateName === 'playing' || stateName === 'buffering' ? REPORT_PLAYING_MS
          : stateName === 'paused' ? REPORT_PAUSED_MS : 0;
        if (interval) reportTimer = env.setTimeout(report, interval);
      });
    }

    // ── Credential ──────────────────────────────────────────────────────

    function scheduleRenew() {
      renewTimer = clearTimer(renewTimer);
      if (!state || !state.expiresAt) return;
      var delay = Math.max(30000, state.expiresAt - env.now() - RENEW_BEFORE_EXPIRY_MS);
      renewTimer = env.setTimeout(renew, delay);
    }

    function renew() {
      renewTimer = null;
      if (!state) return;
      var grant = state;
      request('POST', SESSIONS_PATH + encodeURIComponent(grant.sessionId) + '/output/renew', {}).then(function (credential) {
        if (state !== grant || !credential || typeof credential.token !== 'string') return;
        grant.token = credential.token;
        grant.expiresAt = Date.parse(credential.expiresAt) || grant.expiresAt;
        grant.renewableUntil = Date.parse(credential.renewableUntil) || grant.renewableUntil;
        // A fresh 12-hour media token comes with it (6a-2).
        if (typeof credential.mediaToken === 'string' && credential.mediaToken && env.setMediaToken) env.setMediaToken(credential.mediaToken);
        marker('receiver-session-follow', 'credential=self-renewed generation=' + grant.generation
          + (credential.mediaToken ? ' mediaToken=renewed' : ''));
        scheduleRenew();
      }, function (error) {
        if (state !== grant) return;
        var stopReason = error && error.code === 'RECEIVER_RENEWAL_EXPIRED' ? 'expired' : stopReasonFor(error);
        if (stopReason) {
          stop(stopReason);
          return;
        }
        renewTimer = env.setTimeout(renew, RENEW_RETRY_MS);
      });
    }

    return {
      start: start,
      stop: stop,
      following: following,
      notePlayerChanged: notePlayerChanged
    };
  }

  var api = {
    createFollower: createFollower,
    planWindow: planWindow,
    desiredUpcoming: desiredUpcoming,
    reportState: reportState,
    UPCOMING: UPCOMING
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuroraSessionFollow = api;
})(this);
