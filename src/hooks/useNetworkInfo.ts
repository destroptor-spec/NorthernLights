import { useState, useEffect } from 'react';

interface NetworkConnection extends EventTarget {
  type?: 'wifi' | 'cellular' | 'bluetooth' | 'ethernet' | 'none' | 'other' | 'unknown';
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  downlink?: number;
  saveData?: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface NetworkInfo {
  type: 'wifi' | 'cellular' | 'bluetooth' | 'ethernet' | 'unknown';
  effectiveType: '4g' | '3g' | '2g' | 'slow-2g' | 'unknown';
  downlink: number | null;
  saveData: boolean;
  isSlow: boolean;
}

function readConnection(conn: NetworkConnection | null): NetworkInfo {
  const type = conn?.type ?? 'unknown';
  const effectiveType = conn?.effectiveType ?? 'unknown';
  const saveData = conn?.saveData ?? false;

  return {
    type: type as NetworkInfo['type'],
    effectiveType: effectiveType as NetworkInfo['effectiveType'],
    downlink: conn?.downlink ?? null,
    saveData,
    isSlow: saveData || effectiveType === '2g' || effectiveType === 'slow-2g',
  };
}

export function useNetworkInfo(): NetworkInfo {
  const conn = (navigator as Navigator & { connection?: NetworkConnection }).connection ?? null;
  const [info, setInfo] = useState<NetworkInfo>(() => readConnection(conn));

  useEffect(() => {
    if (!conn) return;

    const update = () => setInfo(readConnection(conn));
    conn.addEventListener('change', update);
    return () => conn.removeEventListener('change', update);
  }, [conn]);

  return info;
}
