import React from 'react';
import type { UserAvatar as Avatar } from '../../shared/api/v1';
import { avatarAuroraColors } from '../utils/coverGradient';
import { previewLabel } from '../utils/listenTogetherText';

/**
 * A user's avatar: the picture when the server has one (later: Gravatar or
 * an upload, served through Aurora), else the initial, as on the account
 * page (docs/listen-together.md, "Avatars in API v1"), on the user's own
 * aurora colors (avatarAuroraColors).
 */
export const UserAvatar: React.FC<{ avatar: Avatar; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string }> = ({ avatar, size = 'md', className = '' }) => {
  if (avatar.pictureUrl) {
    return (
      <span className={`user-avatar user-avatar--${size} ${className}`} aria-hidden="true">
        <img src={avatar.pictureUrl} alt="" />
      </span>
    );
  }
  const [from, to] = avatarAuroraColors(avatar.userId);
  return (
    <span
      className={`user-avatar user-avatar--${size} is-aurora ${className}`}
      style={{ '--avatar-from': from, '--avatar-to': to } as React.CSSProperties}
      aria-hidden="true"
    >
      {avatar.initial}
    </span>
  );
};

/**
 * Avatars overlapping, at most `max`, then "+N" for the rest (the gig line:
 * five, then "+2" for seven; Andreas, 2026-10-29).
 */
export const AvatarStack: React.FC<{ avatars: Avatar[]; max: number; size?: 'xs' | 'sm' | 'md' }> = ({ avatars, max, size = 'sm' }) => {
  const shown = avatars.slice(0, max);
  const more = avatars.length - shown.length;
  return (
    <span className="avatar-stack" aria-hidden="true">
      {shown.map((avatar) => <UserAvatar key={avatar.userId} avatar={avatar} size={size} />)}
      {more > 0 && <span className={`user-avatar user-avatar--${size} avatar-stack-more`}>+{more}</span>}
    </span>
  );
};

/**
 * Who is in a session, before joining: the owner on its own, then the
 * guests stacked ("+N" past four). No guest names, not even for screen
 * readers, which hear "{owner} and {n} others".
 */
export const SessionPreviewAvatars: React.FC<{ ownerName: string; owner: Avatar; guests: Avatar[]; size?: 'sm' | 'lg' }> = ({ ownerName, owner, guests, size = 'lg' }) => (
  <div className={`session-preview-avatars${size === 'sm' ? ' is-small' : ''}`} role="img" aria-label={previewLabel(ownerName, guests.length)}>
    <UserAvatar avatar={owner} size={size === 'sm' ? 'sm' : 'lg'} />
    {guests.length > 0 && <AvatarStack avatars={guests} max={4} size={size === 'sm' ? 'xs' : 'md'} />}
  </div>
);
