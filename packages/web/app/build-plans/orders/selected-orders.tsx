'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import CircularProgress from '@mui/material/CircularProgress';
import type { CncCatalog } from '@boardsesh/shared-schema';
import {
  GET_MY_CNC_ORDERS,
  GET_CNC_ORDER,
  type GetMyCncOrdersQueryResponse,
  type GetCncOrderQueryResponse,
} from '@boardsesh/graphql/operations/cnc-packs';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import { browserBackendSessionKey } from '@boardsesh/auth-protocol/browser-backend-session';
import SelectedPrivateView from '@/app/components/auth/selected-private-view';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { isCurrentBrowserBackendGraphQLResult } from '@/app/lib/auth/browser-backend-graphql';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { PageFrame } from '../ui';
import { wallLabel } from '../order-display';
import { ORDER_POLL_INTERVAL_MS, cncOrderQueryKey } from '../use-cnc-order-poll';
import { useCncBrowserScope } from '../use-cnc-browser-scope';
import OrdersListContent from './orders-list-content';
import OrderStatus from './[licenceId]/order-status';

type SelectedOrderProps = {
  owner: BrowserBackendLeaseOwner;
  catalog: CncCatalog | null;
  locale: string;
};

function OwnedOrdersList({ owner, catalog, locale }: SelectedOrderProps) {
  const { t } = useTranslation('cnc');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const browserScopeKey = useCncBrowserScope(session);
  const query = useQuery({
    queryKey: ['selected-cnc-orders', browserBackendSessionKey(owner), browserScopeKey],
    enabled: token !== null && typeof browserScopeKey === 'string',
    queryFn: async ({ signal }) => {
      const response = await createGraphQLHttpClient(token).request<GetMyCncOrdersQueryResponse>({
        document: GET_MY_CNC_ORDERS,
        signal,
      });
      if (!isCurrentBrowserBackendGraphQLResult(response)) throw new BrowserBackendConsumerError('superseded');
      return response.myCncOrders;
    },
  });
  if (typeof browserScopeKey !== 'string') return null;
  if (query.isError) return <Alert severity="error">{t('orders.loadError')}</Alert>;
  if (query.data === undefined) return <CircularProgress size={24} />;
  return <OrdersListContent orders={query.data} catalog={catalog} locale={locale} t={t} />;
}

export function SelectedOrdersList(props: SelectedOrderProps) {
  return (
    <SelectedPrivateView expectedOwner={props.owner}>
      <OwnedOrdersList key={browserBackendSessionKey(props.owner)} {...props} />
    </SelectedPrivateView>
  );
}

type SelectedOrderDetailProps = SelectedOrderProps & {
  licenceId: string;
  checkoutOutcome: 'success' | 'cancelled' | null;
};

function OrderShell({ licenceId, children }: { licenceId: string; children?: ReactNode }) {
  const { t } = useTranslation('cnc');
  return (
    <PageFrame
      title={licenceId}
      actions={
        <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2">
          {t('order.back')}
        </MuiLink>
      }
    >
      {children ?? null}
    </PageFrame>
  );
}

function OwnedOrderDetail({ owner, catalog, locale, licenceId, checkoutOutcome }: SelectedOrderDetailProps) {
  const { t } = useTranslation('cnc');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const browserScopeKey = useCncBrowserScope(session);
  const query = useQuery({
    // Match the existing poll's cache: it can adopt this actual client result
    // without a second initial request or a fabricated private server seed.
    queryKey: cncOrderQueryKey(owner.userId, owner.authSessionId, licenceId, browserScopeKey ?? undefined),
    enabled: token !== null && typeof browserScopeKey === 'string',
    staleTime: ORDER_POLL_INTERVAL_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await createGraphQLHttpClient(token).request<GetCncOrderQueryResponse>({
        document: GET_CNC_ORDER,
        variables: { licenceId },
        signal,
      });
      if (!isCurrentBrowserBackendGraphQLResult(response)) throw new BrowserBackendConsumerError('superseded');
      return response.cncOrder;
    },
  });
  if (typeof browserScopeKey !== 'string') return null;
  if (query.isError)
    return (
      <OrderShell licenceId={licenceId}>
        <Alert severity="error">{t('order.loadError')}</Alert>
      </OrderShell>
    );
  if (query.data === undefined)
    return (
      <OrderShell licenceId={licenceId}>
        <CircularProgress size={24} />
      </OrderShell>
    );
  if (query.data === null)
    return (
      <PageFrame title={t('order.notFound.heading')} intro={t('order.notFound.body')} width="prose">
        <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2">
          {t('order.back')}
        </MuiLink>
      </PageFrame>
    );
  return (
    <OrderStatus
      initialOrder={query.data}
      initialOwnerId={owner.userId}
      initialBrowserScopeKey={browserScopeKey}
      wallLabel={wallLabel(catalog, query.data, t)}
      checkoutOutcome={checkoutOutcome}
      locale={locale}
    />
  );
}

export function SelectedOrderDetail(props: SelectedOrderDetailProps) {
  return (
    <SelectedPrivateView expectedOwner={props.owner} fallback={<OrderShell licenceId={props.licenceId} />}>
      <OwnedOrderDetail key={browserBackendSessionKey(props.owner)} {...props} />
    </SelectedPrivateView>
  );
}
