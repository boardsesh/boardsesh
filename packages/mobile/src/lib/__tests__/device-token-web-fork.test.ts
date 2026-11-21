import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Where the #7656 device-token header may appear. The backend's CORS does not
// allow it (packages/backend/src/handlers/cors.ts), so a browser that sent it
// would fail the preflight and could not sign in: no `.web` file may name it.
// And it rides on one request only, the native password sign-in.

const mobileRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_DIRECTORIES = ['src', 'app', 'modules'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '__tests__', 'ios', 'android', 'build']);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

// Read from source rather than imported: importing the store would load the
// real expo-secure-store, which does not run under Node.
const NATIVE_DEVICE_TOKEN_HEADER = /NATIVE_DEVICE_TOKEN_HEADER\s*=\s*'([^']+)'/.exec(
  readFileSync(join(mobileRoot, 'src', 'lib', 'device-token-store.ts'), 'utf8'),
)?.[1];

const files = SOURCE_DIRECTORIES.flatMap((directory) => sourceFiles(join(mobileRoot, directory)));
const relativePath = (path: string) => relative(mobileRoot, path);
const header = (): string => NATIVE_DEVICE_TOKEN_HEADER ?? 'missing-header-constant';

describe('device-token header placement', () => {
  it('scans the real source tree', () => {
    expect(NATIVE_DEVICE_TOKEN_HEADER).toBe('x-boardsesh-device-token');
    expect(files.some((path) => relativePath(path) === join('src', 'lib', 'auth.web.ts'))).toBe(true);
  });

  it('is named in no .web file', () => {
    const offenders = files
      .filter((path) => /\.web\.(?:ts|tsx|js|jsx)$/.test(path))
      .filter((path) => readFileSync(path, 'utf8').toLowerCase().includes(header()))
      .map(relativePath);
    expect(offenders).toEqual([]);
  });

  it('is spelled out in the native device-token store only', () => {
    const offenders = files
      .filter((path) => readFileSync(path, 'utf8').toLowerCase().includes(header()))
      .map(relativePath);
    expect(offenders).toEqual([join('src', 'lib', 'device-token-store.ts')]);
  });

  it('is added to the native credentials request and nowhere else', () => {
    const callers = files
      .filter((path) => readFileSync(path, 'utf8').includes('deviceTokenHeadersForCredentialsSignIn('))
      .map(relativePath)
      .filter((path) => !path.startsWith(join('src', 'lib', 'device-token-store')));
    expect(callers).toEqual([join('src', 'lib', 'auth.ts')]);

    const auth = readFileSync(join(mobileRoot, 'src', 'lib', 'auth.ts'), 'utf8');
    const credentialsSignIn = auth.slice(
      auth.indexOf('export async function signInWithCredentials('),
      auth.indexOf('export async function registerWithCredentials('),
    );
    expect(credentialsSignIn).toContain('deviceTokenHeadersForCredentialsSignIn(email)');
    expect(credentialsSignIn).toContain('`${BACKEND_URL}/auth/native/credentials`');
    expect(auth.split('deviceTokenHeadersForCredentialsSignIn(').length - 1).toBe(1);
  });

  it('matches the header the backend reads', () => {
    const protocol = readFileSync(join(mobileRoot, '..', 'shared', 'auth-protocol', 'src', 'native-v1.ts'), 'utf8');
    const declared = /NATIVE_V1_DEVICE_TOKEN_HEADER\s*=\s*['"]([^'"]+)['"]/.exec(protocol)?.[1];
    expect(declared).toBe(NATIVE_DEVICE_TOKEN_HEADER);
  });
});
