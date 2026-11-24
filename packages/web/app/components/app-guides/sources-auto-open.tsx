'use client';

import { useEffect } from 'react';

/**
 * Opens a closed `<details>` when the URL fragment points inside it, then scrolls
 * to the target: a verdict chip links to its row's group in the Sources
 * disclosure. Chromium already expands `<details>` on fragment navigation; this
 * covers the rest. Renders nothing: the sources are in the server HTML either way.
 */
export default function SourcesAutoOpen() {
  useEffect(() => {
    const reveal = () => {
      const { hash } = window.location;
      if (hash.length < 2) return;
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      const disclosure = target?.closest('details');
      if (!target || !disclosure) return;
      if (!disclosure.open) disclosure.open = true;
      target.scrollIntoView({ block: 'start' });
    };
    reveal();
    // A second click on the same link fires no hashchange, so listen for the click too.
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
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
