import { PlayCore, type PlayDrawerProps } from './PlayCore';
import { RankedClimbInspection } from './RankedClimbInspection';

export { SHARED_BROWSE_LATCH_RELEASE_MS, type PlayDrawerOpenOptions, type PlayDrawerOpenTarget } from './PlayCore';

/** Route and persistent pane share the ordinary player. Staff ranking inspection owns no player actions. */
export function PlayDrawer(props: PlayDrawerProps) {
  const { openTarget, onClose } = props;
  if (openTarget?.options?.rankedPreview) {
    return (
      <RankedClimbInspection climb={openTarget.climb} preview={openTarget.options.rankedPreview} onClose={onClose} />
    );
  }
  return <PlayCore {...props} />;
}
