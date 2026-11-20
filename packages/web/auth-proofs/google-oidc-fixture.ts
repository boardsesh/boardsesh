/**
 * A loopback stand-in for Google's OpenID provider, for the #7596 B5b proofs.
 *
 * It names itself `https://accounts.google.com` and signs RS256 ID tokens for
 * the configured client, so both readers of a Google sign-in check a real
 * token: www's NextAuth (through the discovery document's loopback endpoints,
 * PKCE and the nonce it sent) and the backend's own freshness verifier (which
 * fetches Google's certificates; the proof answers that one URL with this
 * fixture's key). Each authorization names the identity and the `auth_time`
 * Google would report. No real Google credential is used.
 *
 * A browser (the browser-session e2e run) opens the authorization URL with no
 * plan: the page asks for the identity (subject and email fields, a Continue
 * button), and the answer is Google's redirect back to the callback.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export type GoogleIdentity = {
  subject: string;
  email: string;
  name?: string;
  /** When Google says the climber last signed in, in seconds; absent when Google sends no `auth_time`. */
  authTimeSeconds?: number;
};

type IssuedCode = { identity: GoogleIdentity; nonce: string | undefined; challenge: string; redirectUri: string };

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** An RS256 JWS, signed with node:crypto (the web package has no JOSE library of its own). */
export function signRs256(header: Record<string, unknown>, claims: Record<string, unknown>, privateKey: KeyObject) {
  const encode = (part: Record<string, unknown>) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function escapeAttribute(content: string) {
  return content.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * `browserOrigin`: where a browser reaches the authorization endpoint when that
 * is not the loopback listener (the e2e run serves it on its own https site
 * through the edge). The token and key endpoints stay on loopback.
 */
export async function startGoogleOidcFixture(clientId: string, { browserOrigin }: { browserOrigin?: string } = {}) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = `google-fixture-${randomUUID()}`;
  const publicJwk: Record<string, unknown> = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: keyId,
    alg: 'RS256',
    use: 'sig',
  };
  const plans = new Map<string, GoogleIdentity>();
  const codes = new Map<string, IssuedCode>();
  /** Every authorization request's query, for the proofs to read what www asked Google for. */
  const authorizations: URLSearchParams[] = [];
  const sockets = new Set<Socket>();
  let origin = '';

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/.well-known/openid-configuration') {
        json(response, 200, {
          issuer: GOOGLE_ISSUER,
          authorization_endpoint: `${browserOrigin ?? origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'],
        });
        return;
      }
      if (url.pathname === '/jwks') {
        json(response, 200, { keys: [publicJwk] });
        return;
      }
      if (url.pathname === '/authorize' && request.method === 'GET' && !url.searchParams.has('fixture_plan')) {
        authorizations.push(url.searchParams);
        // A browser: the climber names who signs in, as at Google's own page.
        const hidden = [...url.searchParams]
          .map(
            ([name, content]) =>
              `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(content)}">`,
          )
          .join('');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>Sign in with Google</title></head><body>` +
            `<form method="POST" action="/authorize">${hidden}` +
            '<label>Google subject <input name="fixture_subject"></label>' +
            '<label>Google email <input name="fixture_email"></label>' +
            '<button type="submit">Continue with Google</button></form></body></html>',
        );
        return;
      }
      if (url.pathname === '/authorize' && request.method === 'POST') {
        const form = await readForm(request);
        const subject = form.get('fixture_subject') ?? '';
        const email = form.get('fixture_email') ?? '';
        const planId = randomUUID();
        if (subject && email) plans.set(planId, { subject, email, authTimeSeconds: Math.floor(Date.now() / 1000) });
        for (const [name, content] of form) if (!name.startsWith('fixture_')) url.searchParams.set(name, content);
        url.searchParams.set('fixture_plan', planId);
      }
      if (url.pathname === '/authorize') {
        if (request.method === 'GET') authorizations.push(url.searchParams);
        const identity = plans.get(url.searchParams.get('fixture_plan') ?? '');
        const redirectUri = url.searchParams.get('redirect_uri');
        const challenge = url.searchParams.get('code_challenge');
        if (!identity || !redirectUri || !challenge || url.searchParams.get('client_id') !== clientId) {
          json(response, 400, { error: 'invalid_request' });
          return;
        }
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { identity, nonce: url.searchParams.get('nonce') ?? undefined, challenge, redirectUri });
        const callback = new URL(redirectUri);
        callback.searchParams.set('state', url.searchParams.get('state') ?? '');
        callback.searchParams.set('code', code);
        response.writeHead(302, { Location: callback.toString() });
        response.end();
        return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const form = await readForm(request);
        const issued = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !issued ||
          form.get('redirect_uri') !== issued.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== issued.challenge
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(form.get('code') ?? '');
        const now = Math.floor(Date.now() / 1000);
        const { identity, nonce } = issued;
        const idToken = signRs256(
          { alg: 'RS256', kid: keyId, typ: 'JWT' },
          {
            iss: GOOGLE_ISSUER,
            sub: identity.subject,
            aud: clientId,
            iat: now,
            exp: now + 600,
            email: identity.email,
            email_verified: true,
            name: identity.name ?? 'Google climber',
            ...(nonce !== undefined ? { nonce } : {}),
            ...(identity.authTimeSeconds !== undefined ? { auth_time: identity.authTimeSeconds } : {}),
          },
          keys.privateKey,
        );
        json(response, 200, {
          access_token: randomBytes(24).toString('base64url'),
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'openid email profile',
          id_token: idToken,
        });
        return;
      }
      json(response, 404, { error: 'not_found' });
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'fixture_error' });
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    port,
    discoveryUrl: `${origin}/.well-known/openid-configuration`,
    /** Google's certificate document, as the backend fetches it. */
    certificates: () => ({ keys: [publicJwk] }),
    authorizations: () => authorizations,
    /** Google's answer to an authorization URL: the redirect back to www's callback, with code and state. */
    async authorize(authorizationUrl: string, identity: GoogleIdentity): Promise<string> {
      const planId = randomUUID();
      plans.set(planId, identity);
      const url = new URL(authorizationUrl);
      url.searchParams.set('fixture_plan', planId);
      const response = await fetch(url, { redirect: 'manual' });
      plans.delete(planId);
      const location = response.headers.get('location');
      if (response.status !== 302 || !location) throw new Error('Google fixture refused the authorization');
      return location;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
