import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyTokenTables,
  BRAND_ROLE_USE,
  buildTokenTables,
  evaluateLiteral,
  extractObjectLiteral,
  markdownTable,
  renderDoc,
  stripComments,
} from './generate-velvet-token-tables';
import { brandColors } from '../packages/shared/velvet-tokens/src/index';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('markdownTable', () => {
  it('pads columns and escapes pipes', () => {
    expect(markdownTable(['A', 'Bee'], [['x|y', '1']])).toBe(
      ['| A    | Bee |', '| ---- | --- |', '| x\\|y | 1   |'].join('\n'),
    );
  });
});

describe('source reading', () => {
  it('strips comments but keeps strings that look like them', () => {
    expect(stripComments("a: 'http://x', // gone\n/* gone */ b: 1")).toBe("a: 'http://x', \n b: 1");
  });

  it('extracts a literal past nested braces and a trailing satisfies', () => {
    const source = "export const t = { a: { b: 1 }, c: '}' } as const satisfies Record<string, unknown>;";
    expect(evaluateLiteral(extractObjectLiteral(source, 't'), 't')).toEqual({ a: { b: 1 }, c: '}' });
  });

  it('refuses a literal that is no longer plain data', () => {
    expect(() => evaluateLiteral('{ a: compute(1) }', 'x')).toThrow(/no longer a plain object literal/);
    expect(() => evaluateLiteral('{ a: other.b }', 'x')).toThrow(/no longer a plain object literal/);
  });
});

describe('buildTokenTables', () => {
  const tables = buildTokenTables(REPO_ROOT);

  it('reads real values from the token sources', () => {
    expect(tables.brand).toContain(brandColors.primaryFill);
    expect(tables['ios-system']).toContain('systemGroupedBackground');
    expect(tables['android-fallback']).toContain('#F4F1FB');
    expect(tables['type-scale']).toContain('34 / 700 / 41');
    expect(tables.spacing).toContain('`16`');
  });

  it('explains every brand role', () => {
    for (const role of Object.keys(brandColors)) {
      expect(BRAND_ROLE_USE[role], `no Use text for brand role "${role}"`).toBeTruthy();
    }
  });
});

describe('applyTokenTables', () => {
  const marked = (name: string, body: string) =>
    `<!-- velvet-tokens:${name}:start -->\n\n${body}\n\n<!-- velvet-tokens:${name}:end -->`;

  it('rewrites a stale table and is idempotent', () => {
    const doc = `before\n${marked('spacing', '| stale |')}\nafter`;
    const once = applyTokenTables(doc, { spacing: '| fresh |' });
    expect(once).toContain('| fresh |');
    expect(once).not.toContain('stale');
    expect(applyTokenTables(once, { spacing: '| fresh |' })).toBe(once);
  });

  it('fails when a generated table has no marker pair', () => {
    expect(() => applyTokenTables('no markers', { spacing: '| x |' })).toThrow(/missing the "spacing" marker/);
  });

  it('fails on a marker the generator does not produce', () => {
    expect(() => applyTokenTables(marked('mystery', 'x'), {})).toThrow(/mystery/);
  });
});

describe('the committed design doc', () => {
  it('matches the token sources', () => {
    const { current, expected } = renderDoc(REPO_ROOT);
    expect(current).toBe(expected);
  });
});
