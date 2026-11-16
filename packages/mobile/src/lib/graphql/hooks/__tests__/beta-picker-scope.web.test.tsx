import { httpPageSourceDiagnostics } from '../../use-http-query';
// @vitest-environment jsdom
import {
  createElement,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense,
  StrictMode,
  startTransition,
  type ReactNode,
} from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver, onlineManager, hashKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACH_BETA_LINK, type AttachBetaLinkMutationResponse } from '@boardsesh/graphql/operations/beta-links';
import type { HttpQueryScope } from '../../http-query-scope';
import type { createScopedHttpFixture } from '../../__tests__/fixtures/scoped-http';
import type { ToastGuard } from '../../../../components/Toast';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import type { ShareBetaListItem } from '../../../share-beta-list';

const fixtureState = vi.hoisted(() => ({
  platform: 'web' as 'web' | 'ios',
  sectionsReady: false,
  transitionPages: false,
  blockedRows: false,
  suspendedRows: undefined as Promise<void> | undefined,
  attemptedRows: [] as string[][],
  committedRows: [] as string[][],

  routeParams: {} as { link?: string; betaOpening?: string },
  routeBack: vi.fn(),
  routeReplace: vi.fn(),
  routeDelete: undefined as (() => void) | undefined,
  rowHaptic: vi.fn(),
  rowCallbacks: [] as Array<() => void>,

  requests: [] as Promise<unknown>[],
  operationSignals: [] as Array<AbortSignal | undefined>,
  http: null as ReturnType<typeof createScopedHttpFixture> | null,
  scope: null as HttpQueryScope | null,
  authListeners: new Set<() => void>(),
  credentialRead: vi.fn(() => {
    throw new Error('Unexpected credential read');
  }),
  success: vi.fn(),
  error: vi.fn(),
  announce: vi.fn(),
  released: vi.fn(),
  modalSequence: 0,
  modalProps: null as null | {
    onClose?: () => void | Promise<void>;
    onDisplaced?: () => void;
    onFullyDismissed?: () => void;
  },
  modalMounted: vi.fn(),
  modalDeleted: vi.fn(),
  closeSheet: vi.fn(),
  clipboard: vi.fn(async (_text: string) => {}),
  openURL: vi.fn(async (_url: string) => {}),
  selection: vi.fn(async () => {}),
  notification: vi.fn(async (_kind: string) => {}),
  track: vi.fn(),
  reported: vi.fn(),
}));
// Fixture timing only: wrap the real fixed source Promise continuation as
// one lane. All actual source/observer/SDK/page/consumer identities are retained.
vi.mock('../../use-http-query', async () => {
  const actual = await vi.importActual<typeof import('../../use-http-query')>('../../use-http-query');
  const useHttpInfiniteQuery = new Proxy(actual.useHttpInfiniteQuery, {
    apply(target, receiver, parameters: unknown[]) {
      const result = Reflect.apply(target, receiver, parameters) as ReturnType<typeof actual.useHttpInfiniteQuery> & {
        capturePageSource?: () => import('../../use-http-query').HttpInfinitePageSource<unknown, unknown>;
      };
      if (!fixtureState.transitionPages || !result.capturePageSource) return result;
      const capture = result.capturePageSource;
      return {
        ...result,
        capturePageSource: () => {
          const source = capture();
          return Object.freeze({
            ...source,
            fetchNextPage(options?: { signal?: AbortSignal }) {
              return transitionFulfillment(source.fetchNextPage(options));
            },
          });
        },
      };
    },
  });
  return { ...actual, useHttpInfiniteQuery };
});
vi.mock('../../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!fixtureState.scope) throw new Error('Missing actual owned scope');
    return fixtureState.scope;
  },
}));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    throw new Error('Unexpected native transport');
  },
  getOfflineSyncHttpClient: () => {
    throw new Error('Unexpected native offline transport');
  },
}));
// Platform forwarding to the ACTUAL new web export and its unchanged subscriber.
// The three source adapters below are owned fixture ports, never verdicts.
vi.mock('../../use-auth-token', async () => {
  const actual = await vi.importActual<typeof import('../../use-auth-token.web')>('../../use-auth-token.web');
  return { subscribeHttpOperationScope: actual.subscribeHttpOperationScope };
});
// Platform resolution forwards to the ACTUAL owned operation factory. It
// retains real manager/facade/SDK/result and exact-error guards.
vi.mock('../../http-operation', () => ({
  createHttpOperation: (scope: string | undefined, options?: import('../../http-operation').HttpOperationOptions) => {
    if (!fixtureState.http) throw new Error('Missing owned real operation factory');
    fixtureState.operationSignals.push(options?.signal);
    const operation = fixtureState.http.operations.create(scope, options);
    // Observe the actual SDK promise only; preserve both overloads, all actual
    // arguments, original decoded/error identities and every original guard.
    const request = new Proxy(operation.request, {
      apply(target, receiver, parameters: unknown[]) {
        const pending = Reflect.apply(target, receiver, parameters) as Promise<unknown>;
        fixtureState.requests.push(pending);
        return pending;
      },
    });
    return Object.freeze({ ...operation, request });
  },
}));
// Unused native/offline ports in the large historical barrel fail closed.
// The actual attach implementation and final reader refresh are never mocked.
// Unrelated barrel re-exports are platform I/O edges, unused by these beta flows.
vi.mock('../use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: () => {
    throw new Error('Unexpected unrelated hook: useInfiniteSearchClimbs');
  },
}));
vi.mock('../use-mobile-climb-actions-data', () => ({
  useMobileClimbActionsData: () => {
    throw new Error('Unexpected unrelated hook: useMobileClimbActionsData');
  },
}));
vi.mock('../use-you-profile-data', () => ({
  useYouProfileData: () => {
    throw new Error('Unexpected unrelated hook: useYouProfileData');
  },
}));
vi.mock('../use-social', () => ({
  usePublicProfile: () => {
    throw new Error('Unexpected unrelated hook: usePublicProfile');
  },
  useFollowers: () => {
    throw new Error('Unexpected unrelated hook: useFollowers');
  },
  useFollowing: () => {
    throw new Error('Unexpected unrelated hook: useFollowing');
  },
  useSearchUsers: () => {
    throw new Error('Unexpected unrelated hook: useSearchUsers');
  },
  useToggleUserFollow: () => {
    throw new Error('Unexpected unrelated hook: useToggleUserFollow');
  },
  useUserClimbs: () => {
    throw new Error('Unexpected unrelated hook: useUserClimbs');
  },
  useVote: () => {
    throw new Error('Unexpected unrelated hook: useVote');
  },
  useBulkVoteSummaries: () => {
    throw new Error('Unexpected unrelated hook: useBulkVoteSummaries');
  },
  useComments: () => {
    throw new Error('Unexpected unrelated hook: useComments');
  },
  useAddComment: () => {
    throw new Error('Unexpected unrelated hook: useAddComment');
  },
}));
vi.mock('../use-session-detail', () => ({
  useSessionDetail: () => {
    throw new Error('Unexpected unrelated hook: useSessionDetail');
  },
  useSessionPreview: () => {
    throw new Error('Unexpected unrelated hook: useSessionPreview');
  },
  useSessionOwnerUserId: () => {
    throw new Error('Unexpected unrelated hook: useSessionOwnerUserId');
  },
}));
vi.mock('../use-delete-account', () => ({
  useDeleteAccountInfo: () => {
    throw new Error('Unexpected unrelated hook: useDeleteAccountInfo');
  },
  useDeleteAccount: () => {
    throw new Error('Unexpected unrelated hook: useDeleteAccount');
  },
}));
vi.mock('../use-integrations', () => ({
  useIntegrationStatuses: () => {
    throw new Error('Unexpected unrelated hook: useIntegrationStatuses');
  },
  useDisconnectIntegration: () => {
    throw new Error('Unexpected unrelated hook: useDisconnectIntegration');
  },
  useSetIntegrationAutoSync: () => {
    throw new Error('Unexpected unrelated hook: useSetIntegrationAutoSync');
  },
  useSyncSessionToIntegration: () => {
    throw new Error('Unexpected unrelated hook: useSyncSessionToIntegration');
  },
}));
// Read-only barrel closure trace: these exact unused direct imports reach
// PostHog/Sentry/preferences/SQLite native I/O. Keep all beta logic real.
vi.mock('../../../analytics', () => ({ track: fixtureState.track }));
vi.mock('../../../error-reporting', () => ({ reportHandledError: fixtureState.reported }));
vi.mock('../search-grade-source', () => ({
  useGradeSourceSearchInput: () => {
    throw new Error('Unexpected climb search');
  },
}));
vi.mock('../use-similar-climbs', () => ({
  useSimilarClimbs: () => {
    throw new Error('Unexpected similar-climb read');
  },
}));
vi.mock('../../../../db', () => ({
  getDatabaseHandle: () => {
    throw new Error('Unexpected SQLite I/O');
  },
}));
vi.mock('../../offline-request', () => ({
  offlineAwareRequest: () => {
    throw new Error('Unexpected local/offline read');
  },
}));
vi.mock('../../../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: () => {
    throw new Error('Unexpected drain');
  },
}));
vi.mock('../../../../hooks/use-offline-mutations', () => ({
  addFavoriteLocal: () => {
    throw new Error('Unexpected local favorite');
  },
  removeFavoriteLocal: () => {
    throw new Error('Unexpected local favorite');
  },
}));
vi.mock('../../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => {
    throw new Error('Unexpected native stored UID');
  },
}));
vi.mock('../../../../providers/feature-flags-provider', () => ({
  useBoardseshGradeEnabled: () => false,
  useOfflineDownloadsEnabled: () => {
    throw new Error('Unexpected offline flag');
  },
}));
vi.mock('../../../ble/observed-board-matches', () => ({
  fetchBoardsForObservedSerials: () => {
    throw new Error('Unexpected BLE observation lookup');
  },
}));
vi.mock('../../../spray/spray-wall-loader', () => ({
  invalidateSprayWallRenderData: () => {
    throw new Error('Unexpected spray invalidation');
  },
}));
vi.mock('../../../auth-store', () => ({ getAuthToken: fixtureState.credentialRead }));
vi.mock('../../../auth-store.web', () => ({
  subscribeAuthTokenChanges: (listener: () => void) => {
    fixtureState.authListeners.add(listener);
    return () => {
      fixtureState.authListeners.delete(listener);
    };
  },
  captureAuthCredentialGeneration: () => 0,
  getAuthToken: fixtureState.credentialRead,
  hasConfirmedAnonymousWebSession: () => false,
  isAuthCredentialGenerationCurrent: () => true,
  isRequiredBrowserDispatch: () => true,
  synchronizeWebSession: async () => {
    throw new Error('Subscription must not synchronize credentials');
  },
}));
vi.mock('../../../browser-backend-client.web', () => ({
  expoBrowserBackendClient: {
    subscribe: (listener: () => void) => fixtureState.http!.backend.subscribe(listener),
  },
}));
vi.mock('../../client.web', () => ({
  browserHttpClients: {
    subscribe: (listener: () => void) => fixtureState.http!.facade.subscribe(listener),
  },
}));
vi.mock('react-native', () => ({
  View: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement('div', { role: accessibilityRole }, children),
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: {
    get OS() {
      return fixtureState.platform;
    },
  },
  Linking: { openURL: fixtureState.openURL },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('react-native-paper', () => ({
  Snackbar: ({ children, visible, onDismiss }: { children?: ReactNode; visible: boolean; onDismiss: () => void }) =>
    visible ? (
      <div>
        {children}
        <button onClick={onDismiss}>dismiss-toast</button>
      </div>
    ) : null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: fixtureState.clipboard }));
vi.mock('expo-haptics', () => ({
  selectionAsync: fixtureState.selection,
  notificationAsync: fixtureState.notification,
  NotificationFeedbackType: { Error: 'error' },
}));
vi.mock('../../../../providers/dialog-provider', () => ({ useConfirm: () => async () => true }));
vi.mock('../../../../components/privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({ publication: undefined }),
}));
vi.mock('../../../../components/privacy/PublicationAudiencePicker', () => ({ PublicationAudiencePicker: () => null }));
vi.mock('../../../../components/ModalSheet', () => ({
  ModalSheet: ({
    visible,
    header,
    children,
    onClose,
    onDisplaced,
    onFullyDismissed,
  }: {
    visible: boolean;
    header?: ReactNode;
    children?: ReactNode;
    onClose?: () => void | Promise<void>;
    onDisplaced?: () => void;
    onFullyDismissed?: () => void;
  }) => {
    const [identity] = useState(() => ++fixtureState.modalSequence);
    useInsertionEffect(() => {
      fixtureState.modalMounted(identity);
      return () => fixtureState.modalDeleted(identity);
    }, [identity]);
    fixtureState.modalProps = { onClose, onDisplaced, onFullyDismissed };
    return (
      <div data-testid="actual-beta-modal" data-modal-id={identity} data-visible={visible ? 'yes' : 'no'}>
        {visible ? (
          <>
            {header}
            {children}
          </>
        ) : null}
      </div>
    );
  },
}));
vi.mock('../../../../components/SheetTopBar', () => ({
  SheetTopBar: ({
    leading,
    trailing,
  }: {
    leading?: { onPress: () => void };
    trailing?: { onPress: () => void; disabled?: boolean };
  }) => (
    <>
      <button onClick={leading?.onPress}>cancel-beta-sheet</button>
      <button disabled={trailing?.disabled} onClick={trailing?.onPress}>
        submit-beta-sheet
      </button>
    </>
  ),
}));
vi.mock('../../../../components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => <button onClick={onPress}>{title}</button>,
}));
vi.mock('../../../../components/AccessibleBottomSheetTextInput', () => ({
  AccessibleBottomSheetTextInput: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (text: string) => void;
  }) => <input aria-label="owned-beta-url" value={value} onChange={(event) => onChangeText(event.target.value)} />,
}));
vi.mock('../../../../components/play-drawer/BetaVideoCardView', () => ({
  BetaVideoCardView: ({ onPress, link }: { onPress: () => void; link: { link: string } }) => (
    <button data-private-url={link.link} onClick={onPress}>
      open-original-card
    </button>
  ),
  detectPlatform: () => ({ name: 'Instagram' }),
  BETA_CARD_WIDTH: 108,
  BETA_CARD_HEIGHT: 192,
  BETA_CARD_COMPACT_WIDTH: 54,
  BETA_CARD_COMPACT_HEIGHT: 96,
}));
// Actual route/view/row controllers remain real; these are host/native I/O leaves.
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => fixtureState.routeParams,
  useRouter: () => ({
    back: () => {
      fixtureState.routeBack();
      fixtureState.routeDelete?.();
    },
    replace: fixtureState.routeReplace,
  }),
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../components/launch-update/hold-until-launch-ready', () => ({
  holdUntilLaunchReady: <Screen,>(screen: Screen) => screen,
}));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    onEndReached,
    ListFooterComponent,
    ListEmptyComponent,
  }: {
    data: ShareBetaListItem[];
    renderItem: (item: { item: ShareBetaListItem; index: number; target: string }) => ReactNode;
    onEndReached?: () => void;
    ListFooterComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) => {
    const names = data.flatMap((item) => (item.kind === 'ascent' ? [item.ascent.climbName] : []));
    useLayoutEffect(() => {
      fixtureState.committedRows.push(names);
    }, [data]);
    if (names.includes('Owned recent-20')) {
      fixtureState.attemptedRows.push(names);
      if (fixtureState.blockedRows && fixtureState.suspendedRows) throw fixtureState.suspendedRows;
    }
    return (
      <div data-testid="actual-picker-list">
        {data.length
          ? data.map((item, index) => <div key={item.key}>{renderItem({ item, index, target: 'Cell' })}</div>)
          : ListEmptyComponent}
        {ListFooterComponent}
        <button onClick={onEndReached}>picker-end-reached</button>
      </div>
    );
  },
}));
vi.mock('../../../../components/AccessibleTextInput', () => ({
  AccessibleTextInput: ({
    value,
    placeholder,
    onChangeText,
  }: {
    value: string;
    placeholder?: string;
    onChangeText: (text: string) => void;
  }) => <input value={value} placeholder={placeholder} onChange={(event) => onChangeText(event.target.value)} />,
}));
vi.mock('../../../../components/ActivityIndicator', () => ({
  ActivityIndicator: () => <span data-testid="actual-picker-loading" />,
}));
vi.mock('../../../../components/ChromeIconButton', () => ({
  ChromeIconButton: ({
    onPress,
    testID,
    accessibilityLabel,
  }: {
    onPress: () => void;
    testID?: string;
    accessibilityLabel?: string;
  }) => (
    <button data-testid={testID} aria-label={accessibilityLabel} onClick={onPress}>
      close-picker
    </button>
  ),
  useChromeIconButtonSize: () => 40,
}));
vi.mock('../../../../hooks/use-display-grade', () => ({ useBoardseshGradesActive: () => false }));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (label: string | null | undefined) => label ?? null,
    formatGradeByDifficultyId: () => null,
  }),
}));
vi.mock('../../../../components/ClimbListThumbnail', () => ({ ClimbListThumbnail: () => null }));
vi.mock('../../../../components/ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../../../components/PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => {
    fixtureState.rowCallbacks.push(onPress);
    return (
      <button aria-label={accessibilityLabel} onClick={onPress}>
        {children}
      </button>
    );
  },
}));
// Only Beta is under test in DeferredSections. Local/log/other-feature
// producers do not create GraphQL deliveries and must stay outside this family.
vi.mock('@boardsesh/board-react', () => ({
  useLogbook: () => ({ logbook: [] }),
  useBoardAdapter: () => {
    throw new Error('Unexpected board adapter');
  },
}));
vi.mock('../../../../hooks/use-deferred-after-interactions', () => ({
  useDeferredAfterInteractions: (active: boolean) => active && fixtureState.sectionsReady,
}));
vi.mock('../../../../hooks/use-climb-settled', () => ({ useClimbSettled: (active: boolean) => active }));
vi.mock('../../../section-expand-store', () => ({
  useSectionExpanded: () => ({ expanded: false, loaded: true }),
  setSectionExpanded: () => {
    throw new Error('Unexpected saved section write');
  },
}));
vi.mock('../../../preference-store', () => ({
  getPreference: () => {
    throw new Error('Unexpected device preference read');
  },
  setPreference: () => {
    throw new Error('Unexpected device preference write');
  },
}));
vi.mock('../use-followed-authors', () => ({
  useFollowedAuthorsSnapshot: ({ loadWhenMissing }: { loadWhenMissing: boolean }) => {
    if (loadWhenMissing) throw new Error('Unexpected local followed authors load');
    return { data: { users: [] }, isError: false };
  },
}));
vi.mock('../use-following-climb-logs', () => ({
  useFollowingClimbLogs: (_board: string, _climb: string, options?: { enabled?: boolean }) => {
    if (options?.enabled) throw new Error('Unexpected crew HTTP read');
    return { data: undefined };
  },
  useClimbDwell: () => false,
}));
vi.mock('../use-climb-logs', () => ({
  useClimbLogsPreview: ({ enabled }: { enabled?: boolean }) => {
    if (enabled) throw new Error('Unexpected everyone HTTP read');
    return { data: undefined };
  },
  useClimbLogs: () => {
    throw new Error('Unexpected logs read');
  },
  flattenClimbLogPages: () => [],
}));
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/privacy/ContentAudienceControl', () => ({ ContentAudienceControl: () => null }));
vi.mock('../../../../components/CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    summary,
    headerAction,
    children,
  }: {
    title: string;
    summary?: string | null;
    headerAction?: ReactNode;
    children?: ReactNode;
  }) => (
    <section data-testid="actual-beta-header" data-title={title} data-summary={summary ?? ''}>
      {headerAction}
      {children}
    </section>
  ),
}));
vi.mock('../../../../components/play-drawer/LogbookSection', () => ({
  LogbookSection: () => {
    throw new Error('Unexpected non-beta section LogbookSection');
  },
}));
vi.mock('../../../../components/play-drawer/ClimberLogsSection', () => ({
  ClimberLogsSection: () => {
    throw new Error('Unexpected non-beta section ClimberLogsSection');
  },
}));
vi.mock('../../../../components/play-drawer/SimilarClimbsSection', () => ({
  SimilarClimbsSection: () => {
    throw new Error('Unexpected non-beta section SimilarClimbsSection');
  },
}));
vi.mock('../../../../components/play-drawer/CommunitySection', () => ({
  CommunitySection: () => {
    throw new Error('Unexpected non-beta section CommunitySection');
  },
}));
vi.mock('../../../../components/play-drawer/BoardseshGradeSection', () => ({
  BoardseshGradeSection: () => {
    throw new Error('Unexpected non-beta section BoardseshGradeSection');
  },
}));
vi.mock('../../../../components/play-drawer/SetterNotesSection', () => ({
  SetterNotesSection: () => {
    throw new Error('Unexpected non-beta section SetterNotesSection');
  },
}));
vi.mock('../../../../components/play-drawer/ActiveHoldsSection', () => ({
  ActiveHoldsSection: () => {
    throw new Error('Unexpected non-beta section ActiveHoldsSection');
  },
}));
vi.mock('../../../../components/navigation/TabBarHideFollower', () => ({
  TabBarHideFollower: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('../../../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'material',
    colorScheme: 'light',
    systemColors: { secondaryBackground: '#ffffff', label: '#000000' },
    brandColors: { success: '#008800', error: '#880000', primary: '#000088', warning: '#888800' },
  }),
}));
vi.mock('../../../haptics', () => ({
  hapticSuccess: fixtureState.success,
  hapticError: fixtureState.error,
  hapticSelection: fixtureState.rowHaptic,
}));
vi.mock('../../../announce-queued', () => ({ announceQueued: fixtureState.announce }));

import { createScopedHttpFixture as makeHttp } from '../../__tests__/fixtures/scoped-http';
import {
  useBetaReaderOwner,
  useBetaLinks,
  createBetaCauseKeeper,
  createBetaOpeningCoordinator,
  type BetaCauseKeeper,
  type BetaCompletion,
} from '../use-beta-links';
import { ToastProvider, useToast } from '../../../../providers/toast-provider';

const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  dispose
    .splice(0)
    .reverse()
    .forEach((release) => release());
  onlineManager.setOnline(true);
  fixtureState.sectionsReady = false;
  fixtureState.transitionPages = false;
  fixtureState.blockedRows = false;
  fixtureState.suspendedRows = undefined;
  fixtureState.attemptedRows.splice(0);
  fixtureState.committedRows.splice(0);
  fixtureState.platform = 'web';
  fixtureState.http = null;
  fixtureState.scope = null;
  fixtureState.authListeners.clear();
  fixtureState.routeDelete = undefined;
  fixtureState.routeParams = {};
  fixtureState.rowCallbacks.splice(0);
  void fixtureState.requests.splice(0);
  void fixtureState.operationSignals.splice(0);
  fixtureState.modalProps = null;
  vi.clearAllMocks();
});
function owned() {
  const http = makeHttp();
  fixtureState.http = http;
  const scope = http.scope();
  fixtureState.scope = scope;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  http.performFetch.mockImplementation(async (_url, options) => {
    const packet = JSON.parse((options as RequestInit).body as string) as { query: string };
    return Response.json({
      data: packet.query.includes('OwnedFresh') ? { viewer: { id: 'owned-A' } } : { attachBetaLink: true },
    });
  });
  dispose.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, scope, cache };
}
function InlineError({ record }: { record: { guard: ToastGuard; message: string } }) {
  const current = useSyncExternalStore(record.guard.subscribe, () => {
    try {
      record.guard.assertCurrent();
      return true;
    } catch {
      return false;
    }
  });
  useInsertionEffect(() => () => record.guard.release(), [record]);
  return current ? <span>{record.message}</span> : null;
}

// FIRST keeper proof only: the producer uses actual beta opening/keeper code,
// actual original SDK operation and real Toast sink. Route/sheet source wiring
// and their producer event hosts remain separate mandatory later evidence.
function keeperHarness(current: ReturnType<typeof owned>, kind: 'success' | 'error' = 'success') {
  // Deliberate native Toast sink proof; selected consumers below use real web OS.
  fixtureState.platform = 'ios';
  const coordinator = createBetaOpeningCoordinator();
  const opening = coordinator.open(current.scope, 'owned-beta-target');
  let completion: BetaCompletion | undefined;
  let errorGuard: ToastGuard | undefined;
  let finished: Promise<void> = Promise.resolve();
  function Producer({ close }: { close: () => void }) {
    const { showGuardedToast } = useToast();
    const owner = useRef({
      mounted: true,
      controller: new AbortController(),
      keeper: undefined as BetaCauseKeeper | undefined,
    });
    const [error, setError] = useState<{ guard: ToastGuard; message: string } | null>(null);
    useInsertionEffect(
      () => () => {
        owner.current.mounted = false;
        owner.current.keeper?.abandonProducer();
        owner.current.controller.abort();
      },
      [],
    );
    const submit = () => {
      const operationController = new AbortController();
      const operation = current.operations.create(current.scope.scope, { signal: operationController.signal });
      const originalProducer = owner.current;
      const keeper = createBetaCauseKeeper({
        opening,
        operation,
        assertIntent: () => {
          if (!originalProducer.mounted) throw new Error('Original producer deleted');
          opening.assertAction();
        },
        signal: originalProducer.controller.signal,
        abort: () => operationController.abort(),
        onReleased: fixtureState.released,
      });
      originalProducer.keeper = keeper;
      finished = (async () => {
        try {
          if (kind === 'error') {
            let exact: unknown;
            try {
              await operation.request(ATTACH_BETA_LINK, {
                input: { boardType: 'kilter', climbUuid: 'owned-climb', link: 'https://instagram.com/reel/owned' },
              });
            } catch (error) {
              exact = error;
            }
            operation.assertErrorDeliveries(exact);
            keeper.settled(() => operation.assertErrorDeliveries(exact));
            errorGuard = keeper.retain();
            errorGuard.assertCurrent();
            setError({ guard: errorGuard, message: 'Owned authentic SDK guidance' });
            return;
          }
          await operation.request<AttachBetaLinkMutationResponse>(ATTACH_BETA_LINK, {
            input: { boardType: 'kilter', climbUuid: 'owned-climb', link: 'https://instagram.com/reel/owned' },
          });
          operation.assertDeliveries();
          keeper.settled(operation.assertDeliveries);
          const pending = keeper.retain();
          completion = keeper.acceptCompletion();
          pending.release();
          completion.close(close);
          completion.assertCurrent();
          showGuardedToast('Owned accepted beta', 'success', completion);
        } finally {
          keeper.releaseCoordinator();
        }
      })();
    };
    return (
      <div data-testid="actual-producer">
        <button onClick={submit}>attach-owned-beta</button>
        {error && <InlineError record={error} />}
      </div>
    );
  }
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <QueryClientProvider client={current.cache}>
        <ToastProvider>{open && <Producer close={() => setOpen(false)} />}</ToastProvider>
      </QueryClientProvider>
    );
  }
  const screen = render(<Host />);
  return {
    screen,
    coordinator,
    opening,
    completion: () => completion,
    errorGuard: () => errorGuard,
    finished: () => finished,
  };
}

describe('beta first runtime keeper checkpoint: actual SDK and real Toast', () => {
  it('imports the actual native module and subscribes without credential I/O', async () => {
    const native = await vi.importActual<typeof import('../../use-auth-token')>('../../use-auth-token');
    const listener = vi.fn();
    const release = native.subscribeHttpOperationScope(listener);
    release();
    release();
    expect(fixtureState.credentialRead).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
  it('retains original success through intended producer deletion and actual Toast first commit, then releases once', async () => {
    const current = owned();
    const host = keeperHarness(current);
    fireEvent.click(host.screen.getByText('attach-owned-beta'));
    await act(() => host.finished());
    expect(host.screen.queryByTestId('actual-producer')).toBeNull();
    expect(host.screen.getByText('Owned accepted beta')).toBeTruthy();
    expect(fixtureState.success).toHaveBeenCalledOnce();
    expect(fixtureState.announce).toHaveBeenCalledOnce();
    expect(() => host.completion()!.assertCurrent()).not.toThrow();
    expect(fixtureState.released).not.toHaveBeenCalled();
    fireEvent.click(host.screen.getByText('dismiss-toast'));
    expect(fixtureState.released).toHaveBeenCalledOnce();
    expect(fixtureState.authListeners.size).toBe(0);
    host.completion()!.release();
    expect(fixtureState.released).toHaveBeenCalledOnce();
  });
  it.each(['new-opening', 'B', 'expiry-with-live-E2'] as const)(
    'retires accepted original cause after %s without borrowing another authority',
    async (change) => {
      const current = owned();
      const host = keeperHarness(current);
      fireEvent.click(host.screen.getByText('attach-owned-beta'));
      await act(() => host.finished());
      expect(host.screen.getByText('Owned accepted beta')).toBeTruthy();
      let fresh: ReturnType<typeof current.operations.capture> | undefined;
      if (change === 'expiry-with-live-E2') {
        current.clock(100_000);
        fresh = current.operations.capture();
        await fresh.request('query OwnedFresh { viewer { id } }');
        fresh.assertDeliveries();
        current.clock(130_000);
        expect(() => host.completion()!.assertCurrent()).toThrow();
        expect(() => fresh!.assertDeliveries()).not.toThrow();
      } else
        act(() => {
          if (change === 'B') current.switchAccount('owned-B');
          else host.coordinator.open(current.scope, 'owned-beta-target');
        });
      await waitFor(() => expect(host.screen.queryByText('Owned accepted beta')).toBeNull());
      expect(fixtureState.success).toHaveBeenCalledOnce();
      expect(fixtureState.released).toHaveBeenCalledOnce();
      fresh?.dispose();
    },
  );
  it('keeps an authentic original error guard separate and removes expired inline guidance while E2 stays live', async () => {
    const current = owned();
    current.performFetch.mockImplementationOnce(async () =>
      Response.json({ errors: [{ message: 'Owned authentic error' }] }),
    );
    const host = keeperHarness(current, 'error');
    fireEvent.click(host.screen.getByText('attach-owned-beta'));
    await act(() => host.finished());
    expect(host.screen.getByText('Owned authentic SDK guidance')).toBeTruthy();
    expect(fixtureState.success).not.toHaveBeenCalled();
    expect(fixtureState.error).not.toHaveBeenCalled();
    current.clock(100_000);
    const fresh = current.operations.capture();
    await fresh.request('query OwnedFresh { viewer { id } }');
    fresh.assertDeliveries();
    current.clock(130_000);
    expect(() => host.errorGuard()!.assertCurrent()).toThrow();
    expect(() => fresh.assertDeliveries()).not.toThrow();
    await waitFor(() => expect(host.screen.queryByText('Owned authentic SDK guidance')).toBeNull());
    fresh.dispose();
  });
});

function deferredValue<Contents>() {
  let resolve!: (contents: Contents) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Contents>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
describe('actual shared attach hook with original owned SDK', () => {
  it('freezes input before held SDK work and invalidates only original A when the caller mutates its object to B', async () => {
    const current = owned();
    const { useAttachBetaLink } = await import('../index');
    const opening = createBetaOpeningCoordinator().open(current.scope, 'kilter:owned-climb-A');
    const originalKey = current.scope.key(['betaLinks', 'kilter', 'owned-climb-A']);
    const otherKey = current.scope.key(['betaLinks', 'tension', 'owned-climb-B']);
    current.cache.setQueryData(originalKey, { betaLinks: [] });
    current.cache.setQueryData(otherKey, { betaLinks: [] });
    const held = deferredValue<Response>();
    current.performFetch.mockReturnValueOnce(held.promise);
    const wrapper = ({ children }: { children?: ReactNode }) => (
      <QueryClientProvider client={current.cache}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useAttachBetaLink(), { wrapper });
    const input = { boardType: 'kilter', climbUuid: 'owned-climb-A', link: 'https://instagram.com/reel/owned-A' };
    const pending = hook.result.current.attachWithOutcome(input, { opening, assertIntent: opening.assertAction });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    const packet = JSON.parse((current.performFetch.mock.calls[0][1] as RequestInit).body as string) as {
      variables: { input: typeof input };
    };
    expect(packet.variables.input).toEqual(input);
    input.boardType = 'tension';
    input.climbUuid = 'owned-climb-B';
    held.resolve(Response.json({ data: { attachBetaLink: true } }));
    let outcome: Awaited<typeof pending> | undefined;
    await act(async () => {
      outcome = await pending;
    });
    expect(outcome?.kind).toBe('delivered');
    await waitFor(() => expect(current.cache.getQueryState(originalKey)?.isInvalidated).toBe(true));
    expect(current.cache.getQueryState(otherKey)?.isInvalidated).toBe(false);
    if (outcome && outcome.kind !== 'held') outcome.release();
    hook.unmount();
  });
});

// Actual hook + active reader: no replaced refresh function or accepting guard.
describe('actual shared attach refresh at the physical selected fetch', () => {
  it.each(['fresh', 'prewrite-pending'] as const)(
    'requires one actual postwrite reader fetch without cancelling a prior independent read: %s',
    async (phase) => {
      const current = owned();
      const { useAttachBetaLink } = await import('../index');
      const opening = createBetaOpeningCoordinator().open(current.scope, 'kilter:owned-A');
      const oldResponse = deferredValue<Response>();
      const postwrite = { ...ownedBetaRow('POST-WRITE'), climbUuid: 'owned-A' };
      let written = false;
      let betaReads = 0;
      current.performFetch.mockImplementation(async (_url, init) => {
        const packet = JSON.parse((init as RequestInit).body as string) as { query: string };
        if (packet.query.includes('betaLinks(')) {
          betaReads += 1;
          if (phase === 'prewrite-pending' && betaReads === 2) return oldResponse.promise;
          return Response.json({ data: { betaLinks: written ? [postwrite] : [] } });
        }
        written = true;
        return Response.json({ data: { attachBetaLink: true } });
      });
      const hook = renderHook(
        () => {
          const owner = useBetaReaderOwner('kilter', 'owned-A');
          return {
            reader: useBetaLinks('kilter', 'owned-A', true, owner),
            attach: useAttachBetaLink(),
          };
        },
        { wrapper: ({ children }) => <QueryClientProvider client={current.cache}>{children}</QueryClientProvider> },
      );
      await waitFor(() => expect(hook.result.current.reader.data).toEqual([]));
      const key = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
      let independent: Promise<unknown> | undefined;
      let originalQuerySignal: AbortSignal | undefined;
      let originalPhysicalSignal: AbortSignal | null | undefined;
      if (phase === 'prewrite-pending') {
        act(() => {
          independent = current.cache.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
        });
        await waitFor(() => expect(betaReads).toBe(2));
        originalQuerySignal = fixtureState.operationSignals.at(-1);
        originalPhysicalSignal = (current.performFetch.mock.calls.at(-1)![1] as RequestInit).signal;
        expect(originalQuerySignal).toBeDefined();
        expect(originalQuerySignal?.aborted).toBe(false);
        expect(originalPhysicalSignal?.aborted).toBe(false);
      }
      let outcome: Awaited<ReturnType<typeof hook.result.current.attach.attachWithOutcome>> | undefined;
      try {
        await act(async () => {
          outcome = await hook.result.current.attach.attachWithOutcome(
            { boardType: 'kilter', climbUuid: 'owned-A', link: postwrite.link },
            { opening, assertIntent: opening.assertAction },
          );
        });
        expect(outcome?.kind).toBe('delivered');
        if (!outcome || outcome.kind !== 'delivered') throw new Error('Missing actual successful SDK attach');
        outcome.assertCurrent();
        expect(routePackets(current).filter((packet) => packet.query.includes('attachBetaLink('))).toHaveLength(1);
        if (phase === 'prewrite-pending') {
          expect(originalQuerySignal?.aborted).toBe(false);
          expect(originalPhysicalSignal?.aborted).toBe(false);
        }
        // The coordinator retains original writer authority until its reader
        // work settles, even after releasing this separate visible hold.
        outcome.release();
        if (independent) {
          await act(async () => {
            oldResponse.resolve(Response.json({ data: { betaLinks: [] } }));
            await independent;
          });
        }
        await waitFor(() => expect(fixtureState.authListeners.size).toBe(0));
        if (phase === 'prewrite-pending') expect(originalQuerySignal?.aborted).toBe(false);
        const reads = routePackets(current).filter((packet) => packet.query.includes('betaLinks('));
        // A prewrite response cannot count as a fresh postwrite observation,
        // even if it settles after the actual ATTACH succeeded.
        expect(reads).toHaveLength(phase === 'prewrite-pending' ? 3 : 2);
        expect(current.cache.getQueryData(key)).toMatchObject({ betaLinks: [{ link: postwrite.link }] });
      } finally {
        oldResponse.resolve(Response.json({ data: { betaLinks: [] } }));
        if (outcome && outcome.kind !== 'held') outcome.release();
      }
    },
  );
  it.each([
    'expired-E1-live-E2',
    'current-E1',
    'retired-reader',
    'expired-after-read-body',
    'current-after-read-body',
  ] as const)('retains original write and reader through held acquire: %s', async (change) => {
    const current = owned();
    const { useAttachBetaLink } = await import('../index');
    const opening = createBetaOpeningCoordinator().open(current.scope, 'kilter:owned-climb');
    let betaReads = 0;
    const readBody = deferredValue<void>();
    const enteredBody = deferredValue<void>();
    current.performFetch.mockImplementation(async (_url, options) => {
      const packet = JSON.parse((options as RequestInit).body as string) as { query: string };
      if (packet.query.includes('betaLinks(')) {
        betaReads += 1;
        if (betaReads === 2 && (change === 'expired-after-read-body' || change === 'current-after-read-body')) {
          const response = Response.json({
            data: {
              betaLinks: [
                {
                  climbUuid: 'owned-climb',
                  link: 'https://instagram.com/reel/NEW-REFRESHED',
                  foreignUsername: null,
                  angle: 40,
                  thumbnail: null,
                  isListed: true,
                  createdAt: '2026-01-01',
                  tickUuid: null,
                  boardId: null,
                },
              ],
            },
          });
          const decode = response.text.bind(response);
          response.text = async () => {
            enteredBody.resolve();
            await readBody.promise;
            return decode();
          };
          return response;
        }
        return Response.json({ data: { betaLinks: [] } });
      }
      if (packet.query.includes('OwnedFresh')) return Response.json({ data: { viewer: { id: 'owned-A' } } });
      const response = Response.json({ data: { attachBetaLink: true } });
      const readText = response.text.bind(response);
      // Transparent SDK-body scheduling: E1 is genuinely decoded and
      // admitted while live, then the REAL active-reader refresh needs E2.
      response.text = async () => {
        const body = await readText();
        current.clock(100_000);
        return body;
      };
      return response;
    });
    const wrapper = ({ children }: { children?: ReactNode }) => (
      <QueryClientProvider client={current.cache}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => {
        const owner = useBetaReaderOwner('kilter', 'owned-climb');
        const reader = useBetaLinks('kilter', 'owned-climb', true, owner);
        return { reader, attach: useAttachBetaLink() };
      },
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.reader.data).toEqual([]));
    expect(current.performFetch).toHaveBeenCalledTimes(1);
    const issue = current.issueLease.getMockImplementation()!;
    const nextReply = await issue();
    const held = deferredValue<Response>();
    const entered = deferredValue<void>();
    current.issueLease.mockImplementationOnce(async () => {
      entered.resolve();
      return held.promise;
    });
    vi.useFakeTimers();
    let outcome: Awaited<ReturnType<typeof hook.result.current.attach.attachWithOutcome>> | undefined;
    let completion: BetaCompletion | undefined;
    let sibling: QueryObserver | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      outcome = await hook.result.current.attach.attachWithOutcome(
        { boardType: 'kilter', climbUuid: 'owned-climb', link: 'https://instagram.com/reel/owned' },
        { opening, assertIntent: opening.assertAction },
      );
      expect(outcome.kind).toBe('delivered');
      if (outcome.kind !== 'delivered') throw new Error('Actual SDK write must deliver while E1 is live');
      const delivered = outcome;
      delivered.assertCurrent();
      await entered.promise;
      const key = current.scope.key(['betaLinks', 'kilter', 'owned-climb']);
      const physical = current.cache.getQueryCache().find({ queryKey: key, exact: true })?.promise;
      expect(physical).toBeDefined();
      let fresh: ReturnType<typeof current.operations.capture> | undefined;
      let freshRequest: Promise<unknown> | undefined;
      if (change === 'expired-after-read-body' || change === 'current-after-read-body') {
        current.clock(110_000);
        held.resolve(nextReply);
        await enteredBody.promise;
        fresh = current.operations.capture();
        await fresh.request('query OwnedFresh { viewer { id } }');
        fresh.assertDeliveries();
        current.clock(change === 'expired-after-read-body' ? 130_000 : 115_000);
        if (change === 'expired-after-read-body') expect(() => delivered.assertCurrent()).toThrow();
        else outcome.assertCurrent();
        readBody.resolve();
      } else if (change === 'expired-E1-live-E2') {
        fresh = current.operations.capture();
        freshRequest = fresh.request('query OwnedFresh { viewer { id } }');
        current.clock(130_000);
        expect(() => delivered.assertCurrent()).toThrow();
      } else {
        current.clock(110_000);
        if (change === 'retired-reader') {
          // Keep an actual second query observer so deleting the original
          // reader cannot merely cancel its shared physical request.
          sibling = new QueryObserver(current.cache, { queryKey: key, enabled: false });
          unsubscribe = sibling.subscribe(() => {});
          completion = outcome.acceptCompletion();
          hook.unmount();
        }
      }
      await act(async () => {
        held.resolve(nextReply);
        await Promise.allSettled([physical!, ...(freshRequest ? [freshRequest] : [])]);
      });
      if (fresh) {
        fresh.assertDeliveries();
        fresh.dispose();
      }
      const packets = current.performFetch.mock.calls.map(
        ([, options]) => JSON.parse((options as RequestInit).body as string).query as string,
      );
      expect(packets.filter((document) => document.includes('betaLinks('))).toHaveLength(
        change === 'current-E1' || change === 'expired-after-read-body' || change === 'current-after-read-body' ? 2 : 1,
      );
      if (change === 'expired-after-read-body') expect(current.cache.getQueryData(key)).toEqual({ betaLinks: [] });
      if (change === 'current-after-read-body')
        expect(current.cache.getQueryData(key)).toMatchObject({
          betaLinks: [{ link: 'https://instagram.com/reel/NEW-REFRESHED' }],
        });
      if (change === 'current-E1') outcome.assertCurrent();
      if (change === 'expired-E1-live-E2')
        expect(packets.filter((document) => document.includes('OwnedFresh'))).toHaveLength(1);
    } finally {
      unsubscribe?.();
      sibling?.destroy();
      completion?.release();
      if (outcome && outcome.kind !== 'held') outcome.release();
      vi.useRealTimers();
    }
  });
});

async function actualSheet(current: ReturnType<typeof owned>) {
  const { AddBetaVideoSheet } = await import('../../../../components/AddBetaVideoSheet');
  const coordinator = createBetaOpeningCoordinator();
  const climb = {
    uuid: 'owned-climb',
    name: 'Owned climb',
    difficulty: 'V4',
    setter_username: 'owned-setter',
  } as import('@boardsesh/shared-schema').Climb;
  function Host() {
    const [opening, setOpening] = useState(() => coordinator.open(current.scope, 'kilter:owned-climb'));
    const [visible, setVisible] = useState(true);
    const close = () => {
      if (coordinator.current() !== opening) return;
      opening.close();
      fixtureState.closeSheet();
      setVisible(false);
    };
    return (
      <QueryClientProvider client={current.cache}>
        <ToastProvider>
          <button
            onClick={() => {
              const next = coordinator.open(current.scope, 'kilter:owned-climb');
              setOpening(next);
              setVisible(true);
            }}
          >
            new-sheet-opening
          </button>
          <AddBetaVideoSheet
            visible={visible}
            climb={climb}
            boardName="kilter"
            layoutId={1}
            angle={40}
            opening={opening}
            onClose={close}
          />
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { screen: render(<Host />), coordinator };
}
describe('actual selected AddBetaVideoSheet kept surface and original actions', () => {
  it('keeps the ModalSheet instance and refuses an actual retained old close callback after equivalent reopen', async () => {
    const current = owned();
    const host = await actualSheet(current);
    const identity = host.screen.getByTestId('actual-beta-modal').getAttribute('data-modal-id');
    const oldClose = fixtureState.modalProps!.onClose!;
    fireEvent.click(host.screen.getByText('new-sheet-opening'));
    expect(host.screen.getByTestId('actual-beta-modal').getAttribute('data-modal-id')).toBe(identity);
    await act(async () => {
      await oldClose();
    });
    expect(fixtureState.closeSheet).not.toHaveBeenCalled();
    expect(host.screen.getByTestId('actual-beta-modal').getAttribute('data-visible')).toBe('yes');
    expect(fixtureState.modalMounted).toHaveBeenCalledOnce();
  });
});

describe('actual selected sheet SDK completion and draft revision', () => {
  it.each(['current', 'draft-edit'] as const)(
    'retains original intent through actual initial ATTACH acquire: %s',
    async (phase) => {
      const current = owned();
      const entered = deferredValue<void>();
      const releaseAcquire = deferredValue<void>();
      const originalAcquire = current.backend.acquire.bind(current.backend);
      // Complete the actual acquisition and its notifications first. Hold only
      // the Promise return, before the real request authority resumes its await.
      // The same original issued lease and every acceptance guard stay real.
      const acquire = vi.spyOn(current.backend, 'acquire').mockImplementationOnce(async (...parameters) => {
        const lease = await originalAcquire(...parameters);
        entered.resolve();
        await releaseAcquire.promise;
        return lease;
      });
      dispose.push(() => acquire.mockRestore());
      const host = await actualSheet(current);
      fireEvent.change(host.screen.getByLabelText('owned-beta-url'), {
        target: { value: 'https://www.instagram.com/reel/BEFORE-ACQUIRE/' },
      });
      fireEvent.click(host.screen.getByText('submit-beta-sheet'));
      await entered.promise;
      const physical = fixtureState.requests.at(-1);
      expect(physical).toBeDefined();
      expect(current.issueLease).toHaveBeenCalledOnce();
      expect(current.performFetch).not.toHaveBeenCalled();
      if (phase === 'draft-edit') {
        fireEvent.change(host.screen.getByLabelText('owned-beta-url'), {
          target: { value: 'https://www.instagram.com/reel/AFTER-ACQUIRE/' },
        });
        expect((host.screen.getByLabelText('owned-beta-url') as HTMLInputElement).value).toBe(
          'https://www.instagram.com/reel/AFTER-ACQUIRE/',
        );
      }
      await act(async () => {
        releaseAcquire.resolve();
        await Promise.allSettled([physical!]);
      });
      const attachments = routePackets(current).filter((packet) => packet.query.includes('attachBetaLink('));
      // This outer physical-packet assertion precedes later UI refusals.
      expect(attachments).toHaveLength(phase === 'draft-edit' ? 0 : 1);
      if (phase === 'draft-edit') {
        expect((host.screen.getByLabelText('owned-beta-url') as HTMLInputElement).value).toBe(
          'https://www.instagram.com/reel/AFTER-ACQUIRE/',
        );
        expect(fixtureState.closeSheet).not.toHaveBeenCalled();
        expect(fixtureState.track).not.toHaveBeenCalled();
        expect(fixtureState.success).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.attachSuccess')).toBeTruthy());
        expect(attachments[0].variables).toMatchObject({
          input: { link: 'https://www.instagram.com/reel/BEFORE-ACQUIRE/' },
        });
        expect(fixtureState.closeSheet).toHaveBeenCalledOnce();
        expect(fixtureState.success).toHaveBeenCalledOnce();
      }
    },
  );
  it('closes the current actual sheet and keeps its original success through real Toast first commit', async () => {
    const current = owned();
    const host = await actualSheet(current);
    const identity = host.screen.getByTestId('actual-beta-modal').getAttribute('data-modal-id');
    fireEvent.change(host.screen.getByLabelText('owned-beta-url'), {
      target: { value: 'https://www.instagram.com/reel/current/' },
    });
    fireEvent.click(host.screen.getByText('submit-beta-sheet'));
    await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.attachSuccess')).toBeTruthy());
    expect(fixtureState.closeSheet).toHaveBeenCalledOnce();
    expect(fixtureState.track).toHaveBeenCalledOnce();
    expect(fixtureState.success).toHaveBeenCalledOnce();
    expect(host.screen.getByTestId('actual-beta-modal').getAttribute('data-visible')).toBe('no');
    expect(host.screen.getByTestId('actual-beta-modal').getAttribute('data-modal-id')).toBe(identity);
    fireEvent.click(host.screen.getByText('dismiss-toast'));
    host.screen.unmount();
    expect(fixtureState.authListeners.size).toBe(0);
  });
  it.each(['success', 'error'] as const)(
    'editing during held original %s keeps the new draft and allows a new current submission',
    async (reply) => {
      const current = owned();
      const held = deferredValue<Response>();
      current.performFetch.mockReturnValueOnce(held.promise);
      const host = await actualSheet(current);
      fireEvent.change(host.screen.getByLabelText('owned-beta-url'), {
        target: { value: 'https://www.instagram.com/reel/OLD/' },
      });
      fireEvent.click(host.screen.getByText('submit-beta-sheet'));
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
      const physical = fixtureState.requests.at(-1)!;
      fireEvent.change(host.screen.getByLabelText('owned-beta-url'), {
        target: { value: 'https://www.instagram.com/reel/NEW/' },
      });
      await act(async () => {
        held.resolve(
          reply === 'success'
            ? Response.json({ data: { attachBetaLink: true } })
            : Response.json({ errors: [{ message: 'Old authentic SDK guidance' }] }),
        );
        await Promise.allSettled([physical]);
      });
      expect((host.screen.getByLabelText('owned-beta-url') as HTMLInputElement).value).toBe(
        'https://www.instagram.com/reel/NEW/',
      );
      expect(fixtureState.closeSheet).not.toHaveBeenCalled();
      expect(fixtureState.track).not.toHaveBeenCalled();
      expect(fixtureState.success).not.toHaveBeenCalled();
      expect(host.screen.queryByText('Old authentic SDK guidance')).toBeNull();
      fireEvent.click(host.screen.getByText('submit-beta-sheet'));
      await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.attachSuccess')).toBeTruthy());
      expect(current.performFetch).toHaveBeenCalledTimes(2);
      const packet = JSON.parse((current.performFetch.mock.calls[1][1] as RequestInit).body as string) as {
        variables: { input: { link: string } };
      };
      expect(packet.variables.input.link).toBe('https://www.instagram.com/reel/NEW/');
      expect(fixtureState.closeSheet).toHaveBeenCalledOnce();
      expect(fixtureState.success).toHaveBeenCalledOnce();
      expect(fixtureState.track).toHaveBeenCalledOnce();
    },
  );
  it('refuses Clipboard completion from an earlier opening and keeps the current copy action live', async () => {
    const current = owned();
    const held = deferredValue<void>();
    fixtureState.clipboard.mockReturnValueOnce(held.promise);
    const host = await actualSheet(current);
    fireEvent.click(host.screen.getByText('mobile.betaVideos.copyCaption'));
    expect(fixtureState.clipboard).toHaveBeenCalledOnce();
    fireEvent.click(host.screen.getByText('new-sheet-opening'));
    await act(async () => {
      held.resolve();
      await held.promise;
    });
    expect(fixtureState.track).not.toHaveBeenCalled();
    expect(fixtureState.success).not.toHaveBeenCalled();
    fireEvent.click(host.screen.getByText('mobile.betaVideos.copyCaption'));
    await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.captionCopied')).toBeTruthy());
    expect(fixtureState.track).toHaveBeenCalledOnce();
    expect(fixtureState.success).toHaveBeenCalledOnce();
  });
  it('blocks the actual late Instagram fallback after retirement, while a current fallback still opens', async () => {
    const current = owned();
    const held = deferredValue<void>();
    fixtureState.openURL.mockReturnValueOnce(held.promise);
    const host = await actualSheet(current);
    fireEvent.click(host.screen.getByText('mobile.betaVideos.openInstagram'));
    await waitFor(() => expect(fixtureState.openURL).toHaveBeenCalledTimes(1));
    fireEvent.click(host.screen.getByText('new-sheet-opening'));
    await act(async () => {
      held.reject(new Error('Owned late app absence'));
      await Promise.allSettled([held.promise]);
    });
    expect(fixtureState.openURL).toHaveBeenCalledTimes(1);
    expect(fixtureState.track).not.toHaveBeenCalled();
    fixtureState.openURL.mockRejectedValueOnce(new Error('Owned app absent'));
    fireEvent.click(host.screen.getByText('mobile.betaVideos.openInstagram'));
    await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.instagramNotInstalled')).toBeTruthy());
    expect(fixtureState.openURL.mock.calls.map(([url]) => url)).toEqual([
      'instagram://camera',
      'instagram://camera',
      'https://www.instagram.com',
    ]);
    expect(fixtureState.track).toHaveBeenCalledOnce();
  });
});

it('retires actual owner/card/URL Toast on deletion without insertion-effect updates', async () => {
  const current = owned();
  const { BetaVideoCard } = await import('../../../../components/play-drawer/BetaVideoCard');
  fixtureState.openURL.mockRejectedValueOnce(new Error('Owned URL unavailable'));
  let original: ReturnType<typeof useBetaReaderOwner>;
  const errors: unknown[][] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parameters: unknown[]) => {
    errors.push(parameters);
  });
  function ReaderCard() {
    const owner = useBetaReaderOwner('kilter', 'owned-climb');
    original = owner;
    const link = {
      climb_uuid: 'owned-climb',
      link: 'https://www.instagram.com/reel/owned/',
    } as import('@boardsesh/shared-schema').BetaLink;
    return <BetaVideoCard originalOwner={owner} link={link} />;
  }
  function Host() {
    const [visible, setVisible] = useState(true);
    return (
      <QueryClientProvider client={current.cache}>
        <ToastProvider>
          <button onClick={() => setVisible(false)}>delete-original-owner</button>
          {visible && <ReaderCard />}
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  try {
    const screen = render(<Host />);
    fireEvent.click(screen.getByText('open-original-card'));
    await waitFor(() => expect(screen.getByText('mobile.betaVideos.openError')).toBeTruthy());
    expect(() => original!.assertCurrent()).not.toThrow();
    fireEvent.click(screen.getByText('delete-original-owner'));
    expect(() => original!.assertCurrent()).toThrow();
    await waitFor(() => expect(screen.queryByText('mobile.betaVideos.openError')).toBeNull());
    expect(
      errors.filter((parameters) =>
        parameters.some((parameter) => String(parameter).includes('useInsertionEffect must not schedule updates')),
      ),
    ).toEqual([]);
  } finally {
    errorSpy.mockRestore();
  }
});

it('actual hook producer abandonment retires an authentic error Toast synchronously and delivers deletion notifications outside insertion cleanup', async () => {
  const current = owned();
  const { useAttachBetaLink } = await import('../index');
  const opening = createBetaOpeningCoordinator().open(current.scope, 'kilter:owned-climb');
  current.performFetch.mockResolvedValueOnce(
    Response.json({ errors: [{ message: 'Owned authentic retained error' }] }),
  );
  const errors: unknown[][] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parameters: unknown[]) => {
    errors.push(parameters);
  });
  let retained: ToastGuard | undefined;
  function Producer() {
    const attach = useAttachBetaLink();
    const { showGuardedToast } = useToast();
    return (
      <button
        onClick={() => {
          void attach
            .attachWithOutcome(
              { boardType: 'kilter', climbUuid: 'owned-climb', link: 'https://instagram.com/reel/owned/' },
              { opening, assertIntent: opening.assertAction },
            )
            .then((outcome) => {
              if (outcome.kind !== 'request-error') return;
              try {
                const message = outcome.readMessage();
                retained = outcome.retain();
                showGuardedToast(message!, 'error', retained);
              } finally {
                outcome.release();
              }
            });
        }}
      >
        actual-hook-error
      </button>
    );
  }
  function Host() {
    const [visible, setVisible] = useState(true);
    return (
      <QueryClientProvider client={current.cache}>
        <ToastProvider>
          <button onClick={() => setVisible(false)}>delete-hook-producer</button>
          {visible && <Producer />}
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  try {
    const screen = render(<Host />);
    fireEvent.click(screen.getByText('actual-hook-error'));
    await waitFor(() => expect(screen.getByText('Owned authentic retained error')).toBeTruthy());
    expect(() => retained!.assertCurrent()).not.toThrow();
    fireEvent.click(screen.getByText('delete-hook-producer'));
    expect(() => retained!.assertCurrent()).toThrow();
    await waitFor(() => expect(screen.queryByText('Owned authentic retained error')).toBeNull());
    expect(
      errors.filter((parameters) =>
        parameters.some((parameter) => String(parameter).includes('useInsertionEffect must not schedule updates')),
      ),
    ).toEqual([]);
  } finally {
    retained?.release();
    spy.mockRestore();
  }
});

function ownedAscent(id: string): AscentFeedItem {
  return {
    uuid: id,
    climbUuid: `climb-${id}`,
    climbName: `Owned ${id}`,
    setterUsername: null,
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: null,
    layoutId: 8,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    difficulty: 20,
    difficultyName: 'V4',
    consensusDifficulty: 20,
    consensusDifficultyName: 'V4',
    boardseshDifficulty: null,
    boardseshConfidence: null,
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: '',
    climbedAt: '2026-07-31T12:00:00.000Z',
    frames: null,
  };
}
function routePackets(current: ReturnType<typeof owned>) {
  return current.performFetch.mock.calls.map(
    ([, options]) =>
      JSON.parse((options as RequestInit).body as string) as {
        query: string;
        variables?: {
          userId?: string;
          input?: { statusMode?: string; climbName?: string; limit?: number; offset?: number };
          inputUnknown?: unknown;
        };
      },
  );
}
async function actualRoute(
  current: ReturnType<typeof owned>,
  options: { preview?: 'missing' | 'error' | 'caption'; matches?: 'error' | 'none' | 'match'; hasMore?: boolean } = {},
) {
  const { openShareBeta } = await import('../use-beta-links');
  const Route = (await import('../../../../../app/share-beta')).default;
  const link = 'https://www.instagram.com/reel/owned-route/';
  const opening = openShareBeta(current.scope, link);
  fixtureState.routeParams = { link, betaOpening: opening.id };
  current.performFetch.mockImplementation(async (_url, init) => {
    const packet = JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables?: { input?: { climbName?: string; offset?: number } };
    };
    if (packet.query.includes('betaLinkPreview(')) {
      if (options.preview === 'error') return Response.json({ errors: [{ message: 'Owned preview unavailable' }] });
      return Response.json({
        data: { betaLinkPreview: { caption: options.preview === 'caption' ? 'Owned caption' : null, thumbnail: null } },
      });
    }
    if (packet.query.includes('userAscentCaptionMatches(')) {
      if (options.matches === 'error') return Response.json({ errors: [{ message: 'Owned match unavailable' }] });
      return Response.json({
        data: { userAscentCaptionMatches: options.matches === 'match' ? [ownedAscent('suggested')] : [] },
      });
    }
    if (packet.query.includes('userAscentsFeed(')) {
      const offset = packet.variables?.input?.offset ?? 0;
      const search = packet.variables?.input?.climbName;
      return Response.json({
        data: {
          userAscentsFeed: {
            items: [ownedAscent(search ? `search-${search}` : `recent-${offset}`)],
            totalCount: 40,
            hasMore: options.hasMore === true && offset === 0,
          },
        },
      });
    }
    if (packet.query.includes('OwnedFresh')) return Response.json({ data: { viewer: { id: 'owned-A' } } });
    if (packet.query.includes('attachBetaLink(')) return Response.json({ data: { attachBetaLink: true } });
    if (packet.query.includes('profile'))
      return Response.json({ data: { profile: { id: 'owned-A', username: 'owned-route-user' } } });
    throw new Error(`Unexpected actual route SDK document ${packet.query.slice(0, 70)}`);
  });
  function Host() {
    const [mounted, setMounted] = useState(true);
    fixtureState.routeDelete = () => setMounted(false);
    return (
      <QueryClientProvider client={current.cache}>
        <ToastProvider>
          {mounted && (
            <Suspense fallback={<span data-testid="actual-picker-suspended" />}>
              <Route />
            </Suspense>
          )}
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  const screen = render(<Host />);
  return {
    screen,
    opening,
    newOpening(nextLink = link) {
      const next = openShareBeta(fixtureState.scope!, nextLink);
      fixtureState.routeParams = { link: nextLink, betaOpening: next.id };
      screen.rerender(<Host />);
      return next;
    },
  };
}
describe('actual selected share route with genuine SDK manual picker', () => {
  it.each(['missing', 'error'] as const)(
    'uses the real recent SDK feed when preview is %s and closes the actual route through a guarded successful attach',
    async (preview) => {
      const current = owned();
      current.cache.setQueryData(['userAscentsFeed', 'owned-A', { statusMode: 'both' }], {
        pages: [{ userAscentsFeed: { items: [ownedAscent('RAW_PRIVATE_OLD')], hasMore: false } }],
        pageParams: [0],
      });
      const host = await actualRoute(current, { preview });
      await waitFor(() => expect(host.screen.getByText('Owned recent-0')).toBeTruthy());
      expect(host.screen.queryByText('Owned RAW_PRIVATE_OLD')).toBeNull();
      const feed = routePackets(current).filter((packet) => packet.query.includes('userAscentsFeed('));
      expect(feed).toHaveLength(1);
      expect(feed[0].variables).toEqual({ userId: 'owned-A', input: { statusMode: 'both', limit: 20, offset: 0 } });
      expect(routePackets(current).some((packet) => packet.query.includes('userAscentCaptionMatches('))).toBe(false);
      fireEvent.click(host.screen.getByText('Owned recent-0'));
      await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.attachSuccess')).toBeTruthy());
      expect(host.screen.queryByTestId('actual-picker-list')).toBeNull();
      expect(fixtureState.routeBack).toHaveBeenCalledOnce();
      expect(fixtureState.success).toHaveBeenCalledOnce();
      expect(fixtureState.track).toHaveBeenCalledOnce();
      const attach = routePackets(current).filter((packet) => packet.query.includes('attachBetaLink('));
      expect(attach).toHaveLength(1);
    },
  );
});

describe('actual selected route caption, search, page and row lifetimes', () => {
  it.each(['error', 'none'] as const)(
    'keeps real manual browsing and search when actual caption matching returns %s',
    async (matches) => {
      const current = owned();
      const host = await actualRoute(current, { preview: 'caption', matches });
      await waitFor(() => expect(host.screen.getByText('Owned recent-0')).toBeTruthy());
      const key = current.scope.key(['ascentCaptionMatches', 'owned-A', 'Owned caption']);
      await waitFor(() => expect(current.cache.getQueryState(key)?.fetchStatus).toBe('idle'));
      expect(current.cache.getQueryState(key)?.status).toBe(matches === 'error' ? 'error' : 'success');
      expect(host.screen.queryByText('Owned suggested')).toBeNull();
      vi.useFakeTimers();
      try {
        fireEvent.change(host.screen.getByPlaceholderText('mobile.betaVideos.shareSearchPlaceholder'), {
          target: { value: 'Purple' },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(299);
        });
        expect(routePackets(current).filter((packet) => packet.variables?.input?.climbName)).toHaveLength(0);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        const searchKey = current.scope.key([
          'userAscentsFeed',
          'owned-A',
          { statusMode: 'both', climbName: 'Purple' },
        ]);
        const physical = current.cache.getQueryCache().find({ queryKey: searchKey, exact: true })?.promise;
        expect(physical).toBeDefined();
        await act(async () => {
          await physical;
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(host.screen.getByText('Owned search-Purple')).toBeTruthy();
        const searched = routePackets(current).filter(
          (packet) => packet.query.includes('userAscentsFeed(') && packet.variables?.input?.climbName,
        );
        expect(searched).toHaveLength(1);
        expect(searched[0].variables).toEqual({
          userId: 'owned-A',
          input: { statusMode: 'both', climbName: 'Purple', limit: 20, offset: 0 },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('renders actual caption matches with manual rows and advances one actual page by offset20 per end reach', async () => {
    const current = owned();
    const host = await actualRoute(current, { preview: 'caption', matches: 'match', hasMore: true });
    await waitFor(() => expect(host.screen.getByText('Owned suggested')).toBeTruthy());
    expect(host.screen.getByText('Owned recent-0')).toBeTruthy();
    expect(routePackets(current).filter((packet) => packet.query.includes('userAscentsFeed('))).toHaveLength(1);
    fireEvent.click(host.screen.getByText('picker-end-reached'));
    await waitFor(() => expect(host.screen.getByText('Owned recent-20')).toBeTruthy());
    expect(host.screen.getByText('Owned recent-0')).toBeTruthy();
    const pages = routePackets(current).filter((packet) => packet.query.includes('userAscentsFeed('));
    expect(pages.map((packet) => packet.variables?.input?.offset)).toEqual([0, 20]);
    fireEvent.click(host.screen.getByText('picker-end-reached'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(routePackets(current).filter((packet) => packet.query.includes('userAscentsFeed('))).toHaveLength(2);
  });
  it.each(['new-opening', 'view-ABA', 'delete'] as const)(
    'refuses the actual retained old row callback after %s before haptic or attach',
    async (change) => {
      const current = owned();
      const host = await actualRoute(current);
      await waitFor(() => expect(host.screen.getByText('Owned recent-0')).toBeTruthy());
      const original = fixtureState.rowCallbacks.at(-1)!;
      expect(original).toBeTypeOf('function');
      const haptics = fixtureState.rowHaptic.mock.calls.length;
      if (change === 'new-opening')
        act(() => {
          host.newOpening();
        });
      else if (change === 'view-ABA')
        act(() => {
          current.switchAccount('owned-B');
          current.switchAccount('owned-A');
        });
      else fireEvent.click(host.screen.getByTestId('share-beta-close'));
      act(() => {
        original();
      });
      expect(fixtureState.rowHaptic).toHaveBeenCalledTimes(haptics);
      expect(routePackets(current).filter((packet) => packet.query.includes('attachBetaLink('))).toEqual([]);
      expect(fixtureState.track).not.toHaveBeenCalled();
      if (change === 'new-opening') {
        await waitFor(() => expect(host.screen.getByText('Owned recent-0')).toBeTruthy());
        fireEvent.click(host.screen.getByText('Owned recent-0'));
        await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.attachSuccess')).toBeTruthy());
        expect(routePackets(current).filter((packet) => packet.query.includes('attachBetaLink('))).toHaveLength(1);
      }
    },
  );
});

it('allows an actual ACKed appended row to start a new own attach after its page E1 expires with live E2', async () => {
  const current = owned();
  const host = await actualRoute(current, { hasMore: true });
  await waitFor(() => expect(host.screen.getByText('Owned recent-0')).toBeTruthy());
  fireEvent.click(host.screen.getByText('picker-end-reached'));
  await waitFor(() => expect(host.screen.getByText('Owned recent-20')).toBeTruthy());
  const key = current.scope.key(['userAscentsFeed', 'owned-A', { statusMode: 'both' }]);
  expect(httpPageSourceDiagnostics(current.cache, key).consumers).toBe(0);
  current.clock(100_000);
  const fresh = current.operations.capture();
  await fresh.request('query OwnedFresh { viewer { id } }');
  fresh.assertDeliveries();
  current.clock(130_000);
  fresh.assertDeliveries();
  fireEvent.click(host.screen.getByText('Owned recent-20'));
  await waitFor(() => expect(host.screen.getByText('mobile.betaVideos.attachSuccess')).toBeTruthy());
  const attached = routePackets(current).filter((packet) => packet.query.includes('attachBetaLink('));
  expect(attached).toHaveLength(1);
  expect(attached[0].variables).toMatchObject({ input: { climbUuid: 'climb-recent-20', tickUuid: 'recent-20' } });
  fresh.dispose();
});

function transitionFulfillment<Value>(pending: Promise<Value>): Promise<Value> {
  const ordinaryThen: typeof pending.then = pending.then.bind(pending);
  const scheduledThen: typeof pending.then = function <Success = Value, Failure = never>(
    onFulfilled?: ((result: Value) => Success | PromiseLike<Success>) | null,
    onRejected?: ((reason: unknown) => Failure | PromiseLike<Failure>) | null,
  ): Promise<Success | Failure> {
    return ordinaryThen<Success, Failure>(
      onFulfilled
        ? (result) => {
            let returned!: Success | PromiseLike<Success>;
            let thrown: unknown;
            let failed = false;
            startTransition(() => {
              try {
                returned = onFulfilled(result);
              } catch (error) {
                failed = true;
                thrown = error;
              }
            });
            if (failed) throw thrown;
            return returned;
          }
        : undefined,
      onRejected,
    );
  };
  const spy = vi.spyOn(pending, 'then').mockImplementation(scheduledThen);
  dispose.push(() => spy.mockRestore());
  return pending;
}

it.each(['current', 'expired-original'] as const)(
  'guards the actual selected route page updater after an observed uncommitted Suspense attempt: %s',
  async (phase) => {
    const current = owned();
    fixtureState.transitionPages = true;
    const suspended = deferredValue<void>();
    fixtureState.blockedRows = true;
    fixtureState.suspendedRows = suspended.promise;
    const host = await actualRoute(current, { hasMore: true });
    await waitFor(() => expect(host.screen.getByText('Owned recent-0')).toBeTruthy());
    fireEvent.click(host.screen.getByText('picker-end-reached'));
    await waitFor(() => expect(fixtureState.attemptedRows.some((rows) => rows.includes('Owned recent-20'))).toBe(true));
    expect(host.screen.getByText('Owned recent-0')).toBeTruthy();
    expect(host.screen.queryByText('Owned recent-20')).toBeNull();
    expect(host.screen.queryByTestId('actual-picker-suspended')).toBeNull();
    const key = current.scope.key(['userAscentsFeed', 'owned-A', { statusMode: 'both' }]);
    expect(httpPageSourceDiagnostics(current.cache, key).consumers).toBeGreaterThan(0);
    expect(fixtureState.committedRows.some((rows) => rows.includes('Owned recent-20'))).toBe(false);
    current.clock(100_000);
    const fresh = current.operations.capture();
    await fresh.request('query OwnedFresh { viewer { id } }');
    fresh.assertDeliveries();
    current.clock(phase === 'current' ? 110_000 : 130_000);
    fresh.assertDeliveries();
    await act(async () => {
      fixtureState.blockedRows = false;
      suspended.resolve();
      await suspended.promise;
    });
    await waitFor(() => expect(httpPageSourceDiagnostics(current.cache, key).consumers).toBe(0));
    expect(host.screen.getByText('Owned recent-0')).toBeTruthy();
    if (phase === 'current') {
      expect(host.screen.getByText('Owned recent-20')).toBeTruthy();
      expect(fixtureState.committedRows.some((rows) => rows.includes('Owned recent-20'))).toBe(true);
    } else {
      expect(host.screen.queryByText('Owned recent-20')).toBeNull();
      expect(fixtureState.committedRows.some((rows) => rows.includes('Owned recent-20'))).toBe(false);
      fireEvent.click(host.screen.getByText('picker-end-reached'));
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(
      routePackets(current)
        .filter((packet) => packet.query.includes('userAscentsFeed('))
        .map((packet) => packet.variables?.input?.offset),
    ).toEqual([0, 20]);
    fresh.dispose();
  },
);

function ownedBetaRow(id = 'A') {
  return {
    climbUuid: `owned-${id}`,
    link: `https://www.instagram.com/reel/PRIVATE-${id}/`,
    foreignUsername: null,
    angle: 40,
    thumbnail: null,
    isListed: true,
    createdAt: '2026-01-01',
    tickUuid: null,
    boardId: null,
  };
}
const betaOnlySections = {
  activeHolds: false,
  logbook: false,
  climberLogs: false,
  setterNotes: false,
  betaVideos: true,
  boardseshGrade: false,
  community: false,
  similarClimbs: false,
} as const;
it.each(['view', 'entity'] as const)(
  'owns the actual BetaVideosSection selector across malformed A and undefined paused B: %s replacement',
  async (replacement) => {
    const current = owned();
    const { BetaVideosSection } = await import('../../../../components/play-drawer/BetaVideosSection');
    current.performFetch.mockResolvedValue(Response.json({ data: { betaLinks: [ownedBetaRow()] } }));
    let originalParent: ReturnType<typeof useBetaReaderOwner>;
    function Parent({ uuid }: { uuid: string }) {
      const owner = useBetaReaderOwner('kilter', uuid);
      originalParent = owner;
      return <BetaVideosSection boardName="kilter" climbUuid={uuid} originalParent={owner} />;
    }
    const tree = (uuid: string) => (
      <QueryClientProvider client={current.cache}>
        <ToastProvider>
          <Parent key={hashKey(fixtureState.scope!.key(['betaLinks', 'kilter', uuid]))} uuid={uuid} />
        </ToastProvider>
      </QueryClientProvider>
    );
    const screen = render(tree('owned-A'));
    await waitFor(() => expect(screen.getByText('mobile.betaVideos.videoCount')).toBeTruthy());
    const old = originalParent!;
    const keyA = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
    act(() => {
      current.cache.setQueryData(keyA, { betaLinks: null });
    });
    await waitFor(() => expect(screen.getByText('mobile.betaVideos.errorTitle')).toBeTruthy());
    // Actual QueryObserver select failure retained A's selected value/count.
    expect(screen.getByText('mobile.betaVideos.videoCount')).toBeTruthy();
    onlineManager.setOnline(false);
    if (replacement === 'view') {
      current.switchAccount('owned-B');
      fixtureState.scope = fixtureState.http!.scope();
    }
    const uuid = replacement === 'entity' ? 'owned-B' : 'owned-A';
    screen.rerender(tree(uuid));
    await waitFor(() => expect(screen.getByText('mobile.connectivity.needsConnection')).toBeTruthy());
    expect(screen.queryByText('mobile.betaVideos.videoCount')).toBeNull();
    expect(screen.queryByText('mobile.betaVideos.errorTitle')).toBeNull();
    expect(screen.container.querySelector('[data-private-url]')).toBeNull();
    expect(current.cache.getQueryData(fixtureState.scope!.key(['betaLinks', 'kilter', uuid]))).toBeUndefined();
    expect(() => old.assertCurrent()).toThrow();
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  },
);
it('owns the actual DeferredSections peek selector across malformed A and disabled undefined B', async () => {
  const current = owned();
  const { DeferredSections } = await import('../../../../components/play-drawer/DeferredSections');
  current.performFetch.mockResolvedValue(Response.json({ data: { betaLinks: [ownedBetaRow()] } }));
  const climb = {
    uuid: 'owned-A',
    name: 'Owned A',
    difficulty: 'V4',
    description: null,
  } as import('@boardsesh/shared-schema').Climb;
  const tree = (enabled: boolean) => (
    <QueryClientProvider client={current.cache}>
      <ToastProvider>
        <DeferredSections
          climb={climb}
          boardName="kilter"
          layoutId={8}
          sizeId={17}
          setIds="1"
          angle={40}
          enabled={enabled}
          contentEnabled={false}
          sections={betaOnlySections}
          order={['betaVideos']}
          onSimilarClimbPress={() => {
            throw new Error('Unexpected similar action');
          }}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  const screen = render(tree(true));
  await waitFor(() =>
    expect(screen.getByTestId('actual-beta-header').getAttribute('data-summary')).toBe('mobile.betaVideos.videoCount'),
  );
  act(() => {
    current.cache.setQueryData(current.scope.key(['betaLinks', 'kilter', 'owned-A']), { betaLinks: null });
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId('actual-beta-header').getAttribute('data-summary')).toBe('mobile.betaVideos.videoCount');
  // Disable the actual peek QUERY via its real offline gate, keeping the
  // parent rendered so a retained A selected value would be observable.
  onlineManager.setOnline(false);
  current.switchAccount('owned-B');
  fixtureState.scope = fixtureState.http!.scope();
  screen.rerender(tree(true));
  expect(screen.getByTestId('actual-beta-header').getAttribute('data-summary')).toBe('');
  expect(current.cache.getQueryData(fixtureState.scope.key(['betaLinks', 'kilter', 'owned-A']))).toBeUndefined();
  expect(current.performFetch).toHaveBeenCalledTimes(1);
});
it('refuses an actual later BetaVideosSection mount from an old parent before minting a fresh B reader', async () => {
  const current = owned();
  const { BetaVideosSection } = await import('../../../../components/play-drawer/BetaVideosSection');
  let parent: ReturnType<typeof useBetaReaderOwner>;
  function OriginalParent() {
    parent = useBetaReaderOwner('kilter', 'owned-A');
    return null;
  }
  const original = render(<OriginalParent />);
  expect(parent).toBeTruthy();
  act(() => {
    current.switchAccount('owned-B');
    fixtureState.scope = fixtureState.http!.scope();
  });
  const screen = render(
    <QueryClientProvider client={current.cache}>
      <ToastProvider>
        <BetaVideosSection boardName="kilter" climbUuid="owned-A" originalParent={parent} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.container.textContent).toBe('');
  expect(current.performFetch).not.toHaveBeenCalled();
  expect(current.issueLease).not.toHaveBeenCalled();
  expect(current.cache.getQueryState(fixtureState.scope!.key(['betaLinks', 'kilter', 'owned-A']))).toBeUndefined();
  original.unmount();
});

it('retires the actual DeferredSections beta subtree/header action when an old body rerenders without its wrapper', async () => {
  const current = owned();
  const { DeferredSections } = await import('../../../../components/play-drawer/DeferredSections');
  current.performFetch.mockResolvedValue(Response.json({ data: { betaLinks: [ownedBetaRow()] } }));
  const add = vi.fn();
  const climb = {
    uuid: 'owned-A',
    name: 'Owned A',
    difficulty: 'V4',
    description: null,
  } as import('@boardsesh/shared-schema').Climb;
  const screen = render(
    <QueryClientProvider client={current.cache}>
      <ToastProvider>
        <DeferredSections
          climb={climb}
          boardName="kilter"
          layoutId={8}
          sizeId={17}
          setIds="1"
          angle={40}
          enabled
          contentEnabled={false}
          sections={betaOnlySections}
          order={['betaVideos']}
          onAddBetaVideo={add}
          onSimilarClimbPress={() => {
            throw new Error('Unexpected similar action');
          }}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('actual-beta-header').getAttribute('data-summary')).toBe('mobile.betaVideos.videoCount'),
  );
  const originalPress = fixtureState.rowCallbacks.at(-1)!;
  const originalSelections = fixtureState.selection.mock.calls.length;
  // The parent wrapper receives no render/prop event. Its real query observer
  // wakes the old body, which now sees B at the actual scope port.
  act(() => {
    current.switchAccount('owned-B');
    fixtureState.scope = fixtureState.http!.scope();
    current.cache.setQueryData(current.scope.key(['betaLinks', 'kilter', 'owned-A']), { betaLinks: [] });
  });
  await waitFor(() => expect(screen.queryByTestId('actual-beta-header')).toBeNull());
  act(() => {
    originalPress();
  });
  expect(add).not.toHaveBeenCalled();
  expect(fixtureState.selection).toHaveBeenCalledTimes(originalSelections);
  expect(current.performFetch).toHaveBeenCalledTimes(1);
});

async function activeReader(current: ReturnType<typeof owned>) {
  current.performFetch.mockImplementation(async (_url, init) => {
    const packet = JSON.parse((init as RequestInit).body as string) as { query: string };
    return Response.json({
      data: packet.query.includes('betaLinks(') ? { betaLinks: [] } : { viewer: { id: 'owned-A' } },
    });
  });
  const wrapper = ({ children }: { children?: ReactNode }) => (
    <QueryClientProvider client={current.cache}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const owner = useBetaReaderOwner('kilter', 'owned-A');
      return useBetaLinks('kilter', 'owned-A', true, owner);
    },
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.data).toEqual([]));
  return hook;
}
it.each(['released', 'expired'] as const)(
  'does not retain a %s actual command cause in later independent same-view cache refresh',
  async (retirement) => {
    const current = owned();
    const reader = await activeReader(current);
    const command = current.operations.capture();
    await command.request('query OwnedCommand { viewer { id } }');
    command.assertDeliveries();
    const key = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
    let fresh: ReturnType<typeof current.operations.capture> | undefined;
    // Keep the whole real Promise chain in one React batch. No intervening
    // incidental reader rerender may hide leaked temporary Query.options.
    await act(async () => {
      await reader.result.current.refetchOriginal(command.assertDeliveries);
      current.clock(100_000);
      fresh = current.operations.capture();
      await fresh.request('query OwnedFresh { viewer { id } }');
      fresh.assertDeliveries();
      if (retirement === 'released') command.dispose();
      else current.clock(130_000);
      fresh.assertDeliveries();
      expect(() => command.assertDeliveries()).toThrow();
      await current.cache.refetchQueries({ queryKey: key, exact: true });
    });
    const reads = routePackets(current).filter((packet) => packet.query.includes('betaLinks('));
    expect(reads).toHaveLength(3);
    expect(current.cache.getQueryState(key)?.status).toBe('success');
    fresh?.assertDeliveries();
    fresh?.dispose();
    command.dispose();
  },
);

it.each(['pending', 'paused'] as const)(
  'does not graft command E1 into an independent actual %s read joined before E1 expiry',
  async (state) => {
    const current = owned();
    const reader = await activeReader(current);
    const command = current.operations.capture();
    await command.request('query OwnedCommand { viewer { id } }');
    command.assertDeliveries();
    current.clock(100_000);
    const fresh = current.operations.capture();
    await fresh.request('query OwnedFresh { viewer { id } }');
    fresh.assertDeliveries();
    const key = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
    const query = current.cache.getQueryCache().find({ queryKey: key, exact: true })!;
    const body = deferredValue<Response>();
    if (state === 'paused') onlineManager.setOnline(false);
    else current.performFetch.mockReturnValueOnce(body.promise);
    const independent = current.cache.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
    await waitFor(() => expect(query.state.fetchStatus).toBe(state === 'paused' ? 'paused' : 'fetching'));
    if (state === 'pending') await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(4));
    const before = query.options;
    let joined!: ReturnType<typeof reader.result.current.refetchOriginal>;
    act(() => {
      joined = reader.result.current.refetchOriginal(command.assertDeliveries);
    });
    const refusal = expect(joined).rejects.toMatchObject({ status: 'superseded' });
    // The waiting command has not installed its callback on the Query or reset
    // its pending retryer. E1 expires while the independent E2 remains current.
    expect(query.options.queryFn).toBe(before.queryFn);
    expect(query.options.behavior).toBe(before.behavior);
    current.clock(130_000);
    fresh.assertDeliveries();
    expect(() => command.assertDeliveries()).toThrow();
    await act(async () => {
      if (state === 'paused') onlineManager.setOnline(true);
      else body.resolve(Response.json({ data: { betaLinks: [ownedBetaRow('INDEPENDENT')] } }));
      await independent;
      await refusal;
    });
    await waitFor(() => expect(query.state.fetchStatus).toBe('idle'));
    expect(query.state.status).toBe('success');
    expect(routePackets(current).filter((packet) => packet.query.includes('betaLinks('))).toHaveLength(2);
    await act(async () => {
      await current.cache.refetchQueries({ queryKey: key, exact: true });
    });
    expect(routePackets(current).filter((packet) => packet.query.includes('betaLinks('))).toHaveLength(3);
    fresh.dispose();
    command.dispose();
  },
);

it('joins an actual paused retry with a live command without a second packet or retained veto', async () => {
  const current = owned();
  const reader = await activeReader(current);
  const command = current.operations.capture();
  await command.request('query OwnedCommand { viewer { id } }');
  const key = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
  onlineManager.setOnline(false);
  const independent = current.cache.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
  await waitFor(() => expect(current.cache.getQueryState(key)?.fetchStatus).toBe('paused'));
  let joined!: ReturnType<typeof reader.result.current.refetchOriginal>;
  act(() => {
    joined = reader.result.current.refetchOriginal(command.assertDeliveries);
  });
  await act(async () => {
    onlineManager.setOnline(true);
    await independent;
  });
  let returned: Awaited<typeof joined>;
  await act(async () => {
    returned = await joined;
  });
  expect(returned!.isSuccess).toBe(true);
  expect(returned!.data).toEqual([]);
  expect(routePackets(current).filter((packet) => packet.query.includes('betaLinks('))).toHaveLength(2);
  command.dispose();
  await act(async () => {
    await current.cache.refetchQueries({ queryKey: key, exact: true });
  });
  expect(routePackets(current).filter((packet) => packet.query.includes('betaLinks('))).toHaveLength(3);
});

it('preserves a newer actual same-query observer options when a held command settles', async () => {
  const current = owned();
  const reader = await activeReader(current);
  const command = current.operations.capture();
  await command.request('query OwnedCommand { viewer { id } }');
  const key = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
  const body = deferredValue<Response>();
  current.performFetch.mockReturnValueOnce(body.promise);
  let pending!: ReturnType<typeof reader.result.current.refetchOriginal>;
  act(() => {
    pending = reader.result.current.refetchOriginal(command.assertDeliveries);
  });
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(3));
  const query = current.cache.getQueryCache().find({ queryKey: key, exact: true })!;
  const commandFn = query.options.queryFn;
  // A normal observer's replacement is an actual selected read with its own
  // original operation, not a fabricated cache result or receipt.
  const newerFn = async () => {
    const operation = current.operations.capture();
    try {
      const result = await operation.request<{ betaLinks: ReturnType<typeof ownedBetaRow>[] }>(
        'query OwnedNewer { betaLinks(boardType: "kilter", climbUuid: "owned-A") { link } }',
      );
      operation.assertDeliveries();
      return result;
    } finally {
      operation.dispose();
    }
  };
  const newer = new QueryObserver(current.cache, { queryKey: key, queryFn: newerFn, enabled: false });
  dispose.push(() => newer.destroy());
  expect(query.options.queryFn).toBe(newerFn);
  expect(query.options.queryFn).not.toBe(commandFn);
  await act(async () => {
    body.resolve(Response.json({ data: { betaLinks: [] } }));
    await pending;
  });
  expect(query.options.queryFn).toBe(newerFn);
  command.dispose();
  await act(async () => {
    await current.cache.refetchQueries({ queryKey: key, exact: true });
  });
  expect(routePackets(current).some((packet) => packet.query.includes('OwnedNewer'))).toBe(true);
});

it('restores temporary selected finite4-style retry guards before an independent current cache refresh', async () => {
  const current = owned();
  const { useHttpFiniteQuery } = await import('../../use-http-finite-query');
  current.performFetch.mockImplementation(async () => Response.json({ data: { viewer: { id: 'owned-A' } } }));
  const hook = renderHook(
    () =>
      useHttpFiniteQuery({
        queryKey: ['owned-finite4'],
        queryFn: (operation) => operation.request<{ viewer: { id: string } }>('query OwnedFinite4 { viewer { id } }'),
        enabled: true,
        staleTime: 30 * 60 * 1000,
      }),
    { wrapper: ({ children }) => <QueryClientProvider client={current.cache}>{children}</QueryClientProvider> },
  );
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  let active = true;
  const assertInvocation = () => {
    if (!active) throw new Error('Owned old UI invocation');
  };
  await act(async () => {
    const retried = await hook.result.current.refetchOriginal(assertInvocation);
    expect(retried.error).toBeNull();
    expect(retried.isSuccess).toBe(true);
    active = false;
    await current.cache.refetchQueries({ queryKey: current.scope.key(['owned-finite4']), exact: true });
  });
  expect(current.performFetch).toHaveBeenCalledTimes(3);
  expect(current.cache.getQueryState(current.scope.key(['owned-finite4']))?.status).toBe('success');
});

it.each(['current-strict', 'started-before-layout-cleanup'] as const)(
  'binds actual selected reader retry to its invocation while preserving its insertion owner: %s',
  async (phase) => {
    const current = owned();
    const { BetaVideosSection } = await import('../../../../components/play-drawer/BetaVideosSection');
    current.performFetch.mockImplementation(async () => Response.json({ data: { betaLinks: [ownedBetaRow()] } }));
    let blocked = false;
    const suspended = new Promise<void>(() => {});
    let parent!: ReturnType<typeof useBetaReaderOwner>;
    function Pending() {
      if (blocked) throw suspended;
      return null;
    }
    function Parent() {
      parent = useBetaReaderOwner('kilter', 'owned-A');
      return (
        <>
          <BetaVideosSection boardName="kilter" climbUuid="owned-A" originalParent={parent} />
          <Pending />
        </>
      );
    }
    const tree = () => (
      <QueryClientProvider client={current.cache}>
        <ToastProvider>
          <StrictMode>
            <Suspense fallback={<span>actual-reader-hidden</span>}>
              <Parent />
            </Suspense>
          </StrictMode>
        </ToastProvider>
      </QueryClientProvider>
    );
    const screen = render(tree());
    await waitFor(() => expect(screen.getByText('mobile.betaVideos.videoCount')).toBeTruthy());
    const originalParent = parent!;
    const key = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
    act(() => {
      current.cache.setQueryData(key, { betaLinks: null });
    });
    await waitFor(() => expect(screen.getByText('mobile.betaVideos.retry')).toBeTruthy());
    current.performFetch.mockImplementation(async () => Response.json({ data: { betaLinks: [] } }));
    if (phase === 'started-before-layout-cleanup') {
      const survivor = new QueryObserver(current.cache, { queryKey: key, enabled: false });
      const release = survivor.subscribe(() => {});
      dispose.push(() => {
        release();
        survivor.destroy();
      });
      act(() => {
        onlineManager.setOnline(false);
      });
      fireEvent.click(screen.getByText('mobile.betaVideos.retry'));
      await waitFor(() => expect(current.cache.getQueryState(key)?.fetchStatus).toBe('paused'));
      const originalPhysical = current.cache.getQueryCache().find({ queryKey: key, exact: true })!.promise!;
      expect(current.performFetch).toHaveBeenCalledTimes(1);
      act(() => {
        blocked = true;
        screen.rerender(tree());
      });
      expect(screen.getByText('actual-reader-hidden')).toBeTruthy();
      expect(originalParent!.assertCurrent).not.toThrow();
      await act(async () => {
        onlineManager.setOnline(true);
        await originalPhysical.catch(() => undefined);
      });
      expect(current.performFetch).toHaveBeenCalledTimes(1);
      act(() => {
        blocked = false;
        screen.rerender(tree());
      });
      // Reconnecting the actual observer may automatically start its own fresh
      // invocation. It is distinct from the refused pre-cleanup retry above.
      await waitFor(() => expect(screen.getByText('mobile.betaVideos.empty')).toBeTruthy());
      expect(current.performFetch).toHaveBeenCalledTimes(2);
      act(() => {
        current.cache.setQueryData(key, { betaLinks: null });
      });
      await waitFor(() => expect(screen.getByText('mobile.betaVideos.retry')).toBeTruthy());
      expect(originalParent!.assertCurrent).not.toThrow();
    }
    fireEvent.click(screen.getByText('mobile.betaVideos.retry'));
    await waitFor(() => expect(screen.getByText('mobile.betaVideos.empty')).toBeTruthy());
    expect(current.performFetch).toHaveBeenCalledTimes(phase === 'current-strict' ? 2 : 3);
    expect(current.cache.getQueryState(key)?.status).toBe('success');
  },
);

it('refuses a selected joined retry if a newer independent physical flight starts while the original settles', async () => {
  const current = owned();
  const reader = await activeReader(current);
  const command = current.operations.capture();
  await command.request('query OwnedCommand { viewer { id } }');
  command.assertDeliveries();
  const key = current.scope.key(['betaLinks', 'kilter', 'owned-A']);
  const query = current.cache.getQueryCache().find({ queryKey: key, exact: true })!;
  const first = deferredValue<Response>();
  const second = deferredValue<Response>();
  current.performFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const independent = current.cache.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(3));
  let armed = true;
  let subsequent: Promise<void> | undefined;
  const release = current.cache.getQueryCache().subscribe((event) => {
    if (!armed || event.query !== query || event.type !== 'updated' || event.action.type !== 'success') return;
    armed = false;
    // Actual independent caller, entered synchronously by the actual cache
    // success notification before the awaiting original command resumes.
    subsequent = current.cache.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
  });
  dispose.push(release);
  await act(async () => {
    const joined = reader.result.current.refetchOriginal(command.assertDeliveries);
    const refusal = expect(joined).rejects.toMatchObject({ status: 'unavailable' });
    first.resolve(Response.json({ data: { betaLinks: [] } }));
    await independent;
    await refusal;
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(4));
    expect(subsequent).toBeDefined();
    expect(query.state.fetchStatus).toBe('fetching');
    const originalSignal = (current.performFetch.mock.calls.at(-1)![1] as RequestInit).signal!;
    expect(originalSignal.aborted).toBe(false);
    command.assertDeliveries();
    second.resolve(Response.json({ data: { betaLinks: [ownedBetaRow('CURRENT')] } }));
    await subsequent;
    // A completed operation disposes its own signal. The no-cancellation
    // assertion above is deliberately before the real held body settles.
    expect(query.state.data).toEqual({ betaLinks: [ownedBetaRow('CURRENT')] });
    command.dispose();
    await current.cache.refetchQueries({ queryKey: key, exact: true });
  });
  expect(routePackets(current).filter((packet) => packet.query.includes('betaLinks('))).toHaveLength(4);
  expect(query.state.status).toBe('success');
});
