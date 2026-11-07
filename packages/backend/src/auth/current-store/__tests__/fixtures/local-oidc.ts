import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface LocalOidcIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  readonly picture?: string;
  readonly authTimeSeconds?: number;
}

export interface LocalOidcControls {
  readonly cancel?: boolean;
  readonly wrongNonce?: boolean;
  readonly rejectToken?: boolean;
}

interface AuthorizationPlan {
  readonly identity: LocalOidcIdentity;
  readonly controls: LocalOidcControls;
}

interface AuthorizationCode extends AuthorizationPlan {
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string | undefined;
  readonly expiresAt: number;
}

function constantEqual(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  return presentedBytes.length === expectedBytes.length && timingSafeEqual(presentedBytes, expectedBytes);
}

function singleParameter(parameters: URLSearchParams, name: string): string | undefined {
  const candidates = parameters.getAll(name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function json(response: ServerResponse, status: number, payload: object) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function redirect(response: ServerResponse, destination: URL) {
  response.writeHead(302, { Location: destination.toString(), 'Cache-Control': 'no-store' });
  response.end();
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => request.destroy(new Error('Fixture body deadline exceeded')), 2000);
  try {
    for await (const chunk of request as AsyncIterable<unknown>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : undefined;
      if (!buffer) throw new Error('Unsupported fixture body chunk');
      bytes += buffer.length;
      if (bytes > 8192) throw new Error('Fixture body exceeds limit');
      chunks.push(buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

/** Real loopback HTTP/OIDC only; no private NextAuth imports or real provider credentials. */
export async function startLocalOidcFixture(
  options: {
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly requireNonce?: boolean;
    readonly codeLifetimeMs?: number;
  } = {},
) {
  const clientId = options.clientId ?? `local-oidc-${randomUUID()}`;
  const clientSecret = options.clientSecret ?? randomBytes(32).toString('base64url');
  const requireNonce = options.requireNonce ?? true;
  const codeLifetimeMs = options.codeLifetimeMs ?? 60_000;
  if (!Number.isSafeInteger(codeLifetimeMs) || codeLifetimeMs <= 0 || codeLifetimeMs > 60_000)
    throw new Error('Invalid local OIDC code lifetime');
  const signingKeys = await generateKeyPair('RS256');
  const signingKeyId = `local-oidc-key-${randomUUID()}`;
  const publicKey = { ...(await exportJWK(signingKeys.publicKey)), kid: signingKeyId, alg: 'RS256', use: 'sig' };
  const redirectUris = new Set<string>();
  const plans = new Map<string, AuthorizationPlan>();
  const codes = new Map<string, AuthorizationCode>();
  const requestRecords: { method: string; path: string }[] = [];
  const sockets = new Set<Socket>();
  const counters = { issuedCodes: 0, redeemedCodes: 0, deniedTokenRequests: 0 };
  let issuer = '';
  let closed = false;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', issuer);
    if (requestRecords.length < 512) requestRecords.push({ method: request.method ?? 'UNKNOWN', path: url.pathname });
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/jwks') {
      json(response, 200, { keys: [publicKey] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const parameters = url.searchParams;
      const redirectUri = singleParameter(parameters, 'redirect_uri');
      const state = singleParameter(parameters, 'state');
      const challenge = singleParameter(parameters, 'code_challenge');
      const nonce = singleParameter(parameters, 'nonce');
      const planId = singleParameter(parameters, 'fixture_plan');
      const plan = planId ? plans.get(planId) : undefined;
      if (
        singleParameter(parameters, 'client_id') !== clientId ||
        singleParameter(parameters, 'response_type') !== 'code' ||
        !redirectUri ||
        !redirectUris.has(redirectUri) ||
        !state ||
        state.length > 512 ||
        !challenge ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        singleParameter(parameters, 'code_challenge_method') !== 'S256' ||
        (requireNonce && !nonce) ||
        (nonce !== undefined && nonce.length > 512) ||
        !singleParameter(parameters, 'scope')?.split(' ').includes('openid') ||
        !plan ||
        codes.size >= 128
      ) {
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      plans.delete(planId!);
      const callback = new URL(redirectUri);
      callback.searchParams.set('state', state);
      if (plan.controls.cancel) {
        callback.searchParams.set('error', 'access_denied');
        redirect(response, callback);
        return;
      }
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { ...plan, redirectUri, challenge, nonce, expiresAt: Date.now() + codeLifetimeMs });
      counters.issuedCodes += 1;
      callback.searchParams.set('code', code);
      redirect(response, callback);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const deny = (status: number, error: string) => {
        counters.deniedTokenRequests += 1;
        json(response, status, { error });
      };
      const authorization = request.headers.authorization;
      const expectedAuthorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
      if (!authorization || !constantEqual(authorization, expectedAuthorization)) {
        deny(401, 'invalid_client');
        return;
      }
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
        deny(400, 'invalid_request');
        return;
      }
      const form = await readForm(request);
      const code = singleParameter(form, 'code');
      const verifier = singleParameter(form, 'code_verifier');
      const grant = singleParameter(form, 'grant_type');
      const redirectUri = singleParameter(form, 'redirect_uri');
      const issued = code ? codes.get(code) : undefined;
      if (code && issued && issued.expiresAt <= Date.now()) codes.delete(code);
      if (
        !issued ||
        !code ||
        grant !== 'authorization_code' ||
        issued.expiresAt <= Date.now() ||
        redirectUri !== issued.redirectUri ||
        !verifier ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !constantEqual(createHash('sha256').update(verifier).digest('base64url'), issued.challenge)
      ) {
        deny(400, 'invalid_grant');
        return;
      }
      codes.delete(code);
      if (issued.controls.rejectToken) {
        deny(400, 'invalid_grant');
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const nonce = issued.controls.wrongNonce ? `${issued.nonce ?? 'fixture-nonce'}-wrong` : issued.nonce;
      const idToken = await new SignJWT({
        email: issued.identity.email,
        email_verified: issued.identity.emailVerified ?? true,
        name: issued.identity.name ?? 'Local OIDC climber',
        picture: issued.identity.picture,
        ...(nonce !== undefined ? { nonce } : {}),
        ...(issued.identity.authTimeSeconds !== undefined ? { auth_time: issued.identity.authTimeSeconds } : {}),
      })
        .setProtectedHeader({ alg: 'RS256', kid: signingKeyId })
        .setIssuer(issuer)
        .setSubject(issued.identity.subject)
        .setAudience(clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(signingKeys.privateKey);
      counters.redeemedCodes += 1;
      json(response, 200, {
        access_token: randomBytes(32).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid profile email',
        id_token: idToken,
      });
      return;
    }
    json(response, 404, { error: 'not_found' });
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) json(response, 500, { error: 'fixture_transport_error' });
      else response.destroy();
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local OIDC fixture did not bind TCP');
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    registerRedirectUri(redirectUri: string) {
      const parsed = new URL(redirectUri);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
        throw new Error('Invalid owned OIDC callback');
      redirectUris.add(parsed.toString());
    },
    async authorize(
      authorizationUrl: string,
      identity: LocalOidcIdentity,
      controls: LocalOidcControls = {},
    ): Promise<Response> {
      if (closed || plans.size >= 128 || !identity.subject) throw new Error('Local OIDC fixture unavailable');
      const url = new URL(authorizationUrl);
      if (url.origin !== issuer || url.pathname !== '/authorize')
        throw new Error('Unexpected OIDC authorization target');
      const planId = randomUUID();
      plans.set(planId, {
        identity: {
          subject: identity.subject,
          email: identity.email,
          emailVerified: identity.emailVerified,
          name: identity.name,
          picture: identity.picture,
          authTimeSeconds: identity.authTimeSeconds,
        },
        controls: { cancel: controls.cancel, wrongNonce: controls.wrongNonce, rejectToken: controls.rejectToken },
      });
      url.searchParams.set('fixture_plan', planId);
      try {
        return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      } finally {
        plans.delete(planId);
      }
    },
    requests() {
      return requestRecords.map((request) => ({ ...request }));
    },
    stats() {
      return { ...counters, pendingCodes: codes.size };
    },
    async close() {
      if (closed) return;
      closed = true;
      plans.clear();
      codes.clear();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          reject(new Error('Local OIDC fixture close deadline exceeded'));
        }, 3000);
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}
