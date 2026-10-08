import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useProfile } from '../../lib/graphql/hooks';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import { getWsClient } from '../../lib/graphql/ws-client';
import { invalidatePrivacyQueries, registerPrivacyRevalidation } from '../../lib/privacy/privacy-cache';
import { clearSprayWallPrivateCaches } from '../../lib/spray/spray-privacy-cleanup';
import { revalidatePrivateCatalog } from '../../offline/privacy-revalidation';
import { getDatabaseHandle } from '../../db';
import { getSetting } from '../../settings';
import { clearStoredSprayPhotos } from '../../lib/spray/spray-photo-store';
import { reportHandledError } from '../../lib/error-reporting';

/** A reconnect gets an immediate signal, covering revocations missed offline. */
export function PrivacySyncBridge() {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const { data: privacy } = usePrivacySettings();
  const [supported, setSupported] = useState(false);
  const viewerRef = useRef(profile?.id);
  viewerRef.current = profile?.id;
  useEffect(() => {
    if (privacy) setSupported(true);
  }, [privacy]);
  useEffect(() => {
    if (!supported || !profile?.id) return;
    const viewerId = profile.id;
    const unregister = registerPrivacyRevalidation(() => {
      if (viewerRef.current !== viewerId) return Promise.resolve();
      clearSprayWallPrivateCaches();
      clearStoredSprayPhotos();
      const database = getDatabaseHandle();
      // Start synchronously so new local requests wait before reading SQLite.
      return database
        ? revalidatePrivateCatalog(database, viewerId, getSetting('syncEnabledBoards'))
        : Promise.resolve();
    });
    const revokeSnapshots = () => {
      if (viewerRef.current !== viewerId) return;
      void invalidatePrivacyQueries(queryClient).catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'privacy-revocation' } });
      });
    };
    const unsubscribe = getWsClient().subscribe<{ privacyChanged: boolean }>(
      { query: 'subscription PrivacyChanged { privacyChanged }' },
      {
        next: revokeSnapshots,
        // A lost privacy stream invalidates displayed protected material too.
        error: revokeSnapshots,
        complete: () => {},
      },
    );
    return () => {
      unregister();
      unsubscribe();
    };
  }, [supported, profile?.id, queryClient]);
  return null;
}
