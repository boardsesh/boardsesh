import { describe, expect, it, vi } from 'vitest';
import { createAddressedHandoff } from '../addressed-handoff';

describe('createAddressedHandoff', () => {
  it('delivers only to the subscribers under the emitted id, every one of them', () => {
    const handoff = createAddressedHandoff<string>();
    const opener = vi.fn();
    const sameOpenerAgain = vi.fn();
    const otherOpener = vi.fn();
    handoff.subscribe('filter-picker-1', opener);
    handoff.subscribe('filter-picker-1', sameOpenerAgain);
    handoff.subscribe('filter-picker-2', otherOpener);

    handoff.emit('filter-picker-1', 'picks');

    expect(opener).toHaveBeenCalledWith('picks');
    expect(sameOpenerAgain).toHaveBeenCalledWith('picks');
    expect(otherOpener).not.toHaveBeenCalled();
  });

  it('delivers an empty id to nobody, even a subscriber under it', () => {
    const handoff = createAddressedHandoff<string>();
    const listener = vi.fn();
    handoff.subscribe('', listener);
    handoff.emit('', 'picks');
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops delivering once unsubscribed, including from inside a delivery', () => {
    const handoff = createAddressedHandoff<string>();
    const later = vi.fn();
    const unsubscribeFirst = handoff.subscribe('filter-picker-1', () => unsubscribeFirst());
    handoff.subscribe('filter-picker-1', later);
    handoff.emit('filter-picker-1', 'first');
    expect(later).toHaveBeenCalledTimes(1);

    const unsubscribeLater = handoff.subscribe('filter-picker-3', later);
    unsubscribeLater();
    handoff.emit('filter-picker-3', 'second');
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("keeps channels apart: one handoff never delivers another one's results", () => {
    const holds = createAddressedHandoff<string>();
    const zones = createAddressedHandoff<string>();
    const zoneListener = vi.fn();
    zones.subscribe('filter-picker-1', zoneListener);
    holds.emit('filter-picker-1', 'holds');
    expect(zoneListener).not.toHaveBeenCalled();
  });
});
