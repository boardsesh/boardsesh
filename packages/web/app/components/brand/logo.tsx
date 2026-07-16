'use client';

import React from 'react';
import LocaleLink from '@/app/components/i18n/locale-link';
import Image from 'next/image';
import { themeTokens } from '@/app/theme/theme-config';

type LogoProps = {
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  linkToHome?: boolean;
};

const sizes = {
  sm: { icon: 32, fontSize: 14, gap: 6 },
  md: { icon: 40, fontSize: 16, gap: 8 },
  lg: { icon: 52, fontSize: 20, gap: 10 },
};

const Logo = ({ size = 'md', showText = true, linkToHome = true }: LogoProps) => {
  const { icon, fontSize, gap } = sizes[size];

  const logoContent = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {/* i18n-ignore-next-line -- brand name, not translated */}
      <Image src="/brand/boardsesh-mark.png" width={icon} height={icon} alt="Boardsesh logo" priority />
      {showText && (
        <span
          style={{
            fontSize,
            fontWeight: themeTokens.typography.fontWeight.extrabold,
            color: 'var(--neutral-800)',
            letterSpacing: '-0.02em',
            lineHeight: 1,
          }}
        >
          {/* i18n-ignore-next-line -- brand name, not translated */}
          boardsesh
        </span>
      )}
    </div>
  );

  if (linkToHome) {
    return (
      <LocaleLink href="/" style={{ textDecoration: 'none', color: 'inherit', display: 'flex' }}>
        {logoContent}
      </LocaleLink>
    );
  }

  return logoContent;
};

export default Logo;
