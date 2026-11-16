import {
  buildConnectedAppDetail,
  connectedAppDisconnectPrompt,
  connectedAppDisconnectResult,
  type ConnectedAppDetailView,
  type ConnectedAppRowView,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { hashKey } from '@tanstack/react-query';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useHttpQueryScope } from '../../lib/graphql/use-http-query-scope';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';
import { subscribeHttpOperationScope } from '../../lib/graphql/use-auth-token';
import type { ToastGuard } from '../Toast';
import { useTranslation } from 'react-i18next';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDisconnectApp, useMyConnectedApps } from '../../lib/graphql/hooks/use-connected-apps';
import { useAuth } from '../../providers/auth-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { ConnectedAppDetailPageView, type ConnectedAppDetailPageViewProps } from './ConnectedAppDetailPageView';
import {
  useConnectedAppsFormatters,
  useConnectedAppsOwner,
  connectedAppsOwnerCurrent,
  type ConnectedAppsOwner,
} from './PartnerAppsSection';

/**
 * Settings › Connected apps › an app (#6981 F16): what it can see, the
 * unlisted-climbs line under the logbook (#7387), when it connected and was last
 * used, and Disconnect. A pushed settings page, like Board look's leaves: a
 * destination one tap down a list, with Back. Reads the list Connected apps
 * already fetched, so opening it costs no request.
 */
function ConnectedAppDetailBody({ id }: { id: string }) {
  const { t } = useTranslation('settings');
  const { isAuthenticated } = useAuth();
  const owner = useConnectedAppsOwner();
  const selected = owner.scope.scoped;
  const current = !selected || connectedAppsOwnerCurrent(owner);
  const actions = useHttpActionScope();
  const { data, isError, refetch, refetchOriginal } = useMyConnectedApps(current);
  const formatters = useConnectedAppsFormatters();
  const router = useRouter();

  const detail = useMemo(
    () =>
      buildConnectedAppDetail({
        signedIn: isAuthenticated,
        data,
        connectionId: typeof id === 'string' ? id : '',
        // A cold deep link whose first load failed: say so, with a retry, never an endless spinner.
        loadFailed: isError,
        t: t as ConnectedAppsTranslate,
        formatters,
      }),
    [isAuthenticated, data, id, isError, t, formatters],
  );
  const nativeRetry = useCallback(() => void refetch(), [refetch]);
  const retry = useCallback(() => {
    if (!selected) {
      nativeRetry();
      return;
    }
    let action: ReturnType<typeof actions.capture>;
    try {
      owner.assertCurrent();
      action = actions.capture();
    } catch {
      return;
    }
    const assertOriginal = () => {
      owner.assertCurrent();
      action.assertView();
    };
    void refetchOriginal(assertOriginal)
      .catch(() => {})
      .finally(() => action.finish());
  }, [selected, nativeRetry, owner, actions, refetchOriginal]);

  // Once Disconnect succeeds the row leaves the list at once; keep drawing the
  // app while the page slides away instead of flashing "not connected".
  const shown = useRef<ConnectedAppDetailView | null>(null);
  const [leaving, setLeaving] = useState(false);
  if (detail.kind === 'app') shown.current = detail;
  const visible = leaving && shown.current ? shown.current : detail;

  const leave = useCallback(
    (assertDelivery?: () => void) => {
      assertDelivery?.();
      setLeaving(true);
      assertDelivery?.();
      const canGoBack = router.canGoBack();
      assertDelivery?.();
      if (canGoBack) router.back();
    },
    [router],
  );
  const context = useMemo(() => (selected ? { owner, connectionId: id } : undefined), [selected, owner, id]);
  const { disconnect, disconnecting } = usePartnerAppDisconnect(leave, context);
  if (!current) return null;

  return (
    <ConnectedAppDetailPage
      detail={visible}
      onDisconnect={disconnect}
      disconnecting={disconnecting}
      onRetry={retry}
      {...(selected ? { originalOwner: owner } : {})}
    />
  );
}

export function ConnectedAppDetailScreen() {
  const scope = useHttpQueryScope();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const originalId = typeof id === 'string' ? id : '';
  return (
    <ConnectedAppDetailBody
      id={originalId}
      key={scope.scoped ? hashKey(scope.key(['connected-app-detail', originalId])) : undefined}
    />
  );
}

/** Owns only an already-settled original cause. The timer can veto quiet
 * expiry; every actual consumption still calls the original assertion. */
function feedbackGuard(
  assertCause: () => void,
  dispose: () => void,
  owner?: ConnectedAppsOwner,
): ToastGuard & Readonly<{ acceptClose(): void }> {
  let released = false;
  let retired = false;
  let acceptedClose = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const assertCurrent = () => {
    if (released || retired) throw new BrowserBackendConsumerError('superseded');
    if (!acceptedClose) owner?.assertCurrent();
    assertCause();
  };
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const observe = () => {
    if (released || retired) return;
    try {
      assertCurrent();
    } catch {
      retired = true;
      stop();
      const pendingListeners = Array.from(listeners);
      for (const listener of pendingListeners) if (listeners.has(listener)) listener();
    }
  };
  const tick = () => {
    timer = undefined;
    observe();
    if (!released && !retired && listeners.size) timer = setTimeout(tick, 100);
  };
  const releaseView = subscribeHttpOperationScope(observe);
  const releaseOwner = owner?.subscribe(observe);
  return Object.freeze({
    assertCurrent,
    acceptClose() {
      assertCurrent();
      acceptedClose = true;
      releaseOwner?.();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (timer === undefined && !released && !retired) timer = setTimeout(tick, 100);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    },
    release() {
      if (released) return;
      released = true;
      stop();
      releaseView();
      releaseOwner?.();
      listeners.clear();
      dispose();
    },
  });
}

/** Confirm, then end the connection and say how it went. `onDisconnected` leaves the page. */
export function usePartnerAppDisconnect(
  onDisconnected: (assertDelivery?: () => void) => void,
  context?: { owner: ConnectedAppsOwner; connectionId: string },
) {
  const { t } = useTranslation('settings');
  const confirm = useConfirm();
  const { showToast, showGuardedToast } = useToast();
  const { mutate, mutateWithReceipt } = useDisconnectApp();
  const actions = useHttpActionScope();
  const pending = useRef<object | undefined>(undefined);
  const [selectedPending, setSelectedPending] = useState<object>();
  const [disconnecting, setDisconnecting] = useState(false);
  const translate = t as ConnectedAppsTranslate;

  const disconnect = useCallback(
    async (row: ConnectedAppRowView) => {
      const prompt = connectedAppDisconnectPrompt({ name: row.name }, translate);
      const confirmed = await confirm({ ...prompt, destructive: true });
      if (!confirmed) return;
      setDisconnecting(true);
      mutate(
        { connectionId: row.connectionId },
        {
          onSuccess: () => {
            showToast(connectedAppDisconnectResult({ name: row.name }, 'disconnected', translate), 'success');
            onDisconnected();
          },
          onError: () => showToast(connectedAppDisconnectResult({ name: row.name }, 'failed', translate), 'error'),
          onSettled: () => setDisconnecting(false),
        },
      );
    },
    [confirm, mutate, showToast, translate, onDisconnected],
  );

  const selectedDisconnect = useCallback(
    async (row: ConnectedAppRowView) => {
      if (!context || pending.current) return;
      let action: ReturnType<typeof actions.capture>;
      try {
        context.owner.assertCurrent();
        if (row.connectionId !== context.connectionId) return;
        action = actions.capture();
      } catch {
        return;
      }
      const original = Object.freeze({ connectionId: row.connectionId, name: row.name });
      const requestId = Object.freeze({});
      pending.current = requestId;
      let transferred = false;
      let receipt: Awaited<ReturnType<typeof mutateWithReceipt>> | undefined;
      let failed: { error: unknown; assertCurrent: () => void; dispose: () => void } | undefined;
      let guard: ReturnType<typeof feedbackGuard> | undefined;
      const assertIntent = () => {
        context.owner.assertCurrent();
        action.assertView();
        if (pending.current !== requestId) throw new BrowserBackendConsumerError('superseded');
      };
      try {
        assertIntent();
        const prompt = connectedAppDisconnectPrompt(original, translate);
        const confirmed = await confirm({ ...prompt, destructive: true });
        assertIntent();
        if (!confirmed) return;
        setSelectedPending(requestId);
        assertIntent();
        receipt = await mutateWithReceipt(
          { connectionId: original.connectionId },
          {
            signal: action.signal,
            onError(error, _variables, _mutationContext, operation) {
              // Production carries the full operation through its spread. Missing
              // capability refuses: no cast, fresh operation or accepting fallback.
              try {
                if (!('assertErrorDeliveries' in operation) || typeof operation.assertErrorDeliveries !== 'function')
                  return;
                const originalAssertion = operation.assertErrorDeliveries;
                const assertCurrent = () => {
                  originalAssertion(error);
                };
                assertCurrent();
                failed = { error, assertCurrent, dispose: operation.dispose };
              } catch {
                /* A refusal is a hold, never a replacement API error. */
              }
            },
          },
        );
        assertIntent();
        receipt.assertCurrent();
        // The accepted outcome keeps its original delivery, but intentional
        // Back must no longer abort that delivery through the producer lifetime.
        guard = feedbackGuard(receipt.assertCurrent, receipt.dispose, context.owner);
        guard.assertCurrent();
        showGuardedToast(connectedAppDisconnectResult(original, 'disconnected', translate), 'success', guard);
        transferred = true;
        assertIntent();
        guard.assertCurrent();
        guard.acceptClose();
        action.finish();
        onDisconnected(guard.assertCurrent);
      } catch (error) {
        try {
          assertIntent();
          if (!failed || failed.error !== error) return;
          failed.assertCurrent();
          const assertFailure = () => {
            action.assertView();
            failed!.assertCurrent();
          };
          guard = feedbackGuard(
            assertFailure,
            () => {
              failed!.dispose();
              action.finish();
            },
            context.owner,
          );
          guard.assertCurrent();
          showGuardedToast(connectedAppDisconnectResult(original, 'failed', translate), 'error', guard);
          transferred = true;
        } catch {
          /* Unproven or retired failures cannot become guidance. */
        }
      } finally {
        if (pending.current === requestId) pending.current = undefined;
        // Pure exact-ID cleanup must survive refusal and must not clear newer work.
        setSelectedPending((previous) => (previous === requestId ? undefined : previous));
        if (!transferred) {
          guard?.release();
          receipt?.dispose();
          failed?.dispose();
          action.finish();
        }
      }
    },
    [context, actions, confirm, mutateWithReceipt, showGuardedToast, translate, onDisconnected],
  );
  return context
    ? { disconnect: selectedDisconnect, disconnecting: selectedPending !== undefined }
    : { disconnect, disconnecting };
}

export function ConnectedAppDetailPage(props: Omit<ConnectedAppDetailPageViewProps, 'scrollBottomPadding'>) {
  const { scrollBottomPadding } = useBottomChromeMetrics();
  try {
    props.originalOwner?.assertCurrent();
  } catch {
    return null;
  }
  return (
    <>
      <Stack.Screen options={{ title: props.detail.kind === 'app' ? props.detail.row.name : '' }} />
      <ConnectedAppDetailPageView {...props} scrollBottomPadding={scrollBottomPadding} />
    </>
  );
}
