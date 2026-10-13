import React from 'react';
import { usePlayerStore } from '../store/index';
import { ConfirmModal } from './ConfirmModal';

/**
 * Next or Previous pressed on an idle device while another device plays the
 * session: moving playback here is a big change, so ask first. Play is not
 * asked about; it always continues here.
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
      confirmTone="primary"
      onConfirm={() => void resolve(true)}
      onCancel={() => void resolve(false)}
    />
  );
};
