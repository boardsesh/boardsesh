'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_LABELS, isSupportedLocale, type Locale } from '@/app/lib/i18n/config';
import { localeHref, stripLocalePrefix } from '@/app/lib/i18n/locale-href';
import { getPublishedLocales } from '@/app/lib/i18n/published-locales';
import CompactLanguageMenuFallback from './compact-language-menu-fallback';
import { loadCompactLanguageMenu } from './compact-language-menu-loader';
import type { CompactLanguageMenuProps } from './compact-language-menu';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const triggerSx = { minWidth: 44, minHeight: 44 };

function CompactLanguageSwitcherInner({
  pathname,
  publishedLocales,
  ariaLabel,
}: {
  pathname: string;
  publishedLocales: readonly Locale[];
  ariaLabel: string;
}) {
  const { i18n } = useTranslation('common');
  const current: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [Menu, setMenu] = useState<React.ComponentType<CompactLanguageMenuProps> | null>(null);
  const [openedWithFallback, setOpenedWithFallback] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = useCallback(() => setAnchorEl(null), []);
  const select = useCallback(
    (next: Locale) => {
      close();
      if (next === current) return;
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
      const target = localeHref(stripLocalePrefix(pathname, current), next);
      const query = new URLSearchParams(window.location.search).toString();
      window.location.assign(query ? `${target}?${query}` : target);
    },
    [close, current, pathname],
  );
  const open = (event: React.MouseEvent<HTMLButtonElement>) => {
    setOpenedWithFallback(Menu === null);
    setAnchorEl(event.currentTarget);
    if (!Menu) {
      void loadCompactLanguageMenu()
        .then(({ default: LoadedMenu }) => {
          if (mounted.current) setMenu(() => LoadedMenu);
        })
        .catch(() => {
          /* The immediate language choices remain usable offline. */
        });
    }
  };
  const menuProps = { anchorEl: anchorEl!, current, publishedLocales, onClose: close, onSelect: select };
  return (
    <Box sx={{ position: 'relative' }}>
      <Button
        onClick={open}
        title={LOCALE_LABELS[current]}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={anchorEl ? true : undefined}
        size="small"
        sx={triggerSx}
      >
        <Box component="span" sx={{ fontSize: 14, lineHeight: 1 }}>
          {LOCALE_LABELS[current]}
        </Box>
      </Button>
      {anchorEl ? (
        openedWithFallback || !Menu ? (
          <CompactLanguageMenuFallback {...menuProps} />
        ) : (
          <Menu {...menuProps} />
        )
      ) : null}
    </Box>
  );
}

export default function CompactLanguageSwitcher() {
  const pathname = usePathname() ?? '/';
  const { i18n, t } = useTranslation('common');
  const publishedLocales = getPublishedLocales(pathname);
  if (publishedLocales.length < 2) return null;
  const current = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  return (
    <CompactLanguageSwitcherInner
      pathname={pathname}
      publishedLocales={publishedLocales}
      ariaLabel={t('languageSwitcher.ariaLabelWithCurrent', { language: LOCALE_LABELS[current] })}
    />
  );
}
