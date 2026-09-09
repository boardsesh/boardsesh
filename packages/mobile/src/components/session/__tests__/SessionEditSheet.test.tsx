// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const updateSession = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: undefined as unknown,
  reset: vi.fn(),
}));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticSuccess: vi.fn() }));

type ChildrenProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: ({
    value,
    onChangeText,
    placeholder,
    maxLength,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    maxLength?: number;
  }) =>
    createElement('input', {
      'data-textinput': 'true',
      'data-placeholder': placeholder ?? '',
      'data-maxlength': maxLength === undefined ? '' : String(maxLength),
      value: value ?? '',
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
}));

vi.mock('../../Sheet', () => ({
  Sheet: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) =>
    createElement('div', { 'data-sheet': 'true' }, children, footer),
}));

vi.mock('@boardsesh/shared-schema', () => ({ SESSION_NAME_MAX_LENGTH: 100, SESSION_NOTES_MAX_LENGTH: 2000 }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { SessionRenamed: 'Session Renamed' } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', tertiaryLabel: '#aaa', secondaryLabel: '#888' },
    brandColors: { error: '#c00', success: '#0a0' },
  }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useUpdateSession: () => updateSession }));
vi.mock('../../../lib/analytics', () => analytics);
vi.mock('../../../lib/haptics', () => haptics);
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { lg: 12 } }));

vi.mock('../../Text', () => ({
  Text: ({ children }: ChildrenProps) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-button': title }),
}));

import { SessionEditSheet } from '../SessionEditSheet';

const inputByPlaceholder = (root: HTMLElement, placeholder: string) =>
  root.querySelector(`[data-placeholder="${placeholder}"]`) as HTMLInputElement | null;
const nameInput = (root: HTMLElement) => inputByPlaceholder(root, 'creation.form.sessionNamePlaceholder');
const recapInput = (root: HTMLElement) => inputByPlaceholder(root, 'summary.commentPlaceholder');
const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;
const save = (root: HTMLElement) => fireEvent.click(button(root, 'detail.editSave')!);

describe('SessionEditSheet', () => {
  beforeEach(() => {
    updateSession.mutate.mockReset();
    updateSession.reset.mockReset();
    updateSession.isPending = false;
    updateSession.isError = false;
    updateSession.error = undefined;
    analytics.track.mockReset();
    haptics.hapticSuccess.mockReset();
  });

  it('seeds both fields from the current values on open', () => {
    const { container, rerender } = render(
      <SessionEditSheet visible={false} sessionId="s1" currentName="Sesh" currentNotes="Notes" onClose={() => {}} />,
    );
    rerender(<SessionEditSheet visible sessionId="s1" currentName="Sesh" currentNotes="Notes" onClose={() => {}} />);
    expect(nameInput(container)?.value).toBe('Sesh');
    expect(recapInput(container)?.value).toBe('Notes');
  });

  it('sends only the changed name (recap omitted) and tracks the rename', () => {
    const { container } = render(
      <SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />,
    );
    fireEvent.change(nameInput(container)!, { target: { value: 'New' } });
    save(container);
    expect(updateSession.mutate).toHaveBeenCalledTimes(1);
    const [variables] = updateSession.mutate.mock.calls[0];
    expect(variables).toEqual({ input: { sessionId: 's1', name: 'New' } });
    // Drive onSuccess so the rename analytics fire.
    const [, options] = updateSession.mutate.mock.calls[0];
    (options as { onSuccess: () => void }).onSuccess();
    expect(analytics.track).toHaveBeenCalledWith('Session Renamed', { source: 'session_detail', nameLength: 3 });
  });

  it('sends only the changed recap (name omitted) and does NOT track a rename', () => {
    const { container } = render(
      <SessionEditSheet visible sessionId="s1" currentName="Keep" currentNotes="Old recap" onClose={() => {}} />,
    );
    fireEvent.change(recapInput(container)!, { target: { value: 'New recap' } });
    save(container);
    const [variables] = updateSession.mutate.mock.calls[0];
    expect(variables).toEqual({ input: { sessionId: 's1', notes: 'New recap' } });
    const [, options] = updateSession.mutate.mock.calls[0];
    (options as { onSuccess: () => void }).onSuccess();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('sends both fields when both change', () => {
    const { container } = render(
      <SessionEditSheet visible sessionId="s1" currentName="A" currentNotes="B" onClose={() => {}} />,
    );
    fireEvent.change(nameInput(container)!, { target: { value: 'C' } });
    fireEvent.change(recapInput(container)!, { target: { value: 'D' } });
    save(container);
    const [variables] = updateSession.mutate.mock.calls[0];
    expect(variables).toEqual({ input: { sessionId: 's1', name: 'C', notes: 'D' } });
  });

  it('clears a field to null when emptied', () => {
    const { container } = render(
      <SessionEditSheet visible sessionId="s1" currentName="A" currentNotes="B" onClose={() => {}} />,
    );
    fireEvent.change(nameInput(container)!, { target: { value: '   ' } });
    save(container);
    const [variables] = updateSession.mutate.mock.calls[0];
    expect(variables).toEqual({ input: { sessionId: 's1', name: null } });
  });

  it('does not mutate and just closes when nothing changed', () => {
    const onClose = vi.fn();
    const { container } = render(
      <SessionEditSheet visible sessionId="s1" currentName="A" currentNotes="B" onClose={onClose} />,
    );
    save(container);
    expect(updateSession.mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // #5290: the sheet stays mounted (only `visible` toggles) while its owner keeps
  // editing. Before this fix, every closed→open transition unconditionally reseeded
  // name/recap from the (unchanged) server values — so a climber who tapped Save,
  // hit the (then-unfixable) daily-session validation error, gave up and closed the
  // sheet, then reopened to retry lost everything they had typed.
  it('preserves the typed recap after a failed save, across a close and reopen', () => {
    const { container, rerender } = render(
      <SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />,
    );
    fireEvent.change(recapInput(container)!, { target: { value: 'Great sesh, sent my project!' } });
    save(container);
    expect(updateSession.mutate).toHaveBeenCalledTimes(1);

    // The mutation settles into an error state.
    updateSession.isError = true;
    rerender(<SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />);
    expect(recapInput(container)?.value).toBe('Great sesh, sent my project!');

    // Close (Cancel / dismiss) and reopen to retry.
    rerender(
      <SessionEditSheet visible={false} sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />,
    );
    rerender(<SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />);

    expect(recapInput(container)?.value).toBe('Great sesh, sent my project!');
    expect(nameInput(container)?.value).toBe('Old');
  });

  it('still reseeds from server values on reopen when the last attempt did not fail', () => {
    const { container, rerender } = render(
      <SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />,
    );
    fireEvent.change(recapInput(container)!, { target: { value: 'Abandoned scratch draft' } });
    // No save attempt — just closed and reopened, e.g. by accident.
    rerender(
      <SessionEditSheet visible={false} sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />,
    );
    rerender(<SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />);

    expect(recapInput(container)?.value).toBe('Recap');
  });

  it('surfaces the real server error instead of the generic failure message', () => {
    const { container, rerender } = render(
      <SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />,
    );
    fireEvent.change(recapInput(container)!, { target: { value: 'New recap' } });
    save(container);
    updateSession.isError = true;
    updateSession.error = {
      response: { errors: [{ message: 'Invalid input: Session ID must be alphanumeric with hyphens only' }] },
    };
    rerender(<SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />);

    expect(container.textContent).toContain('Invalid input: Session ID must be alphanumeric with hyphens only');
    expect(container.textContent).not.toContain('detail.editSaveFailed');
  });

  it('falls back to the generic failure message when the server error carries no message', () => {
    const { container, rerender } = render(
      <SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />,
    );
    fireEvent.change(recapInput(container)!, { target: { value: 'New recap' } });
    save(container);
    updateSession.isError = true;
    updateSession.error = new Error('network blip');
    rerender(<SessionEditSheet visible sessionId="s1" currentName="Old" currentNotes="Recap" onClose={() => {}} />);

    expect(container.textContent).toContain('detail.editSaveFailed');
  });
});
