'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import type { Persister } from '@tanstack/react-query-persist-client';
import { GET_PRIVACY_SETTINGS, type PrivacySettings } from '@boardsesh/graphql/operations/privacy';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { revokeWebPrivacySnapshots } from '@/app/lib/privacy-client';

export function PrivacySyncBridge({ persister }: { persister: Persister }) {
  const { data: session, status } = useSession();
  const { token } = useWsAuthToken(status === 'authenticated');
  const queryClient = useQueryClient();
  const router = useRouter();
  const viewerId = session?.user?.id;
  const viewerRef = useRef(viewerId);
  viewerRef.current = viewerId;
  const { data: settings } = useQuery({
    queryKey: ['sitePrivacySettings', viewerId],
    queryFn: async ({ signal }) =>
      (
        await createGraphQLHttpClient(token).request<{ privacySettings: PrivacySettings }>({
          document: GET_PRIVACY_SETTINGS,
          signal,
        })
      ).privacySettings,
    enabled: !!token && !!viewerId,
    retry: false,
  });
  useEffect(() => {
    if (!settings || !viewerId || !token) return;
    const url = getBackendWsUrl();
    if (!url) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const revoke = () => {
      if (cancelled || viewerRef.current !== viewerId) return;
      void Promise.all([revokeWebPrivacySnapshots(queryClient), Promise.resolve(persister.removeClient())]).catch(
        (error: unknown) => {
          console.error('Failed to withdraw privacy snapshots:', error);
        },
      );
      router.refresh();
    };
    // The websocket wrapper extends the browser WebSocket constructor.
    // Load it only in an effect so SSR never evaluates that browser global.
    void import('@/app/lib/realtime/graphql-client')
      .then(({ createGraphQLClient }) => {
        if (cancelled) return;
        const client = createGraphQLClient({ url, authToken: token, connectionName: 'privacy' });
        const unsubscribe = client.subscribe<{ privacyChanged: boolean }>(
          { query: 'subscription PrivacyChanged { privacyChanged }' },
          {
            next: revoke,
            error: revoke,
            complete: () => {},
          },
        );
        dispose = () => {
          unsubscribe();
          void client.dispose();
        };
      })
      .catch((error: unknown) => {
        revoke();
        console.error('Failed to connect privacy updates:', error);
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [!!settings, viewerId, token, queryClient, persister, router]);
  return null;
}
