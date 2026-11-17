import { memo, useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useSmartPlaylistCounts } from '@boardsesh/playlists-react';
import type { SmartPlaylistType } from '@boardsesh/graphql/operations/playlists';
import { ArtRow } from '../ArtRow';
import { Icon } from '../Icon';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { PlaylistPreviewSquare } from '../playlist/PlaylistPreviewSquare';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { useAuthToken } from '../../lib/graphql/use-auth-token';
import { track } from '../../lib/analytics';
import { hapticLight } from '../../lib/haptics';
import { smartPlaylistByType, smartPlaylistHref, type SmartPlaylistPresentation } from '../../lib/smart-playlists';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { HomeSectionFrame } from './HomeSectionFrame';

// Climbs to try next, at the climber's level and not sent yet (#7689). Projects
// get their own shelf (#7691); Liked climbs stay one tap away on Discover.
const HOME_SMART_PLAYLIST_TYPES: readonly SmartPlaylistType[] = [
  'RECOMMENDED_AT_LEVEL',
  'RECOMMENDED_HIDDEN_GEMS',
  'RECOMMENDED_FRESH',
];
const HOME_SMART_PLAYLISTS = HOME_SMART_PLAYLIST_TYPES.flatMap((type) => smartPlaylistByType(type) ?? []);
const PREVIEW_SIZE = 44;

/**
 * "At your level, unsent": the At your level, Hidden gems and Fresh smart
 * playlists, then All playlists on Discover.
 *
 * The counts come from the network. Without them (no signal, still loading)
 * the rows show without a count, and each list shows its own offline state.
 */
export const HomePlaylistsSection = memo(function HomePlaylistsSection() {
  const { t } = useTranslation('playlists');
  const { t: tFeed } = useTranslation('feed');
  const router = useRouter();
  const { systemColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const { data: token = null, isLoading: tokenLoading } = useAuthToken();
  // Discover's own query key, so a visit to either warms the other.
  const countsQuery = useSmartPlaylistCounts({ token, tokenLoading, isAuthenticated });
  const countByType = useMemo(
    () => new Map((countsQuery.data ?? []).map((smartCount) => [smartCount.type, smartCount.count])),
    [countsQuery.data],
  );

  const openSmartPlaylist = useCallback(
    (smartType: SmartPlaylistType) => {
      hapticLight();
      track(SHARED_EVENTS.HomeSectionTapped, { section: 'playlists', target: smartType });
      // With its anchor: a Discover tab that has not been opened yet would
      // otherwise hold only this list, and back would leave Discover's main page
      // unreachable (the JS tab bars mount tabs lazily).
      router.push(smartPlaylistHref(smartType, 'home'), { withAnchor: true });
    },
    [router],
  );
  const openAllPlaylists = useCallback(() => {
    hapticLight();
    track(SHARED_EVENTS.HomeSectionTapped, { section: 'playlists', target: 'all' });
    router.navigate('/(tabs)/discover');
  }, [router]);

  const allPlaylistsLabel = tFeed('mobile.home.sections.playlists.all');
  return (
    <HomeSectionFrame title={tFeed('mobile.home.sections.playlists.title')} testID="home-section-playlists">
      <InsetGroupedList>
        {HOME_SMART_PLAYLISTS.map((preset) => {
          const count = countByType.get(preset.type);
          return (
            <SmartPlaylistRow
              key={preset.type}
              preset={preset}
              name={t(preset.titleI18nKey)}
              countLabel={count === undefined ? null : t('detail.climbCount', { count })}
              onOpen={openSmartPlaylist}
            />
          );
        })}
        <PressableSurface
          onPress={openAllPlaylists}
          feedback="opacity"
          rippleColor={systemColors.label as string}
          accessibilityRole="button"
          accessibilityLabel={allPlaylistsLabel}
          style={insetGroupedRowStyles.row}
          testID="home-playlists-all"
        >
          <View style={insetGroupedRowStyles.leading}>
            <Icon name="discover" size={20} color={systemColors.secondaryLabel} />
          </View>
          <Text variant="body" color={systemColors.label} style={insetGroupedRowStyles.text}>
            {allPlaylistsLabel}
          </Text>
          <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
        </PressableSurface>
      </InsetGroupedList>
    </HomeSectionFrame>
  );
});

const SmartPlaylistRow = memo(function SmartPlaylistRow({
  preset,
  name,
  countLabel,
  onOpen,
}: {
  preset: SmartPlaylistPresentation;
  name: string;
  countLabel: string | null;
  onOpen: (smartType: SmartPlaylistType) => void;
}) {
  const { type, color, icon } = preset;
  const handlePress = useCallback(() => onOpen(type), [onOpen, type]);
  const art = useMemo(() => <PlaylistPreviewSquare color={color} icon={icon} size={PREVIEW_SIZE} />, [color, icon]);
  return (
    <ArtRow
      art={art}
      artSize="regular"
      title={name}
      subtitle={countLabel ?? undefined}
      accessory="chevron"
      onPress={handlePress}
      accessibilityLabel={countLabel ? `${name}, ${countLabel}` : name}
      testID={`home-playlists-${preset.slug}`}
    />
  );
});
