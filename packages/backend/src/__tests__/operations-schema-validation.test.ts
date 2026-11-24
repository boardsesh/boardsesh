import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'fs';
import { buildSchema, parse, visit, type DocumentNode, type GraphQLSchema } from 'graphql';
import { validateOperation as validate } from '../graphql/query-validation';
import { typeDefs } from '@boardsesh/shared-schema';
import * as publicOperations from '@boardsesh/graphql/operations';
import * as accountOperations from '@boardsesh/graphql/operations/account';
import * as analyticsConsentOperations from '@boardsesh/graphql/operations/analytics-consent';
import * as proposalOperations from '@boardsesh/graphql/operations/proposals';
import * as queueSessionOperations from '@boardsesh/graphql/operations/queue-session';
import * as appWorkoutOperations from '@boardsesh/graphql/operations/app-workouts';
import * as connectedAppOperations from '@boardsesh/graphql/operations/connected-apps';
import * as partnerSessionHistoryOperations from '@boardsesh/graphql/operations/partner-session-history';
import * as privacyOperations from '@boardsesh/graphql/operations/privacy';
import * as sprayDetectionOperations from '@boardsesh/graphql/operations/spray-detection';
import * as userDataExportOperations from '@boardsesh/graphql/operations/user-data-export';
import * as generatedOperations from '@boardsesh/graphql/generated/graphql';

// Build a fresh schema from the raw typeDefs inside this test's `graphql`
// instance. Importing the backend's `schema` object crosses the boundary
// between two installed `graphql` modules (the backend builds with one,
// `validate()` uses another), which graphql-js rejects with "Cannot use
// GraphQLSchema ...". Building locally keeps everything in one module.
let schema: GraphQLSchema;
try {
  schema = buildSchema(typeDefs.join('\n\n'));
} catch (error) {
  throw new Error(`Failed to build schema from shared-schema typeDefs: ${(error as Error).message}`);
}

function normalizeGraphQLOperation(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

function readNativeIosQueueUpdatesOperation(): string {
  const sessionWebSocketManagerSource = readFileSync(
    new URL('../../../../packages/mobile/modules/live-activity/ios/SessionWebSocketManager.swift', import.meta.url),
    'utf-8',
  );
  const queryMatch = sessionWebSocketManagerSource.match(
    /private func sendSubscription\(\) \{[\s\S]*?let query = """\n([\s\S]*?)\n\s*"""/,
  );

  if (!queryMatch?.[1]) {
    throw new Error('Could not extract native iOS queue subscription query from SessionWebSocketManager.swift');
  }

  return queryMatch[1];
}

// Pull the body of a backtick-template `const NAME = \`...\`` out of a source
// file. Used to read mobile's SUBSCRIPTION_CLIMB_FIELDS without importing the
// mobile package (which pulls RN-only deps into this backend test).
function extractTemplateConst(source: string, constName: string): string {
  const match = source.match(new RegExp(`${constName}\\s*=\\s*\`([\\s\\S]*?)\``));
  if (!match?.[1]) {
    throw new Error(`Could not extract ${constName} template literal from mobile operations.ts`);
  }
  return match[1];
}

function readMobileOperationsSource(): string {
  return readFileSync(new URL('../../../../packages/mobile/src/lib/graphql/operations.ts', import.meta.url), 'utf-8');
}

function readMobileSubscriptionClimbFields(): string {
  return extractTemplateConst(readMobileOperationsSource(), 'SUBSCRIPTION_CLIMB_FIELDS');
}

/**
 * Mobile's operation strings interpolate `${SUBSCRIPTION_QUEUE_ITEM_FIELDS}` (which
 * itself interpolates `${SUBSCRIPTION_CLIMB_FIELDS}`) at build time via JS template
 * literals. The regex extraction above reads raw source text, so it captures those
 * placeholders literally — substitute them, outer one first, to reproduce what the
 * real template literal evaluates to before parsing as GraphQL. One helper so a new
 * nested selection const cannot be taught to one call site and forgotten at another.
 */
function resolveMobileTemplatePlaceholders(rawSource: string, mobileOperationsSource: string): string {
  const queueItemFields = extractTemplateConst(mobileOperationsSource, 'SUBSCRIPTION_QUEUE_ITEM_FIELDS');
  const climbFields = extractTemplateConst(mobileOperationsSource, 'SUBSCRIPTION_CLIMB_FIELDS');
  return rawSource
    .replaceAll('${SUBSCRIPTION_QUEUE_ITEM_FIELDS}', queueItemFields)
    .replaceAll('${SUBSCRIPTION_CLIMB_FIELDS}', climbFields);
}

// Collect the field names selected inside every `climb { ... }` selection set of
// a GraphQL operation document. Both the shared queue-session subscription and a
// wrapped copy of the mobile fragment feed through this, so parity is compared
// field-set to field-set with graphql's own parser (no string diffing).
function climbFieldNames(operationSource: string): Set<string> {
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
 * Guard against the OverlappingFieldsCanBeMergedRule (and any other) GraphQL
 * validation regression that broke production twice:
 *   1. PR #2128 added `uuid: ID` to `ClimbMirrored` while sibling union arms
 *      declared `uuid: ID!`. Every party-session join failed validation, the
 *      client tight-looped reconnects, and the PR had to be reverted.
 *   2. The reland reintroduced the same hazard at first and would have hit
 *      prod again without manual catching.
 *
 * The graphql-js validator catches both classes of bug deterministically when
 * run against the schema. Run every exported `*_OPERATION` string in
 * `operations.ts` through `parse()` + `validate(schema, doc)` and assert no
 * errors. One ~10ms unit test is cheap insurance.
 */
describe('shared-schema operations validate against the executable schema', () => {
  // Pull every exported value that looks like a GraphQL operation string.
  // operations.ts uses plain template-literal strings (not gql tags), so we
  // duck-type by checking it starts with `mutation`/`query`/`subscription`
  // after optional whitespace.
  const operationEntries: Array<[string, string]> = [];
  const operationModules = [
    ['operations', publicOperations],
    ['operations/account', accountOperations],
    ['operations/analytics-consent', analyticsConsentOperations],
    ['operations/proposals', proposalOperations],
    ['operations/queue-session', queueSessionOperations],
    ['operations/app-workouts', appWorkoutOperations],
    ['operations/connected-apps', connectedAppOperations],
    ['operations/partner-session-history', partnerSessionHistoryOperations],
    ['operations/privacy', privacyOperations],
    ['operations/spray-detection', sprayDetectionOperations],
    ['operations/user-data-export', userDataExportOperations],
  ] as const;

  for (const [moduleName, moduleOperations] of operationModules) {
    for (const [name, value] of Object.entries(moduleOperations)) {
      if (typeof value !== 'string') continue;
      if (!/^\s*(query|mutation|subscription)\b/i.test(value)) continue;
      operationEntries.push([`${moduleName}.${name}`, value]);
    }
  }

  it('found at least one exported operation to validate', () => {
    expect(operationEntries.length).toBeGreaterThan(0);
  });

  for (const [name, source] of operationEntries) {
    it(`${name} parses and validates against the schema`, () => {
      let document: DocumentNode;
      try {
        document = parse(source);
      } catch (error) {
        throw new Error(`Operation ${name} failed to parse: ${(error as Error).message}`);
      }

      const errors = validate(schema, document);
      if (errors.length > 0) {
        const detail = errors.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n');
        throw new Error(`Operation ${name} has GraphQL validation errors:\n${detail}`);
      }
    });
  }
});

describe('generated web documents satisfy the shared transport limits', () => {
  for (const [name, document] of Object.entries(generatedOperations)) {
    if (!document.definitions.some((definition) => definition.kind === 'OperationDefinition')) continue;
    it(`${name} validates with depth and cost limits`, () => {
      expect(validate(schema, document).map((error) => error.message)).toEqual([]);
    });
  }
});

describe('all mobile operation strings satisfy the shared transport limits', () => {
  const source = readMobileOperationsSource();
  const templates = new Map(
    [...source.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:gql)?`([\s\S]*?)`/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  templates.set('BOARD_FIELDS', publicOperations.BOARD_FIELDS);

  function resolveTemplate(template: string, resolving: Set<string> = new Set()): string {
    return template.replace(/\$\{(\w+)\}/g, (_placeholder, name: string) => {
      const replacement = templates.get(name);
      if (!replacement || resolving.has(name)) throw new Error(`Unresolved mobile operation template: ${name}`);
      return resolveTemplate(replacement, new Set([...resolving, name]));
    });
  }

  const operations = [...templates].filter(([, template]) => /^\s*(query|mutation|subscription)\b/.test(template));
  it('finds the complete mobile operations file', () => {
    expect(operations.length).toBeGreaterThan(50);
  });
  for (const [name, template] of operations) {
    it(`${name} validates with depth and cost limits`, () => {
      expect(validate(schema, parse(resolveTemplate(template))).map((error) => error.message)).toEqual([]);
    });
  }
});

describe('raw web and mobile fetch documents satisfy the shared transport limits', () => {
  function readOperationStrings(directory: URL): Array<[string, string]> {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
      if (entry.name === '__tests__' || entry.name.includes('.test.')) return [];
      const sourceUrl = new URL(entry.name, directory);
      if (entry.isDirectory()) return readOperationStrings(new URL(`${entry.name}/`, directory));
      if (!/\.tsx?$/.test(entry.name)) return [];
      const source = readFileSync(sourceUrl, 'utf-8');
      return [...source.matchAll(/(['`])\s*((?:query|mutation|subscription)\s+[A-Z][\s\S]*?)\1/g)].map((match) => {
        const operation = match[2].replace(/\$\{(\w+)\}/g, (_placeholder, name: string) =>
          extractTemplateConst(source, name),
        );
        return [sourceUrl.pathname, operation];
      });
    });
  }
  // Codegen does not collect plain fetch documents. Include the SSR readers and
  // native device registration as well as the generated web documents above.
  const documents = [
    ...readOperationStrings(new URL('../../../../packages/web/app/', import.meta.url)),
    ...readOperationStrings(new URL('../../../../packages/mobile/src/notifications/', import.meta.url)),
  ];
  it('finds the raw fetch operation corpus', () => {
    expect(documents.length).toBeGreaterThanOrEqual(19);
  });
  for (const [sourcePath, source] of documents) {
    const document = parse(source);
    const name = document.definitions.find((definition) => definition.kind === 'OperationDefinition')?.name?.value;
    it(`${name} in ${sourcePath} validates with depth and cost limits`, () => {
      expect(validate(schema, document).map((error) => error.message)).toEqual([]);
    });
  }
});

describe('controller operation strings satisfy the shared transport limits', () => {
  const sourcePaths = [
    '../../../../embedded/projects/board-controller/src/main.cpp',
    '../../../../embedded/projects/board-controller/src/gym/client.h',
    '../../../../embedded/libs/graphql-ws-client/src/graphql_ws_client.cpp',
  ];
  const documents = sourcePaths.flatMap((sourcePath) => {
    const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf-8');
    // C++ concatenates adjacent string literals. Read the actual firmware
    // documents so expanding a controller selection cannot silently break it.
    return [...source.matchAll(/"(?:query|mutation|subscription) [A-Z][^"\n]*(?:"\s*"[^"\n]*)*"/g)].map(([literal]) =>
      literal.replace(/"\s*"/g, '').slice(1, -1),
    );
  });
  it('finds every current controller operation', () => {
    expect(documents).toHaveLength(4);
  });
  for (const source of documents) {
    const document = parse(source);
    const name = document.definitions.find((definition) => definition.kind === 'OperationDefinition')?.name?.value;
    it(`${name} validates with depth and cost limits`, () => {
      expect(validate(schema, document).map((error) => error.message)).toEqual([]);
    });
  }
});

describe('native iOS operations satisfy the shared transport limits', () => {
  const sourcePaths = [
    '../../../../packages/mobile/modules/live-activity/ios/SessionWebSocketManager.swift',
    '../../../../packages/mobile/modules/live-activity/ios/LiveActivityModule.swift',
  ];
  const documents = sourcePaths.flatMap((sourcePath) => {
    const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf-8');
    return [...source.matchAll(/"""\s*((?:query|mutation|subscription) [\s\S]*?)"""/g)].map((match) => match[1]);
  });
  it('finds every current native iOS operation', () => {
    expect(documents).toHaveLength(5);
  });
  for (const source of documents) {
    const document = parse(source);
    const name = document.definitions.find((definition) => definition.kind === 'OperationDefinition')?.name?.value;
    it(`${name} validates with depth and cost limits`, () => {
      expect(validate(schema, document).map((error) => error.message)).toEqual([]);
    });
  }
});

/**
 * The actual offender behind #2381: packages/mobile/src/lib/graphql/operations.ts
 * hand-maintains its subscriptions as plain strings, not `gql`-tagged, because they
 * ride graphql-ws rather than graphql-request's HTTP transport (see the "Subscriptions
 * are plain strings" comment above them in that file). Plain strings mean neither
 * graphql-codegen (codegen.ts only scans packages/shared/graphql and packages/web/app
 * documents) nor the `shared-schema operations validate against the executable schema`
 * describe block above (which only covers `@boardsesh/graphql` exports) ever parses or
 * validates them.
 *
 * QUEUE_UPDATES_SUBSCRIPTION shipped with an unaliased `item` selection spread across
 * QueueItemAdded (ClimbQueueItem!) and CurrentClimbChanged (ClimbQueueItem), plus an
 * unaliased `uuid` spread across ClimbMirrored (ID) and its sibling union arms (ID!) —
 * the exact OverlappingFieldsCanBeMergedRule hazard this file's docstring already
 * tracks two prior incidents of. Every real client that opened a party session hit
 * "Fields \"item\"/\"uuid\" conflict ... Use different aliases" (issue #2381, 18x over
 * 6 days) until PR #2340 aliased the fields — a fix that landed by manual catch, with
 * no test asserting it stays fixed.
 *
 * Extract the plain-string documents from source text (same regex-extraction
 * technique already used for SUBSCRIPTION_CLIMB_FIELDS, to avoid importing the RN-only
 * mobile package into this backend test) and run them through the same
 * parse() + validate() guard as the shared operations above.
 */
describe('mobile plain-string subscription documents validate against the executable schema', () => {
  const mobileOperationsSource = readMobileOperationsSource();
  function readMobilePlainOperation(constName: string): string {
    return resolveMobileTemplatePlaceholders(
      extractTemplateConst(mobileOperationsSource, constName),
      mobileOperationsSource,
    );
  }

  const mobilePlainOperationNames = [
    'SESSION_UPDATES_SUBSCRIPTION',
    'QUEUE_UPDATES_SUBSCRIPTION',
    'NOTIFICATION_RECEIVED_SUBSCRIPTION',
  ] as const;

  const operationEntries: Array<[string, string]> = mobilePlainOperationNames.map((constName) => [
    constName,
    readMobilePlainOperation(constName),
  ]);

  it('found every known mobile plain-string subscription', () => {
    expect(operationEntries).toHaveLength(mobilePlainOperationNames.length);
  });

  for (const [name, source] of operationEntries) {
    it(`operations.ts.${name} parses and validates against the schema`, () => {
      let document: DocumentNode;
      try {
        document = parse(source);
      } catch (error) {
        throw new Error(`Mobile operation ${name} failed to parse: ${(error as Error).message}`);
      }

      const errors = validate(schema, document);
      if (errors.length > 0) {
        const detail = errors.map((error, index) => `  ${index + 1}. ${error.message}`).join('\n');
        throw new Error(`Mobile operation ${name} has GraphQL validation errors:\n${detail}`);
      }
    });
  }
});

// Regression guard for #4494. `CLIMB_SEARCH_FIELDS` — the selection set behind
// SEARCH_CLIMBS, which is how every climb reaches the Climbs list and, through
// it, the play drawer — deliberately omitted `description` on the premise that
// "no list UI renders them". The play drawer DOES render it now (setter notes),
// so re-slimming the list would silently blank that section for every climb
// opened from search while leaving deep-linked climbs fine. Same technique as
// queue-climb-field-contract.test.ts: read the hand-maintained template out of
// mobile's source and assert on the parsed field set.
describe('CLIMB_SEARCH_FIELDS carries the fields the play drawer renders', () => {
  // The shared document nests the list under `searchClimbs { climbs { ... } }`,
  // so collect by the `climbs` parent rather than the `climb` one climbFieldNames uses.
  function searchResultClimbFields(operationSource: string): Set<string> {
    const fields = new Set<string>();
    visit(parse(operationSource), {
      Field(node) {
        if (node.name.value !== 'climbs' || !node.selectionSet) return;
        for (const selection of node.selectionSet.selections) {
          if (selection.kind === 'Field') fields.add(selection.name.value);
        }
      },
    });
    return fields;
  }

  const mobileSearchFields = climbFieldNames(
    `{ climb { ${extractTemplateConst(readMobileOperationsSource(), 'CLIMB_SEARCH_FIELDS')} } }`,
  );
  const sharedSearchFields = searchResultClimbFields(publicOperations.SEARCH_CLIMBS);

  it('both copies select a non-empty field set', () => {
    expect(mobileSearchFields.size).toBeGreaterThan(0);
    expect(sharedSearchFields.size).toBeGreaterThan(0);
  });

  it('mobile selects description, so the play drawer can show the setter notes (#4494)', () => {
    expect(mobileSearchFields.has('description')).toBe(true);
  });

  it('the shared search operation selects description too, so a future web caller starts correct', () => {
    expect(sharedSearchFields.has('description')).toBe(true);
  });
});

// The server half of this contract is guarded by resolver-climb-fields.test.ts.
// This is the client half, and it is the half the user sees: a resolver can
// project `characteristics` perfectly and the play drawer still prints "Matching
// rule not recorded" if the document never asked for it. Both halves were
// missing on all five list documents until issue #5214.
//
// `is_no_match` rides along because web reads it directly (climb-title.tsx) to
// draw the no-match glyph, and its field resolver falls back to the Aurora
// description convention — a no-op on Woods and MoonBoard — whenever the parent
// did not select `characteristics`.
describe('climb-list documents select the rule fields the play drawer renders', () => {
  function climbsSelectionFields(operationSource: string): Set<string> {
    const fields = new Set<string>();
    visit(parse(operationSource), {
      Field(node) {
        if (node.name.value !== 'climbs' || !node.selectionSet) return;
        for (const selection of node.selectionSet.selections) {
          if (selection.kind === 'Field') fields.add(selection.name.value);
        }
      },
    });
    return fields;
  }

  // Every document that returns a full Climb list a client opens the play drawer
  // from without refetching. Add new ones here.
  const documents: [string, string][] = [
    ['GET_USER_FAVORITE_CLIMBS', publicOperations.GET_USER_FAVORITE_CLIMBS],
    ['GET_PLAYLIST_CLIMBS', publicOperations.GET_PLAYLIST_CLIMBS],
    ['GET_SMART_PLAYLIST', publicOperations.GET_SMART_PLAYLIST],
    ['GET_SETTER_CLIMBS_FULL', publicOperations.GET_SETTER_CLIMBS_FULL],
    ['GET_USER_CLIMBS', publicOperations.GET_USER_CLIMBS],
  ];

  for (const [name, source] of documents) {
    it(`${name} selects characteristics and is_no_match (#5214)`, () => {
      const fields = climbsSelectionFields(source);

      expect(fields.size).toBeGreaterThan(0);
      expect(fields.has('characteristics')).toBe(true);
      expect(fields.has('is_no_match')).toBe(true);
    });
  }

  it('SIMILAR_CLIMBS_QUERY selects characteristics, so a tapped similar climb keeps its rules', () => {
    const fields = new Set<string>();
    visit(parse(publicOperations.SIMILAR_CLIMBS_QUERY), {
      Field(node) {
        if (node.name.value !== 'similarClimbs' || !node.selectionSet) return;
        for (const selection of node.selectionSet.selections) {
          if (selection.kind === 'Field') fields.add(selection.name.value);
        }
      },
    });

    expect(fields.has('characteristics')).toBe(true);
  });
});

describe('native iOS queue subscription drift guard', () => {
  it('matches the shared-schema native queue operation exactly after whitespace normalization', () => {
    const nativeOperation = readNativeIosQueueUpdatesOperation();

    expect(normalizeGraphQLOperation(nativeOperation)).toBe(
      normalizeGraphQLOperation(queueSessionOperations.NATIVE_IOS_QUEUE_UPDATES),
    );
  });
});

// The mobile app hand-maintains SUBSCRIPTION_CLIMB_FIELDS (a plain
// string-interpolated selection in packages/mobile/src/lib/graphql/operations.ts,
// not a shared GraphQL fragment). It is a second maintenance point against the
// shared queue-session CLIMB_FIELDS: a field added only to the shared fragment
// would silently drop out of party-mode subscription payloads on mobile, so the
// queue row and re-opened drawer render with empty grade / quality / rating.
// This asserts every field the shared QUEUE_UPDATES subscription selects on
// `climb` is also selected by mobile (superset-or-equal).
//
// The deliberately-slim NATIVE_IOS_QUEUE_UPDATES selection is a SEPARATE native
// decode path and is intentionally NOT part of this parity check — it is guarded
// against drift by the exact-match test above.
describe('mobile SUBSCRIPTION_CLIMB_FIELDS is a superset of the shared queue-session climb fragment', () => {
  // Fields the shared fragment selects that the mobile subscription intentionally
  // omits. Keep empty unless there is a documented reason a climb field must not
  // ride the mobile socket; adding one here is an explicit, reviewed exception.
  const INTENTIONAL_MOBILE_OMISSIONS = new Set<string>();

  const sharedClimbFields = climbFieldNames(queueSessionOperations.QUEUE_UPDATES);
  // Wrap the bare mobile field list in a `climb { ... }` selection so the same
  // parser-driven collector applies.
  const mobileClimbFields = climbFieldNames(`{ climb { ${readMobileSubscriptionClimbFields()} } }`);

  it('both fragments select a non-empty set of climb fields', () => {
    expect(sharedClimbFields.size).toBeGreaterThan(0);
    expect(mobileClimbFields.size).toBeGreaterThan(0);
  });

  it('every shared climb field is present in the mobile fragment', () => {
    const missing = [...sharedClimbFields].filter(
      (field) => !mobileClimbFields.has(field) && !INTENTIONAL_MOBILE_OMISSIONS.has(field),
    );
    if (missing.length > 0) {
      throw new Error(
        `mobile SUBSCRIPTION_CLIMB_FIELDS is missing shared queue-session climb fields: ${missing.join(', ')}.\n` +
          'Add them to packages/mobile/src/lib/graphql/operations.ts, or (with a reason) to INTENTIONAL_MOBILE_OMISSIONS.',
      );
    }
    expect(missing).toEqual([]);
  });

  it('carries the Boardsesh grade fields on both sides', () => {
    for (const field of ['boardseshDifficulty', 'boardseshConfidence']) {
      expect(sharedClimbFields.has(field)).toBe(true);
      expect(mobileClimbFields.has(field)).toBe(true);
    }
  });
});

// Regression test for issue #3358: QUEUE_UPDATES_SUBSCRIPTION shipped with NO
// `... on PlaybackStateChanged` fragment at all. Per GraphQL union selection
// semantics that meant the server returned a `__typename`-only payload for
// every PlaybackStateChanged event — `event.climbUuid` was always `undefined`,
// so `use-mobile-playback.ts`'s `event.climbUuid !== climbUuid` guard always
// short-circuited and inbound peer route-playback sync silently did nothing on
// mobile. TypeScript never caught it because `use-session-realtime.ts` reads
// the raw wire payload through an `as unknown as SubscriptionQueueEvent` cast
// (tracked separately as TODO(#2507)) — this parser-driven check is the
// backstop until that cast is removed.
describe('mobile QUEUE_UPDATES_SUBSCRIPTION selects the same PlaybackStateChanged fields as the shared queue-session subscription', () => {
  // Collect the field names selected inside every inline fragment for a given
  // type condition (e.g. `... on PlaybackStateChanged { ... }`), anywhere in
  // the document. Mirrors climbFieldNames' parser-driven approach above so
  // this compares field sets, not raw strings.
  function inlineFragmentFieldNames(operationSource: string, typeName: string): Set<string> {
    const fields = new Set<string>();
    visit(parse(operationSource), {
      InlineFragment(node) {
        if (node.typeCondition?.name.value !== typeName || !node.selectionSet) return;
        for (const selection of node.selectionSet.selections) {
          if (selection.kind === 'Field') fields.add(selection.name.value);
        }
      },
    });
    return fields;
  }

  const mobileOperationsSource = readMobileOperationsSource();
  const mobileQueueUpdates = resolveMobileTemplatePlaceholders(
    extractTemplateConst(mobileOperationsSource, 'QUEUE_UPDATES_SUBSCRIPTION'),
    mobileOperationsSource,
  );

  const sharedPlaybackFields = inlineFragmentFieldNames(queueSessionOperations.QUEUE_UPDATES, 'PlaybackStateChanged');
  const mobilePlaybackFields = inlineFragmentFieldNames(mobileQueueUpdates, 'PlaybackStateChanged');

  it('both subscriptions select a non-empty PlaybackStateChanged field set', () => {
    expect(sharedPlaybackFields.size).toBeGreaterThan(0);
    expect(mobilePlaybackFields.size).toBeGreaterThan(0);
  });

  it('every shared PlaybackStateChanged field is present in the mobile subscription', () => {
    const missing = [...sharedPlaybackFields].filter((field) => !mobilePlaybackFields.has(field));
    if (missing.length > 0) {
      throw new Error(
        `mobile QUEUE_UPDATES_SUBSCRIPTION is missing PlaybackStateChanged fields the shared subscription selects: ${missing.join(', ')}.\n` +
          'Without them, inbound peer route-playback sync is dead on mobile (issue #3358) — add the missing fields to the ' +
          '`... on PlaybackStateChanged` fragment in packages/mobile/src/lib/graphql/operations.ts.',
      );
    }
    expect(missing).toEqual([]);
  });

  it('carries climbUuid specifically, since that field gates whether use-mobile-playback applies the event at all', () => {
    expect(mobilePlaybackFields.has('climbUuid')).toBe(true);
  });
});

// Workstream B7 (reduced variant, 2026-07) removed ONLY the takeControl/releaseControl
// mutations. Session.driverParticipantId, the DriverChanged type, and its SessionEvent
// union membership are DEFERRED: telemetry found a real tail of stale mobile JS bundles
// (~15-20 users/14d) whose JoinSession documents still select driverParticipantId and
// whose sessionUpdates subscriptions still contain `... on DriverChanged`. Whole-document
// GraphQL validation means removing those would break the ENTIRE document (join, or the
// whole subscription) for those clients — a much bigger blast radius than a single unknown
// mutation failing on its own. The removed mutations were NOT pure no-ops: takeControl
// with a `climb` argument still propagated that climb via setCurrentClimbAndPublish, and
// stale bundles' party-mode lightbulb press routed through it — those users now lose the
// go-live gesture in party mode (their client's catch handler rolls back and resyncs;
// join and subscriptions are unaffected). That degradation is an accepted,
// telemetry-bounded trade-off (coordinator ruling, reduced-B7): the cohort is a shrinking
// stale-bundle tail whose fix is one app open (OTA).
//
// This is the safety contract of the reduced variant, made explicit as an assertion split:
//   - legacy JoinSession / SessionUpdates documents (driverParticipantId, DriverChanged)
//     must STILL validate — those types were not touched.
//   - legacy TakeControl / ReleaseControl documents must NOW fail validation — those
//     mutations are gone.
describe('previous-release driver operations: reduced-B7 validation split', () => {
  const stillValidLegacyOperations: Array<[string, string]> = [
    [
      'legacy JoinSession selecting driverParticipantId',
      `mutation JoinSession($sessionId: ID!, $boardPath: String!) {
        joinSession(sessionId: $sessionId, boardPath: $boardPath) {
          id
          participantId
          isLeader
          driverParticipantId
        }
      }`,
    ],
    [
      'legacy SessionUpdates subscription with DriverChanged fragment',
      `subscription SessionUpdates($sessionId: ID!) {
        sessionUpdates(sessionId: $sessionId) {
          __typename
          ... on DriverChanged {
            driverParticipantId
            previousDriverParticipantId
          }
          ... on WallConfirmedClimb {
            climbUuid
          }
        }
      }`,
    ],
  ];

  for (const [name, source] of stillValidLegacyOperations) {
    it(`${name} still validates against the schema (driver type removal is deferred)`, () => {
      const document = parse(source);
      const errors = validate(schema, document);
      if (errors.length > 0) {
        const detail = errors.map((error, index) => `  ${index + 1}. ${error.message}`).join('\n');
        throw new Error(`Legacy operation "${name}" must keep validating (deferred removal) but errored:\n${detail}`);
      }
      expect(errors).toHaveLength(0);
    });
  }

  const nowInvalidLegacyOperations: Array<[string, string]> = [
    [
      'legacy TakeControl mutation',
      `mutation TakeControl($climb: ClimbQueueItemInput) {
        takeControl(climb: $climb) {
          id
          driverParticipantId
        }
      }`,
    ],
    [
      'legacy ReleaseControl mutation',
      `mutation ReleaseControl {
        releaseControl {
          id
          driverParticipantId
        }
      }`,
    ],
  ];

  for (const [name, source] of nowInvalidLegacyOperations) {
    it(`${name} now fails validation (mutation removed by reduced-B7)`, () => {
      const document = parse(source);
      const errors = validate(schema, document);
      // Pin the failure reason: it must be the removed mutation field itself, not an
      // incidental error elsewhere in the document (e.g. driverParticipantId, which
      // deliberately still validates).
      const unknownMutationErrors = errors.filter((error) =>
        /Cannot query field "(takeControl|releaseControl)"/.test(error.message),
      );
      expect(unknownMutationErrors.length).toBeGreaterThan(0);
    });
  }
});
