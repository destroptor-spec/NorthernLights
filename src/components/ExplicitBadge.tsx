import React from 'react';

/** The small "E" beside an explicit track's title (the file's iTunes advisory rating). */
export const ExplicitBadge: React.FC = () => (
    <span className="explicit-badge" role="img" aria-label="Explicit" title="Explicit">E</span>
);
