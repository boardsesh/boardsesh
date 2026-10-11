import { execFileSync } from 'node:child_process';

export const TUTORIAL_RELEASE_SOURCE_PATHS = [
  'packages/mobile/app',
  'packages/mobile/src',
  'packages/mobile/app.config.ts',
  'packages/mobile/package.json',
  'packages/backend/src',
  'packages/shared',
  'packages/shared-schema',
  'packages/board-constants',
  'packages/db/src',
  'package.json',
  'pnpm-lock.yaml',
  ':(exclude)packages/backend/src/scripts/*instructional-video.ts',
] as const;

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
