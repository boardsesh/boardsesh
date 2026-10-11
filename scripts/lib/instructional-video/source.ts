import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TUTORIAL_RELEASE_SOURCE_PATHS = [
  'packages/mobile/app',
  'packages/mobile/src',
  'packages/mobile/app.config.ts',
  'packages/mobile/package.json',
  'packages/mobile/metro.config.js',
  'packages/mobile/assets',
  'packages/mobile/locales',
  'packages/mobile/modules',
  'packages/backend/src',
  'packages/backend/package.json',
  'packages/shared',
  'packages/shared-schema',
  'packages/board-constants',
  'packages/board-renderer',
  'packages/db/src',
  'packages/db/drizzle',
  'packages/db/package.json',
  'package.json',
  'pnpm-lock.yaml',
  ':(exclude)packages/backend/src/scripts/*instructional-video.ts',
] as const;

/** Hash the actual runtime and capture tooling, including untracked source additions. */
export function tutorialCaptureSourceHash(repoRoot: string): string {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...TUTORIAL_RELEASE_SOURCE_PATHS.filter((path) => !path.startsWith(':')),
      'scripts/lib/android-sdk.ts',
      'scripts/mobile-dev-start.ts',
      'scripts/lib/metro-host.ts',
      'scripts/lib/tailscale-hostname.ts',
      'scripts/lib/showcase-video/android.ts',
      'scripts/lib/showcase-video/contract.ts',
      'scripts/lib/instructional-video/capture.ts',
      'scripts/lib/instructional-video/capture-crew.ts',
      'scripts/lib/instructional-video/capture-contract.ts',
      'scripts/lib/instructional-video/capture-media.ts',
      'scripts/lib/instructional-video/capture-bootstrap.ts',
      'scripts/lib/instructional-video/source.ts',
      'scripts/lib/instructional-video/demo.ts',
      'scripts/lib/instructional-video/snapshots.ts',
      'scripts/prepare-instructional-video-snapshots.ts',
      'scripts/lib/instructional-video/fixtures/compose.yml',
      'scripts/lib/instructional-video/types.ts',
      'scripts/instructional-video.ts',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const sourceHash = createHash('sha256');
  for (const path of [...new Set(paths.split('\n').filter(Boolean))].sort()) {
    const absolutePath = resolve(repoRoot, path);
    if (existsSync(absolutePath)) {
      const fileBytes = readFileSync(absolutePath);
      sourceHash.update(`${path}\0${fileBytes.length}\0`).update(fileBytes);
    }
  }
  return sourceHash.digest('hex');
}

export function tutorialModifiedSourcePaths(repoRoot: string, sourceRef = 'HEAD'): string[] {
  const tracked = execFileSync('git', ['diff', sourceRef, '--name-only', '--', ...TUTORIAL_RELEASE_SOURCE_PATHS], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', ...TUTORIAL_RELEASE_SOURCE_PATHS],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return `${tracked}\n${untracked}`.split('\n').filter(Boolean);
}

export function assertTutorialReleaseClean(changedPaths: readonly string[]): void {
  if (changedPaths.length)
    throw new Error(
      `Release capture cannot include modified app sources: ${changedPaths.slice(0, 5).join(', ')}. Capture the reviewed release sources first.`,
    );
}
