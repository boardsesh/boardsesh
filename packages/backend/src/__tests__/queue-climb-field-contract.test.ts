import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'fs';
import { parse, visit } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import { QUEUE_UPDATES } from '@boardsesh/graphql/operations/queue-session';
import { ClimbInputSchema, ClimbQueueItemSchema } from '../validation/schemas/climbs';

/**
 * Drift guard for the queue climb boundary (#3927).
 *
 * A queue climb crosses several independently-maintained field lists on its way
 * from one client to another. When any one of them drifts, the field does not
 * merely go missing — it FLAPS. A peer whose read path omits a field rebuilds
 * the item without it, and that peer's next full-queue write pushes the gap back
 * to everyone, so the originator loses the field too on the following FullSync.
 * A flapping field is worse than a consistently absent one: it makes an Edit
 * button and a draft badge blink in and out depending on who touched the queue
 * last.
 *
 * Every list below is read from a LIVE source (the schema, the Zod shape, the
 * operation strings) rather than hand-transcribed here, so adding a sixth field
 * to one side only turns this red without anyone editing this file. That is the
 * whole point — a regression test pinned to today's field names would not have
 * stopped the drift that produced #3927 in the first place.
 */

/** Field names declared on a GraphQL input type, read from the schema. */
function inputTypeFieldNames(typeName: string): Set<string> {
  const fields = new Set<string>();
  visit(parse(typeDefs.join('\n\n')), {
    InputObjectTypeDefinition(node) {
      if (node.name.value !== typeName) return;
      for (const field of node.fields ?? []) fields.add(field.name.value);
    },
  });
  return fields;
}

/** Field names selected inside every `climb { ... }` selection set of an operation. */
function climbSelectionFieldNames(operationSource: string): Set<string> {
  const fields = new Set<string>();
  visit(parse(operationSource), {
    Field(node) {
      if (node.name.value !== 'climb' || !node.selectionSet) return;
      for (const selection of node.selectionSet.selections) {
        if (selection.kind === 'Field') fields.add(selection.name.value);
      }
    },
  });
  return fields;
}

/**
 * The GraphQL fields a queue ITEM hangs off in these operations: the FullSync
 * queue list, the FullSync current pointer, and the per-variant `item` (aliased
 * `addedItem` / `currentItem` to dodge the union nullability conflict).
 */
const QUEUE_ITEM_PARENT_FIELDS = new Set(['queue', 'currentClimbQueueItem', 'item']);

/** Top-level field names selected on each queue ITEM of an operation. */
function queueItemSelectionFieldNames(operationSource: string): Set<string> {
  const fields = new Set<string>();
  visit(parse(operationSource), {
    Field(node) {
      if (!QUEUE_ITEM_PARENT_FIELDS.has(node.name.value) || !node.selectionSet) return;
      for (const selection of node.selectionSet.selections) {
        if (selection.kind === 'Field') fields.add(selection.alias?.value ?? selection.name.value);
      }
    },
  });
  return fields;
}

/**
 * Mobile hand-maintains its selection sets as plain template strings, so read
 * them out of the source text rather than importing the mobile package (which
 * would drag React Native deps into this backend test). Same technique as
 * `operations-schema-validation.test.ts`.
 */
function mobileSelectionTemplate(constName: string): string {
  const source = readFileSync(
    new URL('../../../../packages/mobile/src/lib/graphql/operations.ts', import.meta.url),
    'utf-8',
  );
  const match = source.match(new RegExp(`${constName}\\s*=\\s*\`([\\s\\S]*?)\``));
  if (!match?.[1]) {
    throw new Error(`Could not extract ${constName} from mobile operations.ts`);
  }
  return match[1];
}

function mobileSubscriptionClimbFields(): Set<string> {
  return climbSelectionFieldNames(`{ climb { ${mobileSelectionTemplate('SUBSCRIPTION_CLIMB_FIELDS')} } }`);
}

function mobileSubscriptionQueueItemFields(): Set<string> {
  // The template interpolates the climb selection; stub the interpolation so the
  // string parses. What the climb sub-selection contains is the climb-level
  // guard's job, not this one's.
  const template = mobileSelectionTemplate('SUBSCRIPTION_QUEUE_ITEM_FIELDS').replace(
    '${SUBSCRIPTION_CLIMB_FIELDS}',
    'uuid',
  );
  return queueItemSelectionFieldNames(`{ item { ${template} } }`);
}

const climbInputFields = inputTypeFieldNames('ClimbInput');

/**
 * The ONLY fields a client may write but never broadcast.
 *
 * `userAscents` / `userAttempts` are the signed-in user's own tick counts for
 * that climb. Putting them on a shared queue payload would show every peer YOUR
 * send count on THEIR queue row, so they are deliberately absent from both read
 * paths. The price is that they behave exactly like the bug this file guards
 * against: a peer's full-queue write clears them, and you get them back only on
 * the next search/detail fetch. That trade is intentional — do NOT "fix" the
 * asymmetry by adding them to the selection sets. Broadcasting per-user data to
 * every participant is a privacy regression, not a parity fix.
 */
const NEVER_BROADCAST = new Set(['userAscents', 'userAttempts']);

const expectedReadPathFields = new Set([...climbInputFields].filter((field) => !NEVER_BROADCAST.has(field)));

describe('queue climb field parity: GraphQL ClimbInput <-> backend Zod schema', () => {
  it('found the ClimbInput type in the schema', () => {
    expect(climbInputFields.size).toBeGreaterThan(0);
  });

  // `z.object()` STRIPS undeclared keys, and `setQueue` / `joinSession` persist
  // the PARSED item (the single-item mutations discard the parse result and keep
  // the GraphQL-coerced input, which is why this gap stayed invisible for so
  // long — it only bit on a full-queue sync). So any ClimbInput field missing
  // from the Zod shape is a field the server silently erases mid-session.
  it('the Zod ClimbInputSchema declares exactly the ClimbInput field set', () => {
    const zodFields = new Set(Object.keys(ClimbInputSchema.shape));
    const strippedByZod = [...climbInputFields].filter((field) => !zodFields.has(field));
    const unknownToSchema = [...zodFields].filter((field) => !climbInputFields.has(field));

    expect(
      strippedByZod,
      'ClimbInputSchema is missing these ClimbInput fields, so setQueue/joinSession will STRIP them ' +
        'and every peer loses them on the next FullSync. Add them to packages/backend/src/validation/schemas/climbs.ts.',
    ).toEqual([]);
    expect(
      unknownToSchema,
      'ClimbInputSchema declares fields the GraphQL ClimbInput does not, so they can never arrive. ' +
        'Either add them to packages/shared-schema/src/schema/climb.ts or drop them from the Zod schema.',
    ).toEqual([]);
  });

  // The behavioural counterpart: prove a fully-populated climb survives the
  // exact call `setQueue` makes, rather than only asserting on key lists.
  it('a fully-populated queue item survives the setQueue parse without losing a field', () => {
    const climb = {
      uuid: 'aurora-climb-uuid-fixture',
      boardType: 'kilter',
      layoutId: 1,
      setter_username: 'setter',
      userId: 'user-1',
      name: 'Proj Braj',
      description: 'crimpy',
      frames: 'p1086r15',
      controllerRouteUuid: null,
      angle: 40,
      ascensionist_count: 3,
      difficulty: 'V5',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.1',
      mirrored: true,
      benchmark_difficulty: null,
      is_no_match: true,
      characteristics: ['method_footless'],
      is_draft: false,
      published_at: '2026-07-01T00:00:00Z',
      userAscents: 2,
      userAttempts: 5,
      framesCount: 1,
      framesPace: 0,
      boardseshDifficulty: 19.2,
      boardseshConfidence: 'confirmed',
      compatibleSizeIds: [10, 17],
    };

    const parsed = ClimbQueueItemSchema.parse({ uuid: 'queue-slot-1', climb });

    expect(new Set(Object.keys(parsed.climb))).toEqual(climbInputFields);
    expect(parsed.climb).toMatchObject(climb);
  });

  // An unrecognised characteristic must NOT fail the item. `parseArrayTolerant`
  // drops the whole queue slot on a schema failure, so enum-validating this
  // field would let a newer client's unknown value silently delete a climb from
  // everyone's queue — the failure mode #3857 fixed for `uuid`.
  it('accepts an unknown characteristic rather than dropping the queue slot', () => {
    const result = ClimbQueueItemSchema.safeParse({
      uuid: 'queue-slot-1',
      climb: {
        uuid: 'aurora-climb-uuid-fixture',
        angle: 40,
        characteristics: ['some_characteristic_a_newer_client_invented'],
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('queue climb field parity: the two READ paths', () => {
  const sharedFields = climbSelectionFieldNames(QUEUE_UPDATES);
  const mobileFields = mobileSubscriptionClimbFields();

  it('found a non-empty field set on both read paths', () => {
    expect(sharedFields.size).toBeGreaterThan(0);
    expect(mobileFields.size).toBeGreaterThan(0);
  });

  // Anchored to the schema rather than to each other. Comparing the two
  // selection sets alone would stay green if BOTH drifted away from what
  // clients write — which is exactly how #3927 survived: `climbToQueueItem` and
  // both selection sets agreed with each other, and all three disagreed with
  // `toClimbInput`.
  for (const [name, fields] of [
    ['shared CLIMB_FIELDS (packages/shared/graphql/src/operations/queue-session.ts)', sharedFields],
    ['mobile SUBSCRIPTION_CLIMB_FIELDS (packages/mobile/src/lib/graphql/operations.ts)', mobileFields],
  ] as const) {
    it(`${name} selects exactly what ClimbInput declares, minus the never-broadcast fields`, () => {
      const notRead = [...expectedReadPathFields].filter((field) => !fields.has(field));
      const readButNeverWritten = [...fields].filter((field) => !expectedReadPathFields.has(field));

      expect(
        notRead,
        `This selection set is missing fields that clients WRITE, so they will FLAP: this peer ` +
          `rebuilds the item without them and its next full-queue write pushes the gap back to ` +
          `everyone. Add them here, or (if per-user) to NEVER_BROADCAST with a reason.`,
      ).toEqual([]);
      expect(
        readButNeverWritten,
        'This selection set reads fields that no client writes, so they can only ever be null. ' +
          'Either add them to ClimbInput or drop them from the selection set.',
      ).toEqual([]);
    });
  }
});

/**
 * The same guard one level up (#3995).
 *
 * A queue item carries more than its climb: `addedBy` / `addedByUser` are who
 * put it on the wall, `tickedBy` is who has sent it this session, `suggested`
 * marks a playlist suggestion. Mobile shipped a `{ uuid, climb }` write mapper
 * AND a `{ uuid, climb }` selection set, so climbs queued from a phone reached
 * peers anonymous and a phone's next full-queue write wiped the crew's avatars
 * off web-queued climbs. Both platforms now write all four, which makes the READ
 * side flap-critical — hence this parity check, the read-side counterpart to the
 * `satisfies Record<keyof ClimbQueueItemInput, true>` guard on the write mapper.
 *
 * `NATIVE_IOS_QUEUE_UPDATES` (same shared operations file) is a third, deliberately
 * slim contract and is NOT guarded here. It feeds the Swift Live Activity / widget,
 * which only needs to know which climb is current, so it selects a subset on purpose
 * to keep the native payload small. It cannot cause the flap above: the widget's
 * `sendSetCurrentClimb` omits `shouldAddToQueue`, so the backend never appends a queue
 * row for it and the shared reducer never rewrites an existing entry — only the
 * current-climb pointer loses attribution, not the rows the avatars render from.
 */
describe('queue item field parity: the shared and mobile READ paths', () => {
  const queueItemInputFields = inputTypeFieldNames('ClimbQueueItemInput');

  it('found the ClimbQueueItemInput type in the schema', () => {
    expect(queueItemInputFields.size).toBeGreaterThan(0);
  });

  it('mobile interpolates the shared item selection at every item-selection site', () => {
    const mobileOperationsSource = readFileSync(
      new URL('../../../../packages/mobile/src/lib/graphql/operations.ts', import.meta.url),
      'utf-8',
    );
    const itemSelectionSites = mobileOperationsSource.match(/\b(?:queue|currentClimbQueueItem|item)\s*\{/g) ?? [];
    const sharedSelectionInterpolations = mobileOperationsSource.match(/\$\{SUBSCRIPTION_QUEUE_ITEM_FIELDS\}/g) ?? [];

    expect(itemSelectionSites.length).toBeGreaterThan(0);
    expect(
      sharedSelectionInterpolations.length,
      'A queue-item selection set in mobile operations.ts is written out longhand instead of ' +
        'interpolating SUBSCRIPTION_QUEUE_ITEM_FIELDS. The parity check below unions field names ' +
        'across every item selection in a document, so one complete site would mask the incomplete ' +
        'sibling — and the missing fields would FLAP.',
    ).toBe(itemSelectionSites.length);
  });

  for (const [name, fields] of [
    [
      'shared QUEUE_ITEM_FIELDS (packages/shared/graphql/src/operations/queue-session.ts)',
      queueItemSelectionFieldNames(QUEUE_UPDATES),
    ],
    [
      'mobile SUBSCRIPTION_QUEUE_ITEM_FIELDS (packages/mobile/src/lib/graphql/operations.ts)',
      mobileSubscriptionQueueItemFields(),
    ],
  ] as const) {
    it(`${name} selects exactly what ClimbQueueItemInput declares`, () => {
      const notRead = [...queueItemInputFields].filter((field) => !fields.has(field));
      const readButNeverWritten = [...fields].filter((field) => !queueItemInputFields.has(field));

      expect(
        notRead,
        'This selection set is missing item-level fields that clients WRITE, so they will FLAP: ' +
          'this peer rebuilds the item without them and its next full-queue write pushes the gap ' +
          'back to everyone — the crew\'s "added by" avatars blink out. Add them here.',
      ).toEqual([]);
      expect(
        readButNeverWritten,
        'This selection set reads item-level fields no client writes, so they can only ever be null. ' +
          'Either add them to ClimbQueueItemInput or drop them from the selection set.',
      ).toEqual([]);
    });
  }
});
