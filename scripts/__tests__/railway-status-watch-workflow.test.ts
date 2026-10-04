import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { withoutCommentLines } from './helpers/workflow-yaml';

const workflow = withoutCommentLines(
  readFileSync(resolve(import.meta.dirname, '../../.github/workflows/railway-status-watch.yml'), 'utf8'),
).join('\n');
const script = readFileSync(resolve(import.meta.dirname, '../railway-status-notify.ts'), 'utf8');

describe('railway status watch workflow', () => {
  it('can read the Discord webhook, which is a Production environment secret', () => {
    expect(workflow).toContain('environment: Production');
    expect(workflow).toContain('DISCORD_DEPLOY_WEBHOOK: ${{ secrets.DISCORD_DEPLOY_WEBHOOK }}');
  });

  it('never runs two passes over the same seen-list', () => {
    expect(workflow).toContain('group: railway-status-watch');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('restores and saves the same state file the script is told to use', () => {
    const statePath = '.boardsesh/railway-status-seen.json';
    expect(workflow.split(`path: ${statePath}`)).toHaveLength(3);
    expect(workflow).toContain(`args=(--state-file ${statePath})`);
    expect(workflow).toContain('restore-keys: |\n            railway-status-seen-');
    expect(workflow).toContain(
      "if: always() && steps.notify.outputs.changed == 'true' && github.ref == 'refs/heads/main'",
    );
  });

  it('keys the cache per attempt, so a re-run restores the newest list and not its own old one', () => {
    const cacheKey = 'key: railway-status-seen-${{ github.run_id }}-${{ github.run_attempt }}';
    expect(workflow.split(cacheKey)).toHaveLength(3);
  });

  it('runs the script with plain node, so the script may only import node: builtins', () => {
    expect(workflow).toContain('node scripts/railway-status-notify.ts');
    expect(workflow).not.toContain('vp install');
    const importSources = [...script.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
    expect(importSources.length).toBeGreaterThan(0);
    expect(importSources.filter((source) => !source.startsWith('node:'))).toEqual([]);
  });
});
