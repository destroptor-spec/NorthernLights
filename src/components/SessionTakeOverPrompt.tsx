import React from 'react';
import { usePlayerStore } from '../store/index';
import { ConfirmModal } from './ConfirmModal';

/**
 * An idle device is about to take playback over from the device that plays
 * the session. Next and Previous always ask; Play asks only when that device
 * is casting, since the listener most likely wants the music to stay on the
 * Cast device, which this device cannot control yet.
 */
export const SessionTakeOverPrompt: React.FC = () => {
  const prompt = usePlayerStore((s) => s.takeOverPrompt);
  const resolve = usePlayerStore((s) => s.resolveTakeOverPrompt);
  if (!prompt) return null;
  return (
    <ConfirmModal
      title="Play here instead?"
      message={`Music is playing on ${prompt.outputName}. Playing here stops it there.`}
      confirmLabel="Play here"
      cancelLabel={prompt.action === 'play' ? `Keep on ${prompt.outputName}` : 'Cancel'}
      confirmTone="primary"
      onConfirm={() => void resolve(true)}
      onCancel={() => void resolve(false)}
    />
  );
};
