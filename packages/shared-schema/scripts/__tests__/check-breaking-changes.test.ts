import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findBlockingSchemaChanges } from '../check-breaking-changes';

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
