import React from 'react';
import Box from '@mui/material/Box';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { formatBoardDisplayName } from '@/app/lib/string-utils';

type SetterSeoFragmentProps = {
  displayName: string;
  boardTypes: readonly string[];
  /** Publicly visible climbs, across every board — not this page's slice. */
  climbCount: number;
};

/**
 * The setter front door's page heading: the `<h1>` and the one-paragraph
 * summary of whose climbs these are, mirroring `climb-view-seo-fragment.tsx`.
 *
 * This is the page's ONLY `<h1>`; the climbs section heading below it is an
 * `<h2>`. Before this component the whole server HTML was chrome — no heading,
 * no copy, no links — because the page rendered a client component that fetched
 * in a `useEffect`.
 */
export default async function SetterSeoFragment({ displayName, boardTypes, climbCount }: SetterSeoFragmentProps) {
  const { t } = await getServerTranslation('profile');
  const boards = boardTypes.map((boardType) => formatBoardDisplayName(boardType)).join(', ');

  return (
    <Box component="header">
      <h1>{t('setter.seoHeading', { name: displayName })}</h1>
      <p>{t('setter.seoSummary', { count: climbCount, name: displayName, boards })}</p>
    </Box>
  );
}
