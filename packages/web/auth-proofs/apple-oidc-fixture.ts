/**
 * A loopback stand-in for Sign in with Apple, for the #7596 B5b and B5e1
 * proofs and the browser-session e2e run.
 *
 * It names itself `https://appleid.apple.com` and does what Apple does for a
 * web client: the authorization request answers with `response_mode=form_post`,
 * a form the browser POSTs cross-site to the client's callback with `code`,
 * `state` and, on a first sign-in, the `user` JSON; the token endpoint redeems
 * the code (PKCE when the request carried a challenge) for an RS256 ID token
 * whose `email_verified` is the string "true", as Apple sends it. Apple signs
 * its ID tokens with RS256 (its JWKS publishes RSA keys); the client secret is
 * the ES256 JWT, which this stand-in only compares. No Apple credential is used.
 *
 * Two ways in:
 * - a proof calls `authorize(url, identity)` and gets the form Apple would
 *   post (`action` and `fields`), then posts it itself with the cookies a
 *   cross-site POST carries;
 * - a browser opens the authorization URL: the page asks for the identity
 *   (subject and email fields, a Continue button, as a climber signs in at
 *   Apple) and answers with a page that posts the form to the callback.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { signRs256 } from './google-oidc-fixture';

export const APPLE_ISSUER = 'https://appleid.apple.com';

export type AppleIdentity = {
  subject: string;
  email: string;
  /** Apple sends the climber's name only on the first authorization, in the form's `user` field. */
  firstSignIn?: boolean;
};

type IssuedCode = {
  identity: AppleIdentity;
  nonce: string | undefined;
  challenge: string | undefined;
  redirectUri: string;
};

/** The form Apple posts to the client's callback. */
export type AppleFormPost = { action: string; fields: Record<string, string> };

export type AppleOidcFixtureOptions = {
  clientId: string;
  clientSecret: string;
  /**
   * The origin a browser reaches the authorization endpoint at, when that is
   * not the loopback listener (the e2e run serves it on its own https site
   * through the edge). The token and key endpoints stay on the loopback
   * listener: only the client's server calls them.
   */
  browserOrigin?: string;
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, body: string) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign in with Apple</title></head><body>${body}</body></html>`,
  );
}

function escapeAttribute(content: string) {
  return content.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function hiddenFields(fields: Record<string, string>) {
  return Object.entries(fields)
    .map(
      ([name, content]) => `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(content)}">`,
    )
    .join('');
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** The client credentials of a token request: HTTP Basic or the form body. */
function clientCredentials(request: IncomingMessage, form: URLSearchParams) {
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
  if (basic) {
    const [id, secret] = Buffer.from(basic, 'base64').toString('utf8').split(':');
    return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
  }
  return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? '' };
}

export async function startAppleOidcFixture({ clientId, clientSecret, browserOrigin }: AppleOidcFixtureOptions) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = `apple-fixture-${randomUUID()}`;
  const publicJwk: Record<string, unknown> = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: keyId,
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map<string, IssuedCode>();
  /** Every authorization request's query, for the proofs to read what the client asked Apple for. */
  const authorizations: URLSearchParams[] = [];
  const sockets = new Set<Socket>();
  let origin = '';

  /** Issues a code for `identity` against an authorization request, or undefined when the request is not Apple's shape. */
  function formPostFor(query: URLSearchParams, identity: AppleIdentity): AppleFormPost | undefined {
    const redirectUri = query.get('redirect_uri');
    if (!redirectUri || query.get('client_id') !== clientId || query.get('response_mode') !== 'form_post')
      return undefined;
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      identity,
      nonce: query.get('nonce') ?? undefined,
      challenge: query.get('code_challenge') ?? undefined,
      redirectUri,
    });
    const fields: Record<string, string> = { state: query.get('state') ?? '', code };
    if (identity.firstSignIn)
      fields.user = JSON.stringify({ name: { firstName: 'Apple', lastName: 'Climber' }, email: identity.email });
    return { action: redirectUri, fields };
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/.well-known/openid-configuration') {
        json(response, 200, {
          issuer: APPLE_ISSUER,
          authorization_endpoint: `${browserOrigin ?? origin}/auth/authorize`,
          token_endpoint: `${origin}/auth/token`,
          jwks_uri: `${origin}/auth/keys`,
          response_types_supported: ['code'],
          response_modes_supported: ['query', 'fragment', 'form_post'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          scopes_supported: ['openid', 'email', 'name'],
        });
        return;
      }
      if (url.pathname === '/auth/keys') {
        json(response, 200, { keys: [publicJwk] });
        return;
      }
      if (url.pathname === '/auth/authorize' && request.method === 'GET') {
        authorizations.push(url.searchParams);
        // A browser: the climber names who signs in, as at Apple's own page.
        html(
          response,
          `<form method="POST" action="/auth/authorize">${hiddenFields(Object.fromEntries(url.searchParams))}` +
            '<label>Apple subject <input name="fixture_subject"></label>' +
            '<label>Apple email <input name="fixture_email"></label>' +
            '<label><input type="checkbox" name="fixture_first_sign_in" value="1"> First sign-in</label>' +
            '<button type="submit">Continue with Apple</button></form>',
        );
        return;
      }
      if (url.pathname === '/auth/authorize' && request.method === 'POST') {
        const form = await readForm(request);
        const subject = form.get('fixture_subject') ?? '';
        const email = form.get('fixture_email') ?? '';
        const query = new URLSearchParams([...form].filter(([name]) => !name.startsWith('fixture_')));
        const post =
          subject && email
            ? formPostFor(query, { subject, email, firstSignIn: form.has('fixture_first_sign_in') })
            : undefined;
        if (!post) {
          json(response, 400, { error: 'invalid_request' });
          return;
        }
        // Apple's answer: a page that posts the form to the client, cross-site.
        html(
          response,
          `<form id="apple-form-post" method="POST" action="${escapeAttribute(post.action)}">${hiddenFields(post.fields)}</form>` +
            '<script>document.getElementById("apple-form-post").submit();</script>',
        );
        return;
      }
      if (url.pathname === '/auth/token' && request.method === 'POST') {
        const form = await readForm(request);
        const credentials = clientCredentials(request, form);
        const issued = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !issued ||
          credentials.id !== clientId ||
          credentials.secret !== clientSecret ||
          form.get('grant_type') !== 'authorization_code' ||
          form.get('redirect_uri') !== issued.redirectUri ||
          (issued.challenge !== undefined &&
            createHash('sha256').update(verifier).digest('base64url') !== issued.challenge)
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(form.get('code') ?? '');
        const now = Math.floor(Date.now() / 1000);
        const { identity, nonce } = issued;
        const idToken = signRs256(
          { alg: 'RS256', kid: keyId },
          {
            iss: APPLE_ISSUER,
            aud: clientId,
            exp: now + 600,
            iat: now,
            sub: identity.subject,
            email: identity.email,
            email_verified: 'true',
            is_private_email: 'false',
            auth_time: now,
            nonce_supported: true,
            ...(nonce !== undefined ? { nonce } : {}),
          },
          keys.privateKey,
        );
        json(response, 200, {
          access_token: randomBytes(24).toString('base64url'),
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: randomBytes(24).toString('base64url'),
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
    authorizations: () => authorizations,
    /** Apple's answer to an authorization URL for `identity`: the form it posts to the callback. */
    authorize(authorizationUrl: string, identity: AppleIdentity): AppleFormPost {
      const query = new URL(authorizationUrl).searchParams;
      authorizations.push(query);
      const post = formPostFor(query, identity);
      if (!post) throw new Error('Apple fixture refused the authorization');
      return post;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
