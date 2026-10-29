import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GENERATED_CHANGELOGS = ['CHANGELOG.md', 'packages/mobile/src/data/changelog.generated.json'] as const;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export type ChangelogOwnershipContext = {
  baseBranch: string | undefined;
  baseSha: string | undefined;
  headSha: string | undefined;
};

/** Only an exact carry from newly imported, trusted main history may touch generated changelogs. */
export function checkChangelogOwnership(context: ChangelogOwnershipContext, cwd = process.cwd()): string {
  const { baseBranch, baseSha, headSha } = context;
  if (baseBranch !== 'release/next') throw new Error('Generated changelogs may only be carried into release/next.');
  if (!baseSha || !headSha || !COMMIT_SHA.test(baseSha) || !COMMIT_SHA.test(headSha)) {
    throw new Error('Exact PR base and head commit SHAs are required.');
  }

  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0)
      throw new Error(`Cannot verify changelog ownership: git ${args[0]} failed.`);
    return result.stdout.trim();
  };
  const isAncestor = (ancestor: string, descendant: string) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, encoding: 'utf8' });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error('Cannot verify changelog ownership ancestry.');
    }
    return result.status === 0;
  };

  git('rev-parse', '--verify', `${baseSha}^{commit}`);
  git('rev-parse', '--verify', `${headSha}^{commit}`);
  const mainSha = git('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
  if (!COMMIT_SHA.test(mainSha)) throw new Error('A fetched origin/main commit is required.');
  if (git('rev-parse', '--is-shallow-repository') !== 'false') {
    throw new Error('Complete history is required to verify changelog ownership.');
  }
  if (!isAncestor(baseSha, headSha)) throw new Error('The PR must retain the release train base history.');

  const mainAncestors = git('merge-base', '--all', headSha, mainSha).split('\n');
  if (mainAncestors.length !== 1 || !COMMIT_SHA.test(mainAncestors[0])) {
    throw new Error('The PR must have one unambiguous shared ancestor with trusted main.');
  }
  const trustedMainAncestor = mainAncestors[0];
  if (isAncestor(trustedMainAncestor, baseSha)) throw new Error('The PR imports no new trusted main history.');
  // Unrelated histories must not qualify merely because somebody merged them together.
  git('merge-base', baseSha, trustedMainAncestor);
  for (const path of GENERATED_CHANGELOGS) {
    const trustedEntry = git('ls-tree', trustedMainAncestor, '--', path);
    const headEntry = git('ls-tree', headSha, '--', path);
    if (!/^100644 blob [0-9a-f]{40}\t/.test(trustedEntry) || headEntry !== trustedEntry) {
      throw new Error(`${path} differs from the newly imported trusted main changelog. Revert manual edits.`);
    }
  }
  return trustedMainAncestor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ancestor = checkChangelogOwnership({
      baseBranch: process.env.PR_BASE_BRANCH,
      baseSha: process.env.PR_BASE_SHA,
      headSha: process.env.PR_HEAD_SHA,
    });
    console.log(`[changelog-owned] Exact generated changelogs carried from trusted main ${ancestor}.`);
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : 'Cannot verify generated changelog ownership.'}`,
    );
    process.exitCode = 1;
  }
}
