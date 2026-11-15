// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  toast: vi.fn(),
  track: vi.fn(),
  haptic: vi.fn(),
  confirm: vi.fn<() => Promise<boolean>>(),
  modalCallbacks: [] as { onDisplaced: () => void; onFullyDismissed: () => void }[],
}));
vi.mock('../../../lib/graphql/use-http-query-scope', () => ({ useHttpQueryScope: () => selected.scope! }));
vi.mock('../../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({ notificationAsync: selected.haptic, NotificationFeedbackType: { Error: 2 } }));
vi.mock('../../../lib/release-context', () => ({ readMobileReleaseContext: () => ({ channel: 'owned-test' }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => selected.confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: selected.toast }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {}, brandColors: {} }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 } }));
vi.mock('../../../lib/analytics', () => ({ track: selected.track }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useGrades: () => ({ data: [] }),
  useProfile: () => ({ data: { id: 'other-setter' } }),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({
    children,
    header,
    onDisplaced,
    onFullyDismissed,
  }: {
    children?: ReactNode;
    header?: ReactNode;
    onDisplaced: () => void;
    onFullyDismissed: () => void;
  }) => {
    selected.modalCallbacks.push({ onDisplaced, onFullyDismissed });
    return (
      <div>
        {header}
        {children}
      </div>
    );
  },
}));
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({
    trailing,
    leading,
  }: {
    trailing: { onPress: () => void; disabled: boolean };
    leading: { onPress: () => void };
  }) => (
    <>
      <button onClick={leading.onPress}>cancel-report</button>
      <button disabled={trailing.disabled} onClick={trailing.onPress}>
        submit-report
      </button>
    </>
  ),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../ClimbPreviewCard', () => ({ ClimbPreviewCard: () => null }));
vi.mock('../../SegmentedControl', () => ({ SegmentedControl: () => null }));
vi.mock('../../grade', () => ({ GradeSingleSelectRail: () => null }));
vi.mock('../../tick', () => ({
  TickNoteField: ({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) => (
    <textarea data-testid="reason" value={value} onChange={(event) => onChangeText(event.target.value)} />
  ),
}));

import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
import { ReportClimbSheet } from '../ReportClimbSheet';

const closeFixtures: (() => void)[] = [];
const climb = {
  uuid: 'owned-climb',
  userId: 'original-setter',
  name: 'Owned climb',
  difficulty: '6b/V4',
} as unknown as Climb;
function heldEnvelope(envelope: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const close = vi.fn();
  const fullyDismissed = vi.fn();
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  const sheet = () => (
    <ReportClimbSheet
      visible
      climb={climb}
      boardName="kilter"
      layoutId={1}
      sizeId={1}
      setIds="1"
      angle={40}
      onClose={close}
      onFullyDismissed={fullyDismissed}
    />
  );
  return {
    ...http,
    cache,
    wrapper,
    close,
    fullyDismissed,
    sheet,
    change(kind: 'B' | 'ABA') {
      http.switchAccount('owned-B');
      if (kind === 'ABA') http.switchAccount('owned-A');
      selected.scope = http.scope();
    },
  };
}
function success() {
  return {
    data: { reportClimb: { status: 'created', proposal: { weightedUpvotes: 1, requiredUpvotes: 3, status: 'open' } } },
  };
}
async function settled(cache: QueryClient) {
  await waitFor(() => {
    expect(cache.getMutationCache().getAll()).toHaveLength(1);
    expect(cache.getMutationCache().getAll()[0].state.status).not.toBe('pending');
  });
  await act(async () => {});
}
beforeEach(() => {
  selected.toast.mockReset();
  selected.track.mockReset();
  selected.haptic.mockReset();
  selected.confirm.mockReset().mockResolvedValue(false);
  selected.modalCallbacks = [];
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});

describe('actual report sheet delivery and action ownership', () => {
  it('keeps a current report, analytics, close and success toast', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValueOnce(Response.json(success()));
    const screen = render(current.sheet(), current);
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'The holds came off' } });
    fireEvent.click(screen.getByText('submit-report'));
    await waitFor(() => expect(selected.toast).toHaveBeenCalledOnce());
    expect(current.performFetch).toHaveBeenCalledOnce();
    expect(selected.track).toHaveBeenCalledOnce();
    expect(current.close).toHaveBeenCalledOnce();
    const sent = JSON.parse((current.performFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.variables.input).toMatchObject({
      climbUuid: 'owned-climb',
      kind: 'hide',
      reason: 'The holds came off',
      boardType: 'kilter',
    });
  });

  it.each(['B', 'ABA', 'expired'] as const)('refuses effects from a held successful body after %s', async (change) => {
    const current = fixture();
    const held = heldEnvelope(success());
    current.performFetch.mockResolvedValueOnce(held.response);
    const screen = render(current.sheet(), current);
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'The holds came off' } });
    fireEvent.click(screen.getByText('submit-report'));
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    if (change === 'expired') {
      current.clock(90_000);
      current.performFetch.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }));
      await selected.scope!.run((operation) => operation.request('{ viewer { id } }'));
      current.clock(120_001);
    } else {
      current.change(change);
      screen.rerender(current.sheet());
    }
    await act(async () => {
      held.release();
    });
    await settled(current.cache);
    expect(selected.track).not.toHaveBeenCalled();
    expect(selected.toast).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    expect(selected.haptic).not.toHaveBeenCalled();
  });

  it.each(['B', 'ABA'] as const)(
    'resets the old form and refuses retired native displacement/dismiss callbacks under %s',
    async (change) => {
      const current = fixture();
      const screen = render(current.sheet(), current);
      fireEvent.change(screen.getByTestId('reason'), { target: { value: 'A private unfinished reason' } });
      const oldCallbacks = selected.modalCallbacks[selected.modalCallbacks.length - 1];
      current.change(change);
      screen.rerender(current.sheet());
      expect((screen.getByTestId('reason') as HTMLTextAreaElement).value).toBe('');
      fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Fresh form for the new view' } });
      act(() => {
        oldCallbacks.onDisplaced();
        oldCallbacks.onFullyDismissed();
      });
      expect(current.close).not.toHaveBeenCalled();
      expect(current.fullyDismissed).not.toHaveBeenCalled();
      expect((screen.getByTestId('reason') as HTMLTextAreaElement).value).toBe('Fresh form for the new view');
    },
  );

  it('rechecks original delivery after analytics before closing or toasting', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValueOnce(Response.json(success()));
    selected.track.mockImplementationOnce(() => current.change('B'));
    const screen = render(current.sheet(), current);
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'The holds came off' } });
    fireEvent.click(screen.getByText('submit-report'));
    await waitFor(() => expect(selected.track).toHaveBeenCalledOnce());
    await settled(current.cache);
    expect(current.close).not.toHaveBeenCalled();
    expect(selected.toast).not.toHaveBeenCalled();
  });

  it('rechecks original delivery after close before the toast', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValueOnce(Response.json(success()));
    current.close.mockImplementationOnce(() => current.change('B'));
    const screen = render(current.sheet(), current);
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'The holds came off' } });
    fireEvent.click(screen.getByText('submit-report'));
    await waitFor(() => expect(current.close).toHaveBeenCalledOnce());
    await settled(current.cache);
    expect(selected.track).toHaveBeenCalledOnce();
    expect(selected.toast).not.toHaveBeenCalled();
  });
});
