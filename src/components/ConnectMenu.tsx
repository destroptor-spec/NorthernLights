import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectedDevice } from '../../shared/api/v1';
import { Cast, Check, ChevronRight, MonitorSmartphone, MonitorSpeaker, Speaker } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { castManager } from '../utils/CastManager';
import { isFollowedOutputPlaying } from '../utils/sessionFollow';
import { getAuroraClientId } from '../api/auroraApi';
import { isPhoneOrTablet } from '../utils/deviceName';
import { ContextMenuFrame, ContextMenuPortal } from './ContextMenu';

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
 * choice is a full-width button: the device that plays (control it from
 * here) or this device (play here instead). This device's output is named
 * and opens Settings → Playback → Output. Cast stays its own button until it
 * moves in here; Listen together and "Open your session" come with Phase 6.
 * The "Playing on" strip and the Now Playing heading only say where.
 */
const stopBubbling = (event: React.SyntheticEvent) => event.stopPropagation();

export const ConnectButton: React.FC<{ className?: string; iconSize?: number }> = ({ className = '', iconSize = 18 }) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const followed = usePlayerStore((s) => !!s.sessionFollow);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`connect-button${followed ? ' is-elsewhere' : ''} ${className}`}
        onClick={(event) => {
          event.stopPropagation(); // inside the mini player's tap-to-expand area
          setOpen((value) => !value);
        }}
        aria-label="Connect to a device"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Connect to a device"
      >
        <MonitorSpeaker size={iconSize} aria-hidden="true" />
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
  onClick?: () => void;
}> = ({ icon, title, detail, selected = false, chosen = false, onClick }) => (
  <button
    type="button"
    className={`connect-option${selected || chosen ? ' is-selected' : ''}${chosen ? ' is-chosen' : ''}`}
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
  // The user's other devices with Aurora open (live: devices.changed), minus
  // the one that plays (shown above) and Cast receivers (reached by casting).
  const myId = getAuroraClientId();
  const followedOutputId = follow?.outputId;
  const otherDevices = useMemo(() => (syncOn
    ? connectedDevices
      .filter((device) => device.clientId !== myId && device.kind !== 'receiver' && device.clientId !== followedOutputId)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    : []), [connectedDevices, followedOutputId, myId, syncOn]);
  const listedDevices = useListedDevices(otherDevices);

  const controlsFollowed = !!follow && remoteControlOutputId === follow.outputId;
  const castDevice = castConnected ? castManager.getCastDeviceName() || 'Cast device' : null;
  const where = follow
    ? follow.silent
      ? `${follow.name} isn't responding`
      : `${isFollowedOutputPlaying(follow) ? 'Playing' : 'Paused'} on ${follow.name}`
    : castDevice
      ? `Casting to ${castDevice}`
      : 'Playing on this device';
  const outputName = audioOutputActive ? audioOutputDeviceLabel || 'Selected output' : defaultOutputLabel || 'System default';

  // A choice is acted on at once, but the card stays about a second, frozen
  // as it was, with the choice lit, before it closes (Andreas, 2026-10-24:
  // closing at once left him tapping again to make sure it took).
  const live = { follow, controlsFollowed, castDevice, where, listedDevices };
  const [chosen, setChosen] = useState<string | null>(null);
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

  return (
    <div className="connect-card" role="dialog" aria-label="Connect">
      <div className="connect-card-header">
        <span className="connect-card-title">Connect</span>
        <span className="connect-card-where">{view.where}</span>
      </div>

      <div className={`connect-options${chosen ? ' has-choice' : ''}`}>
        {view.follow ? (
          <>
            <ConnectOption
              icon={<Speaker size={18} />}
              title={view.follow.name}
              detail={view.follow.silent ? "Isn't responding" : view.controlsFollowed || isChosen('remote') ? 'Controlled from here' : 'Control it from here'}
              selected={view.controlsFollowed && !chosen}
              chosen={isChosen('remote')}
              onClick={view.follow.silent || chosen ? undefined : () => choose('remote')}
            />
            <ConnectOption
              icon={<MonitorSmartphone size={18} />}
              title="This device"
              detail="Play here instead"
              chosen={isChosen('here')}
              onClick={chosen ? undefined : () => choose('here')}
            />
          </>
        ) : view.castDevice ? (
          <ConnectOption icon={<Cast size={18} />} title={view.castDevice} detail="Casting from this device" selected={!chosen} />
        ) : (
          <ConnectOption icon={<MonitorSmartphone size={18} />} title="This device" detail="Playing here" selected={!chosen} />
        )}
      </div>

      {view.listedDevices.length > 0 && (
        <div className={`connect-devices${chosen ? ' has-choice' : ''}`}>
          {view.listedDevices.map(({ device, entering, leaving }) => (
            <div
              key={device.clientId}
              className={`connect-device${entering ? ' is-entering' : ''}${leaving ? ' is-leaving' : ''}`}
              aria-hidden={leaving || undefined}
            >
              <div className="connect-device-inner">
                <ConnectOption
                  icon={<MonitorSmartphone size={18} />}
                  title={device.name || 'Another device'}
                  detail="Play there"
                  chosen={isChosen(device.clientId)}
                  onClick={leaving || chosen ? undefined : () => pick(device.clientId, () => {
                    void usePlayerStore.getState().transferPlaybackTo(device);
                  })}
                />
              </div>
            </div>
          ))}
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
    </div>
  );
};

export default ConnectButton;
