import { useEffect, useState } from 'react';
import { castManager, type CastHealthStatus } from '../utils/CastManager';

const castApiLoaded = () => Boolean((window as unknown as { cast?: { framework?: unknown } }).cast?.framework);

export interface CastStatus {
  /** The Cast SDK loaded and knows of at least one device: casting can start. */
  available: boolean;
  connected: boolean;
  /** Connecting, rejoining or recovering, or the device picker is open. */
  busy: boolean;
  deviceName: string;
}

/**
 * Cast as the Connect menu shows it. Logs `cast-button-state` (required by
 * `npm run verify:cast`) whenever what it shows changes; `surface` names
 * where (it was the launcher's size before Cast moved into the menu).
 */
export function useCastStatus(surface: string): CastStatus {
  const [apiLoaded, setApiLoaded] = useState(castApiLoaded);
  const [castState, setCastState] = useState(castManager.getCastState());
  const [health, setHealth] = useState<CastHealthStatus>(castManager.getHealthStatus());
  const [pickerPending, setPickerPending] = useState(() => castManager.isCastPickerPending());
  const [deviceName, setDeviceName] = useState(castManager.getCastDeviceName());

  useEffect(() => {
    const handleCastReady = () => {
      setApiLoaded(true);
      setCastState(castManager.getCastState());
      setDeviceName(castManager.getCastDeviceName());
    };
    if (castApiLoaded()) handleCastReady();
    else window.addEventListener('castApiAvailable', handleCastReady);
    const unsubscribe = castManager.addStateChangeListener((nextState) => {
      setApiLoaded(castApiLoaded());
      setCastState(nextState);
      setPickerPending(castManager.isCastPickerPending());
      setDeviceName(nextState === 'CONNECTED' ? castManager.getCastDeviceName() : '');
    });
    const unsubscribeHealth = castManager.addHealthChangeListener((next) => {
      setHealth(next);
      setPickerPending(castManager.isCastPickerPending());
    });
    return () => {
      window.removeEventListener('castApiAvailable', handleCastReady);
      unsubscribe();
      unsubscribeHealth();
    };
  }, []);

  const connected = castState === 'CONNECTED';
  const busy = castState === 'CONNECTING' || health.phase === 'rejoining' || health.phase === 'recovering' || pickerPending;
  const available = apiLoaded && castState !== 'NO_DEVICES_AVAILABLE';

  useEffect(() => {
    castManager.logCastButtonState(`visible=${available} api=${apiLoaded} state=${castState} device=${deviceName || 'none'} size=${surface}`);
  }, [apiLoaded, available, castState, deviceName, surface]);

  return { available, connected, busy, deviceName };
}
