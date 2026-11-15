// @vitest-environment jsdom
vi.mock('../../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: vi.fn() }));
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';
import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
const sheet = vi.hoisted(() => ({ closes: [] as (() => void)[] }));
const composer = vi.hoisted(() => ({ changes: [] as ((text: string) => void)[] }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../lib/graphql/hooks', async () => {
  const social = await vi.importActual<typeof import('../../../lib/graphql/hooks/use-social')>(
    '../../../lib/graphql/hooks/use-social',
  );
  return { useComments: social.useComments, useAddComment: social.useAddComment };
});
vi.mock('../../../lib/graphql/hooks/use-followed-authors', () => ({ useToggleAuthorFollow: vi.fn() }));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => {
    throw new Error('Comment UI used an uncaptured client');
  },
}));
vi.mock('../../../lib/graphql/use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing comment UI view');
    return selected.scope;
  },
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', tertiaryLabel: '#999' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
// CommentSheet calls the mobile wrapper (`lib/format-relative-time.ts`), which
// itself imports these from @boardsesh/profile-stats — tickTimeMs only gates
// the empty-string guard, so any finite return keeps it a no-op.
vi.mock('@boardsesh/profile-stats', () => ({ formatTickRelativeTime: () => 'now', tickTimeMs: () => 0 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, disabled }: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled, 'data-testid': 'send' }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
  },
}));

// Sheet renders its children + footer so the composer is interactable.
vi.mock('../../Sheet', () => ({
  Sheet: ({ children, footer, onClose }: { children?: ReactNode; footer?: ReactNode; onClose: () => void }) => {
    sheet.closes.push(onClose);
    return createElement('div', null, children, footer);
  },
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
  }) => {
    if (onChangeText) composer.changes.push(onChangeText);
    return createElement('input', {
      'data-testid': 'comment-input',
      value: value ?? '',
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    });
  },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableAvatar', () => ({ PressableAvatar: () => createElement('div', null) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div', null) }));

const { CommentSheet } = await import('../CommentSheet');

// This suite exercises the existing flow before the server privacy rollout.
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: undefined }) }));
vi.mock('../../privacy/PublicationAudiencePicker', () => ({
  PublicationAudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/ContentAudienceControl', () => ({
  ContentAudienceControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/ResourcePrivacyControl', () => ({
  ResourcePrivacyControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/AudiencePicker', () => ({
  AudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({
    enabled: false,
    isPrivate: false,
    audience: 'public',
    publication: undefined,
    chooseAudience: () => {},
  }),
}));

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((dispose) => dispose());
  selected.scope = null;
  sheet.closes.length = 0;
  composer.changes.length = 0;
});
function heldResponse(rejected = false) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify(
              rejected
                ? { errors: [{ message: 'Comment rejected' }] }
                : { data: { addComment: { uuid: 'comment-one' } } },
            ),
          ),
        );
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function fixture(rejected = false) {
  const current = createScopedHttpFixture();
  selected.scope = current.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const held = heldResponse(rejected);
  current.performFetch.mockImplementation(async (_url, init) => {
    const request = JSON.parse((init as RequestInit).body as string) as { query: string };
    return request.query.includes('addComment(')
      ? held.response
      : Response.json({ data: { comments: { comments: [], totalCount: 0, hasMore: false } } });
  });
  disposals.push(() => {
    cache.clear();
    current.dispose();
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const onClose = vi.fn();
  const props = {
    sheetRef: { current: null },
    entityId: 'entity-one' as string | null,
    entityType: 'session' as 'session' | 'tick',
    onClose,
  };
  const rendered = render(<CommentSheet {...props} />, { wrapper });
  const input = () => rendered.getByTestId('comment-input') as HTMLInputElement;
  const mutationPackets = () =>
    current.performFetch.mock.calls.filter(([, init]) =>
      JSON.parse((init as RequestInit).body as string).query.includes('addComment('),
    );
  const send = async () => {
    fireEvent.change(input(), { target: { value: 'original draft' } });
    fireEvent.click(rendered.getByTestId('send'));
    await waitFor(() => expect(mutationPackets()).toHaveLength(1));
  };
  const settle = async () => {
    await act(async () => held.release());
    await waitFor(() =>
      expect(
        cache
          .getMutationCache()
          .getAll()
          .every((mutation) => mutation.state.status !== 'pending'),
      ).toBe(true),
    );
  };
  return { ...current, ...rendered, cache, props, input, send, settle, mutationPackets, onClose };
}

describe('actual SDK comment composer continuation', () => {
  it.each(['B', 'ABA', 'entity', 'entity-type', 'close-reopen', 'permission'] as const)(
    'hides the old unsent draft immediately after %s and refuses its late input callback',
    async (change) => {
      const current = fixture();
      fireEvent.change(current.input(), { target: { value: 'private original draft' } });
      const originalChange = composer.changes.at(-1)!;
      if (change === 'B' || change === 'ABA') {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
        selected.scope = current.scope();
      } else if (change === 'entity') current.props.entityId = 'entity-two';
      else if (change === 'entity-type') current.props.entityType = 'tick';
      else if (change === 'close-reopen') {
        act(() => sheet.closes.at(-1)!());
        current.rerender(<CommentSheet {...current.props} entityId={null} />);
      } else current.rerender(<CommentSheet {...current.props} canComment={false} />);
      current.rerender(<CommentSheet {...current.props} />);
      expect(current.input().value).toBe('');
      act(() => originalChange('late original native input'));
      expect(current.input().value).toBe('');
      fireEvent.click(current.getByTestId('send'));
      expect(current.mutationPackets()).toHaveLength(0);
      fireEvent.change(current.input(), { target: { value: 'new opening draft' } });
      act(() => originalChange('late original native input'));
      expect(current.input().value).toBe('new opening draft');
    },
  );

  it.each(['B', 'ABA'] as const)(
    'keeps current %s draft and error when an old input callback arrives',
    async (change) => {
      const current = fixture(true);
      fireEvent.change(current.input(), { target: { value: 'private original draft' } });
      const originalChange = composer.changes.at(-1)!;
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      current.rerender(<CommentSheet {...current.props} />);
      expect(current.input().value).toBe('');
      await current.send();
      await current.settle();
      expect(current.input().value).toBe('original draft');
      expect(document.body.textContent).toContain('mobile.comments.sendError');
      act(() => originalChange('late original native input'));
      expect(current.input().value).toBe('original draft');
      expect(document.body.textContent).toContain('mobile.comments.sendError');
    },
  );

  it.each(['B', 'ABA'] as const)('hides an existing original error on %s before new input', async (change) => {
    const current = fixture(true);
    await current.send();
    await current.settle();
    expect(document.body.textContent).toContain('mobile.comments.sendError');
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    current.rerender(<CommentSheet {...current.props} />);
    expect(current.input().value).toBe('');
    expect(document.body.textContent).not.toContain('mobile.comments.sendError');
  });

  it('keeps the draft until its original successful delivery, then clears without closing the sheet', async () => {
    const current = fixture();
    await current.send();
    expect(current.input().value).toBe('original draft');
    await current.settle();
    expect(current.input().value).toBe('');
    expect(current.onClose).not.toHaveBeenCalled();
    expect(current.mutationPackets()).toHaveLength(1);
  });

  it.each(['B', 'ABA', 'original-expiry-with-fresh-lease'] as const)(
    'does not clear or close when a held actual response crosses %s',
    async (change) => {
      const current = fixture();
      await current.send();
      const originalClose = sheet.closes.at(-1)!;
      if (change === 'original-expiry-with-fresh-lease') {
        current.clock(120_001);
        const owner = current.backend.getSnapshot().owner;
        if (!owner) throw new Error('Missing selected owner');
        const lease = await current.backend.acquire(owner);
        const scope = current.backend.capture(lease.token);
        if (!scope) throw new Error('Missing fresh lease scope');
        current.backend.assertCurrent(scope, lease);
        expect(current.issueLease).toHaveBeenCalledTimes(2);
      } else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
        selected.scope = current.scope();
        current.rerender(<CommentSheet {...current.props} />);
        fireEvent.change(current.input(), { target: { value: 'new view draft' } });
        act(() => originalClose());
        expect(current.onClose).not.toHaveBeenCalled();
      }
      await current.settle();
      expect(current.input().value).toBe(
        change === 'original-expiry-with-fresh-lease' ? 'original draft' : 'new view draft',
      );
      expect(current.onClose).not.toHaveBeenCalled();
      expect(current.mutationPackets()).toHaveLength(1);
    },
  );

  it.each(['entity', 'entity-type', 'close-reopen'] as const)(
    'keeps the new composer and close handler after %s recycling',
    async (change) => {
      const current = fixture();
      await current.send();
      const originalClose = sheet.closes.at(-1)!;
      if (change === 'entity') current.props.entityId = 'entity-two';
      if (change === 'entity-type') current.props.entityType = 'tick';
      if (change === 'close-reopen') {
        act(() => originalClose());
        expect(current.onClose).toHaveBeenCalledOnce();
        current.onClose.mockClear();
        current.rerender(<CommentSheet {...current.props} entityId={null} />);
      }
      current.rerender(<CommentSheet {...current.props} />);
      fireEvent.change(current.input(), { target: { value: 'new opening draft' } });
      act(() => originalClose());
      expect(current.onClose).not.toHaveBeenCalled();
      await current.settle();
      expect(current.input().value).toBe('new opening draft');
      expect(current.onClose).not.toHaveBeenCalled();
    },
  );

  it('retires the old close callback and request when unmounted', async () => {
    const current = fixture();
    await current.send();
    const originalClose = sheet.closes.at(-1)!;
    current.unmount();
    act(() => originalClose());
    expect(current.onClose).not.toHaveBeenCalled();
    await current.settle();
  });
});
