import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Agent, createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export type ConfiguredProvider = 'google' | 'apple' | 'facebook';
export interface ConfiguredIdentity {
  subject: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
}
export interface ConfiguredProviderFaults {
  cancel?: boolean;
  rejectToken?: boolean;
  wrongAudience?: boolean;
  wrongIssuer?: boolean;
  missingResponseIssuer?: boolean;
  wrongResponseIssuer?: boolean;
  wrongSignature?: boolean;
  expired?: boolean;
}
const specifications = {
  google: {
    issuer: 'https://accounts.google.com',
    discovery: 'https://accounts.google.com/.well-known/openid-configuration',
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  },
  apple: {
    issuer: 'https://appleid.apple.com',
    discovery: 'https://appleid.apple.com/.well-known/openid-configuration',
    authorization: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    jwks: 'https://appleid.apple.com/auth/keys',
  },
  facebook: {
    issuer: 'https://www.facebook.com',
    authorization: 'https://www.facebook.com/v11.0/dialog/oauth',
    token: 'https://graph.facebook.com/oauth/access_token',
    userinfo: 'https://graph.facebook.com/me',
  },
} as const;
const same = (first: string, second: string) => {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
};
const single = (form: URLSearchParams, name: string) => {
  const candidates = form.getAll(name);
  return candidates.length === 1 ? candidates[0] : undefined;
};
function json(response: ServerResponse, status: number, content: object) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(content));
}
async function readForm(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => request.destroy(new Error('Owned provider body deadline')), 2000);
  try {
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 16384) throw new Error('Owned provider body limit');
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

/** External-provider transport only. Actual NextAuth provider options remain intact. */
export async function startConfiguredProviderTransport() {
  const directory = await mkdtemp(join(tmpdir(), 'boardsesh-app-router-'));
  const keyFile = join(directory, 'key.pem');
  const certificateFile = join(directory, 'certificate.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      keyFile,
      '-out',
      certificateFile,
    ],
    { stdio: 'ignore' },
  );
  const tls = { key: await readFile(keyFile), cert: await readFile(certificateFile) };
  const pairs = { google: await generateKeyPair('RS256'), apple: await generateKeyPair('RS256') };
  const wrongPair = await generateKeyPair('RS256');
  const publicKeys = {
    google: {
      ...(await exportJWK(pairs.google.publicKey)),
      kid: `owned-google-${randomUUID()}`,
      alg: 'RS256',
      use: 'sig',
    },
    apple: {
      ...(await exportJWK(pairs.apple.publicKey)),
      kid: `owned-apple-${randomUUID()}`,
      alg: 'RS256',
      use: 'sig',
    },
  };
  const clients = Object.fromEntries(
    (['google', 'apple', 'facebook'] as const).map((provider) => [
      provider,
      { id: `owned-browser-${provider}`, secret: randomBytes(32).toString('base64url') },
    ]),
  ) as Record<ConfiguredProvider, { id: string; secret: string }>;
  interface Code {
    provider: ConfiguredProvider;
    identity: ConfiguredIdentity;
    faults: ConfiguredProviderFaults;
    redirect: string;
    challenge?: string;
    expires: number;
  }
  const codes = new Map<string, Code>();
  const access = new Map<string, ConfiguredIdentity>();
  const registeredRedirects = new Set<string>();
  const browserPages = new Map<string, { url: string; form: string }>();
  const observations: {
    provider: ConfiguredProvider;
    operation: string;
    authentication?: 'client_secret_basic' | 'client_secret_post';
  }[] = [];
  const active = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  let accepting = true;
  let port = 0;
  const allowedDestinations = new Set<string>(
    Object.values(specifications).flatMap((specification) => Object.values(specification)),
  );
  const server = createServer(tls, (request, response) => {
    if (!accepting) {
      response.destroy();
      return;
    }
    const pending = (async () => {
      const address = new URL(request.url ?? '/', `https://${request.headers.host}`);
      const browserPage = browserPages.get(address.pathname);
      if (
        address.hostname === '127.0.0.1' &&
        address.port === String(port) &&
        browserPage &&
        request.method === 'GET'
      ) {
        browserPages.delete(address.pathname);
        const fields = [...new URLSearchParams(browserPage.form)]
          .map(([name, content]) => `<input type="hidden" name="${name}" value="${content}">`)
          .join('');
        response.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        response.end(`<form method="POST" action="${browserPage.url}">${fields}<button>Complete Apple</button></form>`);
        return;
      }
      const provider = (['google', 'apple', 'facebook'] as const).find((candidate) =>
        Object.values(specifications[candidate]).some(
          (endpoint) => endpoint === `${address.origin}${address.pathname}`,
        ),
      );
      if (!provider || !allowedDestinations.has(`${address.origin}${address.pathname}`)) return json(response, 404, {});
      const specification = specifications[provider];
      if ('discovery' in specification && address.href === specification.discovery) {
        observations.push({ provider, operation: 'discovery' });
        return json(response, 200, {
          issuer: specification.issuer,
          authorization_endpoint: specification.authorization,
          token_endpoint: specification.token,
          jwks_uri: specification.jwks,
          response_types_supported: ['code'],
          response_modes_supported: ['query', 'fragment', 'form_post'],
          subject_types_supported: provider === 'apple' ? ['pairwise'] : ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          // Relevant advertised checks mirror the providers' public discovery.
          // Synthetic secrets and local S256 verification do not prove a real
          // registered Apple client or the vendor's PKCE implementation.
          token_endpoint_auth_methods_supported:
            provider === 'apple' ? ['client_secret_post'] : ['client_secret_post', 'client_secret_basic'],
          ...(provider === 'google'
            ? {
                code_challenge_methods_supported: ['plain', 'S256'],
                authorization_response_iss_parameter_supported: true,
              }
            : {}),
        });
      }
      if (provider !== 'facebook' && address.href === specifications[provider].jwks) {
        observations.push({ provider, operation: 'jwks' });
        return json(response, 200, { keys: [publicKeys[provider]] });
      }
      if (provider === 'facebook' && address.pathname === '/me') {
        observations.push({ provider, operation: 'userinfo' });
        const bearer =
          request.headers.authorization?.replace(/^Bearer /, '') ?? address.searchParams.get('access_token') ?? '';
        const identity = access.get(bearer);
        if (!identity) return json(response, 401, {});
        return json(response, 200, {
          id: identity.subject,
          name: identity.name,
          email: identity.email,
          picture: { data: { url: 'https://images.example.test/owned-avatar.png' } },
        });
      }
      if (address.pathname !== new URL(specification.token).pathname || request.method !== 'POST')
        return json(response, 404, {});
      const form = await readForm(request);
      const basic = request.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(request.headers.authorization.slice(6), 'base64').toString('utf8').split(':')
        : undefined;
      observations.push({
        provider,
        operation: 'token',
        authentication: basic ? 'client_secret_basic' : 'client_secret_post',
      });
      if (provider === 'apple' && request.headers.authorization !== undefined)
        return json(response, 401, { error: 'invalid_client' });
      const id = basic ? decodeURIComponent(basic[0]) : single(form, 'client_id');
      const secret = basic ? decodeURIComponent(basic[1] ?? '') : single(form, 'client_secret');
      if (!id || !secret || !same(id, clients[provider].id) || !same(secret, clients[provider].secret))
        return json(response, 401, { error: 'invalid_client' });
      const rawCode = single(form, 'code') ?? '';
      const code = codes.get(rawCode);
      if (
        !code ||
        code.provider !== provider ||
        code.expires <= Date.now() ||
        single(form, 'grant_type') !== 'authorization_code' ||
        single(form, 'redirect_uri') !== code.redirect
      )
        return json(response, 400, { error: 'invalid_grant' });
      codes.delete(rawCode);
      const verifier = single(form, 'code_verifier');
      if (code.challenge && (!verifier || createHash('sha256').update(verifier).digest('base64url') !== code.challenge))
        return json(response, 400, { error: 'invalid_grant' });
      if (code.faults.rejectToken) return json(response, 400, { error: 'invalid_grant' });
      const accessToken = randomBytes(32).toString('base64url');
      access.set(accessToken, code.identity);
      const result: Record<string, unknown> = { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 };
      if (provider !== 'facebook')
        result.id_token = await new SignJWT({
          sub: code.identity.subject,
          email: code.identity.email,
          name: code.identity.name,
          email_verified: code.identity.emailVerified,
          picture: 'https://images.example.test/owned-avatar.png',
        })
          .setProtectedHeader({ alg: 'RS256', kid: publicKeys[provider].kid })
          .setIssuer(code.faults.wrongIssuer ? 'https://foreign-provider.example.test' : specification.issuer)
          .setAudience(code.faults.wrongAudience ? 'foreign-browser-client' : clients[provider].id)
          .setIssuedAt()
          .setExpirationTime(code.faults.expired ? '1h ago' : '10m')
          .sign(code.faults.wrongSignature ? wrongPair.privateKey : pairs[provider].privateKey);
      json(response, 200, result);
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'owned_provider_failure' });
      else response.destroy();
    });
    active.add(pending);
    void pending.finally(() => active.delete(pending));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned provider bind failed');
  port = address.port;
  class OwnedProviderAgent extends Agent {
    override createConnection(
      options: ConnectionOptions,
      callback?: (error: Error | null, stream: TLSSocket) => void,
    ): TLSSocket {
      const hostname = options.servername ?? options.host;
      if (
        !hostname ||
        !new Set([
          'accounts.google.com',
          'oauth2.googleapis.com',
          'www.googleapis.com',
          'appleid.apple.com',
          'graph.facebook.com',
        ]).has(hostname)
      )
        throw new Error('Unowned provider connection refused');
      return connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, callback ? () => {} : undefined);
    }
  }
  const agent = new OwnedProviderAgent({ keepAlive: false });
  return {
    clients,
    tls,
    agent,
    observations,
    allowedDestinations,
    origin: `https://127.0.0.1:${port}`,
    registerRedirect(origin: string) {
      for (const provider of ['google', 'apple', 'facebook'])
        registeredRedirects.add(`${origin}/api/auth/callback/${provider}`);
    },
    browserPage(callback: { url: string; form: string }) {
      if (browserPages.size > 128 || !registeredRedirects.has(callback.url))
        throw new Error('Invalid owned browser callback');
      const path = `/owned-authorization/${randomUUID()}`;
      browserPages.set(path, { ...callback });
      return `https://127.0.0.1:${port}${path}`;
    },
    authorize(input: string, identity: ConfiguredIdentity, faults: ConfiguredProviderFaults = {}) {
      const authorization = new URL(input);
      const provider = (['google', 'apple', 'facebook'] as const).find(
        (candidate) => `${authorization.origin}${authorization.pathname}` === specifications[candidate].authorization,
      );
      if (
        !provider ||
        single(authorization.searchParams, 'client_id') !== clients[provider].id ||
        single(authorization.searchParams, 'response_type') !== 'code'
      )
        throw new Error('Invalid owned authorization');
      const redirect = single(authorization.searchParams, 'redirect_uri');
      const state = single(authorization.searchParams, 'state');
      if (!redirect || !registeredRedirects.has(redirect) || !state)
        throw new Error('Unregistered owned redirect/state');
      const challenge = single(authorization.searchParams, 'code_challenge');
      if (
        provider !== 'facebook' &&
        (!challenge || single(authorization.searchParams, 'code_challenge_method') !== 'S256')
      )
        throw new Error('Owned provider requires configured S256');
      const callback = new URL(redirect);
      const form = new URLSearchParams({ state });
      if (provider === 'google' && !faults.missingResponseIssuer)
        form.set('iss', faults.wrongResponseIssuer ? 'https://issuer.example.test' : specifications.google.issuer);
      if (faults.cancel) form.set('error', 'access_denied');
      else {
        const code = randomBytes(32).toString('base64url');
        codes.set(code, {
          provider,
          identity: { ...identity },
          faults: { ...faults },
          redirect,
          challenge,
          expires: Date.now() + 60000,
        });
        form.set('code', code);
      }
      if (provider === 'apple' && authorization.searchParams.get('response_mode') !== 'form_post')
        throw new Error('Apple configured form_post was changed');
      if (provider !== 'apple') callback.search = form.toString();
      return { provider, method: provider === 'apple' ? 'POST' : 'GET', url: callback.href, form: form.toString() };
    },
    async close() {
      accepting = false;
      agent.destroy();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(active);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
