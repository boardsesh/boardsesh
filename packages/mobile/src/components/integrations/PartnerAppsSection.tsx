import {
  buildConnectedAppsSection,
  type ConnectedAppRowView,
  type ConnectedAppsFormatters,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import { useCallback, useMemo, useState, useRef, useLayoutEffect, useInsertionEffect } from 'react';
import { hashKey } from '@tanstack/react-query';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useHttpQueryScope } from '../../lib/graphql/use-http-query-scope';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';
import { useTranslation } from 'react-i18next';
import { nowMs } from '../../lib/clock';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useMyConnectedApps } from '../../lib/graphql/hooks/use-connected-apps';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { useAuth } from '../../providers/auth-provider';
import { PartnerAppsSectionView } from './PartnerAppsSectionView';
export { PartnerAppsSectionView } from './PartnerAppsSectionView';

/** The dates in the climber's language, with mobile's clock. */
export function useConnectedAppsFormatters(): ConnectedAppsFormatters {
  const { i18n } = useTranslation('settings');
  const locale = i18n.language;
  return useMemo(
    () => ({
      date: (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
      relativeTime: formatRelativeTime,
      nowMs: nowMs(),
    }),
    [locale],
  );
}

/**
 * Apps the climber connected to their account through partner OAuth (#6981
 * F16), last on Settings › Connected apps: one row per app with when it was last
 * used, each opening the app's detail (`ConnectedAppDetailScreen`). The words and
 * the show-or-hide rule come from `@boardsesh/connected-apps`, shared with the
 * website; this file only draws them.
 */
/** Local UI provenance; it never stands in for an SDK delivery. */
export function useConnectedAppsOwner() {
  const scope = useHttpQueryScope();
  const [owner] = useState(() => {
    let mounted = true;
    const listeners = new Set<() => void>();
    return Object.freeze({
      scope,
      assertCurrent() {
        if (!mounted) throw new BrowserBackendConsumerError('superseded');
        scope.assertView();
      },
      retire() {
        mounted = false;
        // Authority retires during deletion; React subscriber delivery waits
        // until insertion cleanup has ended and respects actual unsubscribe.
        const pendingListeners = Array.from(listeners);
        queueMicrotask(() => {
          for (const listener of pendingListeners) if (listeners.has(listener)) listener();
        });
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  });
  useInsertionEffect(() => () => owner.retire(), [owner]);
  return owner;
}
export type ConnectedAppsOwner = ReturnType<typeof useConnectedAppsOwner>;
export function connectedAppsOwnerCurrent(owner: ConnectedAppsOwner): boolean {
  try {
    owner.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

function PartnerAppsSectionBody() {
  const { t } = useTranslation('settings');
  const { isAuthenticated } = useAuth();
  const owner = useConnectedAppsOwner();
  const selected = owner.scope.scoped;
  const current = !selected || connectedAppsOwnerCurrent(owner);
  const { data } = useMyConnectedApps(current);
  const formatters = useConnectedAppsFormatters();
  const actions = useHttpActionScope();
  const section = useMemo(
    () => buildConnectedAppsSection({ signedIn: isAuthenticated, data, t: t as ConnectedAppsTranslate, formatters }),
    [isAuthenticated, data, t, formatters],
  );
  const committed = useRef(new Map<string, object>());
  const targets = useMemo(
    () =>
      new Map(
        section.kind === 'list'
          ? section.rows.map((row) => [row.connectionId, committed.current.get(row.connectionId) ?? Object.freeze({})])
          : [],
      ),
    [section],
  );
  useLayoutEffect(() => {
    committed.current = targets;
  }, [targets]);
  const openApp = useCallback((row: ConnectedAppRowView) => {
    router.push({ pathname: '/settings/connected-app', params: { id: row.connectionId } });
  }, []);
  const guardedOpen = useCallback(
    (row: ConnectedAppRowView) => {
      let action: ReturnType<typeof actions.capture> | undefined;
      try {
        owner.assertCurrent();
        const target = targets.get(row.connectionId);
        if (!target || committed.current.get(row.connectionId) !== target) return;
        action = actions.capture();
        owner.assertCurrent();
        action.assertView();
        if (committed.current.get(row.connectionId) !== target) return;
        openApp(row);
      } catch {
        /* A retired section cannot navigate as another viewer. */
      } finally {
        action?.finish();
      }
    },
    [owner, targets, actions, openApp],
  );
  if (!current) return null;
  return (
    <PartnerAppsSectionView
      section={section}
      onOpen={selected ? guardedOpen : openApp}
      {...(selected ? { originalOwner: owner } : {})}
    />
  );
}

export function PartnerAppsSection() {
  const scope = useHttpQueryScope();
  return <PartnerAppsSectionBody key={scope.scoped ? hashKey(scope.key(['connected-apps-section'])) : undefined} />;
}
