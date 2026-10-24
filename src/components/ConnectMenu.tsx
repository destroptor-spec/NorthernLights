import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectedDevice } from '../../shared/api/v1';
import { Cast, Check, ChevronRight, MonitorSmartphone, MonitorSpeaker, Speaker } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { castManager } from '../utils/CastManager';
import { isFollowedOutputPlaying } from '../utils/sessionFollow';
import { getAuroraClientId } from '../api/auroraApi';
import { ContextMenuFrame, ContextMenuPortal } from './ContextMenu';

const MENU_WIDTH = 304;
/** How long a device's row takes to fade and fold away (matches the CSS). */
export const DEVICE_LEAVE_MS = 220;

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
    </>
  );
};

const ConnectOption: React.FC<{
  icon: React.ReactNode;
  title: string;
  detail: string;
  selected?: boolean;
  onClick?: () => void;
}> = ({ icon, title, detail, selected = false, onClick }) => (
  <button
    type="button"
    className={`connect-option${selected ? ' is-selected' : ''}`}
    onClick={onClick}
    disabled={!onClick}
    aria-pressed={onClick ? selected : undefined}
  >
    <span className="connect-option-icon" aria-hidden="true">{icon}</span>
    <span className="connect-option-text">
      <span className="connect-option-title">{title}</span>
      <span className="connect-option-detail">{detail}</span>
    </span>
    {selected && <Check size={16} className="connect-option-check" aria-label="chosen" />}
  </button>
);

export const ConnectMenuContent: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const follow = usePlayerStore((s) => s.sessionFollow);
  const remoteControlOutputId = usePlayerStore((s) => s.remoteControlOutputId);
  const castConnected = usePlayerStore((s) => s.castConnected);
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

  const choose = (choice: 'remote' | 'here') => {
    onDone();
    void usePlayerStore.getState().resolvePlayWhere(choice);
  };

  return (
    <div className="connect-card" role="dialog" aria-label="Connect">
      <div className="connect-card-header">
        <span className="connect-card-title">Connect</span>
        <span className="connect-card-where">{where}</span>
      </div>

      <div className="connect-options">
        {follow ? (
          <>
            <ConnectOption
              icon={<Speaker size={18} />}
              title={follow.name}
              detail={follow.silent ? "Isn't responding" : controlsFollowed ? 'Controlled from here' : 'Control it from here'}
              selected={controlsFollowed}
              onClick={follow.silent ? undefined : () => choose('remote')}
            />
            <ConnectOption
              icon={<MonitorSmartphone size={18} />}
              title="This device"
              detail="Play here instead"
              onClick={() => choose('here')}
            />
          </>
        ) : castDevice ? (
          <ConnectOption icon={<Cast size={18} />} title={castDevice} detail="Casting from this device" selected />
        ) : (
          <ConnectOption icon={<MonitorSmartphone size={18} />} title="This device" detail="Playing here" selected />
        )}
      </div>

      {listedDevices.length > 0 && (
        <div className="connect-devices">
          {listedDevices.map(({ device, entering, leaving }) => (
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
                  onClick={leaving ? undefined : () => {
                    onDone();
                    void usePlayerStore.getState().transferPlaybackTo(device);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {!castConnected && (
        <button
          type="button"
          className="connect-output"
          onClick={() => {
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
