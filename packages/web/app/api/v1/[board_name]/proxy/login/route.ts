import { deprecatedAuroraProxyRoute } from '@/app/lib/api-deprecation';

// Retired. See app/lib/api-deprecation.ts for the deprecation contract and
// W-25b (#4443) for the removal on the Sunset date.
export const GET = deprecatedAuroraProxyRoute('login');
export const POST = deprecatedAuroraProxyRoute('login');
