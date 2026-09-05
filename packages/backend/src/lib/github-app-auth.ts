/**
 * Installation access tokens for the Boardsesh Feedback Bot GitHub App.
 *
 * The in-app bug reporter and the crowdsourced-QA mirror used to write to
 * GitHub with a personal access token, so every issue, comment and label swap
 * was attributed to whoever owned the PAT. They authenticate as the App now.
 *
 * The App is deliberately narrow — Issues read+write, Pull requests read+write,
 * Contents read, Deployments read. It is NOT the `Boardsesh Repo Bot` used by
 * CI: that one carries `contents:write` and `workflows:write`, which have no
 * business sitting on an internet-facing service.
 *
 * Nothing here throws. Every failure path returns undefined, which callers
 * already handle as "no token": reads fall back to anonymous (60/hr per IP) and
 * writes no-op. An expired key must degrade the QA mirror, never fail the
 * mutation that recorded the verdict.
 */

import { SignJWT, importPKCS8 } from 'jose';
import { logger } from '../utils/logger';

const GITHUB_API = 'https://api.github.com';

/**
 * GitHub rejects a JWT older than 10 minutes. Nine leaves room for the request
 * itself, and the 60s back-dated `iat` absorbs clock skew between us and
 * GitHub — their own docs recommend it.
 */
const JWT_LIFETIME_SECONDS = 9 * 60;
const JWT_CLOCK_SKEW_SECONDS = 60;

/**
 * Installation tokens last an hour. Renew five minutes early so a request that
 * starts just under the wire cannot finish just over it.
 */
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60 * 1000;

type InstallationToken = { token: string; expiresAtMs: number };

let cachedToken: InstallationToken | null = null;
let cachedInstallationId: number | null = null;
// De-dupes concurrent mints. A burst of testers opening the app at once would
// otherwise each sign their own JWT and ask GitHub for their own token.
let inFlightToken: Promise<string | undefined> | null = null;
let hasWarnedMissingCredentials = false;

/**
 * The PEM as GitHub generated it, whatever a deploy dashboard did to it on the
 * way in. Three shapes reach us in practice:
 *
 *  - a real multi-line PEM (a `.pem` pasted into a multiline field),
 *  - one line with literal `\n` two-character escapes (most single-line fields),
 *  - base64 of either of the above (what people reach for when the first two
 *    have already bitten them).
 *
 * Returns null when the result still doesn't look like an unencrypted private
 * key, so the caller logs one clear line instead of handing `jose` something it
 * will throw on — or worse, handing `toPkcs8` a passphrase-encrypted body it
 * would happily wrap into garbage DER and fail on much further away.
 */
export function normalizePrivateKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Trim again after unescaping: a one-liner that ended in `\n` unescapes to a
  // trailing newline the first trim could not see.
  const unescaped = (trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed).trim();
  if (unescaped.includes('-----BEGIN')) return isEncryptedPem(unescaped) ? null : unescaped;

  // Not a PEM yet — the remaining supported shape is base64 of one.
  try {
    const decoded = Buffer.from(unescaped, 'base64').toString('utf8').trim();
    if (decoded.includes('-----BEGIN')) return isEncryptedPem(decoded) ? null : decoded;
  } catch {
    // Fall through to the null below; a decode failure is just "not base64".
  }
  return null;
}

/**
 * A passphrase-protected key. GitHub never emits one, but an operator
 * substituting their own key might, and there is nowhere to put a passphrase —
 * so this has to be refused loudly rather than mangled quietly.
 */
function isEncryptedPem(pem: string): boolean {
  return pem.includes('ENCRYPTED') || pem.includes('DEK-Info');
}

/**
 * PKCS#1 (`BEGIN RSA PRIVATE KEY`) is what GitHub's "Generate a private key"
 * button still hands out; `jose` only imports PKCS#8. Convert by wrapping the
 * key in the PKCS#8 envelope rather than asking every operator to run openssl.
 */
function toPkcs8(pem: string): string {
  if (pem.includes('-----BEGIN PRIVATE KEY-----')) return pem;

  const body = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const pkcs1 = Buffer.from(body, 'base64');

  // PKCS#8 PrivateKeyInfo = SEQUENCE { version 0, AlgorithmIdentifier(rsaEncryption, NULL), OCTET STRING pkcs1 }
  const rsaOid = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = Buffer.from([0x02, 0x01, 0x00]);
  const octetString = Buffer.concat([derHeader(0x04, pkcs1.length), pkcs1]);
  const contents = Buffer.concat([version, rsaOid, octetString]);
  const der = Buffer.concat([derHeader(0x30, contents.length), contents]);

  const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

/** DER tag + length, using the long form once a length exceeds 127. */
function derHeader(tag: number, length: number): Buffer {
  if (length < 0x80) return Buffer.from([tag, length]);
  const lengthBytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    lengthBytes.unshift(remaining % 256);
  }
  return Buffer.from([tag, 0x80 | lengthBytes.length, ...lengthBytes]);
}

/** App id + private key, or null when the deploy has no App configured. */
function readCredentials(): { appId: string; privateKey: string } | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !rawKey) return null;

  const privateKey = normalizePrivateKey(rawKey);
  if (!privateKey) {
    logger.error(
      '[github-app] GITHUB_APP_PRIVATE_KEY is not an unencrypted PEM (or base64 of one). ' +
        'A passphrase-protected key cannot be used — there is nowhere to supply the passphrase.',
    );
    return null;
  }
  return { appId, privateKey };
}

/** A short-lived App JWT — authenticates as the App itself, not an installation. */
async function signAppJwt(appId: string, privateKey: string, nowMs: number): Promise<string> {
  const key = await importPKCS8(toPkcs8(privateKey), 'RS256');
  const nowSeconds = Math.floor(nowMs / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(appId)
    .setIssuedAt(nowSeconds - JWT_CLOCK_SKEW_SECONDS)
    .setExpirationTime(nowSeconds + JWT_LIFETIME_SECONDS)
    .sign(key);
}

async function githubAppRequest<T>(path: string, jwt: string, method: 'GET' | 'POST'): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'boardsesh-backend',
    },
  });
  if (!response.ok) {
    // The body is not logged: GitHub echoes the request in some error shapes.
    throw new Error(`GitHub ${method} ${path} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * The App's installation on `owner/repo`. An App is installed once and the id
 * never changes, so this is looked up once per process.
 */
async function getInstallationId(owner: string, repo: string, jwt: string): Promise<number> {
  if (cachedInstallationId !== null) return cachedInstallationId;
  const installation = await githubAppRequest<{ id?: number }>(`/repos/${owner}/${repo}/installation`, jwt, 'GET');
  if (typeof installation.id !== 'number') {
    throw new Error(`GitHub returned no installation id for ${owner}/${repo}`);
  }
  cachedInstallationId = installation.id;
  return installation.id;
}

async function mintInstallationToken(repo: string, nowMs: number): Promise<string | undefined> {
  const credentials = readCredentials();
  if (!credentials) {
    if (!hasWarnedMissingCredentials) {
      hasWarnedMissingCredentials = true;
      logger.warn('[github-app] no GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY; GitHub reads go anonymous and writes no-op');
    }
    return undefined;
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    logger.error(`[github-app] invalid repo "${repo}" (expected owner/name)`);
    return undefined;
  }

  try {
    const jwt = await signAppJwt(credentials.appId, credentials.privateKey, nowMs);
    const installationId = await getInstallationId(owner, name, jwt);
    const minted = await githubAppRequest<{ token?: string; expires_at?: string }>(
      `/app/installations/${installationId}/access_tokens`,
      jwt,
      'POST',
    );
    if (typeof minted.token !== 'string') {
      logger.error('[github-app] access_tokens returned no token');
      return undefined;
    }

    const expiresAtMs = Date.parse(minted.expires_at ?? '');
    cachedToken = {
      token: minted.token,
      // An unparseable expiry is not a reason to refuse the token — fall back
      // to the documented one-hour lifetime.
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs + 60 * 60 * 1000,
    };
    return minted.token;
  } catch (error) {
    // A 404 here usually means the App is not installed on this repo rather
    // than that the repo is missing — both look the same to us.
    logger.error('[github-app] could not mint an installation token:', error);
    // Drop a stale installation id so a reinstall recovers without a restart.
    cachedInstallationId = null;
    return undefined;
  }
}

/**
 * An installation access token for `repo`, or undefined when the App is not
 * configured or GitHub refused. Cached until five minutes before it expires.
 */
export async function getInstallationAccessToken(repo: string, now: number = Date.now()): Promise<string | undefined> {
  if (cachedToken && cachedToken.expiresAtMs - TOKEN_RENEWAL_MARGIN_MS > now) return cachedToken.token;
  if (inFlightToken) return inFlightToken;

  inFlightToken = (async () => {
    try {
      return await mintInstallationToken(repo, now);
    } finally {
      inFlightToken = null;
    }
  })();
  return inFlightToken;
}

/** Test-only: forget the cached token, installation id and one-shot warning. */
export function resetGithubAppAuthCache(): void {
  cachedToken = null;
  cachedInstallationId = null;
  inFlightToken = null;
  hasWarnedMissingCredentials = false;
}
