import { useEffect, useRef } from 'react';
import { useProfile } from '../../lib/graphql/hooks';
import { startCatalogAuthorization } from '../../offline/catalog-authorization';

/**
 * Keeps the downloaded catalogue authorized for the signed-in account. The app
 * does not subscribe to `privacyChanged`; `startCatalogAuthorization` explains
 * the two cases that still revalidate the catalogue.
 */
export function PrivacySyncBridge() {
  const { data: profile } = useProfile();
  const viewerRef = useRef(profile?.id);
  viewerRef.current = profile?.id;
  useEffect(() => {
    if (!profile?.id) return;
    const viewerId = profile.id;
    return startCatalogAuthorization(viewerId, () => viewerRef.current === viewerId);
  }, [profile?.id]);
  return null;
}
