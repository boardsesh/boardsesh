'use client';

import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ChevronLeft from '@mui/icons-material/ChevronLeft';
import ChevronRight from '@mui/icons-material/ChevronRight';
import styles from './boards-gallery.module.css';

type BoardLayoutRailProps = {
  labelledBy: string;
  previousLabel: string;
  nextLabel: string;
  children: React.ReactNode;
};

export default function BoardLayoutRail({ labelledBy, previousLabel, nextLabel, children }: BoardLayoutRailProps) {
  const scrollerRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState<{ overflow: boolean | null; start: boolean; end: boolean }>({
    overflow: null,
    start: true,
    end: false,
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const updateEdges = () => {
      const overflow = scroller.scrollWidth > scroller.clientWidth + 1;
      const start = scroller.scrollLeft <= 1;
      const end = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
      setEdges((previous) =>
        previous.overflow === overflow && previous.start === start && previous.end === end
          ? previous
          : { overflow, start, end },
      );
    };
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(scroller);
    scroller.addEventListener('scroll', updateEdges, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', updateEdges);
    };
  }, [children]);

  const move = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const card = scroller.firstElementChild;
    const gap = Number.parseFloat(getComputedStyle(scroller).columnGap) || 0;
    scroller.scrollBy({ left: direction * ((card?.getBoundingClientRect().width ?? 205) + gap) });
  };

  return (
    <Box className={styles.rail}>
      {edges.overflow && (
        <Box className={styles.railControls}>
          <IconButton
            aria-label={previousLabel}
            disabled={edges.start}
            onClick={() => move(-1)}
            className={styles.railButton}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton aria-label={nextLabel} disabled={edges.end} onClick={() => move(1)} className={styles.railButton}>
            <ChevronRight />
          </IconButton>
        </Box>
      )}
      <Box
        component="ul"
        role="list"
        aria-labelledby={labelledBy}
        // Keep native keyboard scrolling before hydration; measured fitting lists need no extra tab stop.
        tabIndex={edges.overflow === false ? undefined : 0}
        ref={scrollerRef}
        className={styles.scroller}
        onKeyDown={(event) => {
          if (!edges.overflow || event.target !== event.currentTarget) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            move(event.key === 'ArrowLeft' ? -1 : 1);
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            event.currentTarget.scrollTo({ left: event.key === 'Home' ? 0 : event.currentTarget.scrollWidth });
          }
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
