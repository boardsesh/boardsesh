import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { deriveProjects, type ClimbProject } from '@boardsesh/profile-stats';
import { ArtRow } from '../ArtRow';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { Icon } from '../Icon';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { ART_SLOTS } from '../art-slot';
import { getDatabaseHandle } from '../../db';
import type { ActivityTick } from '../../db/queries/get-activity-ticks-local';
import { readClimbArtLocal, type LocalClimbArt } from '../../db/queries/get-climb-art-local';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { track } from '../../lib/analytics';
import { hapticLight } from '../../lib/haptics';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { getBoardConfigForClimb, type PlaylistBoardConfig } from '../../lib/playlists/board-details-for-playlist';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { smartPlaylistHref } from '../../lib/smart-playlists';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius } from '../../theme/tokens';
import { HomeSectionFrame } from './HomeSectionFrame';
import { useActivityTicks } from './use-activity-ticks';

/** Three rows, then See all: the shelf is a way back to the wall, not the whole list. */
const SHELF_ROWS = 3;
/** Module-level so `ClimbListThumbnail`'s memo can bail. */
const THUMBNAIL_SIZE = ART_SLOTS.large;
const NO_ART: ReadonlyMap<string, LocalClimbArt> = new Map();

type Project = ClimbProject<ActivityTick>;

const projectKey = (boardType: string, climbUuid: string) => `${boardType}\u0000${climbUuid}`;

/**
 * The art of the shelf's rows, from the catalogue on this phone. A row whose
 * board is not downloaded draws a blank tile and keeps its name and grade.
 */
function useProjectArt(projects: readonly Project[]): ReadonlyMap<string, LocalClimbArt> {
  const { userId: viewerId } = useStoredUserId(projects.length > 0);
  const refs = useMemo(
    () => projects.map(({ latest }) => ({ boardType: latest.boardType, climbUuid: latest.climbUuid })),
    [projects],
  );
  const { data } = useQuery({
    queryKey: ['localClimbArt', viewerId ?? '', refs.map((ref) => projectKey(ref.boardType, ref.climbUuid))],
    enabled: refs.length > 0 && !!viewerId,
    // The board_climbs sync invalidates this key, so a board downloaded later
    // fills the blank tiles in.
    staleTime: Infinity,
    networkMode: 'always',
    queryFn: async () => {
      const db = getDatabaseHandle();
      return db && viewerId ? readClimbArtLocal(db, refs, viewerId) : [];
    },
  });
  return useMemo(
    () => (data ? new Map(data.map((art) => [projectKey(art.boardType, art.climbUuid), art])) : NO_ART),
    [data],
  );
}

/**
 * "Back to your projects" (#7691): the climbs the climber tried and has not
 * sent, the latest tried first, one tap from the wall. Same rule as the Projects
 * smart playlist, which See all opens. From the ticks on this phone, so it is
 * there on a cold start and with no signal, and a send takes its climb off.
 *
 * Draws nothing at all when there is no project (most climbers log single
 * tries), and nothing while the local read loads, so it never shows as an
 * empty box.
 */
export const HomeProjectsSection = memo(function HomeProjectsSection() {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const ticks = useActivityTicks(true);
  const shown = useMemo(() => (ticks ? deriveProjects(ticks).slice(0, SHELF_ROWS) : []), [ticks]);
  const artByClimb = useProjectArt(shown);

  const openProject = useCallback(
    (project: Project, boardConfig: PlaylistBoardConfig) => {
      const { climbUuid, boardType, angle } = project.latest;
      hapticLight();
      track(SHARED_EVENTS.HomeSectionTapped, { section: 'projects', target: 'climb' });
      // The climb's own layout, size and sets, so it never opens on a board guessed from its type.
      openClimbInPlayDrawer(
        {
          kind: 'ref',
          climbUuid,
          boardType,
          layoutId: boardConfig.layoutId,
          angle,
          sizeId: boardConfig.sizeId,
          setIds: boardConfig.setIds.join(','),
        },
        { openPlayDrawer, router },
      );
    },
    [openPlayDrawer, router],
  );
  const openAll = useCallback(() => {
    hapticLight();
    track(SHARED_EVENTS.HomeSectionTapped, { section: 'projects', target: 'all' });
    // With its anchor, as the playlists shelf opens a smart playlist.
    router.push(smartPlaylistHref('PROJECTS', 'home'), { withAnchor: true });
  }, [router]);

  if (shown.length === 0) return null;
  const seeAllLabel = t('mobile.home.sections.projects.seeAll');
  return (
    <HomeSectionFrame title={t('mobile.home.sections.projects.title')} testID="home-section-projects">
      <InsetGroupedList separatorInset="large">
        {shown.map((project) => {
          const key = projectKey(project.latest.boardType, project.latest.climbUuid);
          return <ProjectRow key={key} project={project} art={artByClimb.get(key) ?? null} onOpen={openProject} />;
        })}
        <PressableSurface
          onPress={openAll}
          feedback="opacity"
          rippleColor={systemColors.label as string}
          accessibilityRole="button"
          accessibilityLabel={seeAllLabel}
          style={insetGroupedRowStyles.row}
          testID="home-projects-all"
        >
          <View style={styles.seeAllLeading}>
            <Icon name="queue" size={20} color={systemColors.secondaryLabel} />
          </View>
          <Text variant="body" color={systemColors.label} style={insetGroupedRowStyles.text}>
            {seeAllLabel}
          </Text>
          <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
        </PressableSurface>
      </InsetGroupedList>
    </HomeSectionFrame>
  );
});

const ProjectRow = memo(function ProjectRow({
  project,
  art,
  onOpen,
}: {
  project: Project;
  art: LocalClimbArt | null;
  onOpen: (project: Project, boardConfig: PlaylistBoardConfig) => void;
}) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const { latest, tries } = project;
  const boardConfig = useMemo(
    () => (art ? getBoardConfigForClimb(art.boardType, art.layoutId, art.compatibleSizeIds) : null),
    [art],
  );
  const handlePress = useCallback(() => {
    if (boardConfig) onOpen(project, boardConfig);
  }, [onOpen, project, boardConfig]);
  const placeholderStyle = useMemo(
    () => [styles.placeholder, { backgroundColor: systemColors.tertiaryFill }],
    [systemColors.tertiaryFill],
  );
  const thumbnail = useMemo(
    () =>
      art && boardConfig ? (
        <ClimbListThumbnail
          climbUuid={latest.climbUuid}
          frames={art.frames}
          boardName={boardConfig.boardName}
          layoutId={boardConfig.layoutId}
          sizeId={boardConfig.sizeId}
          setIds={boardConfig.setIds.join(',')}
          size={THUMBNAIL_SIZE}
        />
      ) : (
        <View style={placeholderStyle} />
      ),
    [art, boardConfig, latest.climbUuid, placeholderStyle],
  );

  const name = latest.climbName ?? t('mobile.home.sections.projects.unknownClimb');
  // The grade leads, so a long line cuts the tries, never the grade.
  const subtitle = [
    latest.difficulty === null ? null : formatGradeByDifficultyId(latest.difficulty, latest.boardType),
    t('mobile.home.sections.projects.tries', { count: tries }),
  ]
    .filter((part): part is string => !!part)
    .join(' · ');
  return (
    <ArtRow
      art={thumbnail}
      artSize="large"
      title={name}
      subtitle={subtitle}
      // Without the climb's board on this phone there is no layout to open it
      // on: the row names the project and is not a button.
      accessory={boardConfig ? 'chevron' : undefined}
      onPress={boardConfig ? handlePress : undefined}
      accessibilityLabel={`${name}, ${subtitle}`}
      testID={`home-project-${latest.climbUuid}`}
    />
  );
});

const styles = StyleSheet.create({
  placeholder: {
    width: ART_SLOTS.large.width,
    height: ART_SLOTS.large.height,
    borderRadius: borderRadius.sm,
  },
  seeAllLeading: {
    width: ART_SLOTS.large.width,
    flexShrink: 0,
    alignItems: 'center',
  },
});
