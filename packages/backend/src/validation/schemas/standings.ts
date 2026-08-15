import { z } from 'zod';

/**
 * Standings input.
 *
 * Deliberately no `all` window: 69.4% of the tick history is a frozen bulk
 * logbook import, so an all-time ranking ranks whoever uploaded a file. A
 * rolling window also cannot reach that corpus, whose newest row is 2026-03-26.
 */
export const StandingsScopeInputSchema = z
  .object({
    kind: z.enum(['global', 'boardType', 'layout', 'board', 'gym']),
    key: z.string().max(200).optional(),
  })
  .refine((scope) => (scope.kind === 'global' ? !scope.key : Boolean(scope.key)), {
    message: 'Every scope kind except global requires a key',
    path: ['key'],
  });

export const StandingsInputSchema = z.object({
  scope: StandingsScopeInputSchema,
  window: z.enum(['week', 'month']).optional().default('month'),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).max(10_000).optional().default(0),
});

export type StandingsInput = z.infer<typeof StandingsInputSchema>;
