'use client';

import React, { Suspense, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type Locale,
} from '@/app/lib/i18n/config';
import { localeHref, stripLocalePrefix } from '@/app/lib/i18n/locale-href';

const FLAGS: Record<Locale, string> = {
  'en-US': '🇺🇸',
  es: '🇪🇸',
  fr: '🇫🇷',
  de: '🇩🇪',
};
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const flagSx = { fontSize: 20, lineHeight: 1 };
const menuFlagSx = { fontSize: 18, lineHeight: 1, minWidth: 24 };

type LabelProps = {
  ariaLabel: string;
  flag: string;
};

function CompactLanguageSwitcherInner({ ariaLabelTemplate }: { ariaLabelTemplate: (label: string) => string }) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const { i18n } = useTranslation('common');
  const current: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = anchorEl !== null;

  const handleOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleSelect = (next: Locale) => {
    handleClose();
    if (next === current) {
      return;
    }
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    const basePath = stripLocalePrefix(pathname, current);
    const target = localeHref(basePath, next);
    const query = searchParams?.toString();
    window.location.assign(query ? `${target}?${query}` : target);
  };

  return (
    <>
      <Tooltip title={LOCALE_LABELS[current]}>
        <IconButton
          onClick={handleOpen}
          aria-label={ariaLabelTemplate(LOCALE_LABELS[current])}
          aria-haspopup="menu"
          aria-expanded={open ? true : undefined}
          size="small"
        >
          <Box component="span" sx={flagSx} aria-hidden>
            {FLAGS[current]}
          </Box>
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={open} onClose={handleClose}>
        {SUPPORTED_LOCALES.map((locale) => (
          <MenuItem key={locale} selected={locale === current} onClick={() => handleSelect(locale)}>
            <ListItemIcon>
              <Box component="span" sx={menuFlagSx} aria-hidden>
                {FLAGS[locale]}
              </Box>
            </ListItemIcon>
            <ListItemText>{LOCALE_LABELS[locale]}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

function CompactLanguageSwitcherFallback({ ariaLabel, flag }: LabelProps) {
  return (
    <IconButton disabled size="small" aria-label={ariaLabel}>
      <Box component="span" sx={flagSx} aria-hidden>
        {flag}
      </Box>
    </IconButton>
  );
}

export default function CompactLanguageSwitcher() {
  const { i18n, t } = useTranslation('common');
  const fallbackLocale: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  const ariaLabelTemplate = (label: string) => t('languageSwitcher.ariaLabelWithCurrent', { language: label });

  return (
    <Suspense
      fallback={
        <CompactLanguageSwitcherFallback
          ariaLabel={ariaLabelTemplate(LOCALE_LABELS[fallbackLocale])}
          flag={FLAGS[fallbackLocale]}
        />
      }
    >
      <CompactLanguageSwitcherInner ariaLabelTemplate={ariaLabelTemplate} />
    </Suspense>
  );
}
