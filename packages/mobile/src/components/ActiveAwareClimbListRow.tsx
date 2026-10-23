import { memo, type ComponentProps } from 'react';
import { ClimbListRow } from './ClimbListRow';
import { useActiveClimbUuid } from '../providers/queue-provider';
import { usePreviewedClimbUuid } from '../providers/drawer-host-provider';

// A climb row that highlights itself when it is the climb you last had up, in
// every list that plays climbs: Climbs search, playlists, smart lists and setter
// pages (#6671 QA). Reads the active-climb selector itself, so navigating climbs
// re-renders only these cheap row wrappers (and the two ClimbListRows whose
// `selected` flips), never the list around them. ClimbListRow stays
// presentational (a plain `selected` prop).
export const ActiveAwareClimbListRow = memo(function ActiveAwareClimbListRow(
  props: Omit<ComponentProps<typeof ClimbListRow>, 'selected'>,
) {
  const activeClimbUuid = useActiveClimbUuid();
  // The highlight means "the climb you last had up", which is not always the
  // queue's current climb. A row tap can open a view-only preview that never
  // writes the queue, and `activeClimbUuid` by construction only moves when the
  // queue does — so keying the highlight on it alone left a climber tapping down
  // a filtered list with no feedback that anything had been selected at all.
  // The previewed uuid clears itself on the next committing open, so exactly one
  // row is ever selected.
  const previewedClimbUuid = usePreviewedClimbUuid();
  const selectedClimbUuid = previewedClimbUuid ?? activeClimbUuid;
  return <ClimbListRow {...props} selected={props.climb.uuid === selectedClimbUuid} />;
});
