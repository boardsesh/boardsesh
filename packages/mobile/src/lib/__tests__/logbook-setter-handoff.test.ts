import { describe, expect, it, vi } from 'vitest';
import { emitLogbookSetterSelection, subscribeToLogbookSetterSelection } from '../logbook-setter-handoff';

describe('logbook setter handoff', () => {
  it('hands the picks only to the Logbook they are addressed to, without the address', () => {
    const ownLogbook = vi.fn();
    const otherLogbook = vi.fn();
    const unsubscribeOwn = subscribeToLogbookSetterSelection('filter-picker-1', ownLogbook);
    const unsubscribeOther = subscribeToLogbookSetterSelection('filter-picker-2', otherLogbook);

    emitLogbookSetterSelection({ handoffId: 'filter-picker-1', setterUsernames: ['sam'], apply: true });

    expect(ownLogbook).toHaveBeenCalledWith({ setterUsernames: ['sam'], apply: true });
    expect(otherLogbook).not.toHaveBeenCalled();
    unsubscribeOwn();
    unsubscribeOther();
  });

  it('hands picks with no address to nobody', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLogbookSetterSelection('', listener);
    emitLogbookSetterSelection({ handoffId: '', setterUsernames: ['sam'], apply: false });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops delivering once unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLogbookSetterSelection('filter-picker-1', listener);
    unsubscribe();
    emitLogbookSetterSelection({ handoffId: 'filter-picker-1', setterUsernames: [], apply: false });
    expect(listener).not.toHaveBeenCalled();
  });
});
