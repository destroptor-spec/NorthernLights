import React from 'react';

const GlobalSearch = React.lazy(() => import('./GlobalSearch').then(module => ({ default: module.GlobalSearch })));

const SearchFallback: React.FC = () => (
  <div className="header-pill w-[104px] max-md:w-[2.375rem] pointer-events-none" aria-hidden="true" />
);

// The global search entry point, wrapped in its own Suspense boundary so the
// search chunk loads lazily. Rendered by both the mobile header and desktop tab
// bar.
export const GlobalSearchSlot: React.FC = () => (
  <React.Suspense fallback={<SearchFallback />}>
    <GlobalSearch />
  </React.Suspense>
);

export default GlobalSearchSlot;
