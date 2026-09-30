import { describe, expect, it } from 'vitest';
import { LOG_LINES, logLine } from './log-lines';

describe('logLine', () => {
  it('picks one of the lines for the outcome', () => {
    expect(LOG_LINES.send).toContain(logLine('send', () => 0.5));
  });

  it('never repeats the line it just showed', () => {
    const first = logLine('flash', () => 0);
    const second = logLine('flash', () => 0);
    expect(second).not.toBe(first);
    expect(LOG_LINES.flash).toContain(second);
  });
});
