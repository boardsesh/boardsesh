import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchema, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typeDefs } from '../../packages/shared-schema/src/schema';
import {
  Backend,
  decodePacket,
  parseSnapshot,
  QA_QUERIES,
  QA_SUBSCRIPTION,
  requireReadOnlyQuery,
  requireStaticFrames,
} from './backend';
import { EXAMPLE_CONFIG, type Board, type QaConfig } from './config';
import { Evidence } from './evidence';

const socketState = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
}));
vi.mock('ws', () => ({
  default: class {
    constructor() {
      queueMicrotask(() => socketState.listeners.get('open')?.forEach((listener) => listener()));
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = socketState.listeners.get(event) ?? [];
      listeners.push(listener);
      socketState.listeners.set(event, listeners);
    }
    send(encoded: string) {
      const message = JSON.parse(encoded) as Record<string, unknown>;
      socketState.sent.push(message);
      if (message.type === 'connection_init')
        queueMicrotask(() =>
          socketState.listeners
            .get('message')
            ?.forEach((listener) => listener(Buffer.from('{"type":"connection_ack"}'))),
        );
    }
    removeAllListeners() {
      socketState.listeners.clear();
    }
    close() {}
  },
}));

const directories: string[] = [];
function evidence(): Evidence {
  const directory = mkdtempSync(join(tmpdir(), 'board-qa-backend-'));
  directories.push(directory);
  return new Evidence(directory);
}
afterEach(() => {
  vi.unstubAllGlobals();
  socketState.sent.length = 0;
  socketState.listeners.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const board = {
  ...EXAMPLE_CONFIG.boards[0],
  uuid: 'board-uuid',
  boardId: 1,
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  angle: 40,
  catalog: [],
} satisfies Board;
function wire(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}
const presence = {
  climbUuid: 'climb-uuid',
  angle: 40,
  mirrored: false,
  sentByUserId: 'user-id',
  seq: 12,
  sentAt: '2026-10-31T00:00:00Z',
};
const wall = { holder: { userId: 'user-id' }, recent: [presence], durable: { entries: [presence] } };

describe('independent physical packet evidence', () => {
  it('decodes literal Aurora v3 position and quantized RGB goldens', () => {
    // ONLY, positions 0x1234 and 7: red 3 bits=7, green=7, blue=3.
    expect(decodePacket(wire([1, 7, 95, 2, 84, 52, 18, 224, 7, 0, 31, 3]), false)).toEqual([
      { position: 4660, r: 252, g: 0, b: 0 },
      { position: 7, r: 0, g: 252, b: 255 },
    ]);
    expect(decodePacket(wire([1, 1, 171, 2, 84, 3]), false)).toEqual([]);
  });
  it('requires complete ordered Aurora multipart and rejects extra updates', () => {
    const first = [1, 4, 144, 2, 82, 1, 0, 28, 3];
    const last = [1, 4, 167, 2, 83, 2, 0, 3, 3];
    expect(decodePacket(wire([...first, ...last]), false)).toEqual([
      { position: 1, r: 0, g: 252, b: 0 },
      { position: 2, r: 0, g: 0, b: 255 },
    ]);
    for (const invalid of [
      [],
      first,
      last,
      [...last, ...first],
      [...first, ...first, ...last],
      [1, 1, 171, 2, 84, 3, 0],
      [1, 4, 0, 2, 84, 1, 0, 28, 3],
      [1, 1, 171, 2, 84],
    ])
      expect(() => decodePacket(wire(invalid), false)).toThrow();
  });
  it('pins MoonBoard roles and rejects unsupported config, malformed, and out-of-grid packets', () => {
    expect(decodePacket(new TextEncoder().encode('l#S0,P35,E197#'), true)).toEqual([
      { position: 0, r: 0, g: 255, b: 0 },
      { position: 35, r: 0, g: 0, b: 255 },
      { position: 197, r: 255, g: 0, b: 0 },
    ]);
    expect(decodePacket(new TextEncoder().encode('l##'), true)).toEqual([]);
    for (const invalid of ['~Dl#S1#', 'l#F1#', 'l#S198#', 'l#S1,#', 'l#S1#l#P2#', 'l#S99999999999999999999#'])
      expect(() => decodePacket(new TextEncoder().encode(invalid), true)).toThrow();
  });
  it('rejects multi-frame and permissively parseable partial climb strings', () => {
    expect(() => requireStaticFrames('p1r42p35r43p198r44', 1)).not.toThrow();
    for (const frames of ['p1r42,p2r43', 'p1r42 junk', 'p1r42p2r43p', 'p-1r42', ''])
      expect(() => requireStaticFrames(frames, 1)).toThrow();
    expect(() => requireStaticFrames('p1r42', 2)).toThrow();
  });
});

describe('production observer contracts without network access', () => {
  it('fetches pinned UUIDs directly and never selects a namesake from search', async () => {
    const fixtures = [
      { name: 'Same name', uuid: 'first' },
      { name: 'Second', uuid: 'second' },
      { name: 'Third', uuid: 'third' },
    ];
    const config: QaConfig = { ...EXAMPLE_CONFIG, boards: [{ ...EXAMPLE_CONFIG.boards[2], climbs: fixtures }] };
    const backend = new Backend(config, evidence());
    const query = vi.spyOn(backend, 'query').mockImplementation(async (document, variables) => {
      if (document === QA_QUERIES.board)
        return {
          boardBySlug: {
            uuid: 'moon-wall',
            boardId: 3,
            boardType: 'moonboard',
            gymUuid: 'ef8b823e-8d2e-4840-8218-761369f9c059',
            layoutId: 3,
            sizeId: 1,
            setIds: '5,6,7,8,9,10',
            angle: 40,
          },
        };
      if (document !== QA_QUERIES.climb) throw new Error('Pinned catalog must not search by name');
      const index = fixtures.findIndex((fixture) => fixture.uuid === variables?.climbUuid);
      return { climb: { ...fixtures[index], frames: `p${index + 1}r42`, framesCount: 1 } };
    });
    const catalog = await backend.catalog();
    expect(catalog[0].catalog.map((climb) => climb.uuid)).toEqual(['first', 'second', 'third']);
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('refuses ambiguous name-only candidates and wrong-UUID responses', async () => {
    const named: QaConfig = { ...EXAMPLE_CONFIG, boards: [{ ...EXAMPLE_CONFIG.boards[2], climbs: ['Same name'] }] };
    const backend = new Backend(named, evidence());
    const query = vi.spyOn(backend, 'query').mockImplementation(async (document) =>
      document === QA_QUERIES.board
        ? {
            boardBySlug: {
              uuid: 'moon-wall',
              boardId: 3,
              boardType: 'moonboard',
              gymUuid: 'ef8b823e-8d2e-4840-8218-761369f9c059',
              layoutId: 3,
              sizeId: 1,
              setIds: '5,6,7,8,9,10',
              angle: 40,
            },
          }
        : {
            searchClimbs: {
              climbs: [
                { uuid: 'a', name: 'Same name', frames: 'p1r42', framesCount: 1 },
                { uuid: 'b', name: 'same NAME', frames: 'p2r42', framesCount: 1 },
              ],
            },
          },
    );
    await expect(backend.catalog()).rejects.toThrow('Ambiguous');
    named.boards[0].climbs = [{ name: 'Same name', uuid: 'wanted' }];
    query
      .mockResolvedValueOnce({
        boardBySlug: {
          uuid: 'moon-wall',
          boardId: 3,
          boardType: 'moonboard',
          gymUuid: 'ef8b823e-8d2e-4840-8218-761369f9c059',
          layoutId: 3,
          sizeId: 1,
          setIds: '5,6,7,8,9,10',
          angle: 40,
        },
      })
      .mockResolvedValueOnce({ climb: { uuid: 'wrong', name: 'Same name', frames: 'p1r42', framesCount: 1 } });
    await expect(backend.catalog()).rejects.toThrow('missing');
  });

  it('validates every observer document against the repository schema', () => {
    const schema = buildSchema(typeDefs.join('\n'));
    for (const query of [...Object.values(QA_QUERIES), QA_SUBSCRIPTION])
      expect(validate(schema, parse(query))).toEqual([]);
  });
  it('rejects mutations even when hidden after a leading query', () => {
    for (const query of [
      'mutation { endSession(sessionId: "x") }',
      'query Good { profile { id } } mutation Bad { endSession(sessionId: "x") }',
      'query A { profile { id } } query B { profile { id } }',
    ])
      expect(() => requireReadOnlyQuery(query)).toThrow();
    expect(() => requireReadOnlyQuery('# read only\n query { profile { id } }')).not.toThrow();
  });
  it('rejects invalid presence shapes and preserves anonymous/null states', () => {
    expect(parseSnapshot(wall)).toEqual({ holder: wall.holder, recent: [presence], history: [presence] });
    expect(
      parseSnapshot({
        holder: { userId: null },
        recent: [{ ...presence, angle: null, mirrored: null, sentByUserId: null }],
        durable: { entries: [] },
      }).holder,
    ).toEqual({ userId: null });
    for (const seq of [NaN, -1, 0, 1.5, '12'])
      expect(() => parseSnapshot({ ...wall, recent: [{ ...presence, seq }] })).toThrow();
    expect(() => parseSnapshot({ ...wall, recent: null })).toThrow();
    expect(() => parseSnapshot({ ...wall, durable: {} })).toThrow();
  });
  it('authenticates the observer using the backend authToken contract and redacts secrets', async () => {
    const report = evidence();
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string, options: RequestInit) => {
        if (typeof options.body !== 'string') throw new Error('Expected JSON body');
        const body = JSON.parse(options.body) as Record<string, unknown>;
        requests.push({
          url: String(url),
          body,
          authorization: (options.headers as Record<string, string>).Authorization,
        });
        return new Response(
          JSON.stringify(
            String(url).endsWith('/auth/native/credentials')
              ? { jwt: 'private-test-token' }
              : { data: { profile: { id: 'user-id' } } },
          ),
          { status: 200 },
        );
      }),
    );
    const backend = new Backend(EXAMPLE_CONFIG, report);
    await backend.signIn(EXAMPLE_CONFIG.phones.ios.email, 'private-test-password');
    await backend.observe([board]);
    expect(requests[0]).toMatchObject({
      url: 'https://ws.boardsesh.com/auth/native/credentials',
      body: { email: EXAMPLE_CONFIG.phones.ios.email, password: 'private-test-password' },
    });
    expect(requests[1].authorization).toBe('Bearer private-test-token');
    expect(socketState.sent[0]).toMatchObject({
      type: 'connection_init',
      payload: { authToken: 'private-test-token' },
    });
    expect(socketState.sent[1]).toMatchObject({
      id: board.uuid,
      type: 'subscribe',
      payload: { query: QA_SUBSCRIPTION, variables: { boardId: board.boardId, boardUuid: board.uuid } },
    });
    report.event('secret-redaction-check', { token: 'private-test-token', password: 'private-test-password' });
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).not.toContain('private-test-token');
    expect(saved).not.toContain('private-test-password');
    backend.close();
  });
});
