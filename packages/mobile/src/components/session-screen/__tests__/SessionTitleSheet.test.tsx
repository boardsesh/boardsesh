// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const updateSession = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  reset: vi.fn(),
}));
const queryClient = vi.hoisted(() => ({ setQueryData: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticSuccess: vi.fn() }));

type ChildrenProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', {}, children),
  KeyboardAvoidingView: ({ children }: ChildrenProps) => createElement('div', { 'data-kav': 'true' }, children),
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

// The Sheet mock always renders its children + footer so the input and buttons
// are queryable regardless of `visible` — the seeding effect keys off the
// `visible` prop transition, not off whether the body is mounted.
vi.mock('../../Sheet', () => ({
  Sheet: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) =>
    createElement('div', { 'data-sheet': 'true' }, children, footer),
}));

vi.mock('@boardsesh/shared-schema', () => ({ SESSION_NAME_MAX_LENGTH: 100 }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { SessionRenamed: 'Session Renamed' } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', tertiaryLabel: '#aaa' },
    brandColors: { error: '#c00' },
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
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', {
      onClick: onPress,
      'data-button': title,
      'data-disabled': disabled ? 'true' : 'false',
    }),
}));

import { SessionTitleSheet } from '../SessionTitleSheet';

const input = (root: HTMLElement) => root.querySelector('[data-textinput]') as HTMLInputElement | null;
const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

describe('SessionTitleSheet', () => {
  beforeEach(() => {
    updateSession.mutate.mockReset();
    updateSession.reset.mockReset();
    updateSession.isPending = false;
    updateSession.isError = false;
    queryClient.setQueryData.mockReset();
    analytics.track.mockReset();
    haptics.hapticSuccess.mockReset();
  });

  it('seeds the input from the current name on open', () => {
    const { container, rerender } = render(
      <SessionTitleSheet visible={false} sessionId="s1" currentName="Morning Sesh" onClose={() => {}} />,
    );
    // Closed → open transition seeds the field.
    rerender(<SessionTitleSheet visible sessionId="s1" currentName="Morning Sesh" onClose={() => {}} />);
    expect(input(container)?.value).toBe('Morning Sesh');
  });

  it('re-seeds from the current name on each reopen', () => {
    const { container, rerender } = render(
      <SessionTitleSheet visible sessionId="s1" currentName="First" onClose={() => {}} />,
    );
    expect(input(container)?.value).toBe('First');
    // Edit locally, then close and reopen with a new server name.
    fireEvent.change(input(container)!, { target: { value: 'scratch' } });
    rerender(<SessionTitleSheet visible={false} sessionId="s1" currentName="Second" onClose={() => {}} />);
    rerender(<SessionTitleSheet visible sessionId="s1" currentName="Second" onClose={() => {}} />);
    expect(input(container)?.value).toBe('Second');
  });

  it('caps the input at SESSION_NAME_MAX_LENGTH', () => {
    const { container } = render(<SessionTitleSheet visible sessionId="s1" currentName={null} onClose={() => {}} />);
    expect(input(container)?.getAttribute('data-maxlength')).toBe('100');
  });

  it('saves the trimmed name through updateSession', () => {
    const { container } = render(<SessionTitleSheet visible sessionId="s1" currentName={null} onClose={() => {}} />);
    fireEvent.change(input(container)!, { target: { value: '  Evening Board  ' } });
    fireEvent.click(button(container, 'mobile.session.renameSave')!);
    expect(updateSession.mutate).toHaveBeenCalledTimes(1);
    const [variables] = updateSession.mutate.mock.calls[0];
    expect(variables).toEqual({ input: { sessionId: 's1', name: 'Evening Board' } });
  });

  it('sends null when the name is cleared to empty', () => {
    const { container } = render(
      <SessionTitleSheet visible sessionId="s1" currentName="Old name" onClose={() => {}} />,
    );
    fireEvent.change(input(container)!, { target: { value: '   ' } });
    fireEvent.click(button(container, 'mobile.session.renameSave')!);
    const [variables] = updateSession.mutate.mock.calls[0];
    expect(variables).toEqual({ input: { sessionId: 's1', name: null } });
  });

  it('shows an inline error when the save fails', () => {
    updateSession.isError = true;
    const { container } = render(<SessionTitleSheet visible sessionId="s1" currentName={null} onClose={() => {}} />);
    expect(container.textContent).toContain('mobile.session.renameError');
  });

  it('optimistically patches the sessionDetail cache, tracks, and closes on success', () => {
    const onClose = vi.fn();
    const { container } = render(<SessionTitleSheet visible sessionId="s1" currentName={null} onClose={onClose} />);
    fireEvent.change(input(container)!, { target: { value: 'Named' } });
    fireEvent.click(button(container, 'mobile.session.renameSave')!);

    // Drive the mutation's per-call onSuccess as the hook would.
    const [, options] = updateSession.mutate.mock.calls[0];
    (options as { onSuccess: (updated: { name: string | null }) => void }).onSuccess({ name: 'Named' });

    // Both title sources get patched: the preview (works for zero-tick
    // sessions, where sessionDetail is null) and the detail.
    expect(queryClient.setQueryData).toHaveBeenCalledTimes(2);
    const [previewKey, previewUpdater] = queryClient.setQueryData.mock.calls[0];
    expect(previewKey).toEqual(['sessionPreview', 's1']);
    expect((previewUpdater as (p: unknown) => unknown)({ id: 's1', name: 'old' })).toEqual({
      id: 's1',
      name: 'Named',
    });
    expect((previewUpdater as (p: unknown) => unknown)(null)).toBeNull();
    const [detailKey, detailUpdater] = queryClient.setQueryData.mock.calls[1];
    expect(detailKey).toEqual(['sessionDetail', 's1']);
    // The updater merges the new name into the cached detail.
    expect((detailUpdater as (p: unknown) => unknown)({ sessionId: 's1', sessionName: 'old' })).toEqual({
      sessionId: 's1',
      sessionName: 'Named',
    });
    // ...and leaves a missing cache entry untouched.
    expect((detailUpdater as (p: unknown) => unknown)(undefined)).toBeUndefined();

    expect(haptics.hapticSuccess).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith('Session Renamed', { source: 'record_chrome', nameLength: 5 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
