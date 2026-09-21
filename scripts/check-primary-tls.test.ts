import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluateCertificate,
  probePostgresCertificate,
  type ObservedCertificate,
  type TlsManifest,
} from './check-primary-tls';

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'primary-tls-'));

function mintCertificate(commonName: string, altName: string, days: number): { cert: string; key: string } {
  const certPath = join(fixtureDirectory, `${commonName}-${days}.pem`);
  const keyPath = join(fixtureDirectory, `${commonName}-${days}.key`);
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-noenc',
    '-days',
    String(days),
    '-subj',
    `/CN=${commonName}`,
    '-addext',
    `subjectAltName=DNS:${altName}`,
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ]);
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}

/**
 * A server that speaks just enough PostgreSQL to be probed: it answers the
 * cleartext SSLRequest, then upgrades. `answer` lets a test refuse TLS the way a
 * server built without SSL support does.
 */
function startFakePrimary(
  material: { cert: string; key: string },
  answer: 'S' | 'N',
): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const context = createSecureContext({ cert: material.cert, key: material.key });
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write(answer);
      if (answer !== 'S') return;
      const secured = new TLSSocket(socket, { isServer: true, secureContext: context });
      secured.on('error', () => secured.destroy());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const goodMaterial = mintCertificate('localhost', 'localhost', 400);

afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

function manifest(overrides: Partial<TlsManifest> = {}): TlsManifest {
  return {
    host: 'localhost',
    port: 5432,
    connectTimeoutMs: 5000,
    rejectedFingerprints: {},
    pendingRollout: null,
    expected: null,
    ...overrides,
  };
}

describe('probePostgresCertificate', () => {
  let primary: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    primary = await startFakePrimary(goodMaterial, 'S');
  });
  afterAll(async () => primary.close());

  it('reads the certificate a PostgreSQL server serves after the SSLRequest', async () => {
    const observed = await probePostgresCertificate({
      host: 'localhost',
      port: primary.port,
      connectTimeoutMs: 5000,
    });
    expect(observed.subject).toBe('localhost');
    expect(observed.subjectAltNames).toEqual(['DNS:localhost']);
    expect(observed.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(observed.daysRemaining).toBeGreaterThan(300);
  });

  it('fails loudly when the server refuses TLS instead of reporting it healthy', async () => {
    const plaintext = await startFakePrimary(goodMaterial, 'N');
    try {
      await expect(
        probePostgresCertificate({ host: 'localhost', port: plaintext.port, connectTimeoutMs: 5000 }),
      ).rejects.toThrow(/refused TLS/);
    } finally {
      await plaintext.close();
    }
  });
});

describe('evaluateCertificate', () => {
  const observed: ObservedCertificate = {
    fingerprint256: 'AA:BB:CC',
    subject: 'pgdr.boardsesh.com',
    issuer: 'Boardsesh DR CA',
    subjectAltNames: ['DNS:pgdr.boardsesh.com', 'DNS:postgis---pg18.railway.internal'],
    validTo: 'Sep 24 02:44:31 2027 GMT',
    daysRemaining: 400,
  };

  it('passes when nothing is pinned and the certificate is not on the rejected list', () => {
    expect(evaluateCertificate(manifest(), observed)).toEqual({ failures: [], warnings: [] });
  });

  // The case that is actionable before the private CA exists: production must
  // never serve the base image's snakeoil certificate again, because its private
  // key is public.
  it('refuses a rejected certificate even with nothing pinned', () => {
    const { failures } = evaluateCertificate(
      manifest({ rejectedFingerprints: { 'aa:bb:cc': 'its private key is published' } }),
      observed,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('its private key is published');
  });

  it('compares fingerprints without caring about colons or case', () => {
    const { failures } = evaluateCertificate(
      manifest({ expected: { fingerprint256: 'aabbcc', subjectAltNames: [], minDaysRemaining: 30 } }),
      observed,
    );
    expect(failures).toEqual([]);
  });

  it('reports a fingerprint mismatch', () => {
    const { failures } = evaluateCertificate(
      manifest({ expected: { fingerprint256: 'DD:EE:FF', subjectAltNames: [], minDaysRemaining: 30 } }),
      observed,
    );
    expect(failures.join(' ')).toContain('fingerprint is AA:BB:CC');
  });

  it('reports a missing subject alternative name', () => {
    const { failures } = evaluateCertificate(
      manifest({
        expected: {
          fingerprint256: 'AA:BB:CC',
          subjectAltNames: ['DNS:pgdr.boardsesh.com', 'DNS:missing.boardsesh.com'],
          minDaysRemaining: 30,
        },
      }),
      observed,
    );
    expect(failures.join(' ')).toContain('DNS:missing.boardsesh.com');
  });

  // Expiry is the failure with a two-day fuse on the DR side, so it has to fail
  // the run well before it happens.
  it('fails while there is still time to act on an expiry', () => {
    const { failures } = evaluateCertificate(
      manifest({ expected: { fingerprint256: 'AA:BB:CC', subjectAltNames: [], minDaysRemaining: 30 } }),
      { ...observed, daysRemaining: 12 },
    );
    expect(failures.join(' ')).toContain('expires in 12 day(s)');
  });

  it('treats an unreadable expiry as a failure rather than ignoring it', () => {
    const { failures } = evaluateCertificate(
      manifest({ expected: { fingerprint256: 'AA:BB:CC', subjectAltNames: [], minDaysRemaining: 30 } }),
      { ...observed, validTo: 'not a date', daysRemaining: Number.NaN },
    );
    expect(failures.join(' ')).toContain('expiry is unreadable');
  });
});

describe('the pending rollout escape', () => {
  const snakeoil = 'AA:BB:CC';
  const rejected = { 'aa:bb:cc': 'its private key is published in a public image layer' };
  const pending = {
    fingerprint256: snakeoil,
    reason: 'the private CA has not been minted yet',
    warnUntil: '2026-12-31',
  };
  const observed: ObservedCertificate = {
    fingerprint256: snakeoil,
    subject: 'localhost',
    issuer: 'localhost',
    subjectAltNames: ['DNS:localhost'],
    validTo: 'Aug 22 00:41:42 2036 GMT',
    daysRemaining: 3600,
  };

  // Landing this check red on day one would have meant silencing it instead, so
  // the known-bad certificate warns rather than fails -- loudly, and only until
  // the deadline.
  it('warns instead of failing while the rollout is still in its window', () => {
    const verdict = evaluateCertificate(
      manifest({ rejectedFingerprints: rejected, pendingRollout: pending }),
      observed,
      Date.parse('2026-09-21T00:00:00Z'),
    );
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain('private key is published');
    expect(verdict.warnings[0]).toContain('fails after 2026-12-31');
  });

  it('fails once the deadline passes, so a stalled rollout cannot go quiet', () => {
    const verdict = evaluateCertificate(
      manifest({ rejectedFingerprints: rejected, pendingRollout: pending }),
      observed,
      Date.parse('2027-01-01T00:00:00Z'),
    );
    expect(verdict.warnings).toEqual([]);
    expect(verdict.failures.join(' ')).toContain('private key is published');
    expect(verdict.failures.join(' ')).toContain('overdue');
  });

  it('does not excuse a different certificate than the one acknowledged', () => {
    const verdict = evaluateCertificate(
      manifest({ rejectedFingerprints: { 'dd:ee:ff': 'also compromised' }, pendingRollout: pending }),
      { ...observed, fingerprint256: 'DD:EE:FF' },
      Date.parse('2026-09-21T00:00:00Z'),
    );
    expect(verdict.warnings).toEqual([]);
    expect(verdict.failures.join(' ')).toContain('also compromised');
  });
});

describe('the committed manifest', () => {
  it('rejects the snakeoil certificate the base image ships', () => {
    const committed = JSON.parse(readFileSync('docs/pg-primary-tls.json', 'utf8')) as TlsManifest;
    expect(committed.host).toBe('pgdr.boardsesh.com');
    expect(Object.keys(committed.rejectedFingerprints)).toHaveLength(1);
    const [fingerprint, reason] = Object.entries(committed.rejectedFingerprints)[0]!;
    expect(fingerprint.replace(/:/g, '')).toHaveLength(64);
    expect(reason).toMatch(/private key/i);
  });

  // The shipped config has to be self-consistent, or the check is either red on
  // arrival or quietly excusing something it never names.
  it('acknowledges that same certificate as the pending rollout', () => {
    const committed = JSON.parse(readFileSync('docs/pg-primary-tls.json', 'utf8')) as TlsManifest;
    const rejected = Object.keys(committed.rejectedFingerprints)[0]!;
    expect(committed.pendingRollout).not.toBeNull();
    expect(committed.pendingRollout?.fingerprint256).toBe(rejected);
    expect(Date.parse(`${committed.pendingRollout?.warnUntil}T00:00:00Z`)).not.toBeNaN();
  });

  it('still warns rather than fails as shipped today', () => {
    const committed = JSON.parse(readFileSync('docs/pg-primary-tls.json', 'utf8')) as TlsManifest;
    const servedToday: ObservedCertificate = {
      fingerprint256: Object.keys(committed.rejectedFingerprints)[0]!,
      subject: 'localhost',
      issuer: 'localhost',
      subjectAltNames: ['DNS:localhost'],
      validTo: 'Aug 22 00:41:42 2036 GMT',
      daysRemaining: 3600,
    };
    const verdict = evaluateCertificate(committed, servedToday, Date.now());
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
  });
});
