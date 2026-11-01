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

  it('publishes several labelled actions and runs whichever fired', () => {
    const openSheet = vi.fn();
    const drive = vi.fn();
    const actions = [
      { name: LONG_PRESS_ACTION_NAME, label: 'Board controls', run: openSheet },
      { name: 'drive', label: 'Light every climb', run: drive },
    ];
    expect(namedAccessibilityActions(actions)).toEqual([
      { name: LONG_PRESS_ACTION_NAME, label: 'Board controls' },
      { name: 'drive', label: 'Light every climb' },
    ]);
    const handler = onNamedAccessibilityAction(actions);
    handler({ nativeEvent: { actionName: 'drive' } } as never);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(openSheet).not.toHaveBeenCalled();
    handler({ nativeEvent: { actionName: LONG_PRESS_ACTION_NAME } } as never);
    expect(openSheet).toHaveBeenCalledTimes(1);
    handler({ nativeEvent: { actionName: 'activate' } } as never);
    expect(drive).toHaveBeenCalledTimes(1);
  });
});
