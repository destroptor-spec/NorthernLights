import { createLucideIcon } from 'lucide-react';

/**
 * Lucide's "galaxy" icon (lucide v1.74.0, ISC licence, © Lucide Icons and
 * Contributors). The lucide-react we're on (0.x) predates it; once the move to
 * lucide-react 1 is done (issue #28), import `Galaxy` from 'lucide-react' and
 * delete this file.
 */
export const Galaxy = createLucideIcon('galaxy', [
  ['path', { d: 'M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001', key: 'galaxy-arms' }],
  ['path', { d: 'M17 21h.01', key: 'galaxy-star-1' }],
  ['path', { d: 'M7 3h.01', key: 'galaxy-star-2' }],
  ['path', { d: 'M7.997 8.891a11.885 7.288-60.756 0111.977 8.107', key: 'galaxy-arm-2' }],
  ['circle', { cx: '12', cy: '12', r: '1', fill: 'currentColor', key: 'galaxy-core' }],
]);
