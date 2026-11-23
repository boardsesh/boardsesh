/**
 * The attribute a server page puts on its own store badges so the sticky
 * install bar (`sticky-install-bar.tsx`) stays down while they are on screen,
 * and only appears once the reader has scrolled past one.
 *
 * A plain module, not an export of the bar: a server component importing a
 * value from a `'use client'` file gets a client reference, not the string.
 */
export const STICKY_INSTALL_HIDE_ATTRIBUTE = 'data-sticky-install-hide';
