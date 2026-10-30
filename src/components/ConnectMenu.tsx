import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectedDevice } from '../../shared/api/v1';
import { Cast, Check, ChevronRight, Loader2, LogOut, MonitorSmartphone, MonitorSpeaker, Speaker, Users } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { castManager } from '../utils/CastManager';
import { sessionMirror } from '../utils/SessionMirror';
import { useCastStatus } from '../hooks/useCastStatus';
import { isFollowedOutputPlaying } from '../utils/sessionFollow';
import { getAuroraClientId } from '../api/auroraApi';
import { isPhoneOrTablet } from '../utils/deviceName';
import { ContextMenuFrame, ContextMenuPortal } from './ContextMenu';
import { useListenTogetherStore } from '../store/listenTogether';
import { joinNearby, leaveSharedSession, openSharedSession, refreshNearby, refreshOwn } from '../utils/listenTogether';
import { sessionTitle } from '../utils/listenTogetherText';
import { AvailableGigs, GigSection } from './GigSection';
import { UserAvatar } from './UserAvatar';

const MENU_WIDTH = 304;
/** How long a device's row takes to fade and fold away (matches the CSS). */
export const DEVICE_LEAVE_MS = 220;
/** How long the card shows a choice before it closes. */
export const CHOICE_CONFIRM_MS = 1000;

type ListedDevice = { device: ConnectedDevice; entering: boolean; leaving: boolean };

/**
 * The device list as rendered: a device that appears is marked entering (it
 * fades and unfolds in); one that goes away stays a moment, marked leaving,
 * while it fades and folds away, so the card's height follows smoothly.
 * Devices already there when the card opens don't animate.
 */
export function useListedDevices(devices: ConnectedDevice[]): ListedDevice[] {
  const [listed, setListed] = useState<ListedDevice[]>(() => devices.map((device) => ({ device, entering: false, leaving: false })));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setListed((previous) => {
      const was = new Set(previous.filter((entry) => !entry.leaving).map((entry) => entry.device.clientId));
      const now = new Set(devices.map((device) => device.clientId));
      const next = devices.map((device) => ({ device, entering: !was.has(device.clientId), leaving: false }));
      // A device that left keeps its place while it folds away.
      previous.forEach((entry, index) => {
        if (!now.has(entry.device.clientId)) next.splice(Math.min(index, next.length), 0, { ...entry, entering: false, leaving: true });
      });
      return next;
    });
    const timer = setTimeout(() => setListed((current) => current.filter((entry) => !entry.leaving)), DEVICE_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [devices]);
  return listed;
}

/**
 * "Connect": where the music plays, and the choices that go with it, in one
 * card (docs/playback_sessions.md, Phase 6 prep; Andreas, 2026-10-20). Each
 * choice is a full-width button, in a fixed order (Andreas, 2026-10-26):
 * Cast first ("Cast to a device" opens Chrome's device picker; no
 * <google-cast-launcher>, the card unmounts, #40), then this device, then the
 * user's other devices. The device that plays is always the one marked;
 * there is no "Playing on" line. This device's output is named and opens
 * Settings → Playback → Output. Last, Listen together (Phase 6): gigs nearby
 * to join ("Available gigs"), and the owner's own gig line, which grows into
 * the gig's controls (GigSection). On the device that shows a shared
 * session, the card is that gig's: the device that plays it, marked, and
 * Leave; where it plays is the owner's to choose (6d). The user's other
 * devices offer to Open it.
 * The "Playing on" strip and the Now Playing heading only say where.
 */
const stopBubbling = (event: React.SyntheticEvent) => event.stopPropagation();

export const ConnectButton: React.FC<{ className?: string; iconSize?: number }> = ({ className = '', iconSize = 18 }) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const followed = usePlayerStore((s) => !!s.sessionFollow);
  // Casting, connecting and recovering show here, where the Cast button was.
  const cast = useCastStatus('connect');
  const icon = cast.busy
    ? <Loader2 size={iconSize} aria-hidden="true" className="connect-spinner" />
    : cast.connected
      ? <Cast size={iconSize} aria-hidden="true" />
      : <MonitorSpeaker size={iconSize} aria-hidden="true" />;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`connect-button${followed || cast.connected || cast.busy ? ' is-elsewhere' : ''} ${className}`}
        onClick={(event) => {
          event.stopPropagation(); // inside the mini player's tap-to-expand area
          setOpen((value) => !value);
        }}
        aria-label="Connect to a device"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Connect to a device"
      >
        {icon}
      </button>
      {/* The card is portalled out of the bar, but React still bubbles its
          clicks up the component tree: into the mini player's tap-to-expand,
          which opened Now Playing as the card closed (Andreas, 2026-10-24).
          They stop here. */}
      <span style={{ display: 'contents' }} onClick={stopBubbling} onKeyDown={stopBubbling}>
        <ContextMenuPortal
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          placement="above"
          desktopWidth={MENU_WIDTH}
        >
          {({ isMobile }) => (
            <ContextMenuFrame isMobile={isMobile} widthClassName="w-[304px]">
              <ConnectMenuContent onDone={() => setOpen(false)} />
            </ContextMenuFrame>
          )}
        </ContextMenuPortal>
      </span>
    </>
  );
};

const ConnectOption: React.FC<{
  icon: React.ReactNode;
  title: string;
  detail: string;
  selected?: boolean;
  /** Just picked: lit and checked while the card confirms it. */
  chosen?: boolean;
  /** Asks to confirm a choice that ends something (a cast): warning colours. */
  warning?: boolean;
  /** Where the row leads (a sheet, leaving), shown at its end. */
  trailing?: React.ReactNode;
  onClick?: () => void;
}> = ({ icon, title, detail, selected = false, chosen = false, warning = false, trailing, onClick }) => (
  <button
    type="button"
    className={`connect-option${selected || chosen ? ' is-selected' : ''}${chosen ? ' is-chosen' : ''}${warning ? ' is-warning' : ''}`}
    onClick={onClick}
    disabled={!onClick}
    aria-pressed={onClick ? selected || chosen : undefined}
  >
    <span className="connect-option-icon" aria-hidden="true">{icon}</span>
    <span className="connect-option-text">
      <span className="connect-option-title">{title}</span>
      <span className="connect-option-detail">{detail}</span>
    </span>
    {(selected || chosen) && <Check size={16} className="connect-option-check" aria-label="chosen" />}
    {trailing && !selected && !chosen && <span className="connect-option-trailing">{trailing}</span>}
  </button>
);

export const ConnectMenuContent: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const follow = usePlayerStore((s) => s.sessionFollow);
  const remoteControlOutputId = usePlayerStore((s) => s.remoteControlOutputId);
  const castConnected = usePlayerStore((s) => s.castConnected);
  const audioOutputSupported = usePlayerStore((s) => s.audioOutputSupported);
  const audioOutputPermission = usePlayerStore((s) => s.audioOutputPermission);
  // Only where an output can really be chosen here: not on phones or tablets
  // (the system routes audio there), and not where Settings can't name
  // speakers. A denied permission still shows: Settings can ask again.
  const outputChoosable = audioOutputSupported
    && audioOutputPermission !== 'unavailable' && audioOutputPermission !== 'unsupported'
    && !isPhoneOrTablet();
  const audioOutputActive = usePlayerStore((s) => s.audioOutputActive);
  const audioOutputDeviceLabel = usePlayerStore((s) => s.audioOutputDeviceLabel);
  const defaultOutputLabel = usePlayerStore((s) => s.audioOutputDevices.find((device) => device.isDefault)?.label);
  const syncOn = usePlayerStore((s) => s.syncPlaybackAcrossDevices);
  const connectedDevices = usePlayerStore((s) => s.connectedDevices);
  // A Cast device that plays the session (another device casts to it, or it
  // follows the session itself) belongs with Cast at the top; any other
  // device that plays is listed with the user's devices.
  const followedCast = !!follow && (follow.kind === 'cast' || follow.kind === 'receiver');
  // The user's other devices with Aurora open (live: devices.changed), minus
  // Cast receivers (reached by casting), plus the one that plays even when it
  // has no event stream open right now.
  const myId = getAuroraClientId();
  const otherDevices = useMemo(() => {
    if (!syncOn) return [];
    const devices = connectedDevices.filter((device) => device.clientId !== myId && device.kind !== 'receiver');
    if (follow && !followedCast && !devices.some((device) => device.clientId === follow.outputId)) {
      devices.push({ clientId: follow.outputId, name: follow.name, kind: 'browser' });
    }
    return devices.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [connectedDevices, follow, followedCast, myId, syncOn]);
  const listedDevices = useListedDevices(otherDevices);
  const cast = useCastStatus('connect');
  const shared = useListenTogetherStore((s) => s.shared);
  const showingShared = useListenTogetherStore((s) => !!s.openedSessionId);
  const available = useListenTogetherStore((s) => s.available);
  // Who is in the gig, and the gigs nearby, may have changed while the card was closed.
  useEffect(() => {
    void refreshOwn();
    void refreshNearby();
  }, []);
  const gigs = available.filter((gig) => !gig.joined && gig.sessionId !== shared?.sessionId);

  const controlsFollowed = !!follow && remoteControlOutputId === follow.outputId;
  const castDevice = castConnected ? castManager.getCastDeviceName() || 'Cast device' : null;
  const outputName = audioOutputActive ? audioOutputDeviceLabel || 'Selected output' : defaultOutputLabel || 'System default';

  // A choice is acted on at once, but the card stays about a second, frozen
  // as it was, with the choice lit, before it closes (Andreas, 2026-10-24:
  // closing at once left him tapping again to make sure it took).
  const live = { follow, followedCast, controlsFollowed, castDevice, listedDevices };
  // The device that casts: the one the followed Cast output comes from, or
  // this one. Moving the music to (or from) it ends that cast.
  const castingClientId = follow?.castingClientId ?? null;
  const endsCast = (clientId: string) => castConnected || clientId === castingClientId;
  const [chosen, setChosen] = useState<string | null>(null);
  // "Play there" that would end a cast asks first (Andreas, 2026-10-27): the
  // first tap arms the row, the second moves the music.
  const [armed, setArmed] = useState<string | null>(null);
  const frozen = useRef(live);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  if (!chosen) frozen.current = live;
  const view = frozen.current;
  const pick = (key: string, act: () => void) => {
    if (chosen) return;
    setChosen(key);
    act();
    closeTimer.current = setTimeout(onDone, CHOICE_CONFIRM_MS);
  };
  const isChosen = (key: string) => chosen === key;
  const choose = (choice: 'remote' | 'here') => pick(choice, () => {
    void usePlayerStore.getState().resolvePlayWhere(choice);
  });
  // Opens Chrome's picker, which is the confirmation: the card closes at once.
  // Synchronous in the tap (the SDK needs the gesture). Starting to cast is
  // "play here" for the session, as the Cast button's tap was.
  const startCasting = () => {
    if (castManager.openCastPicker('connect-menu') !== 'opened') return;
    sessionMirror.notePlayIntent();
    onDone();
  };
  // Hands the music back here (cast-ended-handoff), like the Cast dialog's Stop.
  const stopCasting = () => pick('stop-casting', () => { void castManager.disconnect(); });

  // The device that plays is always the one marked (Andreas, 2026-10-26: after
  // "Play there" it lost its mark), whether or not it is controlled from here.
  const followedOption = (icon: React.ReactNode) => {
    const f = view.follow!;
    const state = f.silent ? "Isn't responding"
      : view.controlsFollowed || isChosen('remote') ? 'Controlled from here' : 'Control it from here';
    return (
      <ConnectOption
        key={f.outputId}
        icon={icon}
        title={f.name}
        detail={!f.silent && !isFollowedOutputPlaying(f) ? `Paused · ${state}` : state}
        selected={!chosen}
        chosen={isChosen('remote')}
        onClick={f.silent || chosen ? undefined : () => choose('remote')}
      />
    );
  };

  if (showingShared) {
    const f = view.follow;
    return (
      <div className="connect-card" role="dialog" aria-label="Connect">
        <div className="connect-card-header">
          <span className="connect-card-title">{shared?.ownerName ? sessionTitle(shared.ownerName) : 'Listening together'}</span>
        </div>
        <div className={`connect-options${chosen ? ' has-choice' : ''}`}>
          {f && (
            <ConnectOption
              icon={view.followedCast ? <Speaker size={18} /> : <MonitorSmartphone size={18} />}
              title={f.name}
              detail={f.silent ? "Isn't responding" : isFollowedOutputPlaying(f) ? 'Playing' : 'Paused'}
              selected={!chosen}
            />
          )}
          <ConnectOption
            icon={<LogOut size={18} />}
            title="Leave"
            detail="Back to your own music"
            chosen={isChosen('leave')}
            onClick={chosen ? undefined : () => pick('leave', () => { void leaveSharedSession(); })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="connect-card" role="dialog" aria-label="Connect">
      <div className="connect-card-header">
        <span className="connect-card-title">Connect</span>
      </div>

      <div className={`connect-options${chosen ? ' has-choice' : ''}`}>
        {/* Cast first, always: casting from here, or a Cast device that plays. */}
        {cast.available && !view.castDevice && (
          <ConnectOption
            icon={cast.busy ? <Loader2 size={18} className="connect-spinner" /> : <Cast size={18} />}
            title="Cast to a device"
            detail="Speakers and TVs nearby"
            onClick={cast.busy || chosen ? undefined : startCasting}
          />
        )}
        {view.castDevice && (
          <ConnectOption icon={<Cast size={18} />} title={view.castDevice} detail="Casting from this device" selected={!chosen} />
        )}
        {view.follow && view.followedCast && followedOption(<Speaker size={18} />)}

        {/* Then this device. */}
        {view.castDevice ? (
          <ConnectOption
            icon={<MonitorSmartphone size={18} />}
            title="This device"
            detail="Stop casting"
            chosen={isChosen('stop-casting')}
            onClick={chosen ? undefined : stopCasting}
          />
        ) : view.follow ? (
          <ConnectOption
            icon={<MonitorSmartphone size={18} />}
            title="This device"
            detail="Play here instead"
            chosen={isChosen('here')}
            onClick={chosen ? undefined : () => choose('here')}
          />
        ) : (
          <ConnectOption icon={<MonitorSmartphone size={18} />} title="This device" detail="Playing here" selected={!chosen} />
        )}
      </div>

      {/* Last, the user's other devices; the one that plays is marked. */}
      {view.listedDevices.length > 0 && (
        <div className={`connect-devices${chosen ? ' has-choice' : ''}`}>
          {view.listedDevices.map(({ device, entering, leaving }) => (
            <div
              key={device.clientId}
              className={`connect-device${entering ? ' is-entering' : ''}${leaving ? ' is-leaving' : ''}`}
              aria-hidden={leaving || undefined}
            >
              <div className="connect-device-inner">
                {view.follow && !view.followedCast && device.clientId === view.follow.outputId && !leaving
                  ? followedOption(<MonitorSmartphone size={18} />)
                  : (
                    <ConnectOption
                      icon={<MonitorSmartphone size={18} />}
                      title={device.name || 'Another device'}
                      detail={armed === device.clientId && !chosen ? 'End cast? Tap to confirm' : 'Play there'}
                      chosen={isChosen(device.clientId)}
                      warning={armed === device.clientId && !chosen}
                      onClick={leaving || chosen ? undefined : () => {
                        if (endsCast(device.clientId) && armed !== device.clientId) {
                          setArmed(device.clientId);
                          return;
                        }
                        pick(device.clientId, () => {
                          void usePlayerStore.getState().transferPlaybackTo(device);
                        });
                      }}
                    />
                  )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The gig this user is a guest in, shown on another device: Open it here. */}
      {syncOn && shared && (
        <div className={`connect-options${chosen ? ' has-choice' : ''}`}>
          <ConnectOption
            icon={shared.owner ? <UserAvatar avatar={shared.owner} size="sm" /> : <Users size={18} />}
            title={shared.ownerName ? sessionTitle(shared.ownerName) : 'Listening together'}
            detail="Open"
            trailing={<ChevronRight size={16} aria-hidden="true" />}
            chosen={isChosen('open')}
            onClick={chosen ? undefined : () => pick('open', () => { void openSharedSession(); })}
          />
        </div>
      )}

      {/* Only where an output can be chosen (outputChoosable). */}
      {outputChoosable && !castConnected && (
        <button
          type="button"
          className="connect-output"
          disabled={!!chosen}
          onClick={() => {
            // Opens Settings: no confirmation needed, it goes somewhere.
            onDone();
            usePlayerStore.getState().openSettingsAt('Playback', 'output');
          }}
        >
          <Speaker size={15} aria-hidden="true" className="shrink-0" />
          <span className="connect-output-label">Output</span>
          <span className="connect-output-name">{outputName}</span>
          <ChevronRight size={15} aria-hidden="true" className="shrink-0" />
        </button>
      )}

      {/* Listen together: gigs nearby, then this user's own gig. */}
      {syncOn && (
        <AvailableGigs gigs={gigs} disabled={!!chosen} onJoin={(gig) => pick(`join:${gig.sessionId}`, () => { void joinNearby(gig); })} />
      )}
      {syncOn && <GigSection onDone={onDone} />}
    </div>
  );
};

export default ConnectButton;
