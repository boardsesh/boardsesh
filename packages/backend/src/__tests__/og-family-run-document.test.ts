import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, parse } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';

const errors = vi.hoisted(() => ({ next: null as Error | null }));

vi.mock('../graphql/index', () => ({
  schema: makeExecutableSchema({
    typeDefs: `type Query { ping: String }`,
    resolvers: {
      Query: {
        ping: () => {
          if (errors.next) throw errors.next;
          return 'pong';
        },
      },
    },
  }),
}));

import { PlaylistAccessDeniedError } from '../graphql/resolvers/playlists/helpers/enrichment';
import { InputValidationError } from '../validation/schemas/primitives';
import {
  OG_FAMILY_NOT_FOUND_CODES,
  OgFamilyNotFoundError,
  createAnonymousOgContext,
  runOgDocument,
} from '../services/og-family/run-document';

const DOCUMENT = parse(`query { ping }`);

describe('createAnonymousOgContext', () => {
  it('is anonymous and carries no client IP', () => {
    const context = createAnonymousOgContext();

    expect(context.userId).toBeUndefined();
    expect(context.isAuthenticated).toBe(false);
    expect(context.transport).toBe('http');
    expect(context.clientIp).toBeUndefined();
  });

  it('mints a fresh connection id every time, or every card would share one rate-limit bucket', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createAnonymousOgContext().connectionId));

    expect(ids.size).toBe(1000);
  });
});

describe('runOgDocument', () => {
  beforeEach(() => {
    errors.next = null;
  });

  it('returns the data', async () => {
    await expect(runOgDocument(DOCUMENT, {}, createAnonymousOgContext())).resolves.toEqual({ ping: 'pong' });
  });

  it.each([...OG_FAMILY_NOT_FOUND_CODES])('maps %s to the 404 error', async (code) => {
    errors.next = new GraphQLError('refused', { extensions: { code } });

    await expect(runOgDocument(DOCUMENT, {}, createAnonymousOgContext())).rejects.toBeInstanceOf(OgFamilyNotFoundError);
  });

  it('maps a playlist that went private between the gate and the climbs read to the 404', async () => {
    errors.next = new PlaylistAccessDeniedError();

    await expect(runOgDocument(DOCUMENT, {}, createAnonymousOgContext())).rejects.toBeInstanceOf(OgFamilyNotFoundError);
  });

  it('maps a validateInput refusal to the 404', async () => {
    errors.next = new InputValidationError('Invalid sessionId: nope');

    await expect(runOgDocument(DOCUMENT, {}, createAnonymousOgContext())).rejects.toBeInstanceOf(OgFamilyNotFoundError);
  });

  it('never turns a database failure into a 404, even with a look-alike message', async () => {
    errors.next = new Error('Playlist not found or access denied');

    await expect(runOgDocument(DOCUMENT, {}, createAnonymousOgContext())).rejects.not.toBeInstanceOf(
      OgFamilyNotFoundError,
    );
  });

  it('lets any other error through as a real failure', async () => {
    errors.next = new GraphQLError('boom', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });

    await expect(runOgDocument(DOCUMENT, {}, createAnonymousOgContext())).rejects.not.toBeInstanceOf(
      OgFamilyNotFoundError,
    );
  });

  it('treats an error with no code as a real failure', async () => {
    errors.next = new Error('plain');

    await expect(runOgDocument(DOCUMENT, {}, createAnonymousOgContext())).rejects.not.toBeInstanceOf(
      OgFamilyNotFoundError,
    );
  });
});
