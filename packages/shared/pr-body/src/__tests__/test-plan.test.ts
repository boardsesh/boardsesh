import { describe, expect, it } from 'vitest';
import { parseTestPlan } from '../test-plan';

describe('parseTestPlan', () => {
  it('reads numbered steps', () => {
    const body = ['## Test plan', '', '1. You tab → Log a tick', '2. Type 5 lines → field grows', '', '## Risk'].join(
      '\n',
    );
    expect(parseTestPlan(body)).toEqual({
      steps: ['You tab → Log a tick', 'Type 5 lines → field grows'],
      raw: '1. You tab → Log a tick\n2. Type 5 lines → field grows',
    });
  });

  it('reads bulleted steps too', () => {
    expect(parseTestPlan('## Test plan\n- one\n* two\n+ three')?.steps).toEqual(['one', 'two', 'three']);
  });

  it('folds indented sub-bullets and wrapped prose into the previous step', () => {
    const body = [
      '### Test plan',
      '1. Open Boards',
      '   - expect the list',
      '   loads in under a second',
      '2. Tap one',
    ].join('\n');
    expect(parseTestPlan(body)?.steps).toEqual(['Open Boards expect the list loads in under a second', 'Tap one']);
  });

  it('ignores the template placeholder, comments, trailers, and code fences', () => {
    const body = [
      '## Test plan',
      '<!-- write 1–5 steps -->',
      '1.',
      '```',
      '1. not a step',
      '```',
      'Co-Authored-By: Bot <bot@example.com>',
      'https://claude.ai/code/session_1',
    ].join('\n');
    expect(parseTestPlan(body)).toEqual({ steps: [], raw: '1.\n```\n1. not a step\n```' });
  });

  it('returns null without the heading', () => {
    expect(parseTestPlan('## Summary\n1. nope')).toBeNull();
    expect(parseTestPlan(undefined)).toBeNull();
  });

  it('treats prose without list markers as no steps', () => {
    expect(parseTestPlan('## Test plan\nRan the suite, all green.')?.steps).toEqual([]);
  });
});
