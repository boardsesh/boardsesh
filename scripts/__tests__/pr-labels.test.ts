import { describe, expect, it } from 'vitest';
import { parseLabels } from '../lib/pr-labels';

describe('parseLabels', () => {
  it('reads the GitHub labels payload (objects with a name)', () => {
    expect(parseLabels('[{"name":"db-migration","color":"0052cc"},{"name":"skip-qa-gate"}]')).toEqual([
      'db-migration',
      'skip-qa-gate',
    ]);
  });

  it('reads a JSON array of strings and drops non-string junk', () => {
    expect(parseLabels('["a", "b", 3, {"nope": true}]')).toEqual(['a', 'b']);
  });

  it('reads a comma-separated list with whitespace', () => {
    expect(parseLabels(' a , b,,c ')).toEqual(['a', 'b', 'c']);
  });

  it('falls back to comma-splitting on malformed JSON', () => {
    expect(parseLabels('[not json')).toEqual(['[not json']);
  });

  it('returns nothing for unset, empty, or blank input', () => {
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels('')).toEqual([]);
    expect(parseLabels('   ')).toEqual([]);
    expect(parseLabels('[]')).toEqual([]);
  });
});
