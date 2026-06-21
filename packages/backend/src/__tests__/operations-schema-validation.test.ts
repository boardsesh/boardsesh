import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'fs';
import { buildSchema, parse, validate, type DocumentNode, type GraphQLSchema } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import * as publicOperations from '@boardsesh/graphql/operations';
import * as accountOperations from '@boardsesh/graphql/operations/account';
import * as proposalOperations from '@boardsesh/graphql/operations/proposals';
import * as queueSessionOperations from '@boardsesh/graphql/operations/queue-session';

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
    new URL('../../../../mobile/ios/App/App/SessionWebSocketManager.swift', import.meta.url),
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
    ['operations/proposals', proposalOperations],
    ['operations/queue-session', queueSessionOperations],
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

describe('native iOS queue subscription drift guard', () => {
  it('matches the shared-schema native queue operation exactly after whitespace normalization', () => {
    const nativeOperation = readNativeIosQueueUpdatesOperation();

    expect(normalizeGraphQLOperation(nativeOperation)).toBe(
      normalizeGraphQLOperation(queueSessionOperations.NATIVE_IOS_QUEUE_UPDATES),
    );
  });
});

describe('previous-release driver operations still validate (deprecated compat shims)', () => {
  // Stale clients — cached web bundles and un-OTA'd native binaries — still send
  // the pre-always-live driver operations. The deprecated schema shims
  // (Session.driverParticipantId, takeControl/releaseControl, the DriverChanged
  // union member) exist so these keep passing GraphQL validation through the
  // rollout window. Without them, a single `... on DriverChanged` fragment would
  // fail validation and take down the WHOLE sessionUpdates subscription (and a
  // driverParticipantId selection would break join). This test fails loudly if
  // a shim is removed before the rollout window closes.
  const legacyOperations: Array<[string, string]> = [
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

  for (const [name, source] of legacyOperations) {
    it(`${name} still validates against the shimmed schema`, () => {
      const document = parse(source);
      const errors = validate(schema, document);
      if (errors.length > 0) {
        const detail = errors.map((error, index) => `  ${index + 1}. ${error.message}`).join('\n');
        throw new Error(`Legacy operation "${name}" must keep validating during rollout but errored:\n${detail}`);
      }
      expect(errors).toHaveLength(0);
    });
  }
});
