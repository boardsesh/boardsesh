import React from 'react';
import Box from '@mui/material/Box';
import type { TFunction } from 'i18next';
import { summarizeHoldRoles, type HoldLegendRole } from '@boardsesh/board-constants/hold-states';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { fillNodeSlot, nodeSlot } from '@/app/lib/i18n/node-slot';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardName } from '@/app/lib/types';

type HoldLegendProps = {
  board: BoardName;
  frames: string | null | undefined;
};

const listSx = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  rowGap: `${themeTokens.spacing[1]}px`,
  columnGap: { xs: `${themeTokens.spacing[3]}px`, md: `${themeTokens.spacing[5]}px` },
  margin: 0,
  marginTop: `${themeTokens.spacing[3]}px`,
  paddingInline: `${themeTokens.spacing[1]}px`,
  listStyle: 'none',
  fontSize: themeTokens.typography.fontSize.sm,
  color: 'var(--neutral-500)',
  '& b': { color: 'text.primary', fontWeight: themeTokens.typography.fontWeight.semibold },
};

const itemSx = { display: 'inline-flex', alignItems: 'center', gap: `${themeTokens.spacing[2]}px` };

const COUNT_SLOT = 'count';

/**
 * A shape per role as well as a colour, so the legend still reads for a
 * climber who can't tell the render's green from its cyan: up for the start,
 * a dot for hands, a square for the finish, down for the feet.
 */
function RoleShape({ role, color }: { role: HoldLegendRole; color: string }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      {role === 'STARTING' ? <path d="M6 1.2 11.2 10.8H.8z" fill={color} /> : null}
      {role === 'HAND' ? <circle cx="6" cy="6" r="5.2" fill={color} /> : null}
      {role === 'FINISH' ? <rect x="1.2" y="1.2" width="9.6" height="9.6" rx="1.5" fill={color} /> : null}
      {role === 'FOOT' ? <path d="M6 10.8 .8 1.2h10.4z" fill={color} /> : null}
    </svg>
  );
}

// One literal key per role, so the catalog checks can see every key in use.
function roleLabel(t: TFunction, role: HoldLegendRole, count: number): string {
  const options = { count, formattedCount: nodeSlot(COUNT_SLOT) };
  switch (role) {
    case 'STARTING':
      return t('frontDoor.legend.start', options);
    case 'HAND':
      return t('frontDoor.legend.hand', options);
    case 'FINISH':
      return t('frontDoor.legend.finish', options);
    case 'FOOT':
      return t('frontDoor.legend.foot', options);
  }
}

/**
 * How many holds the climb lights in each role, under its board render. The
 * counts are the same union of frames the render draws, and each entry's swatch
 * is the colour its holds are drawn in, so the picture and the legend agree. A
 * role drawn in two colours (Kilter's Tycho colour mode) gets two entries.
 * Renders nothing when the climb lights nothing it can count.
 */
export default async function HoldLegend({ board, frames }: HoldLegendProps) {
  const roles = summarizeHoldRoles(board, frames);
  if (roles.length === 0) return null;

  const { t, locale } = await getServerTranslation('climbs');
  const numberFormat = new Intl.NumberFormat(locale);

  return (
    <Box component="ul" aria-label={t('frontDoor.legend.aria')} sx={listSx}>
      {roles.map(({ role, count, color }) => (
        <Box component="li" key={`${role}-${color}`} sx={itemSx}>
          <RoleShape role={role} color={color} />
          <span>{fillNodeSlot(roleLabel(t, role, count), COUNT_SLOT, <b>{numberFormat.format(count)}</b>)}</span>
        </Box>
      ))}
    </Box>
  );
}
