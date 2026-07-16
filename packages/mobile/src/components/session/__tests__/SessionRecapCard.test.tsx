// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const updateSession = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  reset: vi.fn(),
}));

const draftStore = vi.hoisted(() => ({
  getDraftComment: vi.fn(async (): Promise<string | null> => null),
  clearDraftComment: vi.fn(async () => {}),
}));

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

type ChildrenProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  TextInput: ({
    value,
    onChangeText,
    placeholder,
    accessibilityLabel,
    maxLength,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    accessibilityLabel?: string;
    maxLength?: number;
  }) =>
    createElement('input', {
      'data-textinput': 'true',
      'data-placeholder': placeholder ?? '',
      'data-aria': accessibilityLabel ?? '',
      'data-maxlength': maxLength === undefined ? '' : String(maxLength),
      value: value ?? '',
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
}));

vi.mock('@boardsesh/shared-schema', () => ({ SESSION_NOTES_MAX_LENGTH: 2000 }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { SessionCommentAdded: 'Session Comment Added' } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', fill: '#eee', label: '#000', tertiaryLabel: '#aaa' },
    brandColors: { error: '#c00' },
  }),
}));

vi.mock('../../../lib/graphql/hooks', () => ({ useUpdateSession: () => updateSession }));
vi.mock('../../../lib/session-comment-draft-store', () => draftStore);
vi.mock('../../../lib/analytics', () => analytics);
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12 },
  borderRadius: { lg: 12 },
}));

type CardMockProps = { children?: ReactNode; onPress?: () => void };
vi.mock('../../Card', () => ({
  Card: ({ children, onPress }: CardMockProps) =>
    createElement('div', { 'data-card': 'true', onClick: onPress }, children),
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', { 'data-text': 'true' }, children),
}));

type ButtonMockProps = { title: string; onPress?: () => void; loading?: boolean };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, loading }: ButtonMockProps) =>
    createElement('button', {
      onClick: onPress,
      'data-button': title,
      'data-loading': loading ? 'true' : 'false',
    }),
}));

import { SessionRecapCard } from '../SessionRecapCard';

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;
const textInput = (root: HTMLElement) => root.querySelector('[data-textinput]') as HTMLInputElement | null;

describe('SessionRecapCard', () => {
  beforeEach(() => {
    updateSession.mutate.mockReset();
    updateSession.reset.mockReset();
    updateSession.isPending = false;
    updateSession.isError = false;
    draftStore.getDraftComment.mockReset();
    draftStore.getDraftComment.mockResolvedValue(null);
    draftStore.clearDraftComment.mockReset();
    analytics.track.mockReset();
  });

  it('renders the recap in read mode when notes are present', () => {
    const { container } = render(<SessionRecapCard sessionId="s1" notes="Sent my project" editable />);
    expect(container.textContent).toContain('summary.recapTitle');
    expect(container.textContent).toContain('Sent my project');
    // No add-a-recap affordance when a recap already exists.
    expect(button(container, 'summary.addRecap')).toBeNull();
  });

  it('shows the add-a-recap button when empty and editable', () => {
    const { container } = render(<SessionRecapCard sessionId="s1" notes={null} editable />);
    expect(button(container, 'summary.addRecap')).not.toBeNull();
    expect(textInput(container)).toBeNull();
  });

  it('renders nothing when empty and not editable', () => {
    const { container } = render(<SessionRecapCard sessionId="s1" notes={null} editable={false} />);
    expect(button(container, 'summary.addRecap')).toBeNull();
    expect(textInput(container)).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('saves via updateSession with { sessionId, notes } from the inline editor', () => {
    const { container } = render(<SessionRecapCard sessionId="s1" notes={null} editable />);
    fireEvent.click(button(container, 'summary.addRecap')!);
    fireEvent.change(textInput(container)!, { target: { value: '  three send day  ' } });
    fireEvent.click(button(container, 'comment.save')!);
    expect(updateSession.mutate).toHaveBeenCalledTimes(1);
    const [variables] = updateSession.mutate.mock.calls[0];
    expect(variables).toEqual({ input: { sessionId: 's1', notes: 'three send day' } });
  });

  it('shows an inline error when the save fails', () => {
    updateSession.isError = true;
    const { container } = render(<SessionRecapCard sessionId="s1" notes={null} editable />);
    fireEvent.click(button(container, 'summary.addRecap')!);
    expect(container.textContent).toContain('summary.recapSaveError');
  });

  it('seeds the editor from a stored draft when the server recap is empty', async () => {
    draftStore.getDraftComment.mockResolvedValue('recovered draft');
    const { container } = render(<SessionRecapCard sessionId="s1" notes={null} editable />);
    // Draft seeding resolves on a microtask after mount.
    await waitFor(() => expect(draftStore.getDraftComment).toHaveBeenCalledWith('s1'));
    fireEvent.click(button(container, 'summary.addRecap')!);
    await waitFor(() => expect(textInput(container)?.value).toBe('recovered draft'));
  });

  it('clears the draft and tracks the recap on a successful save', () => {
    const { container } = render(<SessionRecapCard sessionId="s1" notes={null} editable />);
    fireEvent.click(button(container, 'summary.addRecap')!);
    fireEvent.change(textInput(container)!, { target: { value: 'logged it' } });
    fireEvent.click(button(container, 'comment.save')!);
    // Drive the config's onSuccess as the mutation would.
    const [, options] = updateSession.mutate.mock.calls[0];
    (options as { onSuccess: (result: { notes: string | null }) => void }).onSuccess({ notes: 'logged it' });
    expect(draftStore.clearDraftComment).toHaveBeenCalledWith('s1');
    expect(analytics.track).toHaveBeenCalledWith('Session Comment Added', { source: 'summary', commentLength: 9 });
  });
});
