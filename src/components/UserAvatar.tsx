import React from 'react';
import type { UserAvatar as Avatar } from '../../shared/api/v1';
import { previewLabel } from '../utils/listenTogether';

/**
 * A user's avatar: the picture when the server has one (later: Gravatar or
 * an upload, served through Aurora), else the initial, as on the account
 * page (docs/listen-together.md, "Avatars in API v1").
 */
export const UserAvatar: React.FC<{ avatar: Avatar; size?: 'sm' | 'md' | 'lg'; className?: string }> = ({ avatar, size = 'md', className = '' }) => (
  <span className={`user-avatar user-avatar--${size} ${className}`} aria-hidden="true">
    {avatar.pictureUrl ? <img src={avatar.pictureUrl} alt="" /> : avatar.initial}
  </span>
);

const STACKED = 4;

/**
 * Who is in a session, before joining: the owner on its own, then the
 * guests stacked ("+N" past four). No guest names, not even for screen
 * readers, which hear "{owner} and {n} others".
 */
export const SessionPreviewAvatars: React.FC<{ ownerName: string; owner: Avatar; guests: Avatar[] }> = ({ ownerName, owner, guests }) => {
  const shown = guests.slice(0, STACKED);
  const more = guests.length - shown.length;
  return (
    <div className="session-preview-avatars" role="img" aria-label={previewLabel(ownerName, guests.length)}>
      <UserAvatar avatar={owner} size="lg" />
      {guests.length > 0 && (
        <span className="avatar-stack">
          {shown.map((guest) => <UserAvatar key={guest.userId} avatar={guest} size="md" />)}
          {more > 0 && <span className="user-avatar user-avatar--md avatar-stack-more" aria-hidden="true">+{more}</span>}
        </span>
      )}
    </div>
  );
};
