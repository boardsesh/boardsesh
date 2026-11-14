import { createBrowserCoordinatorRoutes } from '@/app/lib/auth/browser-coordinator-routes.server';
export const GET = createBrowserCoordinatorRoutes().observe;
