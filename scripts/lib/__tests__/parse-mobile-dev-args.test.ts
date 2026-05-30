import { describe, it, expect } from 'vitest';
import { parseMobileDevArgs } from '../parse-mobile-dev-args';

describe('parseMobileDevArgs', () => {
  it('returns defaults for an empty argv', () => {
    expect(parseMobileDevArgs([], {})).toEqual({
      qaNotesFilePath: null,
      simulator: false,
      passthroughArgs: [],
    });
  });

  it('recognises --simulator and strips it from passthrough', () => {
    const result = parseMobileDevArgs(['--simulator', '--port', '8084'], {});
    expect(result.simulator).toBe(true);
    expect(result.passthroughArgs).toEqual(['--port', '8084']);
  });

  it('honours BOARDSESH_DEV_SIMULATOR=1 from env', () => {
    const result = parseMobileDevArgs([], { BOARDSESH_DEV_SIMULATOR: '1' });
    expect(result.simulator).toBe(true);
  });

  it('treats BOARDSESH_DEV_SIMULATOR values other than "1" as false', () => {
    expect(parseMobileDevArgs([], { BOARDSESH_DEV_SIMULATOR: 'true' }).simulator).toBe(false);
    expect(parseMobileDevArgs([], { BOARDSESH_DEV_SIMULATOR: '0' }).simulator).toBe(false);
    expect(parseMobileDevArgs([], {}).simulator).toBe(false);
  });

  it('lets an explicit --simulator override an unset env', () => {
    const result = parseMobileDevArgs(['--simulator'], {});
    expect(result.simulator).toBe(true);
  });

  it('parses --qa-notes-file with a separate value', () => {
    const result = parseMobileDevArgs(['--qa-notes-file', 'notes.md'], {});
    expect(result.qaNotesFilePath).toBe('notes.md');
    expect(result.passthroughArgs).toEqual([]);
  });

  it('parses --qa-notes-file= inline form', () => {
    const result = parseMobileDevArgs(['--qa-notes-file=plan.md'], {});
    expect(result.qaNotesFilePath).toBe('plan.md');
    expect(result.passthroughArgs).toEqual([]);
  });

  it('accepts the --qa-plan-file alias', () => {
    expect(parseMobileDevArgs(['--qa-plan-file', 'p.md'], {}).qaNotesFilePath).toBe('p.md');
    expect(parseMobileDevArgs(['--qa-plan-file=p.md'], {}).qaNotesFilePath).toBe('p.md');
  });

  it('throws when --qa-notes-file has no value', () => {
    expect(() => parseMobileDevArgs(['--qa-notes-file'], {})).toThrow(/requires a file path/);
    expect(() => parseMobileDevArgs(['--qa-notes-file', '--port'], {})).toThrow(/requires a file path/);
    expect(() => parseMobileDevArgs(['--qa-notes-file='], {})).toThrow(/requires a file path/);
  });

  it('passes unknown flags through unchanged', () => {
    const result = parseMobileDevArgs(['--clear', '--host', 'lan'], {});
    expect(result.passthroughArgs).toEqual(['--clear', '--host', 'lan']);
  });

  it('combines --simulator with QA notes and passthrough args', () => {
    const result = parseMobileDevArgs(['--simulator', '--qa-notes-file=x.md', '--clear'], {});
    expect(result).toEqual({
      qaNotesFilePath: 'x.md',
      simulator: true,
      passthroughArgs: ['--clear'],
    });
  });
});
