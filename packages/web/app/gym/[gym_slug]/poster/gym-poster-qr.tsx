'use client';

// The printed code itself (#4379).
//
// A client island because `qrcode.react` calls hooks — the rest of the poster
// is server-rendered.

import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { gymQrUrl } from '@/app/lib/gym-attribution';
import styles from './gym-poster.module.css';

// COLOURS ARE COMPONENT PROPS, NOT CSS, AND THAT IS THE WHOLE POINT.
//
// Browsers strip background graphics when printing unless the reader ticks the
// box, so a white quiet zone painted as a CSS background disappears on paper
// and a dark-mode page prints a dark code on dark — unscannable, and only
// discovered after someone laminates it. As SVG fills they are page content:
// they print by default, in every theme, on every browser.
const POSTER_QR_FOREGROUND = '#000000';
const POSTER_QR_BACKGROUND = '#ffffff';

export default function GymPosterQr({ gymSlug }: { gymSlug: string }) {
  // `gymQrUrl` — never a hand-built string. The printed code and every counter
  // that reads `?src=qr&medium=poster` have to come out of one function, because
  // a disagreement between them is only discovered after the poster is on a wall.
  const posterUrl = gymQrUrl(gymSlug, 'poster');

  return (
    <QRCodeSVG
      className={styles.qr}
      value={posterUrl}
      // Internal resolution only; the CSS sizes the SVG in millimetres.
      size={512}
      fgColor={POSTER_QR_FOREGROUND}
      bgColor={POSTER_QR_BACKGROUND}
      // Error correction Q (25%) rather than the kiosk's M. A kiosk QR lives on
      // a clean backlit screen; this one gets taped to a wall, scuffed and
      // fingerprinted. The extra modules cost nothing at 76 mm.
      level="Q"
      // The spec quiet zone is 4 modules. The kiosk uses 1, which is fine
      // against its own white tile and wrong on paper next to printed text.
      marginSize={4}
      // The typed-URL line below the code is the accessible equivalent, so the
      // matrix itself is decoration to a screen reader.
      aria-hidden
    />
  );
}
