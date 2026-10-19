import React from 'react';
import { ChevronRight, Speaker } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { useFollowedDeviceLabel } from '../hooks/useFollowedDeviceName';

/**
 * "Playing on NAD Forstærker": one strip with one look on the player bars
 * (the desktop bar, docked or floating, and the mobile mini player; full Now
 * Playing says it in its heading instead), shown only while this device
 * follows another one that plays the session. Tapping it opens "Play
 * where?". Built like the offline notice:
 * a slim full-width band with an icon and one line. Before, the line lived in
 * a different place on each surface, and replaced the artist on the mini
 * player (Andreas, 2026-10-18).
 */
export const DeviceStrip: React.FC<{ variant: 'bar' | 'mini' }> = ({ variant }) => {
  const label = useFollowedDeviceLabel();
  const silent = usePlayerStore((s) => !!s.sessionFollow?.silent);
  if (!label) return null;
  return (
    <button
      type="button"
      className={`device-strip device-strip--${variant}${silent ? ' is-silent' : ''}`}
      // Inside the mini player's tap-to-expand area: choose, don't expand.
      onClick={(event) => {
        event.stopPropagation();
        usePlayerStore.getState().openPlayWhere();
      }}
      aria-label={`${label}. Choose where to play`}
    >
      <Speaker size={14} aria-hidden="true" className="shrink-0" />
      <span className="device-strip-label">{label}</span>
      <ChevronRight size={14} aria-hidden="true" className="device-strip-chevron shrink-0" />
    </button>
  );
};

export default DeviceStrip;
