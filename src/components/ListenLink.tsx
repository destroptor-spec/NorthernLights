import React, { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { openInviteLink } from '../utils/listenTogether';

// Strict mode runs effects twice; a link is opened once.
const opened = new Set<string>();

/**
 * `/listen/<token>`, a join link (docs/listen-together.md): the app opens
 * as usual, with the invitation's preview over it. A link opened before
 * signing in comes here after the sign-in.
 */
export const ListenLink: React.FC = () => {
  const { token } = useParams();
  useEffect(() => {
    if (!token || opened.has(token)) return;
    opened.add(token);
    void openInviteLink(token);
  }, [token]);
  return <Navigate to="/library" replace />;
};

export default ListenLink;
