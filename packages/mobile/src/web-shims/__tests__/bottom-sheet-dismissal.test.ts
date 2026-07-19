import { describe, expect, it } from 'vitest';
import { initialSheetDismissalState, transitionSheetDismissal } from '../bottom-sheet-dismissal';

describe('web bottom-sheet dismissal cycle', () => {
  it('notifies once for each present-dismiss cycle', () => {
    let state = initialSheetDismissalState;

    let transition = transitionSheetDismissal(state, 'dismiss');
    expect(transition.shouldNotify).toBe(false);

    transition = transitionSheetDismissal(transition.state, 'present');
    state = transition.state;
    transition = transitionSheetDismissal(state, 'dismiss');
    expect(transition.shouldNotify).toBe(true);

    state = transition.state;
    transition = transitionSheetDismissal(state, 'dismiss');
    expect(transition.shouldNotify).toBe(false);

    transition = transitionSheetDismissal(transition.state, 'present');
    transition = transitionSheetDismissal(transition.state, 'dismiss');
    expect(transition.shouldNotify).toBe(true);
  });
});
