'use client';

import { useRef, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import MenuOutlined from '@mui/icons-material/MenuOutlined';
import styles from './marketing-chrome.module.css';
import headerStyles from '@/app/components/site-chrome/marketing-header.module.css';

/** Native disclosure keeps navigation usable before hydration and with scripts disabled. */
export default function MarketingDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <Box
      component="details"
      ref={detailsRef}
      className={`${headerStyles.navMenuSlot} ${styles.menu}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !detailsRef.current?.open) return;
        detailsRef.current.open = false;
        detailsRef.current.querySelector('summary')?.focus();
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('a') && detailsRef.current) {
          detailsRef.current.open = false;
        }
      }}
    >
      <Box component="summary" aria-label={label} className={styles.menuTrigger}>
        <MenuOutlined />
      </Box>
      <Box component="nav" aria-label={label} className={styles.menuLinks}>
        {children}
      </Box>
    </Box>
  );
}
