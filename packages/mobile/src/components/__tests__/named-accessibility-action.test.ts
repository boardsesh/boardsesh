import { describe, it, expect, vi } from 'vitest';
import {
  LONG_PRESS_ACTION_NAME,
  namedAccessibilityActions,
  onNamedAccessibilityAction,
} from '../../lib/named-accessibility-action';

describe('named accessibility action', () => {
  it('publishes one labelled action', () => {
    expect(namedAccessibilityActions(LONG_PRESS_ACTION_NAME, 'Climb actions')).toEqual([
      { name: LONG_PRESS_ACTION_NAME, label: 'Climb actions' },
    ]);
  });

  it('runs the handler only for its own action name', () => {
    const run = vi.fn();
    const handler = onNamedAccessibilityAction(LONG_PRESS_ACTION_NAME, run);
    handler({ nativeEvent: { actionName: 'other' } } as never);
    expect(run).not.toHaveBeenCalled();
    handler({ nativeEvent: { actionName: LONG_PRESS_ACTION_NAME } } as never);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
