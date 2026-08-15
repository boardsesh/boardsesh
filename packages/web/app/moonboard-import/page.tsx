import React from 'react';
import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import LocaleLink from '@/app/components/i18n/locale-link';
import MoonBoardBulkImport from '@/app/components/moonboard-import/moonboard-bulk-import';
import {
  type MoonBoardLayoutKey,
  MOONBOARD_ANGLES,
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  getHoldSetImages,
} from '@/app/lib/moonboard-config';
import { getMoonBoardLayoutBySlug } from '@/app/lib/url-utils';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';

/**
 * The MoonBoard bulk importer, re-homed off the board routes.
 *
 * It used to hang off `…/[angle]/import` on both board trees, which W-17
 * deleted along with the rest of the board-route siblings. The importer itself
 * stays on Next (the reposition epic keeps it here deliberately), so it needs a
 * board-agnostic home: this route takes the board from the query string, and
 * the two old paths 308 into it carrying whatever they knew.
 *
 * Utility surface — noindex, follow. It needs none of the board-tree providers:
 * `MoonBoardBulkImport` reads next-auth, react-query, the snackbar and i18n,
 * all of which the root layout already mounts.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('climbs');
  return createNoIndexMetadata({
    title: t('metadata.import.title'),
    description: t('metadata.import.description'),
    locale,
  });
}

type ResolvedLayout = {
  layoutKey: MoonBoardLayoutKey;
  id: number;
  name: string;
  folder: string;
};

/**
 * `layout` accepts what the old board URLs carried in that segment: a numeric
 * layout id (`2`) or a layout slug (`moonboard-2016`, `moonboard2016`).
 * Anything else resolves to null and the picker takes over.
 */
function resolveLayout(rawLayout: string | undefined): ResolvedLayout | null {
  if (!rawLayout) return null;

  const bySlug = getMoonBoardLayoutBySlug(rawLayout);
  const layoutId = bySlug ? bySlug.id : Number(rawLayout);
  if (!Number.isInteger(layoutId)) return null;

  const entry = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === layoutId);
  if (!entry) return null;

  const [layoutKey, layout] = entry;
  return { layoutKey: layoutKey as MoonBoardLayoutKey, id: layout.id, name: layout.name, folder: layout.folder };
}

const DEFAULT_ANGLE = 40;

function resolveAngle(rawAngle: string | undefined): number {
  const angle = Number(rawAngle);
  return MOONBOARD_ANGLES.includes(angle as (typeof MOONBOARD_ANGLES)[number]) ? angle : DEFAULT_ANGLE;
}

/**
 * The overlay images for the hold sets actually bolted to the climber's wall.
 *
 * The old board URL named them in its `set_ids` segment and the deleted page
 * drew only those; the canonical redirect carries that segment through as
 * `sets` so this route can keep doing the same. Without it a MoonBoard 2024
 * wall running Hold Set D + Wooden Holds would get all six of the layout's sets
 * stacked on the import preview and the edit modal — holds that are not on the
 * wall.
 *
 * Falls back to every set for the layout when `sets` is absent or names nothing
 * this layout has: the `/b/:board_slug` tree has no set segment, and a
 * slug-form URL carries names rather than ids. That is the same art the picker's
 * own entry point produces, so the fallback is the status quo, not a surprise.
 */
function resolveHoldSetImages(layoutKey: MoonBoardLayoutKey, rawSets: string | undefined): string[] {
  const everySetForLayout = (MOONBOARD_SETS[layoutKey] ?? []).map((holdSet) => holdSet.imageFile);
  if (!rawSets) return everySetForLayout;

  const setIds = rawSets
    .split(',')
    .map((rawSetId) => Number(rawSetId.trim()))
    .filter((setId) => Number.isInteger(setId));
  if (setIds.length === 0) return everySetForLayout;

  const selected = getHoldSetImages(layoutKey, setIds);
  return selected.length > 0 ? selected : everySetForLayout;
}

type MoonBoardImportPageProps = {
  searchParams: Promise<{ layout?: string; sets?: string; angle?: string }>;
};

export default async function MoonBoardImportPage(props: MoonBoardImportPageProps) {
  const searchParams = await props.searchParams;
  const layout = resolveLayout(searchParams.layout);
  const angle = resolveAngle(searchParams.angle);

  if (!layout) {
    const { t } = await getServerTranslation('climbs');
    return (
      <Box sx={{ maxWidth: 640, mx: 'auto', px: 2, py: 4 }}>
        <Typography variant="h1" sx={{ fontSize: '1.5rem', fontWeight: 600, mb: 1 }}>
          {t('moonboardImport.picker.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {t('moonboardImport.picker.hint')}
        </Typography>
        <Stack spacing={2}>
          {Object.entries(MOONBOARD_LAYOUTS).map(([layoutKey, moonBoardLayout]) => (
            <Stack
              key={layoutKey}
              direction="row"
              spacing={1}
              alignItems="center"
              justifyContent="space-between"
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: `${themeTokens.borderRadius.lg}px`,
                px: 2,
                py: 1.5,
              }}
            >
              <Typography variant="body1">{moonBoardLayout.name}</Typography>
              <Stack direction="row" spacing={1}>
                {MOONBOARD_ANGLES.map((moonBoardAngle) => (
                  <Button
                    key={moonBoardAngle}
                    component={LocaleLink}
                    href={`/moonboard-import?layout=${layoutKey}&angle=${moonBoardAngle}`}
                    size="small"
                    variant="outlined"
                  >
                    {t('moonboardImport.picker.angleOption', { angle: moonBoardAngle })}
                  </Button>
                ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Box>
    );
  }

  const holdSetImages = resolveHoldSetImages(layout.layoutKey, searchParams.sets);

  return (
    <MoonBoardBulkImport
      layoutFolder={layout.folder}
      layoutName={layout.name}
      layoutId={layout.id}
      holdSetImages={holdSetImages}
      angle={angle}
    />
  );
}
