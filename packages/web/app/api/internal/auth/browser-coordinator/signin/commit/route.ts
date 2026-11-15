import { createExpiredBrowserBindingBrowserBroker } from '@/app/lib/auth/expired-browser-binding-browser.server';
export const POST = createExpiredBrowserBindingBrowserBroker().commit;
