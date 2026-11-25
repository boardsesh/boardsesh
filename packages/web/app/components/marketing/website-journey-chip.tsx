'use client';

import Chip from '@mui/material/Chip';
import type { WebsiteJourneyEvent } from '@boardsesh/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
import { trackWebsiteJourneyEvent } from '@/app/lib/website-journey-analytics';

/** Static marketing sections resolve the label and event on the server. */
export function WebsiteJourneyChip({
  href,
  label,
  event,
}: {
  href: string;
  label: string;
  event: WebsiteJourneyEvent;
}) {
  return (
    <Chip
      component={LocaleLink}
      clickable
      href={href}
      label={label}
      variant="outlined"
      sx={{ minHeight: 44, borderColor: 'var(--control-border)' }}
      onClick={() => trackWebsiteJourneyEvent(event)}
    />
  );
}
