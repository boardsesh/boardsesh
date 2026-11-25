'use client';

import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { LOCALE_LABELS, type Locale } from '@/app/lib/i18n/config';
import SelectedCheck from '@/app/components/ui/selected-check';

export type CompactLanguageMenuProps = {
  anchorEl: HTMLElement;
  current: Locale;
  publishedLocales: readonly Locale[];
  onClose: () => void;
  onSelect: (locale: Locale) => void;
};

/** The popover and focus-managed MUI menu are needed only after a deliberate open. */
export default function CompactLanguageMenu({
  anchorEl,
  current,
  publishedLocales,
  onClose,
  onSelect,
}: CompactLanguageMenuProps) {
  return (
    <Menu anchorEl={anchorEl} open onClose={onClose}>
      {publishedLocales.map((locale) => (
        <MenuItem
          key={locale}
          selected={locale === current}
          aria-current={locale === current ? 'true' : undefined}
          onClick={() => onSelect(locale)}
          sx={{ minHeight: { sm: 44 } }}
        >
          {locale === current ? (
            <>
              <ListItemIcon sx={{ color: 'inherit' }}>
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
  );
}
