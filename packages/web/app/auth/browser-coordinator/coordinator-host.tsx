'use client';
import { useEffect } from 'react';
import { mountCanonicalBrowserCoordinator } from '@boardsesh/auth-protocol/browser-coordinator-dom';
import { publicBrowserCoordinatorReady } from '@/app/lib/auth/browser-coordinator-readiness';

export default function CoordinatorHost({
  canonicalOrigin,
  appOrigin,
}: {
  readonly canonicalOrigin: string;
  readonly appOrigin: string;
}) {
  useEffect(() => {
    if (!publicBrowserCoordinatorReady()) return;
    const host = mountCanonicalBrowserCoordinator({
      window,
      canonicalOrigin,
      peers: [canonicalOrigin, appOrigin].map((origin) => ({ origin, source: window.parent })),
    });
    return () => host.close();
  }, [canonicalOrigin, appOrigin]);
  return null;
}
