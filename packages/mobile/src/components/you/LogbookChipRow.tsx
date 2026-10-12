// The Logbook's quick-filter capsule row: Filters · N and the climber's pinned
// capsules, above their logbook. A Logbook adapter over the shared CapsuleRow:
// buildLogbookCapsules (logbook-capsules.ts) turns the filter state into
// capsule descriptors, and CapsuleRow (filter-capsules/) draws them natively
// per platform: SwiftUI glass on iOS, Compose FilterChips on Android, Paper
// chips on the web.

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CapsuleRow } from '../filter-capsules/CapsuleRow';
import { buildLogbookCapsules, type LogbookCapsuleInput } from './logbook-capsules';

function LogbookChipRowComponent(props: LogbookCapsuleInput) {
  const { t } = useTranslation('you');
  const capsules = useMemo(() => buildLogbookCapsules(props, t), [props, t]);
  return <CapsuleRow capsules={capsules} />;
}

// Memoised: pass stable handlers, and the row re-renders only when the filters,
// sort, pins or the open rail change.
export const LogbookChipRow = memo(LogbookChipRowComponent);
