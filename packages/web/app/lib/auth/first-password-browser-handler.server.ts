import 'server-only';
import { createFirstPasswordBrowserBroker } from './first-password-browser.server';
export const firstPasswordBrowserHandler = createFirstPasswordBrowserBroker();
