import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';

type ClimbViewSeoFragmentProps = {
  climb: Climb;
  boardDetails: BoardDetails;
};

const headingSx = { fontWeight: themeTokens.typography.fontWeight.bold, mb: 1 };

const summarySx = { m: 0, mb: 2, maxWidth: '68ch' };

/**
 * The climb front door's page heading: the `<h1>` and the one-paragraph summary
 * of what this climb is.
 *
 * It used to be `sx={visuallyHidden}` — a crawler-only payload sitting behind
 * the PlayViewDrawer, which hydrated and covered the viewport. W-15 removed the
 * drawer from this route, so there is nothing left to double up with and no
 * reason to hide the only heading the page has. Element identity (`<h1>` + `<p>`)
 * is deliberately unchanged; `view-seo-fragment.test.tsx` pins it. `Typography`
 * only supplies the site's type ramp — `component` keeps the tags themselves,
 * which is why both assertions there match `<h1[\s>]` rather than a bare `<h1>`.
 *
 * This is the page's ONLY `<h1>`. Every other front-door section heading is an
 * `<h2>`.
 */
export default async function ClimbViewSeoFragment({ climb, boardDetails }: ClimbViewSeoFragmentProps) {
  const { t } = await getServerTranslation('climbs');
  const grade = climb.difficulty ?? '';
  const setter = climb.setter_username ?? '';
  const layoutName = boardDetails.layout_name ?? '';
  const ascents = climb.ascensionist_count ?? 0;

  // Draft climbs can have a null difficulty — fall back to the bare name so we
  // don't render "{climbName} — " with a dangling em dash.
  const heading = grade ? t('metadata.view.seoHeading', { climbName: climb.name, grade }) : climb.name;
  const summary = t('metadata.view.seoSummary', { boardName: boardDetails.board_name, layoutName });
  const setterSuffix = setter ? t('metadata.view.seoSetterSuffix', { setter }) : '';
  const ascentsSuffix = ascents > 0 ? t('metadata.view.seoAscentsSuffix', { ascents }) : '';

  return (
    <Box component="header">
      <Typography variant="h3" component="h1" sx={headingSx}>
        {heading}
      </Typography>
      <Typography variant="body1" component="p" color="text.secondary" sx={summarySx}>
        {summary}
        {setterSuffix}
        {ascentsSuffix}.
      </Typography>
    </Box>
  );
}
