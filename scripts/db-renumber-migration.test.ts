import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  STICKY_MARKER,
  classifyGenerate,
  conflictsAreResolvable,
  normalizeSql,
  parseArgs,
  renderComment,
  type RenumberResult,
} from './db-renumber-migration';
import { migrationFiles, planRenumber } from './lib/drizzle-migrations';

function result(overrides: Partial<RenumberResult> = {}): RenumberResult {
  return {
    status: 'renumbered',
    reason: null,
    strategy: 'rebase',
    moves: planRenumber(migrationFiles(['0187_greedy_thing.sql']), 188),
    diverged: [],
    rewritten: [],
    notes: [],
    ...overrides,
  };
}

describe('normalizeSql', () => {
  it('ignores indentation and blank lines', () => {
    expect(normalizeSql('ALTER TABLE "a"\n\n   ADD COLUMN "b" text;\n')).toBe(
      normalizeSql('ALTER TABLE "a"\nADD COLUMN "b" text;'),
    );
  });

  it('still distinguishes different statements', () => {
    expect(normalizeSql('ADD COLUMN "b" text;')).not.toBe(normalizeSql('ADD COLUMN "b" text NOT NULL;'));
  });
});

describe('conflictsAreResolvable', () => {
  it('accepts conflicts confined to the migration folder', () => {
    expect(conflictsAreResolvable(['packages/db/drizzle/meta/_journal.json', 'packages/db/drizzle/0187_x.sql'])).toBe(
      true,
    );
  });

  it('refuses when anything else conflicts', () => {
    // Resolving a real code conflict by rule would silently pick a side of
    // somebody's work; that always goes back to a human.
    expect(conflictsAreResolvable(['packages/db/drizzle/meta/_journal.json', 'packages/web/app/page.tsx'])).toBe(false);
  });

  it('refuses an empty conflict set', () => {
    expect(conflictsAreResolvable([])).toBe(false);
  });

  it('does not treat a sibling path prefix as inside the folder', () => {
    expect(conflictsAreResolvable(['packages/db/drizzle-extra/x.sql'])).toBe(false);
  });
});

describe('classifyGenerate', () => {
  const before = ['0186_tail.sql', 'meta'];

  it('reports the file drizzle-kit created', () => {
    expect(classifyGenerate(before, [...before, '0187_new.sql'], '').generated).toBe('0187_new.sql');
  });

  it('detects a no-op even though the exit code was 0', () => {
    // prepareAndMigratePg ends in `catch (e) { console.error(e); }` with no
    // rethrow, so every failure mode exits 0 — the file listing is the only
    // trustworthy signal.
    const outcome = classifyGenerate(before, before, 'No schema changes, nothing to migrate 😴');
    expect(outcome.generated).toBeNull();
    expect(outcome.detail).toContain('no schema delta');
  });

  it('names a snapshot parent collision, which exits 0 silently', () => {
    const outcome = classifyGenerate(
      before,
      before,
      '[...] are pointing to a parent snapshot: x which is a collision.',
    );
    expect(outcome.generated).toBeNull();
    expect(outcome.detail).toContain('meta/ was not reset');
  });

  it('reports a bare failure with no recognisable output', () => {
    expect(classifyGenerate(before, before, '').detail).toContain('produced nothing');
  });

  it('refuses to guess when more than one migration appeared', () => {
    const outcome = classifyGenerate(before, [...before, '0187_a.sql', '0188_b.sql'], '');
    expect(outcome.generated).toBeNull();
    expect(outcome.detail).toContain('2 migrations');
  });

  it('ignores non-sql files drizzle-kit writes alongside', () => {
    expect(classifyGenerate(before, [...before, '0187_new.sql', '0187_snapshot.json'], '').generated).toBe(
      '0187_new.sql',
    );
  });
});

describe('renderComment', () => {
  it('carries the sticky marker in every state', () => {
    for (const status of ['no-op', 'renumbered', 'blocked'] as const) {
      expect(renderComment(result({ status }))).toContain(STICKY_MARKER);
    }
  });

  it('names the rename and reassures about the SQL', () => {
    const body = renderComment(result());
    expect(body).toContain('0187_greedy_thing.sql');
    expect(body).toContain('0188_greedy_thing.sql');
    expect(body).toContain('Your SQL is unchanged');
  });

  it('surfaces a divergence as a review aid, stating that the author’s SQL won', () => {
    const body = renderComment(
      result({
        diverged: [
          { tag: '0188_greedy_thing', original: 'ADD COLUMN "b" text;', generated: 'ADD COLUMN "b" text NOT NULL;' },
        ],
      }),
    );
    expect(body).toContain('yours was kept');
    expect(body).toContain('ADD COLUMN "b" text NOT NULL;');
  });

  it('says nothing was pushed when blocked, and why', () => {
    const body = renderComment(result({ status: 'blocked', reason: 'The rebase conflicts outside the folder.' }));
    expect(body).toContain('Nothing was pushed');
    expect(body).toContain('conflicts outside the folder');
  });

  it('lists files whose tag references moved', () => {
    expect(renderComment(result({ rewritten: ['packages/db/src/testing/dedup-replay.ts'] }))).toContain(
      'dedup-replay.ts',
    );
  });
});

describe('conflict-resolution orientation', () => {
  // Guards a bug that shipped once: the merge path staged conflicted .sql files
  // without resolving them, committing conflict markers into the author's history.
  // `--ours`/`--theirs` mean opposite things in a merge and a rebase, so each path
  // needs its own flag to end up with the same thing (the branch's body).
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'db-renumber-migration.ts'), 'utf8');

  const bodyOf = (fnName: string): string => {
    const start = source.indexOf(`function ${fnName}(`);
    expect(start, `${fnName} not found`).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n}\n', start));
  };

  it('takes --theirs when rebasing (the replayed branch commit)', () => {
    expect(bodyOf('rebaseOntoBase')).toContain("'--theirs'");
  });

  it('takes --ours when merging (the branch being merged into)', () => {
    expect(bodyOf('mergeBaseRef')).toContain("'--ours'");
  });

  it('never stages a conflicted path without resolving it first', () => {
    for (const fnName of ['rebaseOntoBase', 'mergeBaseRef']) {
      const body = bodyOf(fnName);
      const stageIndex = body.indexOf("git(['add', '--', path])");
      expect(stageIndex, `${fnName} should stage the resolved path`).toBeGreaterThan(-1);
      const resolveIndex = Math.max(body.indexOf("'--ours'"), body.indexOf("'--theirs'"));
      expect(resolveIndex, `${fnName} must resolve the conflict at all`).toBeGreaterThan(-1);
      expect(resolveIndex, `${fnName} resolves before staging`).toBeLessThan(stageIndex);
    }
  });
});

describe('renderComment notes', () => {
  it('passes an inherited-orphan warning through without claiming it blocked', () => {
    // Main can already carry an orphan (0177_illegal_omega_red sat there for weeks).
    // Inheriting one must not wedge the renumber, so it is a note, not a block.
    const body = renderComment(
      result({ notes: ['`main` carries an orphaned migration (0177_illegal_omega_red.sql).'] }),
    );
    expect(body).toContain('Renumbered onto');
    expect(body).toContain('0177_illegal_omega_red.sql');
    expect(body).not.toContain('Nothing was pushed');
  });
});

describe('parseArgs', () => {
  it('defaults to rebase, fetching, and committing', () => {
    expect(parseArgs([])).toEqual({
      base: 'origin/main',
      strategy: 'rebase',
      dryRun: false,
      fetch: true,
      install: false,
      repo: null,
    });
  });

  it('skips the `--` that `vp run <task> -- <args>` forwards', () => {
    expect(parseArgs(['--', '--dry-run']).dryRun).toBe(true);
  });

  it('accepts the merge strategy', () => {
    expect(parseArgs(['--strategy', 'merge']).strategy).toBe('merge');
  });

  it('rejects an unknown strategy', () => {
    expect(() => parseArgs(['--strategy', 'squash'])).toThrow(/rebase or merge/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument/);
  });
});

describe('workflow comment trust boundary', () => {
  const workflowSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/db-migration-renumber.yml'),
    'utf8',
  );
  const renumberJobStart = workflowSource.indexOf('\n  renumber:\n');
  const commentJobStart = workflowSource.indexOf('\n  comment:\n');
  const renumberJob = workflowSource.slice(renumberJobStart, commentJobStart);
  const commentJob = workflowSource.slice(commentJobStart);

  it('keeps PR-controlled work out of the pull-request-write job', () => {
    expect(renumberJobStart).toBeGreaterThan(-1);
    expect(commentJobStart).toBeGreaterThan(renumberJobStart);
    expect(workflowSource.slice(0, renumberJobStart)).toContain('pull-requests: read');
    expect(renumberJob).not.toContain('renderRenumberWorkflowComment');
    expect(commentJob).toContain('needs: [gate, renumber]');
    expect(commentJob).toContain('pull-requests: write');
  });

  it('loads the helper from the immutable workflow commit on the fresh comment runner', () => {
    expect(commentJob).toContain('always() &&');
    expect(commentJob).toContain('ref: ${{ github.workflow_sha }}');
    expect(commentJob).toContain('sparse-checkout: scripts/lib/db-renumber-comment.cjs');
    expect(commentJob).toContain('persist-credentials: false');
    expect(commentJob).toContain('`${process.env.GITHUB_WORKSPACE}/scripts/lib/db-renumber-comment.cjs`');
    expect(commentJob).not.toContain('.renumber-tooling');
  });
});
