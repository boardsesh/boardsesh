import { createBrowserCoordinatorRoutes } from '@/app/lib/auth/browser-coordinator-routes.server';
import { createBrowserRenewalRecovery } from '@/app/lib/auth/browser-renewal-recovery.server';
const recover = createBrowserRenewalRecovery();
const observe = createBrowserCoordinatorRoutes().observe;
export async function GET(request: Request): Promise<Response> {
  return (await recover(request)) ?? observe(request);
}
