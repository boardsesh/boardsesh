import { z } from 'zod';
import {
  MAX_REST_CADENCE_ELAPSED_MS,
  MAX_REST_CADENCE_PAUSED_SECONDS,
  REST_CADENCE_ADVANCE_RULES,
  REST_CADENCE_MODES,
  REST_CADENCE_SOURCES,
  REST_CADENCE_TARGET_SECONDS,
  REST_CADENCE_TICK_STATUSES,
} from '../../services/rest-cadence';
import { QueueItemIdSchema } from './primitives';

const nonNegativeIntUpTo = (max: number, label: string) =>
  z.number().int(`${label} must be an integer`).min(0, `${label} cannot be negative`).max(max, `${label} is too large`);

/**
 * One rest clock config. `targetSeconds` is null for Off, otherwise inside the
 * per-mode bounds (afterTick 10..3600, onTheMinute 15..3600). `autoAdvanceOnce`
 * is optional: omitted, null and false all mean auto-advance stays on, and only
 * true reaches the reducer (RestCadenceConfig.autoAdvanceOnce).
 */
export const SessionRestCadenceConfigSchema = z
  .object({
    mode: z.enum(REST_CADENCE_MODES),
    targetSeconds: z.number().int('Rest length must be a whole number of seconds').nullish(),
    autoAdvance: z.boolean(),
    autoAdvanceOnce: z.boolean().nullish(),
    advanceOn: z.enum(REST_CADENCE_ADVANCE_RULES),
    source: z.enum(REST_CADENCE_SOURCES),
  })
  .superRefine((config, issues) => {
    if (config.targetSeconds == null) return;
    const { min, max } = REST_CADENCE_TARGET_SECONDS[config.mode];
    if (config.targetSeconds < min || config.targetSeconds > max) {
      issues.addIssue({
        code: 'custom',
        path: ['targetSeconds'],
        message: `Rest length for ${config.mode} must be between ${min} and ${max} seconds`,
      });
    }
  })
  .transform(({ autoAdvanceOnce, ...config }) => ({
    ...config,
    targetSeconds: config.targetSeconds ?? null,
    ...(autoAdvanceOnce === true ? { autoAdvanceOnce: true } : {}),
  }));

/**
 * `setSessionRestCadence` input. Each action reads only its own fields; the
 * cross-field rules here are the ones an action cannot work without: ARM and
 * CONFIGURE need a config, TICK needs a status, and FIRE must be
 * compare-and-set so two phones never both advance the wall on one beat.
 */
export const SessionRestCadenceInputSchema = z
  .object({
    action: z.enum(['ARM', 'DISARM', 'CONFIGURE', 'TICK', 'FIRE', 'PAUSE', 'RESUME', 'RESET']),
    config: SessionRestCadenceConfigSchema.nullish(),
    elapsedMs: nonNegativeIntUpTo(MAX_REST_CADENCE_ELAPSED_MS, 'Elapsed time').nullish(),
    anchor: z.enum(['KEEP', 'NOW', 'CLEAR']).nullish(),
    isRunning: z.boolean().nullish(),
    pausedElapsedSeconds: nonNegativeIntUpTo(MAX_REST_CADENCE_PAUSED_SECONDS, 'Paused elapsed time').nullish(),
    tickQueueItemUuid: QueueItemIdSchema.nullish(),
    tickStatus: z.enum(REST_CADENCE_TICK_STATUSES).nullish(),
    // Still on the wire and still bounded, but the reducer ignores it: a FIRE's beat comes from the stored clock.
    firedBeatAgoMs: nonNegativeIntUpTo(MAX_REST_CADENCE_ELAPSED_MS, 'Fired beat age').nullish(),
    // GraphQL Int is 32-bit; revisions start at 0.
    expectedRevision: nonNegativeIntUpTo(2_147_483_647, 'Expected revision').nullish(),
  })
  .superRefine((input, issues) => {
    if ((input.action === 'ARM' || input.action === 'CONFIGURE') && !input.config) {
      issues.addIssue({ code: 'custom', path: ['config'], message: `${input.action} requires a config` });
    }
    if (input.action === 'TICK' && !input.tickStatus) {
      issues.addIssue({ code: 'custom', path: ['tickStatus'], message: 'TICK requires a tickStatus' });
    }
    if (input.action === 'FIRE' && input.expectedRevision == null) {
      issues.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'FIRE requires an expectedRevision' });
    }
  });
