'use client';

import React, { Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import MenuItem from '@mui/material/MenuItem';
import Select, { type SelectChangeEvent } from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  type Locale,
  isSupportedLocale,
} from '@/app/lib/i18n/config';
import { localeHref, stripLocalePrefix } from '@/app/lib/i18n/locale-href';

function LanguageSwitcherInner() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  // useSearchParams forces the consumer into a client-rendered Suspense
  // boundary; the wrapper below provides it.
  const searchParams = useSearchParams();
  const { i18n } = useTranslation();
  const currentLocale: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;

  const handleChange = (event: SelectChangeEvent) => {
    const next = event.target.value;
    if (!isSupportedLocale(next) || next === currentLocale) {
      return;
    }
    // Persist the choice so subsequent navigation to plain (un-prefixed) paths
    // gets redirected to the matching localised URL by middleware.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
    const basePath = stripLocalePrefix(pathname, currentLocale);
    const target = localeHref(basePath, next);
    const query = searchParams?.toString();
    router.push(query ? `${target}?${query}` : target);
  };

  return (
    <FormControl size="small">
      <Select
        value={currentLocale}
        onChange={handleChange}
        inputProps={{ 'aria-label': 'Language' }}
        sx={{ minWidth: 120 }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <MenuItem key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function LanguageSwitcherFallback() {
  return (
    <FormControl size="small">
      <Select value={DEFAULT_LOCALE} disabled inputProps={{ 'aria-label': 'Language' }} sx={{ minWidth: 120 }}>
        {SUPPORTED_LOCALES.map((locale) => (
          <MenuItem key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

export default function LanguageSwitcher() {
  return (
    <Suspense fallback={<LanguageSwitcherFallback />}>
      <LanguageSwitcherInner />
    </Suspense>
  );
}
