import React from 'react';
import { usePlayerStore } from '../store/index';
import { ConfirmModal } from './ConfirmModal';

/**
 * "Play where?": something was done on this idle device while another device
 * plays the session (docs/playback_sessions.md, "Device choice and remote
 * control"). On that device makes this one a remote for as long as it plays;
 * on this device takes playback over. Closing the dialog does nothing.
 */
export const PlayWherePrompt: React.FC = () => {
  const prompt = usePlayerStore((s) => s.playWherePrompt);
  const resolve = usePlayerStore((s) => s.resolvePlayWhere);
  if (!prompt) return null;
  if (prompt.silent) {
    return (
      <ConfirmModal
        title="Play here instead?"
        message={`${prompt.outputName} isn't responding. The device casting to it may be asleep, so playing here won't stop it.`}
        confirmLabel="Play here"
        confirmTone="primary"
        onConfirm={() => void resolve('here')}
        onCancel={() => void resolve(null)}
      />
    );
  }
  return (
    <ConfirmModal
      title="Play where?"
      message={`Music is playing on ${prompt.outputName}.`}
      confirmLabel={`On ${prompt.outputName}`}
      cancelLabel="On this device"
      confirmTone="primary"
      onConfirm={() => void resolve('remote')}
      onCancelButton={() => void resolve('here')}
      onCancel={() => void resolve(null)}
    />
  );
};
