import { firstPasswordBrowserHandler } from '@/app/lib/auth/first-password-browser-handler.server';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => firstPasswordBrowserHandler.run(request, 'context');
