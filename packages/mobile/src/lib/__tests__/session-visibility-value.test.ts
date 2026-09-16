import { describe, expect, it } from 'vitest';
import { parseStoredSessionVisibility, serializeSessionVisibility } from '../session-visibility-value';

describe('session visibility stored value', () => {
  it('reads back what it wrote for the same session', () => {
    expect(parseStoredSessionVisibility(serializeSessionVisibility('session-1', false), 'session-1')).toBe(false);
    expect(parseStoredSessionVisibility(serializeSessionVisibility('session-1', true), 'session-1')).toBe(true);
  });

  it('never answers for another session', () => {
    expect(parseStoredSessionVisibility(serializeSessionVisibility('session-1', false), 'session-2')).toBeNull();
  });

  it('treats an empty or malformed slot as unknown', () => {
    expect(parseStoredSessionVisibility(null, 'session-1')).toBeNull();
    expect(parseStoredSessionVisibility('', 'session-1')).toBeNull();
    expect(parseStoredSessionVisibility('not json', 'session-1')).toBeNull();
    expect(parseStoredSessionVisibility('null', 'session-1')).toBeNull();
    expect(parseStoredSessionVisibility('{"sessionId":"session-1","isPublic":"false"}', 'session-1')).toBeNull();
  });
});
