import { memo, useMemo } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserPlaylists, usePinnedPlaylists } from '@boardsesh/playlists-react';
import { PlaylistCard, PlaylistScrollSection } from '../playlist';
import { useAuth } from '../../providers/auth-provider';
import { useAuthToken } from '../../lib/graphql/use-auth-token';

export type HomeJumpBackInProps = {
  boardType: string;
  layoutId: number;
};

/**
 * "Jump Back In" — the user's pinned + owned playlists for the active board, a
 * quick path back into their own stuff. Mirrors the Discover tab's section;
 * hidden when signed out or empty.
 */
export const HomeJumpBackIn = memo(function HomeJumpBackIn({ boardType, layoutId }: HomeJumpBackInProps) {
  const { t } = useTranslation('playlists');
  const { isAuthenticated } = useAuth();
  const { data: token = null } = useAuthToken();
  const effectiveToken = isAuthenticated ? token : null;

  const {
    playlists: userPlaylists,
    isLoading,
    isLoadingMore,
    loadMore,
  } = useUserPlaylists({ token: effectiveToken, boardType, layoutId, pageSize: 20 });

  const { pinned } = usePinnedPlaylists({
    token: effectiveToken,
    boardType,
    layoutId,
    candidatePlaylists: userPlaylists,
  });

  // Pinned lead, then owned with pinned removed so none appear twice.
  const jumpBackIn = useMemo(() => {
    const pinnedUuids = new Set(pinned.map((playlist) => playlist.uuid));
    return [...pinned, ...userPlaylists.filter((playlist) => !pinnedUuids.has(playlist.uuid))];
  }, [pinned, userPlaylists]);

  if (!isAuthenticated) return null;
  if (!isLoading && jumpBackIn.length === 0) return null;

  return (
    <PlaylistScrollSection
      title={t('library.sections.jumpBackIn')}
      loading={isLoading && jumpBackIn.length === 0}
      isLoadingMore={isLoadingMore}
      onEndReached={loadMore}
    >
      {jumpBackIn.map((playlist, index) => (
        <PlaylistCard
          key={playlist.uuid}
          name={playlist.name}
          climbCount={playlist.climbCount}
          color={playlist.color}
          icon={playlist.icon}
          variant="scroll"
          index={index}
          onPress={() => router.push(`/(tabs)/discover/${playlist.uuid}`)}
        />
      ))}
    </PlaylistScrollSection>
  );
});
