'use client';

import { useEffect } from 'react';

/**
 * Opens the closed Sources disclosure when a row's "Sources" link (or a shared
 * `#sources-…` URL) points inside it. Some browsers already expand a `<details>`
 * on fragment navigation; this covers the rest. Renders nothing: the sources are
 * in the server HTML either way.
 */
export default function SourcesAutoOpen() {
  useEffect(() => {
    const reveal = () => {
      const { hash } = window.location;
      if (!hash.startsWith('#sources')) return;
      const disclosure = document.getElementById('sources');
      if (!(disclosure instanceof HTMLDetailsElement)) return;
      disclosure.open = true;
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' });
    };
    reveal();
    // A second click on the same link fires no hashchange, so listen for the click too.
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#sources"]') : null;
      if (link) window.requestAnimationFrame(reveal);
    };
    window.addEventListener('hashchange', reveal);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('hashchange', reveal);
      document.removeEventListener('click', onClick);
    };
  }, []);
  return null;
}
