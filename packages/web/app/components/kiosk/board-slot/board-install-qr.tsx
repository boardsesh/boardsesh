'use client';

// Per-board "install Boardsesh" QR for the kiosk. Encodes /b/{slug} for THIS
// board so a climber on the wall can scan, get the app, and have their sends
// light up the screen. Rendered in a corner of the board slot when the kiosk's
// showInstallQr toggle is on and the board has a slug.
//
// The QR must sit on a WHITE tile: a bare dark QR on the dark kiosk surface
// won't scan (a QR needs a light quiet zone), so we render black modules on a
// white card and keep the caption dark-on-white too.
//
// TARGET NOTE: /b/{slug} opens the app on iOS (universal link) and Android
// (`/b/` intent filter), via the app/b/[board_slug] route. Without the app it
// falls back to the web board page, which carries install CTAs.

import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { boardQrUrl } from '@/app/lib/gym-attribution';
import styles from './board-install-qr.module.css';

export default function BoardInstallQr({ slug }: { slug: string }) {
  const { t } = useTranslation('kiosk');
  // Carries `?src=qr&medium=kiosk` (#4379). The params survive `/b/[board_slug]`'s
  // redirect, and the board list it lands on counts the scan as
  // `Board QR Scanned` with `medium: 'kiosk'` (#4415). Not `Gym QR Scanned`:
  // that one is the gym poster's, on `/gym/[gym_slug]`.
  const installUrl = boardQrUrl(slug, 'kiosk');

  return (
    <div className={styles.tile}>
      {/* Fixed internal resolution; CSS scales the SVG responsively via clamp(). */}
      <QRCodeSVG className={styles.qr} value={installUrl} size={128} level="M" marginSize={1} aria-hidden />
      <span className={styles.caption}>{t('installQr.caption')}</span>
    </div>
  );
}
