import { describe, expect, it } from 'vitest';

import { decideMigrationTarget } from '../dev-db-discover';

// Regression coverage for https://github.com/boardsesh/boardsesh/issues/6497:
// the discover script migrated a Tailscale peer's database, then failed at
// 0272 and left it half-migrated.
const pending = ['0265_first', '0272_sync_deletions_cutoff_guard'];

describe('decideMigrationTarget', () => {
  it('refuses to migrate a Tailscale peer and names it', () => {
    const decision = decideMigrationTarget(
      { source: 'tailscale', host: '100.64.0.7', label: 'vibetunnel-dev-1' },
      pending,
    );
    expect(decision.action).toBe('skip-remote');
    if (decision.action !== 'skip-remote') return;
    expect(decision.message).toContain('vibetunnel-dev-1');
    expect(decision.message).toContain('100.64.0.7');
    expect(decision.message).toContain('0272_sync_deletions_cutoff_guard');
  });

  it('refuses to migrate an env-provided host', () => {
    const decision = decideMigrationTarget({ source: 'env', host: 'db.example', label: 'env' }, pending);
    expect(decision.action).toBe('skip-remote');
  });

  it('migrates a database on this machine', () => {
    const decision = decideMigrationTarget({ source: 'local-standalone', host: 'localhost', label: 'local' }, pending);
    expect(decision).toEqual({ action: 'migrate' });
  });

  it('uses an up-to-date remote database as is', () => {
    const decision = decideMigrationTarget({ source: 'tailscale', host: '100.64.0.7', label: 'peer' }, []);
    expect(decision).toEqual({ action: 'use' });
  });
});
