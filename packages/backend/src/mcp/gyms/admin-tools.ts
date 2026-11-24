import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { SlugSchema, UUIDSchema } from '../../validation/schemas/primitives';
import { UpdateBoardInputSchema } from '../../validation/schemas';
import { mergeDuplicateBoards } from '../../services/merge-duplicate-boards';
import type { GymMcpAuthorizedAction, GymMcpTool } from './registry';
import {
  assertGymMcpGlobalAdmin,
  authorizeAdminMergeReplay,
  correctBoardLocationVisibility,
  correctBoardSetup,
  inspectGymDuplicates,
  mergeAdminGyms,
  repairGymCanonicalSlug,
  authorizeCanonicalSlugReplay,
} from './admin-domain';

const reason = z
  .string()
  .trim()
  .min(10)
  .max(1000)
  .describe('Why these records are incorrect and the evidence for this repair.');
const stateHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe('The current stateHash returned by inspect_gym_duplicates. Inspect again after each correction.');
const writeIdentity = {
  idempotencyKey: UUIDSchema.describe('A fresh UUID for this action; reuse unchanged only for a retry.'),
  confirm: z
    .literal(true)
    .describe('Acknowledge this directory repair. The assistant must follow its human approval policy.'),
  reason,
};
const boardIdentity = { gymUuid: UUIDSchema, boardUuid: UUIDSchema, expectedStateHash: stateHash };
const setupChanges = UpdateBoardInputSchema.pick({
  layoutId: true,
  sizeId: true,
  setIds: true,
  angle: true,
  isAngleAdjustable: true,
})
  .strict()
  .refine(
    (changes) => Object.values(changes).some((entry) => entry !== undefined),
    'Supply at least one setup change.',
  );

function adminTool<Shape extends z.ZodRawShape>(options: {
  name: string;
  description: string;
  schema: z.ZodObject<Shape>;
  write?: boolean;
  authorizeReplay?(arguments_: z.output<z.ZodObject<Shape>>, context: ConnectionContext): Promise<void>;
  run(arguments_: z.output<z.ZodObject<Shape>>, context: ConnectionContext): Promise<Record<string, unknown>>;
}): GymMcpTool {
  const authorize = async (
    arguments_: unknown,
    context: ConnectionContext,
    replay: boolean,
  ): Promise<GymMcpAuthorizedAction> => {
    const parsed = options.schema.parse(arguments_);
    await assertGymMcpGlobalAdmin(context);
    if (replay) await options.authorizeReplay?.(parsed, context);
    return () => options.run(parsed, context);
  };
  return {
    name: options.name,
    description: options.description,
    category: 'admin',
    scope: options.write ? 'gyms:admin:write' : 'gyms:admin:read',
    readOnly: !options.write,
    destructive: options.write ?? false,
    inputSchema: options.schema,
    authorize,
    run: async (arguments_, context) => (await authorize(arguments_, context, false))(),
  };
}

function distinctUuids(uuids: string[]): boolean {
  return new Set(uuids).size === uuids.length;
}

export const gymMcpAdminTools: readonly GymMcpTool[] = [
  adminTool({
    name: 'inspect_gym_duplicates',
    description:
      'Global admin only: compare explicit gym UUIDs, their board setups, owner account IDs and display names, privacy and history counts, even when names differ. Returns state hashes for repairs. Does not expose pairing credentials or individual climber activity.',
    schema: z
      .object({ gymUuids: z.array(UUIDSchema).min(1).max(10).refine(distinctUuids, 'Choose each gym once.') })
      .strict(),
    run: ({ gymUuids }, context) => inspectGymDuplicates(gymUuids, context),
  }),
  adminTool({
    name: 'repair_gym_canonical_slug',
    description:
      'Global admin only: promote an existing merged alias URL to the active survivor’s canonical URL. Inspect the survivor and alias first. Retains ownership, every old slug and UUID, and the deleted duplicate. Requires both current state hashes, the approved alias slug, a reason and confirmation.',
    write: true,
    schema: z
      .object({
        ...writeIdentity,
        gymUuid: UUIDSchema,
        aliasGymUuid: UUIDSchema,
        slug: SlugSchema.max(120),
        expectedStateHash: stateHash,
        expectedAliasStateHash: stateHash,
      })
      .strict(),
    authorizeReplay: authorizeCanonicalSlugReplay,
    run: repairGymCanonicalSlug,
  }),
  adminTool({
    name: 'correct_gym_board_setup',
    description:
      'Global admin only: correct a stale catalogue board layout, size, hold sets, angle or adjustability after inspection. Logged climbs retain their original problem layouts. Requires a reason and current board state hash. Does not change location privacy.',
    write: true,
    schema: z
      .object({
        ...boardIdentity,
        ...writeIdentity,
        changes: setupChanges,
        allowDuplicateConfig: z
          .boolean()
          .optional()
          .describe(
            'Explicitly allow a matching setup already recorded at this gym while correcting confirmed duplicate records.',
          ),
      })
      .strict(),
    run: (arguments_, context) => correctBoardSetup(arguments_, context),
  }),
  adminTool({
    name: 'correct_gym_board_location_visibility',
    description:
      'Global admin only: explicitly hide or publicly show the location of a catalogue board, including another owner’s board. Updates the location policy and legacy flag together, records the reason, and preserves the board audience and ownership. hideLocation=false makes its location public to viewers who can access the board.',
    write: true,
    schema: z.object({ ...boardIdentity, ...writeIdentity, hideLocation: z.boolean() }).strict(),
    run: (arguments_, context) => correctBoardLocationVisibility(arguments_, context),
  }),
  adminTool({
    name: 'merge_duplicate_gyms',
    description:
      'Global admin only: merge confirmed duplicate physical gym listings into an explicitly chosen survivor. Moves linked boards and gym social records, preserves ownership of the survivor and old-link tombstones, and records the merge audit. This does not merge board records. Inspect first; supply every selected gym’s current state hash.',
    write: true,
    schema: z
      .object({
        ...writeIdentity,
        canonicalGymUuid: UUIDSchema,
        duplicateGymUuids: z.array(UUIDSchema).min(1).max(9).refine(distinctUuids, 'Choose each duplicate once.'),
        expectedStates: z
          .array(z.object({ gymUuid: UUIDSchema, stateHash }).strict())
          .min(2)
          .max(10),
        allowSystemCanonicalOverride: z
          .boolean()
          .default(false)
          .describe('Explicitly keep SYSTEM ownership over a user-owned or claimed gym; normally leave false.'),
      })
      .strict()
      .superRefine((arguments_, refinement) => {
        const selected = [arguments_.canonicalGymUuid, ...arguments_.duplicateGymUuids];
        if (
          !distinctUuids(selected) ||
          arguments_.expectedStates.length !== selected.length ||
          !distinctUuids(arguments_.expectedStates.map((expected) => expected.gymUuid)) ||
          arguments_.expectedStates.some((expected) => !selected.includes(expected.gymUuid))
        )
          refinement.addIssue({
            code: 'custom',
            message: 'Supply distinct canonical/duplicate gyms and exactly one state hash per gym.',
          });
      }),
    authorizeReplay: (arguments_, context) =>
      authorizeAdminMergeReplay('gym', arguments_.canonicalGymUuid, arguments_.duplicateGymUuids, context),
    run: (arguments_, context) => mergeAdminGyms(arguments_, context),
  }),
  adminTool({
    name: 'merge_duplicate_gym_boards',
    description:
      'Global admin only: merge explicit UUIDs for confirmed duplicate records of one physical catalogue wall. Serial numbers are optional. The survivor keeps its owner; other real creators lose editing ownership, become followers and receive a notice. Inspect owner IDs/display names and set allowOwnershipChange=true explicitly for cross-owner merges. Merge gym listings and correct mismatched setups first; every board must share the gym and normalized configuration. Preserves ticks, history sequences, follows, pins, old links and reporting provenance. Restricted policies or unresolved dependent settings may block the merge. Location restrictions remain unless explicitly corrected beforehand.',
    write: true,
    schema: z
      .object({
        ...writeIdentity,
        gymUuid: UUIDSchema,
        canonicalBoardUuid: UUIDSchema,
        duplicateBoardUuids: z.array(UUIDSchema).min(1).max(10).refine(distinctUuids, 'Choose each duplicate once.'),
        expectedStates: z
          .array(z.object({ boardUuid: UUIDSchema, stateHash }).strict())
          .min(2)
          .max(11),
        allowOwnershipChange: z
          .boolean()
          .default(false)
          .describe(
            'Explicitly acknowledge that the survivor keeps its owner while different real creators lose editing ownership, become followers and receive a notice. Inspect owner IDs and display names before setting true.',
          ),
        samePhysicalWall: z
          .literal(true)
          .describe(
            'Confirm independent evidence that these records describe the same physical wall. Matching configurations or coordinates alone are insufficient.',
          ),
      })
      .strict()
      .superRefine((arguments_, refinement) => {
        const selected = [arguments_.canonicalBoardUuid, ...arguments_.duplicateBoardUuids];
        if (
          !distinctUuids(selected) ||
          arguments_.expectedStates.length !== selected.length ||
          !distinctUuids(arguments_.expectedStates.map((expected) => expected.boardUuid)) ||
          arguments_.expectedStates.some((expected) => !selected.includes(expected.boardUuid))
        )
          refinement.addIssue({
            code: 'custom',
            message: 'Supply distinct canonical/duplicate boards and exactly one state hash per board.',
          });
      }),
    authorizeReplay: (arguments_, context) =>
      authorizeAdminMergeReplay('board', arguments_.canonicalBoardUuid, arguments_.duplicateBoardUuids, context),
    run: (
      { gymUuid, canonicalBoardUuid, duplicateBoardUuids, allowOwnershipChange, reason, expectedStates },
      context,
    ) =>
      mergeDuplicateBoards(
        { gymUuid, canonicalBoardUuid, duplicateBoardUuids, allowOwnershipChange, reason, expectedStates },
        context,
      ),
  }),
];
