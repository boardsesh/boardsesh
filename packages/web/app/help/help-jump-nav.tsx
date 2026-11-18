'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import type { HelpJumpLink } from './help-page-shell';
import styles from './help-page-shell.module.css';

export default function HelpJumpNav({ links, label }: { links: readonly HelpJumpLink[]; label: string }) {
  const [activeId, setActiveId] = useState(links[0]?.id ?? '');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -60% 0px' },
    );
    for (const link of links) {
      const section = document.getElementById(link.id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [links]);
  return (
    <Box component="nav" aria-label={label} className={styles.stickyJumpNav}>
      <Box component="ul" className={styles.jump}>
        {links.map((link) => (
          <li key={link.id}>
            <MuiLink
              href={`#${link.id}`}
              underline="none"
              className={styles.chip}
              aria-current={activeId === link.id ? 'location' : undefined}
              onClick={() => setActiveId(link.id)}
            >
              {link.label}
            </MuiLink>
          </li>
        ))}
      </Box>
    </Box>
  );
}
