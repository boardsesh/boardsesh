// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type MutateOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

const addComment = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../lib/graphql/hooks', () => ({
  useComments: () => ({ data: { comments: [] }, isPending: false }),
  useAddComment: () => addComment,
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', tertiaryLabel: '#999' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('@boardsesh/profile-stats', () => ({ formatTickRelativeTime: () => 'now' }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, disabled }: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled, 'data-testid': 'send' }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

// Sheet renders its children + footer so the composer is interactable.
vi.mock('../../Sheet', () => ({
  Sheet: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) =>
    createElement('div', null, children, footer),
}));
vi.mock('@gorhom/bottom-sheet', () => ({
  __esModule: true,
  default: () => null,
  BottomSheetTextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
  }) =>
    createElement('input', {
      'data-testid': 'comment-input',
      value: value ?? '',
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableAvatar', () => ({ PressableAvatar: () => createElement('div', null) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div', null) }));

const { CommentSheet } = await import('../CommentSheet');

function renderSheet() {
  const sheetRef = { current: null };
  return render(<CommentSheet sheetRef={sheetRef} entityId="entity-1" entityType="session" onClose={() => {}} />);
}

describe('CommentSheet submit error handling', () => {
  beforeEach(() => {
    addComment.mutate.mockReset();
    addComment.isPending = false;
    toast.showToast.mockReset();
  });

  it('clears the draft only after the comment posts successfully', () => {
    addComment.mutate.mockImplementation((_input: unknown, options: MutateOptions) => {
      options.onSuccess?.();
    });

    const { getByTestId } = renderSheet();
    const input = getByTestId('comment-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nice send' } });
    fireEvent.click(getByTestId('send'));

    expect(addComment.mutate).toHaveBeenCalledOnce();
    expect(input.value).toBe('');
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('keeps the draft and shows an error toast when posting fails', () => {
    addComment.mutate.mockImplementation((_input: unknown, options: MutateOptions) => {
      options.onError?.(new Error('network down'));
    });

    const { getByTestId } = renderSheet();
    const input = getByTestId('comment-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nice send' } });
    fireEvent.click(getByTestId('send'));

    expect(addComment.mutate).toHaveBeenCalledOnce();
    // Draft must survive so the user's text isn't silently lost.
    expect(input.value).toBe('nice send');
    expect(toast.showToast).toHaveBeenCalledWith('mobile.comments.sendError', 'error');
  });
});
