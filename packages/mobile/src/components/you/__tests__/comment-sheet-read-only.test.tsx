// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const addComment = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useComments: () => ({ data: { comments: [], totalCount: 0 }, isPending: false }),
  useAddComment: () => addComment,
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', tertiaryLabel: '#999', secondaryLabel: '#666' },
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
vi.mock('../../Sheet', () => ({
  Sheet: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) =>
    createElement('div', null, children, footer),
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: () => createElement('input', { 'data-testid': 'comment-input' }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableAvatar', () => ({ PressableAvatar: () => createElement('div', null) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div', null) }));

const { CommentSheet } = await import('../CommentSheet');

const sheetRef = { current: null };

describe('CommentSheet read-only mode', () => {
  it('swaps the composer for a sign-in prompt when canComment is false', () => {
    const { queryByTestId, container } = render(
      <CommentSheet
        sheetRef={sheetRef}
        entityId="playlist-1:_all"
        entityType="playlist_climb"
        canComment={false}
        onClose={() => {}}
      />,
    );

    expect(container.textContent).toContain('comment.signInPrompt');
    expect(queryByTestId('comment-input')).toBeNull();
    expect(queryByTestId('send')).toBeNull();
  });

  it('keeps the composer by default so the session/tick call sites are unchanged', () => {
    const { queryByTestId, container } = render(
      <CommentSheet sheetRef={sheetRef} entityId="session-1" onClose={() => {}} />,
    );

    expect(queryByTestId('comment-input')).not.toBeNull();
    expect(queryByTestId('send')).not.toBeNull();
    expect(container.textContent).not.toContain('comment.signInPrompt');
  });
});
