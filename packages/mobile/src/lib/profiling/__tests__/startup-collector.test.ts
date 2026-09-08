import { describe, expect, it } from 'vitest';
import { createStartupCollector, homeEmptyStartupOutcome } from '../startup-collector';

describe('local startup collector', () => {
  it('does not read clocks or retain marks while disabled', () => {
    const collector = createStartupCollector(false, () => {
      throw new Error('unexpected clock');
    });
    expect(collector.mark('root.commit')).toBe(false);
    expect(collector.snapshot()).toEqual([]);
  });

  it('keeps the first commit and isolates returned snapshots', () => {
    let timestamp = 1;
    const collector = createStartupCollector(true, () => timestamp++);
    expect(collector.mark('home.useful.commit', 'offline')).toBe(true);
    for (let render = 0; render < 200; render++) collector.mark('home.useful.commit', 'content');
    collector.snapshot()[0].timestampMs = 999;
    expect(collector.snapshot()).toEqual([{ name: 'home.useful.commit', timestampMs: 1, outcome: 'offline' }]);
  });

  it('keeps SQLite initial gate and recovery separate', () => {
    let timestamp = 1;
    const collector = createStartupCollector(true, () => timestamp++);
    collector.mark('sqlite.initial.start');
    collector.mark('sqlite.initial.gate', 'degraded');
    collector.mark('sqlite.recovery.start');
    collector.mark('auth.initial.start');
    collector.mark('sqlite.recovery.end', 'ready');
    expect(collector.snapshot().map(({ name }) => name)).toEqual([
      'sqlite.initial.start',
      'sqlite.initial.gate',
      'sqlite.recovery.start',
      'auth.initial.start',
      'sqlite.recovery.end',
    ]);
  });
});

describe('Home useful empty-state outcome', () => {
  const loaded = { authenticated: true, blockedReason: null, loading: false, scopeReady: true, error: false };
  it('excludes unresolved scope and loading skeletons', () => {
    expect(homeEmptyStartupOutcome({ ...loaded, loading: true })).toBeNull();
    expect(homeEmptyStartupOutcome({ ...loaded, scopeReady: false })).toBeNull();
    expect(homeEmptyStartupOutcome({ ...loaded, loading: true, error: true })).toBeNull();
  });
  it('records empty, offline, and error content matching rendered precedence', () => {
    expect(homeEmptyStartupOutcome(loaded)).toBe('empty');
    expect(homeEmptyStartupOutcome({ ...loaded, authenticated: false, loading: true })).toBe('empty');
    expect(homeEmptyStartupOutcome({ ...loaded, error: true })).toBe('error');
    expect(homeEmptyStartupOutcome({ ...loaded, blockedReason: 'offline', loading: true })).toBe('offline');
    expect(homeEmptyStartupOutcome({ ...loaded, blockedReason: 'error', loading: true })).toBe('error');
  });
});
