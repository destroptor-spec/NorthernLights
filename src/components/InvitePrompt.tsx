import React from 'react';
import { useListenTogetherStore } from '../store/listenTogether';
import { dismissInvite, joinInvite, sessionTitle } from '../utils/listenTogether';
import { ConfirmModal } from './ConfirmModal';
import { SessionPreviewAvatars } from './UserAvatar';

/**
 * An invitation to listen together: a prompt from a session's owner, or a
 * `/listen/<token>` link (docs/listen-together.md, "Before joining"). The
 * same preview either way: "{owner}'s session" and avatars, nothing about
 * what plays. Not now only closes it.
 */
export const InvitePrompt: React.FC = () => {
  const prompt = useListenTogetherStore((s) => s.prompt);
  if (!prompt) return null;
  const { preview } = prompt;
  return (
    <ConfirmModal
      title={sessionTitle(preview.ownerName)}
      message={`Listen together with ${preview.ownerName}?`}
      body={<SessionPreviewAvatars ownerName={preview.ownerName} owner={preview.owner} guests={preview.guests} />}
      wide={false}
      confirmLabel="Join"
      cancelLabel="Not now"
      confirmTone="primary"
      onConfirm={() => void joinInvite()}
      onCancel={dismissInvite}
    />
  );
};
