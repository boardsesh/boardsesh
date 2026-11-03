'use client';

import React, { useEffect, useId, useState } from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import styles from './help.module.css';

export type HelpTopic = { id: string; label: string };

/**
 * The hub's "on this page" list: a quiet sticky column beside the content on a
 * desktop, a plain two-column list above it on a phone.
 *
 * The section being read is marked with `aria-current="location"` and a violet
 * rail. Server HTML marks the first topic; after hydration an
 * IntersectionObserver watches a band 15–35% down the viewport and marks the
 * first section crossing it, keeping the last mark while the band sits in a gap
 * between sections. At the very bottom of the page the last topic is marked,
 * since a short last section never reaches the band. Without
 * IntersectionObserver the first mark simply stays.
 */
export default function HelpTopicsNav({ label, topics }: { label: string; topics: readonly HelpTopic[] }) {
  const [activeId, setActiveId] = useState(topics[0]?.id);
  const labelId = useId();

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const sections = topics
      .map((topic) => document.getElementById(topic.id))
      .filter((element): element is HTMLElement => element !== null);
    const crossing = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) crossing.add(entry.target.id);
          else crossing.delete(entry.target.id);
        }
        const firstCrossing = sections.find((section) => crossing.has(section.id));
        if (firstCrossing) setActiveId(firstCrossing.id);
      },
      { rootMargin: '-15% 0px -65% 0px' },
    );
    sections.forEach((section) => observer.observe(section));

    // A short last section can never reach the band, so at the bottom of the
    // page mark the last topic outright. React skips the render when it is
    // already marked, so this costs nothing per scroll event.
    const lastSection = sections[sections.length - 1];
    const markLastAtBottom = () => {
      const root = document.documentElement;
      if (lastSection && window.innerHeight + window.scrollY >= root.scrollHeight - 2) {
        setActiveId(lastSection.id);
      }
    };
    window.addEventListener('scroll', markLastAtBottom, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', markLastAtBottom);
    };
  }, [topics]);

  return (
    <Box component="nav" aria-labelledby={labelId} className={styles.topics}>
      <Typography id={labelId} component="p" className={styles.topicsLabel}>
        {label}
      </Typography>
      <Box component="ul" className={styles.topicList}>
        {topics.map((topic) => (
          <li key={topic.id}>
            <MuiLink
              href={`#${topic.id}`}
              underline="none"
              aria-current={topic.id === activeId ? 'location' : undefined}
              className={styles.topicLink}
              onClick={() => setActiveId(topic.id)}
            >
              {topic.label}
            </MuiLink>
          </li>
        ))}
      </Box>
    </Box>
  );
}
