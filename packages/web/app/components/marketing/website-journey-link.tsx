'use client';

import Button, { type ButtonProps } from '@mui/material/Button';
import MuiLink, { type LinkProps } from '@mui/material/Link';
import type { WebsiteJourneyEvent } from '@boardsesh/analytics';
import { trackWebsiteJourneyLinkClick } from '@/app/lib/website-journey-analytics';
import LocaleLink from '@/app/components/i18n/locale-link';

type JourneyEventProp = { event: WebsiteJourneyEvent };

/** Server pages pass a serializable event; the real anchor remains in first HTML. */
export function WebsiteJourneyButton({
  event,
  ...buttonProps
}: Omit<ButtonProps<'a'>, 'onClick' | 'component'> & JourneyEventProp) {
  return (
    <Button
      {...buttonProps}
      component={LocaleLink}
      href={buttonProps.href ?? ''}
      onClick={(click) => trackWebsiteJourneyLinkClick(click, event)}
    />
  );
}

export function WebsiteJourneyLink({
  event,
  ...linkProps
}: Omit<LinkProps<'a'>, 'onClick' | 'component'> & JourneyEventProp) {
  return (
    <MuiLink
      {...linkProps}
      component={LocaleLink}
      href={linkProps.href ?? ''}
      onClick={(click) => trackWebsiteJourneyLinkClick(click, event)}
    />
  );
}
