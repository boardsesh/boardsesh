import React from 'react';
import { ImageResponse } from 'next/og';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeTokens } from './theme/theme-config';

export const runtime = 'nodejs';

export const alt = 'Boardsesh - Train smarter on your climbing board';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Resolve icon.svg via import.meta.url so @vercel/nft traces it into the
// standalone container build. dirname+join yields a plain string, which
// avoids a Turbopack URL-prototype mismatch we saw when passing the URL
// straight into readFileSync.
const iconPath = join(dirname(fileURLToPath(import.meta.url)), 'icon.svg');
const iconSvg = readFileSync(iconPath);
const iconDataUrl = `data:image/svg+xml;base64,${iconSvg.toString('base64')}`;

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#15101e',
        fontFamily: 'sans-serif',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={iconDataUrl} width={320} height={320} alt="" />

      <div
        style={{
          fontSize: 128,
          fontWeight: 900,
          color: themeTokens.text.brandPrimary,
          letterSpacing: '-2px',
          marginTop: 24,
        }}
      >
        {/* i18n-ignore-next-line -- OG image, brand-only text */}
        boardsesh
      </div>

      <div
        style={{
          fontSize: 36,
          color: themeTokens.text.brandMuted,
          fontWeight: 500,
          marginTop: 12,
          letterSpacing: '6px',
        }}
      >
        {/* i18n-ignore-next-line -- OG image, English-only */}
        ONE APP FOR YOUR BOARDS
      </div>
    </div>,
    { ...size },
  );
}
