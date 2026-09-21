/**
 * Assert the production PostgreSQL primary still serves the certificate we
 * declared, by probing it the way libpq does.
 *
 * The certificate is installed by the image's entrypoint from Railway variables
 * (see packages/db/docker/postgres-entrypoint.sh), which makes it declared state.
 * This turns "declared" into "enforced": it runs nightly from railway-drift.yml,
 * so a deploy that loses the TLS variables, or a rollback to an image without the
 * entrypoint, is caught rather than discovered when the DR standby stops
 * replicating -- which, with WAL accruing at ~7.3 GiB/day against a 16 GiB slot
 * cap, invalidates the slot in about two days and costs a full re-bootstrap.
 *
 *   vp exec tsx scripts/check-primary-tls.ts
 *   vp exec tsx scripts/check-primary-tls.ts --manifest docs/pg-primary-tls.json
 */

import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { pathToFileURL } from 'node:url';

/** PostgreSQL's SSLRequest code: 1234 << 16 | 5679. */
const SSL_REQUEST_CODE = 80877103;
const MILLISECONDS_PER_DAY = 86_400_000;

export interface ExpectedCertificate {
  fingerprint256: string;
  subjectAltNames: string[];
  /** Fail when the certificate expires sooner than this. */
  minDaysRemaining: number;
}

/**
 * The certificate we know is being served and have not replaced yet.
 *
 * Without this the check would be red from the day it lands, because the
 * certificate production serves today is on the rejected list. Silencing it
 * instead would be worse: this way every run says out loud what is wrong, and the
 * warning becomes a hard failure once `warnUntil` passes, so a stalled rollout
 * cannot go quiet.
 */
export interface PendingRollout {
  fingerprint256: string;
  reason: string;
  /** ISO date. After this, the known-bad certificate fails the run. */
  warnUntil: string;
}

export interface TlsManifest {
  host: string;
  port: number;
  connectTimeoutMs: number;
  /** Fingerprint → why this certificate must never be served. */
  rejectedFingerprints: Record<string, string>;
  pendingRollout: PendingRollout | null;
  expected: ExpectedCertificate | null;
}

export interface CertificateVerdict {
  failures: string[];
  warnings: string[];
}

export interface ObservedCertificate {
  fingerprint256: string;
  subject: string;
  issuer: string;
  subjectAltNames: string[];
  validTo: string;
  daysRemaining: number;
}

function normaliseFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toUpperCase();
}

/** A distinguished-name field may legally repeat, so Node types it as string | string[]. */
function firstName(value: string | string[] | undefined, fallback: string): string {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function describeCertificate(peer: PeerCertificate, now: number): ObservedCertificate {
  const validTo = peer.valid_to;
  const expiresAt = Date.parse(validTo);
  return {
    fingerprint256: peer.fingerprint256,
    subject: firstName(peer.subject?.CN, '(no common name)'),
    issuer: firstName(peer.issuer?.CN, '(no issuer common name)'),
    // Node reports SANs as one comma-separated string; a list compares cleanly.
    subjectAltNames: (peer.subjectaltname ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    validTo,
    daysRemaining: Number.isNaN(expiresAt) ? Number.NaN : Math.floor((expiresAt - now) / MILLISECONDS_PER_DAY),
  };
}

/**
 * Open a PostgreSQL connection far enough to see the server's certificate.
 *
 * PostgreSQL does not speak TLS immediately: the client sends an SSLRequest in
 * cleartext and the server answers with a single byte. Only then does the
 * connection upgrade, which is why an ordinary TLS client cannot probe it.
 */
export async function probePostgresCertificate(
  manifest: Pick<TlsManifest, 'host' | 'port' | 'connectTimeoutMs'>,
  now: number = Date.now(),
): Promise<ObservedCertificate> {
  const { host, port, connectTimeoutMs } = manifest;
  const socket = netConnect({ host, port });
  socket.setTimeout(connectTimeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('timeout', () => reject(new Error(`timed out connecting to ${host}:${port}`)));
      socket.once('error', reject);
    });

    const sslRequest = Buffer.alloc(8);
    sslRequest.writeInt32BE(8, 0);
    sslRequest.writeInt32BE(SSL_REQUEST_CODE, 4);
    socket.write(sslRequest);

    const answer = await new Promise<Buffer>((resolve, reject) => {
      socket.once('data', resolve);
      socket.once('timeout', () => reject(new Error(`timed out waiting for the SSLRequest answer from ${host}`)));
      socket.once('error', reject);
    });

    if (answer.toString('utf8', 0, 1) !== 'S') {
      // 'N' means the server declined TLS outright, which is its own emergency.
      throw new Error(`${host}:${port} refused TLS; it answered ${JSON.stringify(answer.toString('utf8', 0, 1))}`);
    }

    // rejectUnauthorized stays false on purpose: the job is to report what is
    // being served, including a certificate no client would accept. The manifest
    // comparison below is what passes or fails the run.
    const secured = tlsConnect({ socket, servername: host, rejectUnauthorized: false });
    try {
      await new Promise<void>((resolve, reject) => {
        secured.once('secureConnect', resolve);
        secured.once('error', reject);
      });
      const peer = secured.getPeerCertificate();
      if (!peer || Object.keys(peer).length === 0) throw new Error(`${host}:${port} presented no certificate`);
      return describeCertificate(peer, now);
    } finally {
      secured.destroy();
    }
  } finally {
    socket.destroy();
  }
}

/** Everything wrong with the observed certificate. No failures means the run passes. */
export function evaluateCertificate(
  manifest: TlsManifest,
  observed: ObservedCertificate,
  now: number = Date.now(),
): CertificateVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const observedFingerprint = normaliseFingerprint(observed.fingerprint256);

  const pending = manifest.pendingRollout;
  const pendingMatches = pending !== null && normaliseFingerprint(pending.fingerprint256) === observedFingerprint;
  const pendingDeadline = pending === null ? Number.NaN : Date.parse(`${pending.warnUntil}T23:59:59Z`);
  const pendingStillAllowed = pendingMatches && !Number.isNaN(pendingDeadline) && now <= pendingDeadline;

  for (const [fingerprint, reason] of Object.entries(manifest.rejectedFingerprints)) {
    if (normaliseFingerprint(fingerprint) !== observedFingerprint) continue;
    const message = `the primary is serving a rejected certificate (${observed.subject}): ${reason}`;
    if (pendingStillAllowed && pending !== null) {
      warnings.push(`${message}\n    known and unresolved: ${pending.reason} (fails after ${pending.warnUntil})`);
    } else {
      failures.push(message);
    }
  }

  if (pendingMatches && !pendingStillAllowed && pending !== null) {
    failures.push(`the certificate rollout is overdue: ${pending.reason} (was due by ${pending.warnUntil})`);
  }

  const { expected } = manifest;
  if (expected === null) {
    return { failures, warnings };
  }

  if (normaliseFingerprint(expected.fingerprint256) !== observedFingerprint) {
    failures.push(`certificate fingerprint is ${observed.fingerprint256}, expected ${expected.fingerprint256}`);
  }

  const missingNames = expected.subjectAltNames.filter((name) => !observed.subjectAltNames.includes(name));
  if (missingNames.length > 0) {
    failures.push(`certificate is missing subject alternative name(s): ${missingNames.join(', ')}`);
  }

  if (Number.isNaN(observed.daysRemaining)) {
    failures.push(`certificate expiry is unreadable: ${observed.validTo}`);
  } else if (observed.daysRemaining < expected.minDaysRemaining) {
    failures.push(
      `certificate expires in ${observed.daysRemaining} day(s), under the ${expected.minDaysRemaining}-day floor ` +
        `(${observed.validTo}). Replication stops at expiry and the slot is lost roughly two days later.`,
    );
  }

  return { failures, warnings };
}

/**
 * True when the host simply does not resolve yet.
 *
 * While a rollout is pending this is expected rather than alarming -- the DNS
 * record and this check can land in either order. Once `pendingRollout` is
 * cleared, an unresolvable primary is a hard failure like any other.
 */
export function isUnresolvedHost(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOTFOUND'
  );
}

export function readManifest(path: string): TlsManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as TlsManifest;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const manifestFlag = argv.indexOf('--manifest');
  const manifestPath = manifestFlag === -1 ? 'docs/pg-primary-tls.json' : argv[manifestFlag + 1];
  if (!manifestPath) throw new Error('--manifest needs a path');

  const manifest = readManifest(manifestPath);

  let observed: ObservedCertificate;
  try {
    observed = await probePostgresCertificate(manifest);
  } catch (error) {
    if (manifest.pendingRollout !== null && isUnresolvedHost(error)) {
      console.log(`[primary-tls] WARNING: ${manifest.host} does not resolve yet.`);
      console.log(`[primary-tls]   ${manifest.pendingRollout.reason}`);
      console.log(`[primary-tls]   This is a failure once the rollout is complete and pendingRollout is cleared.`);
      return 0;
    }
    throw error;
  }

  console.log(`[primary-tls] ${manifest.host}:${manifest.port}`);
  console.log(`[primary-tls]   subject       ${observed.subject}`);
  console.log(`[primary-tls]   issuer        ${observed.issuer}`);
  console.log(`[primary-tls]   fingerprint   ${observed.fingerprint256}`);
  console.log(`[primary-tls]   alt names     ${observed.subjectAltNames.join(', ') || '(none)'}`);
  console.log(`[primary-tls]   expires       ${observed.validTo} (${observed.daysRemaining} days)`);

  const { failures, warnings } = evaluateCertificate(manifest, observed);

  for (const warning of warnings) console.log(`\n[primary-tls] WARNING: ${warning}`);

  if (failures.length > 0) {
    console.error('\n[primary-tls] the primary is not serving the declared certificate:\n');
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }

  if (manifest.expected === null) {
    console.log('\n[primary-tls] no certificate is pinned yet; only the rejected list was checked.');
    return 0;
  }
  console.log('\n[primary-tls] the primary is serving the declared certificate.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`[primary-tls] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
