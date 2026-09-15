import { describe, expect, it } from 'vitest';
import { MAX_HOLDS_PER_WALL, MAX_SPRAY_WALLS_PER_USER, MAX_VERSIONS_PER_WALL } from '@boardsesh/board-config';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import { SPRAY_CAP_CODES, SPRAY_CAP_VALUES, sprayCapCopy, sprayCapFromErrorCode } from '../spray-cap-copy';

/**
 * The caps, as the climber reads them.
 *
 * The point of this file is the last test: the NUMBER in the rendered sentence
 * has to come from `@boardsesh/board-config`, the same constant the server
 * refuses on. So the catalog strings are interpolated for real and the output is
 * checked against the constant — change a cap in board-config and this reds,
 * which is exactly what should happen to copy that would otherwise go on telling
 * a climber the rule is 1,500 after it became 2,000.
 *
 * en-US only: `catalog-completeness.test.ts` in `@boardsesh/i18n` already
 * enforces that every locale carries every key, and asserting a Spanish sentence
 * here would pin a translation rather than the wiring.
 */

const catalog = boardsCatalog as { sprayCaps: Record<string, string>; sprayEditor: { errors: Record<string, string> } };

/** The interpolation i18next does, reduced to the one placeholder these use. */
function render(template: string, values: Record<string, number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values[key]));
}

describe('spray cap copy', () => {
  it('names an i18n key and the value for every cap', () => {
    expect(sprayCapCopy('walls')).toEqual({ key: 'sprayCaps.walls', values: { max: MAX_SPRAY_WALLS_PER_USER } });
    expect(sprayCapCopy('holds')).toEqual({ key: 'sprayCaps.holds', values: { max: MAX_HOLDS_PER_WALL } });
    expect(sprayCapCopy('versions')).toEqual({ key: 'sprayCaps.versions', values: { max: MAX_VERSIONS_PER_WALL } });
  });

  it('recognises a cap refusal by its code and nothing else', () => {
    expect(sprayCapFromErrorCode(SPRAY_CAP_CODES.walls)).toBe('walls');
    expect(sprayCapFromErrorCode(SPRAY_CAP_CODES.holds)).toBe('holds');
    expect(sprayCapFromErrorCode(SPRAY_CAP_CODES.versions)).toBe('versions');
    expect(sprayCapFromErrorCode('RATE_LIMITED')).toBeNull();
    expect(sprayCapFromErrorCode(null)).toBeNull();
    // Never the message text: the server's prose is not a contract and is not
    // translated, so a client that matched on it would stop recognising the cap
    // the first time somebody reworded the error.
    expect(sprayCapFromErrorCode('You already have 10 spray walls')).toBeNull();
  });

  it('renders every cap sentence with the number board-config enforces', () => {
    const rendered = {
      walls: render(catalog.sprayCaps.walls, sprayCapCopy('walls').values),
      wallsHint: render(catalog.sprayCaps.wallsHint, { max: SPRAY_CAP_VALUES.walls }),
      holds: render(catalog.sprayCaps.holds, sprayCapCopy('holds').values),
      versions: render(catalog.sprayCaps.versions, sprayCapCopy('versions').values),
      editorTooMany: render(catalog.sprayEditor.errors.tooManyHolds, { max: SPRAY_CAP_VALUES.holds }),
    };

    expect(rendered.walls).toContain(String(MAX_SPRAY_WALLS_PER_USER));
    expect(rendered.wallsHint).toContain(String(MAX_SPRAY_WALLS_PER_USER));
    expect(rendered.holds).toContain(String(MAX_HOLDS_PER_WALL));
    expect(rendered.versions).toContain(String(MAX_VERSIONS_PER_WALL));
    expect(rendered.editorTooMany).toContain(String(MAX_HOLDS_PER_WALL));

    // And no placeholder survived: a sentence that still reads "{{max}}" is a
    // call site that forgot the values object, which the checks above would miss.
    for (const [key, value] of Object.entries(rendered)) expect(value, key).not.toContain('{{');
  });
});
