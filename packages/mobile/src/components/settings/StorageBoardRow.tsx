import { memo, useCallback } from 'react';
import { Button } from '../Button';
import { ListRow } from '../ListRow';

export type StorageBoardRowProps = {
  scopeKey: string;
  title: string;
  /** Board + size, e.g. "Kilter · 12 x 14". */
  subtitle: string;
  /** Size + climb count, e.g. "About 180 MB · 41,000 climbs". */
  caption: string;
  /** Whether this scope is still kept offline, or is leftover data. */
  statusLabel: string;
  removeLabel: string;
  removeAccessibilityLabel: string;
  isRemoving: boolean;
  isDisabled: boolean;
  showSeparator: boolean;
  onRemove: (scopeKey: string) => void;
};

/**
 * One downloaded board scope. Memoized and fed only primitives plus a stable
 * `onRemove`, so removing one board doesn't re-render the others.
 */
function StorageBoardRowComponent({
  scopeKey,
  title,
  subtitle,
  caption,
  statusLabel,
  removeLabel,
  removeAccessibilityLabel,
  isRemoving,
  isDisabled,
  showSeparator,
  onRemove,
}: StorageBoardRowProps) {
  const handleRemove = useCallback(() => onRemove(scopeKey), [onRemove, scopeKey]);

  return (
    <ListRow
      title={title}
      // ListRow renders a single subtitle line, so the board/size, the footprint, and
      // the offline status are composed into it rather than fighting the component.
      subtitle={`${subtitle}\n${caption}\n${statusLabel}`}
      haptic={false}
      showSeparator={showSeparator}
      trailing={
        <Button
          title={removeLabel}
          accessibilityLabel={removeAccessibilityLabel}
          onPress={handleRemove}
          variant="text"
          size="small"
          role="destructive"
          loading={isRemoving}
          disabled={isDisabled}
        />
      }
    />
  );
}

export const StorageBoardRow = memo(StorageBoardRowComponent);
