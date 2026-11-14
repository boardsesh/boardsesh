import type { Metadata } from 'next';
import { requireCoordinatorOrigin } from '@boardsesh/auth-protocol/browser-coordinator';
import { APP_URL } from '@/app/lib/app-origin';
import { resolvePublicAuthOrigin } from '@/app/lib/auth/canonical-auth-url';
import { publicBrowserCoordinatorReady } from '@/app/lib/auth/browser-coordinator-readiness';
import CoordinatorHost from './coordinator-host';

export const metadata: Metadata = { title: 'Boardsesh', robots: { index: false, follow: true } };
/** Utility frame. GET is side-effect-free and never initializes a binding. */
export default function BrowserCoordinatorPage() {
  if (!publicBrowserCoordinatorReady()) return null;
  const canonicalOrigin = requireCoordinatorOrigin(resolvePublicAuthOrigin() ?? '');
  const appOrigin = requireCoordinatorOrigin(APP_URL);
  return <CoordinatorHost canonicalOrigin={canonicalOrigin} appOrigin={appOrigin} />;
}
