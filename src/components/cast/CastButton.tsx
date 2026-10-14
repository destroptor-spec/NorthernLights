import React, { useEffect, useMemo, useState } from 'react';
import { Cast, Loader2 } from 'lucide-react';
import { castManager, type CastHealthStatus } from '../../utils/CastManager';
import { sessionMirror } from '../../utils/SessionMirror';

type CastButtonSize = 'sm' | 'md' | 'lg';

interface CastButtonProps {
  className?: string;
  labelClassName?: string;
  showDeviceName?: boolean;
  showIntro?: boolean;
  showStopAction?: boolean;
  size?: CastButtonSize;
}

const INTRO_STORAGE_KEY = 'aurora-cast-intro-dismissed-v1';

const getInitialCastAvailable = () => Boolean((window as any).cast?.framework);

export const CastButton: React.FC<CastButtonProps> = ({
  className = '',
  labelClassName = '',
  showDeviceName = false,
  showIntro = false,
  showStopAction = false,
  size = 'md',
}) => {
  const [castApiAvailable, setCastApiAvailable] = useState(getInitialCastAvailable);
  const [castState, setCastState] = useState(castManager.getCastState());
  const [castHealth, setCastHealth] = useState<CastHealthStatus>(castManager.getHealthStatus());
  const [deviceName, setDeviceName] = useState(castManager.getCastDeviceName());
  const [introDismissed, setIntroDismissed] = useState(() => {
    try {
      return localStorage.getItem(INTRO_STORAGE_KEY) === 'true';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const handleCastReady = () => {
      setCastApiAvailable(true);
      setCastState(castManager.getCastState());
      setDeviceName(castManager.getCastDeviceName());
    };

    if (getInitialCastAvailable()) {
      handleCastReady();
    } else {
      window.addEventListener('castApiAvailable', handleCastReady);
    }

    const unsubscribe = castManager.addStateChangeListener((nextState) => {
      setCastApiAvailable(getInitialCastAvailable());
      setCastState(nextState);
      setDeviceName(nextState === 'CONNECTED' ? castManager.getCastDeviceName() : '');
    });
    const unsubscribeHealth = castManager.addHealthChangeListener(setCastHealth);

    return () => {
      window.removeEventListener('castApiAvailable', handleCastReady);
      unsubscribe();
      unsubscribeHealth();
    };
  }, []);

  const isConnected = castState === 'CONNECTED';
  const isConnecting = castState === 'CONNECTING';
  const isBusy = isConnecting || castHealth.phase === 'rejoining' || castHealth.phase === 'recovering';
  const hasDevices = castState !== 'NO_DEVICES_AVAILABLE';
  const isVisible = castApiAvailable && hasDevices;

  useEffect(() => {
    castManager.logCastButtonState(
      `visible=${isVisible} api=${castApiAvailable} state=${castState} device=${deviceName || 'none'} size=${size}`
    );
  }, [castApiAvailable, castState, deviceName, isVisible, size]);

  const ariaLabel = useMemo(() => {
    if (isBusy) return castHealth.message || 'Connecting to Cast device';
    if (isConnected && deviceName) return `Cast connected to ${deviceName}. Open Cast dialog`;
    if (isConnected) return 'Cast connected. Open Cast dialog';
    if (isConnecting) return 'Connecting to Cast device';
    return 'Cast to device';
  }, [castHealth.message, deviceName, isBusy, isConnected, isConnecting]);

  const dismissIntro = () => {
    setIntroDismissed(true);
    try {
      localStorage.setItem(INTRO_STORAGE_KEY, 'true');
    } catch {
      // Ignore storage failures. The coach mark is non-critical.
    }
  };

  const noteLaunchIntent = () => {
    if (isConnected) {
      // Opens the Cast dialog, whose "Stop casting" hands playback back here.
      castManager.noteUserCastDialogOpened(`launcher-${size}`);
    } else if (!isBusy) {
      castManager.noteUserCastLaunchIntent(`launcher-${size}`);
      // Starting to cast is "play here": with sync on, this device becomes
      // the session's output once the Cast device plays, even after another
      // device had taken over (prod 2026-10-13: the phone kept playing).
      sessionMirror.notePlayIntent();
    }
  };

  if (!castApiAvailable) return null;

  // Hide, never unmount, when discovery momentarily reports no devices (#40).
  // The SDK flickers NOT_CONNECTED -> NO_DEVICES_AVAILABLE -> NOT_CONNECTED
  // while the picker opens; returning null here tore <google-cast-launcher>
  // out mid-request, the tap never resolved ("press Cast, nothing happens"),
  // and every later tap on that page failed with invalid_parameter until a
  // reload. Prod Sep 1 - Oct 10: 6/6 taps hidden while pending never resolved,
  // 0 of 67 resolved taps were hidden.
  return (
    <div
      className={`aurora-cast-control aurora-cast-control-${size} ${className}`}
      data-cast-state={castState}
      data-cast-health={castHealth.phase}
      style={isVisible ? undefined : { display: 'none' }}
      aria-hidden={isVisible ? undefined : true}
    >
      <span
        className="aurora-cast-button-shell"
        onPointerDownCapture={noteLaunchIntent}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            noteLaunchIntent();
          }
        }}
      >
        {isBusy ? (
          <Loader2 className="aurora-cast-icon aurora-cast-spinner" aria-hidden="true" strokeWidth={1.9} />
        ) : (
          <Cast className="aurora-cast-icon" aria-hidden="true" strokeWidth={1.8} />
        )}
        {React.createElement('google-cast-launcher', {
          class: 'aurora-cast-launcher',
          className: 'aurora-cast-launcher',
          'aria-label': ariaLabel,
          title: ariaLabel,
        })}
      </span>

      {showDeviceName && isConnected && deviceName && (
        <span
          className={`aurora-cast-device ${labelClassName}`}
          title={`Casting to ${deviceName}`}
        >
          {deviceName}
        </span>
      )}

      {showStopAction && isConnected && (
        <button
          type="button"
          className="aurora-cast-stop"
          onClick={() => castManager.disconnect()}
          aria-label={deviceName ? `Stop casting to ${deviceName}` : 'Stop casting'}
        >
          Stop casting
        </button>
      )}

      {showIntro && !introDismissed && !isConnected && (
        <div className="aurora-cast-intro" role="status">
          <div className="aurora-cast-intro-title">Cast is ready</div>
          <div className="aurora-cast-intro-copy">Send playback to nearby speakers or TVs.</div>
          <button type="button" onClick={dismissIntro} className="aurora-cast-intro-action">
            Got it
          </button>
        </div>
      )}
    </div>
  );
};

export default CastButton;
