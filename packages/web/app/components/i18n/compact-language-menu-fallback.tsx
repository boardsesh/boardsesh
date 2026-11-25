'use client';

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import { LOCALE_LABELS } from '@/app/lib/i18n/config';
import SelectedCheck from '@/app/components/ui/selected-check';
import type { CompactLanguageMenuProps } from './compact-language-menu';

function positionNearTrigger(anchorEl: HTMLElement) {
  const bounds = anchorEl.getBoundingClientRect();
  const width = Math.min(180, Math.max(0, window.innerWidth - 32));
  const spaceAbove = Math.max(0, bounds.top - 16);
  const spaceBelow = Math.max(0, window.innerHeight - bounds.bottom - 16);
  const opensAbove = spaceAbove >= spaceBelow;
  return {
    left: Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16)),
    bottom: opensAbove ? Math.max(16, window.innerHeight - bounds.top) : undefined,
    top: opensAbove ? undefined : Math.max(16, bounds.bottom),
    width,
    maxHeight: opensAbove ? spaceAbove : spaceBelow,
  };
}

/** Choices work immediately, including when the enhanced menu cannot download. */
export default function CompactLanguageMenuFallback({
  anchorEl,
  current,
  publishedLocales,
  onClose,
  onSelect,
}: CompactLanguageMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => positionNearTrigger(anchorEl));
  useEffect(() => {
    const reposition = () => setPosition(positionNearTrigger(anchorEl));
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchorEl]);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !anchorEl.contains(event.target))
        onClose();
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      if (anchorEl.isConnected) anchorEl.focus();
    };
  }, [anchorEl, onClose]);
  return (
    <Box
      ref={menuRef}
      role="menu"
      sx={{
        position: 'fixed',
        ...position,
        boxSizing: 'border-box',
        zIndex: 'modal',
        overflowY: 'auto',
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 0.5,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          onClose();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const choices = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const activeIndex = choices.indexOf(document.activeElement as HTMLElement);
        const nextIndex =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? choices.length - 1
              : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        choices[nextIndex]?.focus();
      }}
    >
      {publishedLocales.map((locale) => (
        <MuiLink
          component="button"
          type="button"
          role="menuitem"
          key={locale}
          tabIndex={locale === current ? 0 : -1}
          aria-current={locale === current ? 'true' : undefined}
          color="inherit"
          underline="none"
          onClick={() => onSelect(locale)}
          sx={{
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            width: '100%',
            minHeight: { xs: 48, sm: 44 },
            px: 2,
            bgcolor: locale === current ? 'action.selected' : undefined,
            textAlign: 'left',
          }}
        >
          <Box component="span" sx={{ width: 24, flexShrink: 0 }}>
            {locale === current ? <SelectedCheck /> : null}
          </Box>
          {LOCALE_LABELS[locale]}
        </MuiLink>
      ))}
    </Box>
  );
}
