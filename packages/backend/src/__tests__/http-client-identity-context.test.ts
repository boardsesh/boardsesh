import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_IDENTITY_HEADER } from '@boardsesh/shared-schema';

import { buildHttpConnectionContext, createYogaInstance } from '../graphql/yoga';
import { getClientUsageSnapshotForTests, stopClientUsageReporter } from '../services/client-usage';

/**
 * The HTTP half of client identification: the `x-boardsesh-client` header is
 * parsed onto the connection context and every executed operation is counted
 * against it. Identification only, so a missing or garbage header must still
 * produce a working anonymous context.
 */

function fetchRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/graphql', { method: 'POST', headers });
}

describe('buildHttpConnectionContext client identity', () => {
  it('parses a well-formed header onto the context', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest({ [CLIENT_IDENTITY_HEADER]: 'boardsesh-mobile/2.6.0 (ios; build 45)' }),
    });

    expect(context.clientIdentity).toEqual({
      name: 'boardsesh-mobile',
      version: '2.6.0',
      platform: 'ios',
      build: '45',
    });
    expect(context.clientIdentityRaw).toBe('boardsesh-mobile/2.6.0 (ios; build 45)');
    expect(context.transport).toBe('http');
  });

  it('leaves both fields undefined when the header is absent', async () => {
    const context = await buildHttpConnectionContext({ request: fetchRequest() });

    expect(context.clientIdentity).toBeUndefined();
    expect(context.clientIdentityRaw).toBeUndefined();
    expect(context.isAuthenticated).toBe(false);
  });

  it('keeps the raw value for logs but no parsed identity when the header is garbage', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest({ [CLIENT_IDENTITY_HEADER]: '  not a client identity  ' }),
    });

    expect(context.clientIdentity).toBeUndefined();
    expect(context.clientIdentityRaw).toBe('not a client identity');
  });

  it('caps an oversized raw header so it cannot bloat log lines', async () => {
    const oversized = `boardsesh-web/${'9'.repeat(5_000)}`;
    const context = await buildHttpConnectionContext({
      request: fetchRequest({ [CLIENT_IDENTITY_HEADER]: oversized }),
    });

    expect(context.clientIdentity).toBeUndefined();
    expect(context.clientIdentityRaw).toHaveLength(200);
  });
});

describe('Yoga client usage counting', () => {
  const yoga = createYogaInstance();

  beforeEach(() => {
    stopClientUsageReporter();
  });

  afterEach(() => {
    stopClientUsageReporter();
  });

  async function query(headers: Record<string, string>): Promise<void> {
    const response = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { __typename: 'Query' } });
  }

  it('counts each executed operation against the client named in the header', async () => {
    await query({ [CLIENT_IDENTITY_HEADER]: 'boardsesh-web/1.4.2' });
    await query({ [CLIENT_IDENTITY_HEADER]: 'boardsesh-web/1.4.2' });

    expect(getClientUsageSnapshotForTests()).toEqual([
      { clientName: 'boardsesh-web', clientVersion: '1.4.2', transport: 'http', operations: 2 },
    ]);
  });

  it('counts a request with no or an unparseable header in the unknown bucket', async () => {
    await query({});
    await query({ [CLIENT_IDENTITY_HEADER]: '???' });

    expect(getClientUsageSnapshotForTests()).toEqual([
      { clientName: 'unknown', clientVersion: 'unknown', transport: 'http', operations: 2 },
    ]);
  });
});
