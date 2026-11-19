import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_HOST,
  APPLE_STAND_IN_HOST,
  GOOGLE_STAND_IN_HOST,
  PROBE_HOST_ONE,
  PROBE_HOST_TWO,
  WS_HOST,
  WWW_HOST,
} from './stack';

/**
 * One self-signed certificate for every host, and for 127.0.0.1, where
 * `backend-relay.ts` gives www an https channel to the backend. The key lives
 * only in a run directory under the ignored `.boardsesh/`, and teardown
 * deletes it. `certificatePath` is what www trusts through NODE_EXTRA_CA_CERTS.
 */
export function createCertificate(directory: string): { key: Buffer; cert: Buffer; certificatePath: string } {
  const keyPath = join(directory, 'edge-key.pem');
  const certificatePath = join(directory, 'edge-certificate.pem');
  const hosts = [
    WWW_HOST,
    APP_HOST,
    WS_HOST,
    PROBE_HOST_ONE,
    PROBE_HOST_TWO,
    APPLE_STAND_IN_HOST,
    GOOGLE_STAND_IN_HOST,
  ];
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
      `/CN=${WWW_HOST}`,
      '-addext',
      `subjectAltName=${[...hosts.map((host) => `DNS:${host}`), 'IP:127.0.0.1'].join(',')}`,
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certificatePath), certificatePath };
}
