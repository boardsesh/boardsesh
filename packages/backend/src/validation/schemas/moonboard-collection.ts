import { z } from 'zod';
import { MOONBOARD_LAYOUTS } from '@boardsesh/board-config';
import { PlaylistNameSchema } from './playlists';

const moonBoardLayoutIds = new Set<number>(Object.values(MOONBOARD_LAYOUTS).map((layout) => layout.id));

const moonBoardCollectionFields = {
  layoutId: z
    .number()
    .int()
    .refine((layoutId) => moonBoardLayoutIds.has(layoutId), 'Unknown MoonBoard layout'),
  angle: z.union([z.literal(25), z.literal(40)]),
  rows: z
    .array(
      z.object({
        lineNumber: z.number().int().positive(),
        name: z.string().trim().min(1).max(200),
        grade: z.string().trim().min(1).max(20),
        setter: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullish()
          .transform((setter) => setter ?? undefined),
      }),
    )
    .min(1)
    .max(1000)
    .refine((rows) => new Set(rows.map((row) => row.lineNumber)).size === rows.length, 'Duplicate source row numbers'),
};

function supportedConfiguration(input: { layoutId: number; angle: number }): boolean {
  return input.angle === 40 || [2, 3, 4, 5].includes(input.layoutId);
}

export const MoonBoardCollectionPreviewInputSchema = z
  .object(moonBoardCollectionFields)
  .refine(supportedConfiguration, 'This MoonBoard layout only supports 40 degrees');

export const MoonBoardCollectionImportInputSchema = z
  .object({
    ...moonBoardCollectionFields,
    playlistUuid: z.string().uuid(),
    playlistName: PlaylistNameSchema,
    playlistId: z
      .string()
      .regex(/^[1-9]\d*$/, 'Invalid playlist ID')
      .nullish()
      .transform((playlistId) => playlistId ?? undefined),
  })
  .refine(supportedConfiguration, 'This MoonBoard layout only supports 40 degrees');
