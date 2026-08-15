import { describe, expect, it } from 'vitest';
import { SCOPE_KINDS, scopeDefinition } from '@boardsesh/leaderboard';
import enBoards from '@boardsesh/i18n/locales/en-US/boards.json';
import { scopeKindLabelKey } from '../scope-labels';

/**
 * The label lookup is a template literal rather than `t(definition.labelKey)`,
 * because the i18n linter hard-fails on a dynamic `t()` it cannot analyse. That
 * leaves two sources of truth one edit apart, so this pins them together:
 * whatever the registry declares, the template must produce, and the catalog
 * must actually contain.
 */
describe('scope label keys', () => {
  it('matches every registry entry, so the template and the registry cannot drift', () => {
    for (const kind of SCOPE_KINDS) {
      expect(scopeKindLabelKey(kind)).toBe(scopeDefinition(kind).labelKey);
    }
  });

  it('resolves to real copy in the catalog for every kind', () => {
    const catalog = enBoards as Record<string, unknown>;
    const scopeLabels = (catalog.standings as Record<string, Record<string, string>> | undefined)?.scope;
    expect(scopeLabels).toBeDefined();

    for (const kind of SCOPE_KINDS) {
      // A missing entry here would render the raw key on screen.
      expect(scopeLabels?.[kind], `boards.standings.scope.${kind} is missing from the en-US catalog`).toBeTruthy();
    }
  });
});
