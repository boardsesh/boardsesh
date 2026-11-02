import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DESCRIPTION,
  FIXTURE_BOARDS,
  GYM_NAME,
  GYM_SLUG,
  defaultsHeader,
  provisionQaGym,
} from './provision-qa-gym.mjs';

const require = createRequire(new URL('../../packages/backend/package.json', import.meta.url));
const { buildSchema, graphql, parse, validate } = require('graphql');
const schema = buildSchema(
  await readFile(new URL('../../packages/shared-schema/src/generated/schema.graphql', import.meta.url), 'utf8'),
);
const token = 'normal-user-token-never-log';
const endpoint = 'https://ws.boardsesh.com/graphql';
const ownerId = 'normal-account';
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function fakeBackend() {
  const state = {
    gyms: [],
    boards: [],
    controllers: [],
    requests: [],
    mutations: [],
    schemaReady: true,
    previewReady: true,
    authenticated: true,
    nextId: 1,
    boardFailures: 0,
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method !== 'POST') {
      assert.equal(options.headers, undefined, 'Catalog requests must not carry the user token');
      assert.equal(new URL(url).pathname, '/render/controller-preview');
      if (!state.previewReady) return new Response('', { status: 503 });
      const geometry = Buffer.alloc(20);
      geometry.write('BSGM');
      geometry.writeUInt16LE(1, 4);
      geometry.writeUInt16LE(1, 6);
      geometry.writeUInt16LE(330, 8);
      geometry.writeUInt16LE(330, 10);
      return new Response(geometry);
    }
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    const { operationName, query, variables } = JSON.parse(options.body);
    assert.deepEqual(
      validate(schema, parse(query)),
      [],
      'Every request must validate against the actual repository schema',
    );
    state.requests.push({ operationName, query, variables });
    if (query.startsWith('mutation')) state.mutations.push({ operationName, input: variables.input });
    let result;
    switch (operationName) {
      case 'ProvisionSchema': {
        result = await graphql({ schema, source: query });
        if (!state.schemaReady)
          result.data.CreateGymInput.inputFields = result.data.CreateGymInput.inputFields.filter(
            (field) => field.name !== 'isListed',
          );
        return Response.json(result);
      }
      case 'ProvisionIdentity':
        result = { profile: state.authenticated ? { id: ownerId } : null };
        break;
      case 'ProvisionInventory': {
        const gyms = query.includes('myGyms');
        const rows = gyms ? state.gyms : state.boards;
        const { offset, limit } = variables.input;
        result = {
          [gyms ? 'myGyms' : 'myBoards']: {
            [gyms ? 'gyms' : 'boards']: rows.slice(offset, offset + limit),
            hasMore: offset + limit < rows.length,
          },
        };
        break;
      }
      case 'ProvisionSlug':
        result = { gymBySlug: state.gyms.find((gym) => gym.slug === GYM_SLUG) ?? null };
        break;
      case 'ProvisionLinkedBoards':
        result = { gymBoards: state.boards.filter((board) => board.gymUuid === variables.gymUuid) };
        break;
      case 'ProvisionControllers':
        result = { myControllers: state.controllers };
        break;
      case 'ProvisionSerials':
        result = {
          observedBoardSerialMatches: variables.input.map((entry) => ({
            ...entry,
            candidates: state.boards
              .filter(
                (board) => board.serialNumber === entry.observedSerialNumber && board.boardType === entry.boardType,
              )
              .map((board) => ({
                uuid: board.hidden ? '' : board.uuid,
                boardType: board.boardType,
                layoutId: board.layoutId,
                sizeId: board.sizeId,
              })),
          })),
        };
        break;
      case 'ProvisionCreateGym': {
        assert.equal(variables.input.isListed, false, 'The first write must already create an unlisted gym');
        const gym = { ...variables.input, ownerId, uuid: uuid(state.nextId++), slug: 'boardsesh-qa-gym' };
        state.gyms.push(gym);
        result = { createGym: gym };
        break;
      }
      case 'ProvisionUpdateGym': {
        const gym = state.gyms.find((entry) => entry.uuid === variables.input.gymUuid);
        Object.assign(gym, variables.input);
        result = { updateGym: gym };
        break;
      }
      case 'ProvisionCreateBoard': {
        if (state.boardFailures-- > 0)
          return Response.json({
            errors: [{ message: `Never print ${token}`, extensions: { code: 'BOARD_SERIAL_EXISTS' } }],
          });
        const board = { ...variables.input, ownerId, uuid: uuid(state.nextId++) };
        state.boards.push(board);
        result = { createBoard: board };
        break;
      }
      case 'ProvisionLinkBoard': {
        Object.assign(
          state.boards.find((board) => board.uuid === variables.input.boardUuid),
          { gymUuid: variables.input.gymUuid },
        );
        result = { linkBoardToGym: true };
        break;
      }
      case 'ProvisionRegisterController': {
        const controller = { id: uuid(state.nextId++), ...variables.input };
        state.controllers.push(controller);
        result = {
          registerController: {
            controllerId: controller.id,
            apiKey: String(state.controllers.length).padStart(64, 'a'),
          },
        };
        break;
      }
      default:
        throw new Error(`Unexpected operation ${operationName}`);
    }
    return Response.json({ data: result });
  };
  return { state, fetchImpl };
}

async function setup(context) {
  const directory = await mkdtemp(join(tmpdir(), 'boardsesh-qa-provision-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const backend = fakeBackend();
  const options = {
    token,
    endpoint,
    out: join(directory, 'controller.json'),
    resultFile: join(directory, 'fixture.json'),
    defaultsPath: join(directory, 'defaults.h'),
    fetchImpl: backend.fetchImpl,
  };
  return { ...backend, options, directory };
}

test('dry run reads the live schema/catalog and plans exact configs without writing records or files', async (context) => {
  const { options, state, directory } = await setup(context);
  const result = await provisionQaGym({ ...options, writeDefaults: true });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(
    result.boards.map((board) => board.serialNumber),
    ['99000001', '99000002', '99000003'],
  );
  assert.deepEqual(
    result.boards.map(({ serialNumber, uuid: boardUuid, ...board }) => board),
    FIXTURE_BOARDS,
  );
  assert.equal(result.gym.isListed, false);
  assert.equal(state.requests[0].operationName, 'ProvisionSchema');
  assert.equal(state.mutations.length, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('missing unlisted schema, unauthenticated account, and unavailable art abort before every mutation', async (context) => {
  for (const setting of ['schemaReady', 'authenticated', 'previewReady']) {
    const { options, state, directory } = await setup(context);
    state[setting] = false;
    await assert.rejects(provisionQaGym({ ...options, apply: true }));
    assert.equal(state.mutations.length, 0);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('apply is idempotent, stores only the device key privately, and generates an actual UUID default', async (context) => {
  const { options, state } = await setup(context);
  const placeholder = await readFile(
    new URL('../projects/board-controller/src/gym/provisioned_defaults.h', import.meta.url),
    'utf8',
  );
  assert.ok(placeholder.startsWith('// Generated by provision-qa-gym.mjs.'));
  assert.match(placeholder, /#define GYM_FIXTURE_DEFAULT_GYM "(?:boardsesh-qa|[0-9a-f-]{36})"/i);
  await writeFile(
    options.defaultsPath,
    placeholder.replace(/(#define GYM_FIXTURE_DEFAULT_GYM )"[^"]+"/, '$1"boardsesh-qa"'),
  );
  const first = await provisionQaGym({ ...options, apply: true, writeDefaults: true });
  const initialWrites = state.mutations.length;
  const second = await provisionQaGym({ ...options, apply: true, writeDefaults: true });
  assert.equal(state.mutations.length, initialWrites);
  assert.deepEqual(second.boards, first.boards);
  assert.equal(first.gym.slug, GYM_SLUG);
  assert.equal(state.gyms.length, 1);
  assert.equal(state.controllers.length, 1);
  assert.equal(state.boards.length, 3);
  const privateState = JSON.parse(await readFile(options.out, 'utf8'));
  assert.equal((await stat(options.out)).mode & 0o777, 0o600);
  assert.equal(privateState.apiKey.length, 64);
  assert.equal(privateState.ownerId, ownerId);
  assert.ok(!JSON.stringify(first).includes(privateState.apiKey));
  assert.ok(!JSON.stringify(privateState).includes(token));
  assert.equal(await readFile(options.defaultsPath, 'utf8'), defaultsHeader(first.gym.uuid));
  for (const input of state.mutations.map((mutation) => mutation.input)) {
    assert.equal(input.latitude, undefined);
    assert.equal(input.longitude, undefined);
    assert.equal(input.address, undefined);
    assert.equal(input.locationName, undefined);
  }
  for (const board of state.boards) {
    assert.equal(board.isPublic, true);
    assert.equal(board.isUnlisted, false);
    assert.equal(board.allowDuplicateSerial, false);
  }
});

test('occupied serials, including geometry-only private candidates, choose unused values without clobbering', async (context) => {
  const { options, state } = await setup(context);
  const unrelated = {
    uuid: uuid(100),
    ownerId: 'other-account',
    name: 'Private wall',
    boardType: 'moonboard',
    serialNumber: '99000001',
    hidden: true,
  };
  state.boards.push(unrelated);
  const result = await provisionQaGym({ ...options, apply: true });
  assert.deepEqual(
    result.boards.map((board) => board.serialNumber),
    ['99000004', '99000002', '99000003'],
  );
  assert.equal(state.boards[0], unrelated);
  assert.equal(unrelated.gymUuid, undefined);
});

test('an unrelated slug or same-named board aborts instead of modifying another fixture', async (context) => {
  const first = await setup(context);
  first.state.gyms.push({ uuid: uuid(99), ownerId: 'other-account', name: 'Other gym', slug: GYM_SLUG });
  await assert.rejects(provisionQaGym({ ...first.options, apply: true }), /another gym/);
  assert.equal(first.state.mutations.length, 0);
  const second = await setup(context);
  second.state.boards.push({
    ...FIXTURE_BOARDS[0],
    uuid: uuid(99),
    ownerId,
    description: 'A real personal board',
    isPublic: true,
    serialNumber: '99000001',
  });
  await assert.rejects(provisionQaGym({ ...second.options, apply: true }), /refusing to overwrite/);
  assert.equal(second.state.mutations.length, 0);
});

test('a partial apply resumes its existing gym without duplicating registration or printing server secrets', async (context) => {
  const { options, state } = await setup(context);
  state.boardFailures = 1;
  await assert.rejects(provisionQaGym({ ...options, apply: true }), (error) => {
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(state.gyms.length, 1);
  assert.equal(state.controllers.length, 0);
  const result = await provisionQaGym({ ...options, apply: true });
  assert.equal(result.gym.uuid, state.gyms[0].uuid);
  assert.equal(state.gyms.length, 1);
  assert.equal(state.boards.length, 3);
  assert.equal(state.controllers.length, 1);
});

test('lost or revoked controller credentials require an explicit registration request', async (context) => {
  const { options, state } = await setup(context);
  await provisionQaGym({ ...options, apply: true });
  await unlink(options.out);
  const before = state.mutations.length;
  await assert.rejects(provisionQaGym({ ...options, apply: true }), /--new-controller/);
  assert.equal(state.mutations.length, before);
  await provisionQaGym({ ...options, apply: true, newController: true });
  assert.equal(state.controllers.length, 2);
  state.controllers.length = 0;
  const after = state.mutations.length;
  await assert.rejects(provisionQaGym({ ...options, apply: true }), /--new-controller/);
  assert.equal(state.mutations.length, after);
});

test('orphaned identified fixture boards relink only to the same owned QA gym', async (context) => {
  const { options, state } = await setup(context);
  await provisionQaGym({ ...options, apply: true });
  state.boards[0].gymUuid = null;
  const before = state.mutations.length;
  await provisionQaGym({ ...options, apply: true });
  assert.deepEqual(
    state.mutations.slice(before).map((mutation) => mutation.operationName),
    ['ProvisionLinkBoard'],
  );
  state.boards[0].gymUuid = uuid(99);
  await assert.rejects(provisionQaGym({ ...options, apply: true }), /refusing to overwrite or move/);
});

test('rejects unsafe credential files, reused output paths, shared fixture serials, and invalid header UUIDs', async (context) => {
  const { options, state } = await setup(context);
  await writeFile(options.out, '{}', { mode: 0o644 });
  await assert.rejects(provisionQaGym({ ...options, apply: true }), /owner-only/);
  await unlink(options.out);
  await assert.rejects(provisionQaGym({ ...options, resultFile: options.out, apply: true }), /different/);
  await provisionQaGym({ ...options, apply: true });
  state.boards.push({
    ...state.boards[0],
    uuid: uuid(99),
    ownerId: 'stranger',
    gymUuid: null,
    name: 'Other wall',
    hidden: true,
  });
  const before = state.mutations.length;
  await assert.rejects(provisionQaGym({ ...options, apply: true }), /shared with another/);
  assert.equal(state.mutations.length, before);
  assert.throws(() => defaultsHeader('"\n#error injected'), /UUID/);
});

test('does not overwrite an unrelated header and never logs a token supplied as an invalid CLI argument', async (context) => {
  const { options, state } = await setup(context);
  await writeFile(options.defaultsPath, '// Hand-maintained configuration\n');
  await assert.rejects(provisionQaGym({ ...options, apply: true, writeDefaults: true }), /not generated/);
  assert.equal(state.mutations.length, 0);
  assert.equal(await readFile(options.defaultsPath, 'utf8'), '// Hand-maintained configuration\n');
  const script = fileURLToPath(new URL('./provision-qa-gym.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [script, '--token', token], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(token));
  await writeFile(options.resultFile, token, { mode: 0o600 });
  const overlap = spawnSync(
    process.execPath,
    [script, '--token-file', options.resultFile, '--result-file', options.resultFile],
    { encoding: 'utf8' },
  );
  assert.equal(overlap.status, 1);
  assert.ok(overlap.stderr.includes('cannot also be an output'));
  assert.equal(await readFile(options.resultFile, 'utf8'), token);
});
