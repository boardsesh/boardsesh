// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * The viewer marker carries no authority (#7596 decision): the server writes
 * and clears it beside the session cookie and never reads it. This holds the
 * whole server side to that: the backend never names it, and in www only the
 * cookie builders name it (to write, clear and strip it), while only the
 * client guard reads it.
 */
const repoRoot = resolve(import.meta.dirname, '../../../../../..');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const MENTIONS_MARKER = /viewer-marker|boardsesh\.viewer|ViewerMarker|viewerMarker/;
/** Calls that read a marker out of cookies. Only the client guard may make them. */
const READS_MARKER = /\breadViewerMarker\s*\(|cookies\.get\(\s*[^)]*viewer/i;

const sources = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(
    (path) =>
      SOURCE.test(path) &&
      !path.includes('/node_modules/') &&
      !path.includes('/__tests__/') &&
      !/\.(?:test|spec|proof)\.[cm]?[jt]sx?$/.test(path),
  );
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('no server code reads the viewer marker', () => {
  it('scans the server sources it means to', () => {
    expect(sources).toContain('packages/web/app/lib/auth/browser-session.server.ts');
    expect(sources.some((path) => path.startsWith('packages/backend/src/'))).toBe(true);
  });

  it('the backend never names it', () => {
    expect(sources.filter((path) => path.startsWith('packages/backend/') && MENTIONS_MARKER.test(read(path)))).toEqual(
      [],
    );
  });

  it('in www only the cookie builders and the client guard name it', () => {
    expect(
      sources.filter(
        (path) =>
          path.startsWith('packages/web/') &&
          !path.startsWith('packages/web/e2e/') &&
          !path.startsWith('packages/web/auth-proofs/') &&
          MENTIONS_MARKER.test(read(path)),
      ),
    ).toEqual(['packages/web/app/lib/auth/browser-session.server.ts', 'packages/web/app/lib/auth/session-guard.ts']);
  });

  it('only the client guard reads it; the builders write, clear and strip it', () => {
    const readers = sources.filter((path) => path.startsWith('packages/web/app/') && READS_MARKER.test(read(path)));
    expect(readers).toEqual(['packages/web/app/lib/auth/session-guard.ts']);
    expect(read('packages/web/app/lib/auth/session-guard.ts')).not.toMatch(/^import 'server-only'/m);
  });
});
