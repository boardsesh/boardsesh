'use client';

import React, { Suspense, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_LABELS, isSupportedLocale, type Locale } from '@/app/lib/i18n/config';
import { localeHref, stripLocalePrefix } from '@/app/lib/i18n/locale-href';
import { getPublishedLocales } from '@/app/lib/i18n/published-locales';
import SelectedCheck from '@/app/components/ui/selected-check';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const languageNameSx = { fontSize: 14, lineHeight: 1 };
const triggerSx = { minWidth: 44, minHeight: 44 };
// MUI already gives phone menu rows 48px; desktop rows need a 44px floor.
const menuItemSx = { minHeight: { sm: 44 } };
// The check takes the selected item's ink rather than ListItemIcon's grey.
const currentLocaleIconSx = { color: 'inherit' };

type LabelProps = {
  ariaLabel: string;
  label: string;
};

function CompactLanguageSwitcherInner({
  pathname,
  publishedLocales,
  ariaLabelTemplate,
}: {
  pathname: string;
  publishedLocales: readonly Locale[];
  ariaLabelTemplate: (label: string) => string;
}) {
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
        <Button
          onClick={handleOpen}
          aria-label={ariaLabelTemplate(LOCALE_LABELS[current])}
          aria-haspopup="menu"
          aria-expanded={open ? true : undefined}
          size="small"
          sx={triggerSx}
        >
          <Box component="span" sx={languageNameSx}>
            {LOCALE_LABELS[current]}
          </Box>
        </Button>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={open} onClose={handleClose}>
        {/* The current locale is announced with aria-current and shown on the
            tonal container with a leading check; the others inset their label
            so every name lines up. */}
        {publishedLocales.map((locale) => (
          <MenuItem
            key={locale}
            selected={locale === current}
            aria-current={locale === current ? 'true' : undefined}
            onClick={() => handleSelect(locale)}
            sx={menuItemSx}
          >
            {locale === current ? (
              <>
                <ListItemIcon sx={currentLocaleIconSx}>
                  <SelectedCheck />
                </ListItemIcon>
                <ListItemText>{LOCALE_LABELS[locale]}</ListItemText>
              </>
            ) : (
              <ListItemText inset>{LOCALE_LABELS[locale]}</ListItemText>
            )}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

function CompactLanguageSwitcherFallback({ ariaLabel, label }: LabelProps) {
  return (
    <Button disabled size="small" aria-label={ariaLabel} sx={triggerSx}>
      <Box component="span" sx={languageNameSx}>
        {label}
      </Box>
    </Button>
  );
}

export default function CompactLanguageSwitcher() {
  const pathname = usePathname() ?? '/';
  const { i18n, t } = useTranslation('common');
  const publishedLocales = getPublishedLocales(pathname);
  if (publishedLocales.length < 2) return null;

  const fallbackLocale: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  const ariaLabelTemplate = (label: string) => t('languageSwitcher.ariaLabelWithCurrent', { language: label });

  return (
    <Suspense
      fallback={
        <CompactLanguageSwitcherFallback
          ariaLabel={ariaLabelTemplate(LOCALE_LABELS[fallbackLocale])}
          label={LOCALE_LABELS[fallbackLocale]}
        />
      }
    >
      <CompactLanguageSwitcherInner
        pathname={pathname}
        publishedLocales={publishedLocales}
        ariaLabelTemplate={ariaLabelTemplate}
      />
    </Suspense>
  );
}
