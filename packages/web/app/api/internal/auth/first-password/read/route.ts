import { firstPasswordBrowserHandler } from '@/app/lib/auth/first-password-browser-handler.server';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => firstPasswordBrowserHandler.run(request, 'read');
