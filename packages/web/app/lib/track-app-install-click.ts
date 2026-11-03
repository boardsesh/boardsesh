// The one place a store button reports its click: PostHog's `App Install Click`
// and, with ad-measurement consent, the Meta and Reddit `Lead` conversion.
// Every "get the app" CTA on www calls this, so the two can never drift.

import { track } from './analytics';
import { reportAdLead } from './ad-pixels-browser';
import {
  APP_INSTALL_CLICK_EVENT,
  buildAppInstallClickProperties,
  type AppInstallClickInput,
} from './app-install-event';

export function trackAppInstallClick(input: AppInstallClickInput): void {
  track(APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties(input));
  reportAdLead({ platform: input.platform, placement: input.placement });
}
