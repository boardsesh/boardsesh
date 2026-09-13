import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { findBlockingSchemaChanges, main } from '../check-breaking-changes';

describe('main', () => {
  it('exits 2 without --base-ref', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([])).toBe(2);
    consoleError.mockRestore();
  });

  it('exits 2 with a clear message when the base SDL cannot be read', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['--base-ref', 'refs/heads/no-such-branch-5370'])).toBe(2);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Could not read'));
    consoleError.mockRestore();
  });

  it('exits 0 when the base SDL matches the working tree', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--base-ref', 'HEAD'])).toBe(0);
    consoleLog.mockRestore();
  });
});

const BASE_SDL = `
type Board {
  uuid: ID!
  name: String
  layoutId: Int
}

enum BoardKind {
  KILTER
  TENSION
}

type Query {
  board(uuid: ID!, angle: Int): Board
  otaPreviewChannels: [String!]!
  kinds: [BoardKind!]!
}
`;

describe('findBlockingSchemaChanges', () => {
  it('reports a removed field', () => {
    const headSdl = BASE_SDL.replace('  otaPreviewChannels: [String!]!\n', '');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl)).toEqual([
      { type: 'FIELD_REMOVED', description: 'Query.otaPreviewChannels was removed.' },
    ]);
  });

  it('reports a removed argument', () => {
    const headSdl = BASE_SDL.replace('board(uuid: ID!, angle: Int)', 'board(uuid: ID!)');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl).map((change) => change.type)).toEqual(['ARG_REMOVED']);
  });

  it('reports a removed enum value', () => {
    const headSdl = BASE_SDL.replace('  TENSION\n', '');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl).map((change) => change.type)).toEqual([
      'VALUE_REMOVED_FROM_ENUM',
    ]);
  });

  it('reports a removed type', () => {
    const headSdl = BASE_SDL.replace('  kinds: [BoardKind!]!\n', '').replace(/enum BoardKind \{[^}]*\}/, '');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl).map((change) => change.type)).toContain('TYPE_REMOVED');
  });

  it('reports a newly required argument', () => {
    const headSdl = BASE_SDL.replace('board(uuid: ID!, angle: Int)', 'board(uuid: ID!, angle: Int, layoutId: Int!)');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl).map((change) => change.type)).toEqual(['REQUIRED_ARG_ADDED']);
  });

  it('reports a newly required input field', () => {
    const baseWithInput = `${BASE_SDL}\ninput BoardFilter {\n  name: String\n}\n\ntype Mutation {\n  filter(input: BoardFilter): Int\n}\n`;
    const headSdl = baseWithInput.replace('  name: String\n}', '  name: String\n  layoutId: Int!\n}');
    expect(findBlockingSchemaChanges(baseWithInput, headSdl).map((change) => change.type)).toEqual([
      'REQUIRED_INPUT_FIELD_ADDED',
    ]);
  });

  it('reports a field whose type changed kind', () => {
    const headSdl = BASE_SDL.replace('  layoutId: Int\n', '  layoutId: String\n');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl).map((change) => change.type)).toEqual(['FIELD_CHANGED_KIND']);
  });

  it('reports an argument whose type changed kind', () => {
    const headSdl = BASE_SDL.replace('board(uuid: ID!, angle: Int)', 'board(uuid: ID!, angle: String)');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl).map((change) => change.type)).toEqual(['ARG_CHANGED_KIND']);
  });

  it('is clean when a field is only added', () => {
    const headSdl = BASE_SDL.replace('  layoutId: Int\n', '  layoutId: Int\n  sizeId: Int\n');
    expect(findBlockingSchemaChanges(BASE_SDL, headSdl)).toEqual([]);
  });

  it('builds the committed generated SDL without error and finds nothing against itself', () => {
    const sdlPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'generated', 'schema.graphql');
    const committedSdl = readFileSync(sdlPath, 'utf8');
    expect(findBlockingSchemaChanges(committedSdl, committedSdl)).toEqual([]);
  });
});
