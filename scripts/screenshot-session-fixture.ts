/**
 * Screenshot party-session fixture CLI.
 *
 * Stands up (and tears down) a fresh ACTIVE multi-participant "party" session on the
 * backend so the App Store screenshot run can deep-link into it and capture the live
 * in-session view (store slot 03). It authenticates as the curated test user, then
 * calls the backend's `createScreenshotSession` / `endScreenshotSession` mutations —
 * which are inert unless the backend has `SCREENSHOT_FIXTURE_USER_ID` set to that
 * user, so a normal prod backend rejects them.
 *
 * The orchestrator (`scripts/mobile-screenshots.ts`) shells out to this synchronously
 * (it's a sync `spawnSync` script): `create` prints ONLY the session id on stdout (all
 * logs go to stderr) so the parent can capture it; `end <id>` tears the session down.
 *
 *   bunx tsx scripts/screenshot-session-fixture.ts create
 *   bunx tsx scripts/screenshot-session-fixture.ts end <sessionId>
 *
 * Env:
 *   SCREENSHOT_BACKEND_URL   backend origin (falls back to EXPO_PUBLIC_BACKEND_URL,
 *                            then the app's prod default https://ws.boardsesh.com)
 *   SCREENSHOT_USER_EMAIL    test account email (default test@boardsesh.com)
 *   SCREENSHOT_USER_PASSWORD test account password (default test)
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_BACKEND_URL = 'https://ws.boardsesh.com';
const DEFAULT_USER_EMAIL = 'test@boardsesh.com';
const DEFAULT_USER_PASSWORD = 'test';
const LOG = '[screenshot-fixture]';

type FetchLike = typeof fetch;

const CREATE_MUTATION = 'mutation CreateScreenshotSession { createScreenshotSession { sessionId boardPath } }';
const END_MUTATION = 'mutation EndScreenshotSession($sessionId: ID!) { endScreenshotSession(sessionId: $sessionId) }';

type CredentialsResponse = { jwt: string; refreshToken: string; expiresAt: string };
type GraphQLResponse<TData> = { data?: TData | null; errors?: Array<{ message: string }> };
type CreateData = { createScreenshotSession: { sessionId: string; boardPath: string } };
type EndData = { endScreenshotSession: boolean };

/** Pure: pull the JWT out of the `/auth/native/credentials` body (or throw). */
export function parseCredentialsResponse(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as CredentialsResponse).jwt === 'string') {
    return (body as CredentialsResponse).jwt;
  }
  throw new Error('auth response did not contain a jwt');
}

/** Pure: unwrap a GraphQL response, surfacing `errors` as a thrown Error. */
export function unwrapGraphQL<TData>(body: GraphQLResponse<TData>): TData {
  if (body.errors && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join('; '));
  }
  if (body.data == null) {
    throw new Error('GraphQL response had no data');
  }
  return body.data;
}

export async function authenticate(options: {
  backendUrl: string;
  email: string;
  password: string;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.backendUrl}/auth/native/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  if (!response.ok) {
    throw new Error(`auth failed: HTTP ${response.status}`);
  }
  return parseCredentialsResponse(await response.json());
}

async function graphqlRequest<TData>(options: {
  backendUrl: string;
  jwt: string;
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<TData> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.backendUrl}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.jwt}`,
    },
    body: JSON.stringify({ query: options.query, variables: options.variables ?? {} }),
  });
  if (!response.ok) {
    throw new Error(`GraphQL request failed: HTTP ${response.status}`);
  }
  return unwrapGraphQL((await response.json()) as GraphQLResponse<TData>);
}

export async function createScreenshotSession(options: {
  backendUrl: string;
  jwt: string;
  fetchImpl?: FetchLike;
}): Promise<{ sessionId: string; boardPath: string }> {
  const data = await graphqlRequest<CreateData>({ ...options, query: CREATE_MUTATION });
  return data.createScreenshotSession;
}

export async function endScreenshotSession(options: {
  backendUrl: string;
  jwt: string;
  sessionId: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  const data = await graphqlRequest<EndData>({
    ...options,
    query: END_MUTATION,
    variables: { sessionId: options.sessionId },
  });
  return data.endScreenshotSession;
}

function resolveConfig(): { backendUrl: string; email: string; password: string } {
  return {
    backendUrl: process.env.SCREENSHOT_BACKEND_URL ?? process.env.EXPO_PUBLIC_BACKEND_URL ?? DEFAULT_BACKEND_URL,
    email: process.env.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL,
    password: process.env.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  const { backendUrl, email, password } = resolveConfig();

  if (command === 'create') {
    const jwt = await authenticate({ backendUrl, email, password });
    const { sessionId } = await createScreenshotSession({ backendUrl, jwt });
    console.error(`${LOG} created session ${sessionId} on ${backendUrl}`);
    // Session id is the ONLY thing on stdout, so the orchestrator can capture it.
    process.stdout.write(sessionId);
    return 0;
  }

  if (command === 'end') {
    const sessionId = argv[1];
    if (!sessionId) {
      console.error(`${LOG} usage: end <sessionId>`);
      return 1;
    }
    const jwt = await authenticate({ backendUrl, email, password });
    await endScreenshotSession({ backendUrl, jwt, sessionId });
    console.error(`${LOG} ended session ${sessionId}`);
    return 0;
  }

  console.error(`${LOG} usage: screenshot-session-fixture.ts <create|end> [sessionId]`);
  return 1;
}

// Run as a CLI when invoked directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
