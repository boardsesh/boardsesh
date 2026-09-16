// @vitest-environment jsdom
//
// The dialog's wiring, which no other test can see. `draft-guard.test.ts` pins
// the RULE — with unsaved work the action is only ever reached through `confirm`
// — but not the Alert this binds it to: which button cancels, which one is
// destructive, and that only the destructive one runs the action. Getting that
// backwards throws a wall owner's unsaved holds away on the button they pressed
// to keep them.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Alert } from 'react-native';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

import { confirmDiscardSprayEdits } from '../spray-discard-guard';

const STRINGS = {
  title: 'Leave without saving?',
  message: 'Some holds are not on the wall yet.',
  keep: 'Keep editing',
  discard: 'Discard',
};

type AlertButton = { text: string; style?: string; onPress?: () => void };

function lastButtons(): AlertButton[] {
  const calls = vi.mocked(Alert.alert).mock.calls;
  return calls[calls.length - 1][2] as unknown as AlertButton[];
}

beforeEach(() => {
  vi.mocked(Alert.alert).mockReset();
});

describe('confirmDiscardSprayEdits', () => {
  it('does not ask when there is nothing unsaved, and runs the action at once', () => {
    const action = vi.fn();
    confirmDiscardSprayEdits(false, action, STRINGS);
    expect(Alert.alert).not.toHaveBeenCalled();
    // Synchronously: ordinary navigation must never feel gated.
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('asks before throwing unsaved holds away, and does not act until answered', () => {
    const action = vi.fn();
    confirmDiscardSprayEdits(true, action, STRINGS);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Alert.alert).mock.calls[0][0]).toBe(STRINGS.title);
    expect(vi.mocked(Alert.alert).mock.calls[0][1]).toBe(STRINGS.message);
    expect(action).not.toHaveBeenCalled();
  });

  it('offers cancel first and destructive second, with the caller-supplied labels', () => {
    confirmDiscardSprayEdits(true, vi.fn(), STRINGS);
    const [keep, discard] = lastButtons();
    expect(keep).toMatchObject({ text: STRINGS.keep, style: 'cancel' });
    expect(discard).toMatchObject({ text: STRINGS.discard, style: 'destructive' });
  });

  it('runs the action only from the destructive button', () => {
    const action = vi.fn();
    confirmDiscardSprayEdits(true, action, STRINGS);
    const [keep, discard] = lastButtons();

    // The cancel button carries no callback at all, so "keep editing" cannot
    // reach the action however it is dispatched.
    expect(keep.onPress).toBeUndefined();
    expect(action).not.toHaveBeenCalled();

    discard.onPress?.();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
