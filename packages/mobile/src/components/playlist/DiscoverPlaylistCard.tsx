import { memo, useCallback } from 'react';
import type { SmartPlaylistType } from '@boardsesh/graphql/operations/playlists';
import { PlaylistCard, type PlaylistCardProps } from './PlaylistCard';

type CardDisplayProps = Omit<PlaylistCardProps, 'onPress' | 'onTogglePin'>;
export type DiscoverPlaylistCardProps = CardDisplayProps & {
  uuid: string;
  onOpen: (uuid: string) => void;
  onPin?: (uuid: string, isPinned: boolean) => void;
};

/** Scalars keep refreshed objects and parent renders out of memoized cards. */
export const DiscoverPlaylistCard = memo(function DiscoverPlaylistCard({
  uuid,
  onOpen,
  onPin,
  ...display
}: DiscoverPlaylistCardProps) {
  const isPinned = !!display.isPinned;
  const handleOpen = useCallback(() => onOpen(uuid), [onOpen, uuid]);
  const handlePin = useCallback(() => onPin?.(uuid, isPinned), [onPin, uuid, isPinned]);
  return <PlaylistCard {...display} onPress={handleOpen} onTogglePin={onPin ? handlePin : undefined} />;
});

export type DiscoverSmartPlaylistCardProps = CardDisplayProps & {
  smartType: SmartPlaylistType;
  onOpen: (smartType: SmartPlaylistType) => void;
  onPin?: (smartType: SmartPlaylistType) => void;
};

export const DiscoverSmartPlaylistCard = memo(function DiscoverSmartPlaylistCard({
  smartType,
  onOpen,
  onPin,
  ...display
}: DiscoverSmartPlaylistCardProps) {
  const handleOpen = useCallback(() => onOpen(smartType), [onOpen, smartType]);
  const handlePin = useCallback(() => onPin?.(smartType), [onPin, smartType]);
  return <PlaylistCard {...display} onPress={handleOpen} onTogglePin={onPin ? handlePin : undefined} />;
});
