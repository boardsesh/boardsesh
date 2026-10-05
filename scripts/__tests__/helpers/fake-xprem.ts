/// <reference types="node" />

import { createXpremAdminClient } from '../../lib/xprem-admin.mts';
import type { XpremAdminClient } from '../../lib/xprem-admin.mts';

export const FAKE_BASE_URL = 'https://updates.example';
export const FAKE_APP_ID = 'app-1';
export const FAKE_APP = `/api/apps/${FAKE_APP_ID}`;

export interface RecordedRequest {
  method: string;
  /** Path and query, without the origin. */
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A canned answer: a JSON body (status 200), or an explicit status with an optional body. */
export type FakeAnswer = { status: number; body?: unknown } | unknown[] | Record<string, unknown>;

export type FakeRoute = FakeAnswer | ((request: RecordedRequest) => FakeAnswer);

function isStatusAnswer(answer: FakeAnswer): answer is { status: number; body?: unknown } {
  return !Array.isArray(answer) && typeof (answer as { status?: unknown }).status === 'number';
}

/**
 * A fetch that serves `routes`, keyed `"METHOD /path?query"`, and records every
 * request. An unrouted request fails the test loudly: with an undocumented API,
 * a request nobody expected is the bug.
 */
export function fakeXprem(routes: Record<string, FakeRoute>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
  /** `"METHOD /path"` of every request, in order. */
  log: () => string[];
  client: XpremAdminClient;
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof init.body === 'string' && init.body.startsWith('{') ? (JSON.parse(init.body) as unknown) : init.body,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    requests.push(request);
    const route = routes[`${request.method} ${request.path}`];
    if (route === undefined) throw new Error(`Unexpected xprem request: ${request.method} ${request.path}`);
    const answer = typeof route === 'function' ? route(request) : route;
    if (isStatusAnswer(answer)) {
      // 204 must not carry a body, or Response's constructor throws.
      if (answer.status === 204) return new Response(null, { status: 204 });
      return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
    }
    return Response.json(answer);
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    log: () => requests.map((request) => `${request.method} ${request.path}`),
    client: createXpremAdminClient({ baseUrl: FAKE_BASE_URL, appId: FAKE_APP_ID, token: 'session-jwt', fetchImpl }),
  };
}
