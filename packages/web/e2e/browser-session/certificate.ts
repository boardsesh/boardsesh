import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_HOST, PROBE_HOST_ONE, PROBE_HOST_TWO, WS_HOST, WWW_HOST } from './stack';

/**
 * One self-signed certificate for every host. The key lives only in a run
 * directory under the ignored `.boardsesh/`, and teardown deletes it.
 */
export function createCertificate(directory: string): { key: Buffer; cert: Buffer } {
  const keyPath = join(directory, 'edge-key.pem');
  const certificatePath = join(directory, 'edge-certificate.pem');
  const hosts = [WWW_HOST, APP_HOST, WS_HOST, PROBE_HOST_ONE, PROBE_HOST_TWO];
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
      `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(',')}`,
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
}
