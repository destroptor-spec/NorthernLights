import React, { useRef, useState } from 'react';
import { Check, MonitorSmartphone, MonitorSpeaker, Speaker } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { castManager } from '../utils/CastManager';
import { isFollowedOutputPlaying } from '../utils/sessionFollow';
import {
  ContextMenuButton,
  ContextMenuDivider,
  ContextMenuFrame,
  ContextMenuHeader,
  ContextMenuList,
  ContextMenuPortal,
} from './ContextMenu';

const MENU_WIDTH = 288;
const MENU_HEIGHT = 300;

/**
 * "Connect": where the music plays, and the choices that go with it, in one
 * menu (docs/playback_sessions.md, Phase 6 prep; Andreas, 2026-10-20). For
 * now it holds what plays where and "Play where?" (another device, or this
 * one), and this device's audio output. Cast stays its own button until it
 * moves in here; Listen together and "Open your session" come with Phase 6.
 * The "Playing on" strip and the Now Playing heading only say where.
 */
export const ConnectButton: React.FC<{ className?: string; iconSize?: number }> = ({ className = '', iconSize = 18 }) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const followed = usePlayerStore((s) => !!s.sessionFollow);

  // The bars sit at the bottom of the screen: open above the button.
  const rect = open ? anchorRef.current?.getBoundingClientRect() : undefined;
  const position = rect ? { x: rect.right - MENU_WIDTH, y: rect.top - MENU_HEIGHT - 8 } : undefined;

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
        aria-haspopup="menu"
        aria-expanded={open}
        title="Connect to a device"
      >
        <MonitorSpeaker size={iconSize} aria-hidden="true" />
      </button>
      <ContextMenuPortal
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        position={position}
        desktopWidth={MENU_WIDTH}
        desktopHeight={MENU_HEIGHT}
      >
        {({ isMobile }) => (
          <ContextMenuFrame isMobile={isMobile} widthClassName="w-[288px]">
            <ConnectMenuContent onDone={() => setOpen(false)} />
          </ContextMenuFrame>
        )}
      </ContextMenuPortal>
    </>
  );
};

export const ConnectMenuContent: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const follow = usePlayerStore((s) => s.sessionFollow);
  const remoteControlOutputId = usePlayerStore((s) => s.remoteControlOutputId);
  const castConnected = usePlayerStore((s) => s.castConnected);
  const audioOutputSupported = usePlayerStore((s) => s.audioOutputSupported);
  const audioOutputActive = usePlayerStore((s) => s.audioOutputActive);
  const audioOutputDeviceLabel = usePlayerStore((s) => s.audioOutputDeviceLabel);
  const audioOutputSelecting = usePlayerStore((s) => s.audioOutputSelecting);

  const controlsFollowed = !!follow && remoteControlOutputId === follow.outputId;
  const castDevice = castConnected ? castManager.getCastDeviceName() || 'Cast device' : null;
  const where = follow
    ? follow.silent
      ? `${follow.name} isn't responding`
      : `${isFollowedOutputPlaying(follow) ? 'Playing' : 'Paused'} on ${follow.name}`
    : castDevice
      ? `Casting to ${castDevice}`
      : 'Playing on this device';

  const choose = (choice: 'remote' | 'here') => {
    onDone();
    void usePlayerStore.getState().resolvePlayWhere(choice);
  };

  return (
    <>
      <ContextMenuHeader title="Connect" subtitle={where} />
      {follow && (
        <ContextMenuList>
          {/* "Play where?": what this device's Play, Pause and Next act on. */}
          {!follow.silent && (
            <ContextMenuButton
              icon={<Speaker size={15} />}
              label={`Control ${follow.name}`}
              trailingIcon={controlsFollowed ? <Check size={15} aria-label="chosen" /> : undefined}
              onClick={() => choose('remote')}
            />
          )}
          <ContextMenuButton
            icon={<MonitorSmartphone size={15} />}
            label="Play on this device"
            onClick={() => choose('here')}
          />
        </ContextMenuList>
      )}
      {audioOutputSupported && !castConnected && (
        <>
          {follow && <ContextMenuDivider />}
          <ContextMenuList>
            <ContextMenuButton
              icon={<Speaker size={15} />}
              label={audioOutputActive ? `Output: ${audioOutputDeviceLabel || 'selected output'}` : "Choose this device's output"}
              onClick={() => {
                if (audioOutputSelecting) return;
                onDone();
                void usePlayerStore.getState().selectAudioOutput();
              }}
            />
          </ContextMenuList>
        </>
      )}
    </>
  );
};

export default ConnectButton;
