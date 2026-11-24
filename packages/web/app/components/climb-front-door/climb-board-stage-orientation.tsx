'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './climb-board-stage.module.css';

const readMirror = () => window.location.hash === '#mirrored';
const readOriginal = () => false;
const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
};

/** The fragment changes only the art the viewer sees after hydration. */
export function ClimbBoardStageOrientation({ children, aspectRatio }: { children: ReactNode; aspectRatio: string }) {
  const { t } = useTranslation('boards');
  const mirrored = useSyncExternalStore(subscribe, readMirror, readOriginal);
  return (
    <>
      <Box className={styles.art} data-mirrored={mirrored || undefined} sx={{ '--board-aspect-ratio': aspectRatio }}>
        {children}
      </Box>
      {mirrored && (
        <Typography component="figcaption" variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          {t('gymReporting.rankings.mirrored')}
        </Typography>
      )}
    </>
  );
}
