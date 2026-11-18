import { readFileSync } from 'node:fs';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLError } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { describe, expect, it } from 'vite-plus/test';
import { typeDefs } from '@boardsesh/shared-schema';
import { maskDatabaseError } from '../../graphql/mask-error';
import { validateInput } from '../../validation/schemas/primitives';
import { SaveTickInputSchema } from '../../validation/schemas/ticks';
import { currentGarminFunction } from './garmin-source';

/**
 * The watch's saveTick reply table (garmin/source/state/TickQueue.mc), replayed
 * from the current source against replies produced by the real graphql-yoga
 * transport, the real SaveTickInput type, the real input schema and the real
 * production error mask. The body the watch sends is built by its own
 * BsEndpoints functions. Only the resolver's throw sites are restated here,
 * and each is checked against the backend source text so a changed code or
 * message fails this file instead of silently changing the watch's verdict.
 */

const backendSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

function watchReplay() {
  const scope: Record<string, unknown> = {};
  scope.savedUuid = currentGarminFunction('state/TickQueue.mc', 'savedUuid', scope);
  scope.errorReason = currentGarminFunction('state/TickQueue.mc', 'errorReason', scope);
  scope.nullStateField = currentGarminFunction('state/TickQueue.mc', 'nullStateField', scope);
  const endpoints: Record<string, unknown> = {};
  return {
    exactAck: currentGarminFunction('state/TickQueue.mc', 'exactAck', scope) as (
      code: number,
      reply: unknown,
      uuid: string,
    ) => boolean,
    rejectionReason: currentGarminFunction('state/TickQueue.mc', 'rejectionReason', scope) as (
      code: number,
      reply: unknown,
    ) => string | null,
    saveTickInput: currentGarminFunction('net/BsEndpoints.mc', 'saveTickInput', endpoints) as (
      ...values: unknown[]
    ) => Record<string, unknown>,
    saveTickGraphqlBody: currentGarminFunction('net/BsEndpoints.mc', 'saveTickGraphqlBody', endpoints) as (
      input: unknown,
    ) => unknown,
    graphqlAuthRequired: currentGarminFunction('net/BsClient.mc', 'graphqlAuthRequired', {}) as (
      code: number,
      reply: unknown,
    ) => boolean,
  };
}

const TICK_UUID = '6f1c1c4e-2a0b-4c8e-9a51-3f2b1f0c9d11';

const slimState = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  climb: { climbUuid: 'C0FFEEC0FFEEC0FFEEC0FFEEC0FFEE00', mirrored: false, isBenchmark: false },
};

type Resolve = (input: Record<string, unknown>) => unknown;

async function exchange(
  body: unknown,
  resolve: Resolve,
  context: () => unknown = () => ({ isAuthenticated: true, userId: 'fixture-owner' }),
) {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: {
      Mutation: { saveTick: (_: unknown, { input }: { input: Record<string, unknown> }) => resolve(input) },
    },
  });
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    context,
    logging: false,
    // The production mask (yoga.ts enables it outside local/test runs).
    maskedErrors: { maskError: maskDatabaseError },
  });
  const response = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return { code: response.status, reply: (await response.json()) as unknown };
}

describe('current Garmin saveTick reply classification over the real /graphql transport', () => {
  const watch = watchReplay();
  const body = (state = slimState, climbedAt = '2026-11-16T10:00:00Z') =>
    watch.saveTickGraphqlBody(watch.saveTickInput(state, 'fixture-session', 'send', 1, climbedAt, TICK_UUID));

  it('acknowledges only the stored tick for the sent UUID, including a repeated UUID', async () => {
    const saved = await exchange(body(), (input) => {
      // The real schema accepts exactly what the watch builds.
      validateInput(SaveTickInputSchema, input, 'input');
      return { uuid: input.uuid };
    });
    expect(saved.code).toBe(200);
    expect(watch.exactAck(saved.code, saved.reply, TICK_UUID)).toBe(true);
    expect(watch.exactAck(saved.code, saved.reply, 'another-uuid')).toBe(false);
    expect(watch.rejectionReason(saved.code, saved.reply)).toBeNull();
    expect(watch.graphqlAuthRequired(saved.code, saved.reply)).toBe(false);
    expect(backendSource('graphql/resolvers/ticks/mutations.ts')).toContain('if (existingTick.userId !== userId) {');
  });

  it('sends the board uuid only when session state carries one, in a form the schema accepts', async () => {
    const wallUuid = '0b5a8f0e-6a2d-4f43-9d1e-2b7c3e8f9a10';
    const inputs: Record<string, unknown>[] = [];
    const accept = (input: Record<string, unknown>) => {
      validateInput(SaveTickInputSchema, input, 'input');
      inputs.push(input);
      return { uuid: input.uuid };
    };

    // The share-link capability: sent like the phone's activeBoard.uuid.
    const withBoard = await exchange(body({ ...slimState, boardUuid: wallUuid } as typeof slimState), accept);
    expect(withBoard.code).toBe(200);
    expect(watch.exactAck(withBoard.code, withBoard.reply, TICK_UUID)).toBe(true);
    expect(inputs.at(-1)?.boardUuid).toBe(wallUuid);
    expect(backendSource('graphql/resolvers/ticks/mutations.ts')).toContain('validatedInput.boardUuid ?? null,');

    // Session state from a server that sends no board uuid (every server
    // today) or a null or malformed one: the key is left out. A null would be
    // refused by the schema (`UUIDSchema.optional()`) and dead-lettered.
    for (const boardUuid of [undefined, null, '', 'not-a-uuid', 42]) {
      const state = boardUuid === undefined ? slimState : { ...slimState, boardUuid };
      const built = watch.saveTickInput(state, 'fixture-session', 'send', 1, '2026-11-16T10:00:00Z', TICK_UUID);
      expect(Object.hasOwn(built, 'boardUuid')).toBe(false);
      const saved = await exchange(watch.saveTickGraphqlBody(built), accept);
      expect(watch.exactAck(saved.code, saved.reply, TICK_UUID)).toBe(true);
    }
    const refusedNull = await exchange(body(), (input) =>
      accept({ ...input, boardUuid: null } as Record<string, unknown>),
    );
    expect(watch.rejectionReason(refusedNull.code, refusedNull.reply)).toBe('INVALID_INPUT');
  });

  it('dead-letters the permanent refusals the saveTick handler can produce', async () => {
    const mutations = backendSource('graphql/resolvers/ticks/mutations.ts');
    for (const [code, message] of [
      ['CLIMB_NOT_FOUND', 'Climb not found'],
      ['TICK_UUID_CONFLICT', 'Tick UUID is already in use'],
    ]) {
      expect(mutations).toContain(`throw new GraphQLError('${message}', {`);
      expect(mutations).toContain(`code: '${code}' }`);
      const refused = await exchange(body(), () => {
        throw new GraphQLError(message, { extensions: { code } });
      });
      expect(refused.code).toBe(200);
      expect(watch.exactAck(refused.code, refused.reply, TICK_UUID)).toBe(false);
      expect(watch.rejectionReason(refused.code, refused.reply)).toBe(code);
      expect(watch.graphqlAuthRequired(refused.code, refused.reply)).toBe(false);
    }

    // The real input schema: an impossible climbedAt is refused without a code.
    const invalid = await exchange(body(slimState, 'not-a-date'), (input) => {
      validateInput(SaveTickInputSchema, input, 'input');
      return { uuid: input.uuid };
    });
    expect(invalid.code).toBe(200);
    expect(JSON.stringify(invalid.reply)).not.toContain('"code"');
    expect(watch.rejectionReason(invalid.code, invalid.reply)).toBe('INVALID_INPUT');
    expect(mutations).toContain("validateInput(SaveTickInputSchema, input, 'input')");

    // The real SaveTickInput type: session state without a board type or
    // angle cannot coerce, and only that tick is at fault.
    for (const missing of [
      { ...slimState, boardType: null },
      { ...slimState, angle: null },
      { ...slimState, climb: { ...slimState.climb, climbUuid: null } },
    ]) {
      const uncoercible = await exchange(body(missing as unknown as typeof slimState), () => {
        throw new Error('resolver must not run');
      });
      expect(uncoercible.code).toBe(400);
      expect(watch.rejectionReason(uncoercible.code, uncoercible.reply)).toBe('NULL_STATE_FIELD');
    }
  });

  it('retries verdicts that would hit every tick alike', async () => {
    // Schema skew: a field the watch sends that the server no longer knows.
    const built = body() as { query: string; variables: { input: Record<string, unknown> } };
    const skewed = await exchange(
      { ...built, variables: { input: { ...built.variables.input, retiredField: 1 } } },
      () => ({ uuid: TICK_UUID }),
    );
    expect(skewed.code).toBe(400);
    expect(JSON.stringify(skewed.reply)).toContain('is not defined by type');
    expect(watch.rejectionReason(skewed.code, skewed.reply)).toBeNull();

    // The fixed query no longer validates against the schema.
    const invalidDocument = await exchange(
      { ...built, query: built.query.replace('{ uuid }', '{ uuid retiredField }') },
      () => ({ uuid: TICK_UUID }),
    );
    expect(invalidDocument.code).toBe(200);
    expect(JSON.stringify(invalidDocument.reply)).toContain('GRAPHQL_VALIDATION_FAILED');
    expect(watch.rejectionReason(invalidDocument.code, invalidDocument.reply)).toBeNull();

    // A body the bridge mangled: yoga cannot parse it at all.
    const yoga = createYoga({ schema: makeExecutableSchema({ typeDefs }), logging: false });
    const mangled = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(built).slice(0, 40),
    });
    expect(mangled.status).toBe(400);
    expect(watch.rejectionReason(mangled.status, (await mangled.json()) as unknown)).toBeNull();
  });

  it('retries auth, outage and unknown replies and never dead-letters them', async () => {
    // requireAuthenticated: an expired bearer degrades to anonymous (yoga.ts).
    const authMessage = 'Authentication required to perform this operation';
    expect(backendSource('graphql/resolvers/shared/helpers.ts')).toContain(`throw new Error('${authMessage}');`);
    const anonymous = await exchange(body(), () => {
      throw new Error(authMessage);
    });
    expect(anonymous.code).toBe(200);
    expect(watch.rejectionReason(anonymous.code, anonymous.reply)).toBeNull();
    // That reply, and only that reply, sends the watch to its token refresh
    // and one retry, the same path an HTTP 401 takes (BsRequest.onResponse).
    expect(watch.graphqlAuthRequired(anonymous.code, anonymous.reply)).toBe(true);

    // A refused credential and an unavailable auth admission are transport
    // replies from the context factory (yoga.ts), not verdicts on the tick.
    const yogaSource = backendSource('graphql/yoga.ts');
    for (const [code, status, message] of [
      ['UNAUTHENTICATED', 401, 'Authentication is required'],
      ['SERVICE_UNAVAILABLE', 503, 'Authentication is temporarily unavailable'],
    ] as const) {
      expect(yogaSource).toContain(`extensions: { code: '${code}', http: { status: ${status} } },`);
      const refused = await exchange(
        body(),
        () => ({ uuid: TICK_UUID }),
        () => {
          throw new GraphQLError(message, { extensions: { code, http: { status } } });
        },
      );
      expect(refused.code).toBe(status);
      expect(watch.rejectionReason(refused.code, refused.reply)).toBeNull();
      // A 401 already refreshes by status; a 503 must not spend the refresh secret.
      expect(watch.graphqlAuthRequired(refused.code, refused.reply)).toBe(false);
    }

    // The production mask: a database statement failure and an unreachable
    // database. Both are scrubbed to INTERNAL_SERVER_ERROR.
    const statementFailure = await exchange(body(), () => {
      throw Object.assign(new Error('Failed query: insert into boardsesh_ticks'), {
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      });
    });
    expect(statementFailure.code).toBe(200);
    expect(JSON.stringify(statementFailure.reply)).toContain('INTERNAL_SERVER_ERROR');
    expect(watch.rejectionReason(statementFailure.code, statementFailure.reply)).toBeNull();
    expect(watch.graphqlAuthRequired(statementFailure.code, statementFailure.reply)).toBe(false);
    const outage = await exchange(body(), () => {
      throw Object.assign(new Error('Failed query: select 1'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    });
    expect(outage.code).toBe(503);
    expect(watch.rejectionReason(outage.code, outage.reply)).toBeNull();

    // Edge and SDK replies never reach the resolver.
    for (const code of [-104, -2, -400, 401, 404, 429, 500, 502, 503, 504]) {
      expect(watch.rejectionReason(code, null)).toBeNull();
    }
  });
});
