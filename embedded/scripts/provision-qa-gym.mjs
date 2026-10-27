#!/usr/bin/env node
import { chmod, lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const GYM_NAME = 'Boardsesh QA gym';
export const GYM_SLUG = 'boardsesh-qa';
export const FIXTURE_MARKER = '[boardsesh-qa-fixture:v1]';
export const DESCRIPTION = `${FIXTURE_MARKER} Software and Bluetooth QA fixture. These are simulated boards, not a climbing venue. Shared by link for maintainers; excluded from discovery.`;
export const FIXTURE_BOARDS = [
  {
    name: 'Boardsesh QA Kilter Homewall Full',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    angle: 40,
  },
  { name: 'Boardsesh QA Tension 2 Mirror', boardType: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 40 },
  {
    name: 'Boardsesh QA MoonBoard 2024',
    boardType: 'moonboard',
    layoutId: 3,
    sizeId: 1,
    setIds: '5,6,7,8,9,10',
    angle: 40,
  },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GYM_FIELDS = 'uuid slug ownerId name description isPublic isListed latitude longitude';
const BOARD_FIELDS =
  'uuid name description ownerId gymUuid boardType layoutId sizeId setIds angle serialNumber isPublic isUnlisted';
const DEFAULT_HEADER = fileURLToPath(
  new URL('../projects/board-controller/src/gym/provisioned_defaults.h', import.meta.url),
);
const REQUIRED_SCHEMA = {
  Gym: ['isListed'],
  CreateGymInput: ['isPublic', 'isListed'],
  UpdateGymInput: ['slug', 'isPublic', 'isListed'],
  Query: ['controllerGymManifest', 'observedBoardSerialMatches'],
  Mutation: ['createGym', 'updateGym', 'createBoard', 'linkBoardToGym', 'registerController'],
  ControllerGymManifest: ['version', 'gymUuid', 'name', 'slug', 'boards'],
  ControllerGymBoard: ['serialNumber', 'advertisedName', 'preview'],
};

class ProvisionError extends Error {
  constructor(message, codes = []) {
    super(message);
    this.codes = codes;
  }
}

function endpointUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProvisionError('Invalid GraphQL endpoint');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new ProvisionError('GraphQL endpoint must be HTTPS without credentials, query, or fragment');
  return url;
}

export function graphqlClient(endpoint, token, fetchImpl = fetch) {
  endpointUrl(endpoint);
  if (!token || /\s/.test(token)) throw new ProvisionError('A normal signed-in user token is required');
  return async (operationName, query, variables = {}) => {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ operationName, query, variables }),
      });
    } catch {
      throw new ProvisionError(`${operationName}: request failed`);
    }
    if (!response.ok) throw new ProvisionError(`${operationName}: HTTP ${response.status}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ProvisionError(`${operationName}: invalid JSON response`);
    }
    if (payload.errors?.length) {
      // Server messages may echo input or secrets. Only retain machine codes.
      throw new ProvisionError(
        `${operationName}: GraphQL request rejected`,
        payload.errors.map((error) => error.extensions?.code),
      );
    }
    if (!payload.data) throw new ProvisionError(`${operationName}: missing response`);
    return payload.data;
  };
}

export async function checkSchema(request) {
  const selections = Object.keys(REQUIRED_SCHEMA).map(
    (name) => `${name}: __type(name: "${name}") { fields { name } inputFields { name } }`,
  );
  const schema = await request('ProvisionSchema', `query ProvisionSchema { ${selections.join('\n')} }`);
  for (const [typeName, fields] of Object.entries(REQUIRED_SCHEMA)) {
    const available = new Set(
      [...(schema[typeName]?.fields ?? []), ...(schema[typeName]?.inputFields ?? [])].map((field) => field.name),
    );
    if (fields.some((field) => !available.has(field)))
      throw new ProvisionError(
        'Backend schema is not ready: deploy the unlisted gym and controller manifest changes first',
      );
  }
}

export async function checkCatalog(endpoint, fetchImpl = fetch) {
  for (const board of FIXTURE_BOARDS) {
    const url = new URL('/render/controller-preview', endpoint);
    url.search = new URLSearchParams({
      board_name: board.boardType,
      layout_id: String(board.layoutId),
      size_id: String(board.sizeId),
      set_ids: board.setIds,
      kind: 'geometry',
    }).toString();
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new ProvisionError('Catalog preview preflight failed');
    }
    if (!response.ok) throw new ProvisionError('Catalog preview is unavailable; no fixture records were created');
    const geometry = Buffer.from(await response.arrayBuffer());
    if (
      geometry.length < 12 ||
      geometry.toString('ascii', 0, 4) !== 'BSGM' ||
      geometry.readUInt16LE(4) !== 1 ||
      geometry.readUInt16LE(6) < 1 ||
      geometry.readUInt16LE(6) > 1024 ||
      geometry.readUInt16LE(8) < 1 ||
      geometry.readUInt16LE(8) > 330 ||
      geometry.readUInt16LE(10) < 1 ||
      geometry.readUInt16LE(10) > 330 ||
      geometry.length !== 12 + geometry.readUInt16LE(6) * 8
    )
      throw new ProvisionError('Catalog preview does not match the controller geometry contract');
  }
}

async function allPages(request, field, selection) {
  const rows = [];
  for (let offset = 0; offset < 10_000; offset += 50) {
    const result = await request(
      'ProvisionInventory',
      `query ProvisionInventory($input: ${field === 'myGyms' ? 'MyGymsInput' : 'MyBoardsInput'}) { ${field}(input: $input) { ${selection} hasMore } }`,
      { input: { limit: 50, offset } },
    );
    const page = result[field];
    const entries = page?.[field === 'myGyms' ? 'gyms' : 'boards'];
    if (!Array.isArray(entries)) throw new ProvisionError('Invalid owned fixture inventory');
    rows.push(...entries);
    if (!page.hasMore) return rows;
    if (entries.length === 0) throw new ProvisionError('Fixture inventory pagination made no progress');
  }
  throw new ProvisionError('Fixture inventory exceeds the bounded provisioning scan');
}

function sameConfig(board, expected) {
  const sets = (ids) =>
    String(ids)
      .split(',')
      .map(Number)
      .sort((left, right) => left - right)
      .join(',');
  return (
    board.boardType === expected.boardType &&
    board.layoutId === expected.layoutId &&
    board.sizeId === expected.sizeId &&
    sets(board.setIds) === sets(expected.setIds) &&
    board.angle === expected.angle
  );
}

export function defaultsHeader(gymUuid) {
  if (!UUID.test(gymUuid)) throw new ProvisionError('Cannot generate defaults without a real gym UUID');
  return `// Generated by provision-qa-gym.mjs. Contains no credentials.\n#pragma once\n#ifndef GYM_FIXTURE_DEFAULT_GYM\n#define GYM_FIXTURE_DEFAULT_GYM "${gymUuid}"\n#endif\n`;
}

async function readPrivateState(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ProvisionError('Cannot read the controller credential file');
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw new ProvisionError('Controller credential file must be a regular owner-only file (mode 600)');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new ProvisionError('Controller credential file contains invalid JSON');
  }
}

async function savePrivateState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function checkDefaultsDestination(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || !(await readFile(path, 'utf8')).startsWith('// Generated by provision-qa-gym.mjs.'))
      throw new ProvisionError('Refusing to overwrite a defaults header that was not generated by this script');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function allocateSerials(request, existing) {
  const lookup = async (serials) => {
    const input = serials.flatMap((observedSerialNumber) =>
      FIXTURE_BOARDS.map(({ boardType }) => ({ boardType, observedSerialNumber })),
    );
    const result = await request(
      'ProvisionSerials',
      `query ProvisionSerials($input: [ObservedBoardSerialInput!]!) { observedBoardSerialMatches(input: $input) { boardType observedSerialNumber candidates { uuid boardType layoutId sizeId } } }`,
      { input },
    );
    return serials.map((serial) => {
      const matches = result.observedBoardSerialMatches?.filter((match) => match.observedSerialNumber === serial);
      if (
        matches?.length !== 3 ||
        new Set(matches.map((match) => match.boardType)).size !== 3 ||
        matches.some((match) => !Array.isArray(match.candidates))
      )
        throw new ProvisionError('Incomplete serial collision lookup; refusing to guess');
      return matches.flatMap((match) => match.candidates);
    });
  };
  const present = existing.filter(Boolean);
  if (present.length) {
    const matches = await lookup(present.map((board) => board.serialNumber));
    if (present.some((board, index) => matches[index].length !== 1 || matches[index][0].uuid !== board.uuid))
      throw new ProvisionError(
        'An existing fixture serial is missing or shared with another board; refusing to change it',
      );
  }
  const occupied = new Set(existing.filter(Boolean).map((board) => board.serialNumber));
  const free = new Set();
  const required = existing.filter((board) => !board).length;
  if (required === 0) return existing.map((board) => board.serialNumber);
  for (let start = 1; start <= 99 && free.size < required + 3; start += 6) {
    const serials = Array.from({ length: Math.min(6, 100 - start) }, (_, index) => String(99000000 + start + index));
    const matches = await lookup(serials);
    serials.forEach((serial, index) => {
      if (matches[index].length > 0) occupied.add(serial);
      else free.add(serial);
    });
  }
  const chosen = existing.map((board, index) => {
    if (board) return board.serialNumber;
    const preferred = String(99000001 + index);
    if (free.has(preferred) && !occupied.has(preferred)) {
      occupied.add(preferred);
      return preferred;
    }
    return null;
  });
  return chosen.map((serial) => {
    if (serial) return serial;
    const available = [...free].find((candidate) => !occupied.has(candidate));
    if (!available) throw new ProvisionError('No unused serial remains in the 990000xx fixture range');
    occupied.add(available);
    return available;
  });
}

export async function provisionQaGym({
  token,
  endpoint = 'https://ws.boardsesh.com/graphql',
  apply = false,
  out = '/private/tmp/boardsesh-qa-controller.json',
  resultFile = '/private/tmp/boardsesh-qa-gym.json',
  gymUuid,
  newController = false,
  writeDefaults = false,
  defaultsPath = DEFAULT_HEADER,
  fetchImpl = fetch,
}) {
  endpoint = endpointUrl(endpoint).toString();
  if (gymUuid && !UUID.test(gymUuid)) throw new ProvisionError('Gym UUID is invalid');
  out = resolve(out);
  resultFile = resolve(resultFile);
  if (new Set([out, resultFile, resolve(defaultsPath)]).size !== 3)
    throw new ProvisionError('Output paths must be different');
  const request = graphqlClient(endpoint, token, fetchImpl);
  await checkSchema(request); // Must precede every possible production mutation.
  if (writeDefaults) await checkDefaultsDestination(defaultsPath);
  const { profile } = await request('ProvisionIdentity', 'query ProvisionIdentity { profile { id } }');
  if (!profile?.id) throw new ProvisionError('Sign in with a normal production account before provisioning');
  const saved = await readPrivateState(out);
  if (
    saved &&
    (saved.version !== 1 ||
      saved.ownerId !== profile.id ||
      saved.endpoint !== endpoint ||
      (saved.gymUuid && !UUID.test(saved.gymUuid)) ||
      (saved.controllerId && (!UUID.test(saved.controllerId) || !saved.gymUuid)) ||
      (saved.apiKey && (!/^[a-f0-9]{64}$/i.test(saved.apiKey) || !saved.controllerId)))
  )
    throw new ProvisionError('Credential file belongs to another account, endpoint, or invalid fixture');
  if (gymUuid && saved?.gymUuid && gymUuid !== saved.gymUuid)
    throw new ProvisionError('Gym UUID differs from the saved fixture');
  gymUuid ??= saved?.gymUuid;
  const ownedGyms = (await allPages(request, 'myGyms', `gyms { ${GYM_FIELDS} }`)).filter(
    (gym) => gym.ownerId === profile.id,
  );
  const { gymBySlug } = await request(
    'ProvisionSlug',
    `query ProvisionSlug { gymBySlug(slug: "${GYM_SLUG}") { ${GYM_FIELDS} } }`,
  );
  const matches = ownedGyms.filter((gym) => (gymUuid ? gym.uuid === gymUuid : gym.name === GYM_NAME));
  if (matches.length > 1)
    throw new ProvisionError('Multiple owned QA gyms exist; select one explicitly with --gym-uuid');
  let gym = matches[0] ?? null;
  if (gymUuid && !gym) throw new ProvisionError('The selected gym is not owned by this signed-in account');
  if (gym && (gym.name !== GYM_NAME || (!gym.description?.includes(FIXTURE_MARKER) && gymUuid !== gym.uuid)))
    throw new ProvisionError('Existing gym is not an identified QA fixture; refusing to modify it');
  if (gymBySlug && (gymBySlug.ownerId !== profile.id || gymBySlug.uuid !== gym?.uuid))
    throw new ProvisionError('The boardsesh-qa slug belongs to another gym; refusing to modify it');
  const ownedBoards = (await allPages(request, 'myBoards', `boards { ${BOARD_FIELDS} }`)).filter(
    (board) => board.ownerId === profile.id,
  );
  const linked = gym
    ? (
        await request(
          'ProvisionLinkedBoards',
          `query ProvisionLinkedBoards($gymUuid: ID!) { gymBoards(gymUuid: $gymUuid) { ${BOARD_FIELDS} } }`,
          { gymUuid: gym.uuid },
        )
      ).gymBoards
    : [];
  const existing = FIXTURE_BOARDS.map((expected) => {
    const candidates = ownedBoards.filter((board) => board.name === expected.name);
    if (candidates.length > 1)
      throw new ProvisionError('Duplicate named QA boards exist; resolve them before provisioning');
    const board = candidates[0];
    if (
      board &&
      (!sameConfig(board, expected) ||
        !board.description?.includes(FIXTURE_MARKER) ||
        !/^990000\d{2}$/.test(board.serialNumber ?? '') ||
        board.serialNumber === '99000000' ||
        (board.gymUuid && board.gymUuid !== gym?.uuid) ||
        !board.isPublic ||
        board.isUnlisted)
    )
      throw new ProvisionError('An existing board differs from the QA fixture; refusing to overwrite or move it');
    return board ?? null;
  });
  if (linked.some((board) => !existing.some((candidate) => candidate?.uuid === board.uuid)))
    throw new ProvisionError('The gym contains unrelated boards; refusing to change its configuration');
  if (new Set(existing.filter(Boolean).map((board) => board.serialNumber)).size !== existing.filter(Boolean).length)
    throw new ProvisionError('Existing fixture boards share a serial; manual repair is required');
  const { myControllers } = await request(
    'ProvisionControllers',
    'query ProvisionControllers { myControllers { id name } }',
  );
  const controllerName = gym ? `Boardsesh QA fixture (${gym.uuid})` : null;
  const registered = saved?.controllerId
    ? myControllers.find((controller) => controller.id === saved.controllerId)
    : null;
  if (
    !newController &&
    ((saved?.controllerId && (!registered || !saved.apiKey || registered.name !== controllerName)) ||
      (!saved?.apiKey && controllerName && myControllers.some((controller) => controller.name === controllerName)))
  )
    throw new ProvisionError(
      'Existing controller key is unavailable or revoked; use --new-controller explicitly to register another',
    );
  await checkCatalog(endpoint, fetchImpl);
  const serials = await allocateSerials(request, existing);
  const plan = {
    mode: apply ? 'apply' : 'dry-run',
    endpoint,
    gym: { uuid: gym?.uuid ?? null, name: GYM_NAME, slug: GYM_SLUG, isPublic: true, isListed: false },
    boards: FIXTURE_BOARDS.map((board, index) => ({
      ...board,
      uuid: existing[index]?.uuid ?? null,
      serialNumber: serials[index],
    })),
    controller: { action: registered && !newController ? 'reuse' : 'register', id: registered?.id ?? null },
  };
  if (!apply) return plan;
  const lock = await open(`${out}.lock`, 'wx', 0o600).catch(() => {
    throw new ProvisionError('Provisioning lock exists or credential directory is unavailable');
  });
  try {
    if (JSON.stringify(await readPrivateState(out)) !== JSON.stringify(saved))
      throw new ProvisionError('Fixture credentials changed during planning; rerun the dry run');
    let state = {
      version: 1,
      endpoint,
      ownerId: profile.id,
      ...saved,
      controllerEndpoint: endpoint.replace(/^https:/, 'wss:'),
    };
    await savePrivateState(out, state); // Verify private output storage before the first mutation.
    if (!gym) {
      gym = (
        await request(
          'ProvisionCreateGym',
          `mutation ProvisionCreateGym($input: CreateGymInput!) { createGym(input: $input) { ${GYM_FIELDS} } }`,
          { input: { name: GYM_NAME, description: DESCRIPTION, isPublic: true, isListed: false } },
        )
      ).createGym;
      if (!UUID.test(gym?.uuid)) throw new ProvisionError('Created gym did not return a valid UUID');
    }
    state.gymUuid = gym.uuid;
    await savePrivateState(out, state);
    if (gym.slug !== GYM_SLUG || !gym.isPublic || gym.isListed || gym.description !== DESCRIPTION) {
      gym = (
        await request(
          'ProvisionUpdateGym',
          `mutation ProvisionUpdateGym($input: UpdateGymInput!) { updateGym(input: $input) { ${GYM_FIELDS} } }`,
          { input: { gymUuid: gym.uuid, slug: GYM_SLUG, description: DESCRIPTION, isPublic: true, isListed: false } },
        )
      ).updateGym;
    }
    for (let index = 0; index < FIXTURE_BOARDS.length; index++) {
      if (!existing[index]) {
        existing[index] = (
          await request(
            'ProvisionCreateBoard',
            `mutation ProvisionCreateBoard($input: CreateBoardInput!) { createBoard(input: $input) { ${BOARD_FIELDS} } }`,
            {
              input: {
                ...FIXTURE_BOARDS[index],
                description: DESCRIPTION,
                gymUuid: gym.uuid,
                serialNumber: serials[index],
                isPublic: true,
                isUnlisted: false,
                hideLocation: true,
                isOwned: true,
                hasLeds: true,
                isAngleAdjustable: false,
                allowDuplicateConfig: true,
                allowDuplicateSerial: false,
              },
            },
          )
        ).createBoard;
      } else if (!existing[index].gymUuid) {
        await request(
          'ProvisionLinkBoard',
          'mutation ProvisionLinkBoard($input: LinkBoardToGymInput!) { linkBoardToGym(input: $input) }',
          { input: { gymUuid: gym.uuid, boardUuid: existing[index].uuid } },
        );
      }
    }
    if (!registered || newController) {
      const { boardType, layoutId, sizeId, setIds } = FIXTURE_BOARDS[0];
      const registration = (
        await request(
          'ProvisionRegisterController',
          'mutation ProvisionRegisterController($input: RegisterControllerInput!) { registerController(input: $input) { controllerId apiKey } }',
          { input: { name: `Boardsesh QA fixture (${gym.uuid})`, boardName: boardType, layoutId, sizeId, setIds } },
        )
      ).registerController;
      if (!UUID.test(registration?.controllerId) || !/^[a-f0-9]{64}$/i.test(registration?.apiKey))
        throw new ProvisionError(
          'Controller registration returned invalid credentials; inspect My Controllers before retrying',
        );
      state = { ...state, ...registration };
      await savePrivateState(out, state);
    }
    const result = {
      ...plan,
      gym: { ...plan.gym, uuid: gym.uuid },
      boards: plan.boards.map((board, index) => ({ ...board, uuid: existing[index].uuid })),
      controller: { id: state.controllerId },
      controllerEndpoint: endpoint.replace(/^https:/, 'wss:'),
    };
    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    if (writeDefaults) await writeFile(defaultsPath, defaultsHeader(gym.uuid));
    return result;
  } finally {
    await lock.close();
    await unlink(`${out}.lock`).catch(() => {});
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        apply: { type: 'boolean' },
        'token-file': { type: 'string' },
        endpoint: { type: 'string' },
        out: { type: 'string' },
        'result-file': { type: 'string' },
        'gym-uuid': { type: 'string' },
        'new-controller': { type: 'boolean' },
        'write-defaults': { type: 'boolean' },
        'defaults-header': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch {
    throw new ProvisionError('Invalid arguments; use --help');
  }
  if (values.help) {
    console.log(
      'Usage: vp exec node embedded/scripts/provision-qa-gym.mjs [--apply] [--token-file PATH] [--endpoint HTTPS_URL] [--out PRIVATE_JSON] [--result-file JSON] [--gym-uuid UUID] [--new-controller] [--write-defaults] [--defaults-header PATH]\nToken: --token-file or BOARDSESH_USER_TOKEN. Default is a read-only dry run.',
    );
    return;
  }
  let token = process.env.BOARDSESH_USER_TOKEN?.trim();
  if (values['token-file']) {
    if (
      [
        values.out ?? '/private/tmp/boardsesh-qa-controller.json',
        values['result-file'] ?? '/private/tmp/boardsesh-qa-gym.json',
        values['defaults-header'] ?? DEFAULT_HEADER,
      ].some((path) => resolve(path) === resolve(values['token-file']))
    )
      throw new ProvisionError('The user token file cannot also be an output file');
    try {
      token = (await readFile(values['token-file'], 'utf8')).trim();
    } catch {
      throw new ProvisionError('Cannot read the user token file');
    }
  }
  const result = await provisionQaGym({
    token,
    endpoint: values.endpoint,
    apply: values.apply,
    out: values.out,
    resultFile: values['result-file'],
    gymUuid: values['gym-uuid'],
    newController: values['new-controller'],
    writeDefaults: values['write-defaults'],
    defaultsPath: values['defaults-header'],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof ProvisionError
        ? error.message
        : 'Provisioning failed; no secret values were logged. Inspect fixture records before retrying.',
    );
    process.exitCode = 1;
  });
}
