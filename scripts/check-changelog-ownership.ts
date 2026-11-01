import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GENERATED_CHANGELOGS = ['CHANGELOG.md', 'packages/mobile/src/data/changelog.generated.json'] as const;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export type ChangelogOwnershipContext = {
  baseBranch: string | undefined;
  baseSha: string | undefined;
  headSha: string | undefined;
};

/** Generated changelog edits are forbidden on every PR target, without import exceptions. */
export function checkChangelogOwnership(context: ChangelogOwnershipContext, cwd = process.cwd()): string {
  const { baseSha, headSha } = context;
  if (!baseSha || !headSha || !COMMIT_SHA.test(baseSha) || !COMMIT_SHA.test(headSha)) {
    throw new Error('Exact PR base and head commit SHAs are required.');
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0)
      throw new Error(`Cannot verify changelog ownership: git ${args[0]} failed.`);
    return result.stdout.trim();
  };
  git('rev-parse', '--verify', `${baseSha}^{commit}`);
  git('rev-parse', '--verify', `${headSha}^{commit}`);
  const changed = git('diff', '--name-only', baseSha, headSha, '--', ...GENERATED_CHANGELOGS);
  if (changed) {
    throw new Error(
      `Generated changelogs are owned by the Mobile OTA Production workflow. Revert PR edits: ${changed.replace(/\n/g, ', ')}.`,
    );
  }
  return headSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkChangelogOwnership({
      baseBranch: process.env.PR_BASE_BRANCH,
      baseSha: process.env.PR_BASE_SHA,
      headSha: process.env.PR_HEAD_SHA,
    });
    console.log('[changelog-owned] No manual generated-changelog edits.');
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : 'Cannot verify generated changelog ownership.'}`,
    );
    process.exitCode = 1;
  }
}
