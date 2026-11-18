import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HOME_SECTIONS,
  focusedHomeLayout,
  homeSectionsStore,
  isDefaultHomeLayout,
  isFocusedHomeLayout,
  useHomeSectionLayout,
  type HomeSectionId,
} from '../../lib/home-sections';
import { canMoveSection, type SectionMoveDirection } from '../../lib/section-layout';
import { hapticSelection } from '../../lib/haptics';
import { trackSettingChanged } from '../../lib/settings-analytics';
import type { SectionLayoutRowModel } from '../section-layout/SectionLayoutList';

// Every Home edit reports `Setting Changed` under this page, from the Customize
// sheet and from Settings › Home alike. Values are section ids or preset
// names, never labels.
const ANALYTICS_PAGE = 'homeScreen';

/** Labels, rows and actions shared by the Customize Home sheet and Settings › Home. */
export function useHomeSectionControls() {
  const { t } = useTranslation('common');
  const layout = useHomeSectionLayout();
  const customizeLabel = t('mobile.settings.homeSections.customize');
  const description = t('mobile.settings.homeSections.description');
  const footer = t('mobile.settings.homeSections.footer');
  const showAllLabel = t('mobile.settings.homeSections.showAll');
  const focusedLabel = t('mobile.settings.homeSections.focused');
  const restoreDefaultsLabel = t('mobile.settings.homeSections.restoreDefaults');
  const weekLabel = t('mobile.settings.homeSections.sections.week');
  const boardLabel = t('mobile.settings.homeSections.sections.board');
  const sessionLabel = t('mobile.settings.homeSections.sections.session');
  const projectsLabel = t('mobile.settings.homeSections.sections.projects');
  const playlistsLabel = t('mobile.settings.homeSections.sections.playlists');
  const climbingNowLabel = t('mobile.settings.homeSections.sections.climbingNow');
  const betaLabel = t('mobile.settings.homeSections.sections.beta');
  const feedLabel = t('mobile.settings.homeSections.sections.feed');
  const weekDescription = t('mobile.settings.homeSections.descriptions.week');
  const boardDescription = t('mobile.settings.homeSections.descriptions.board');
  const sessionDescription = t('mobile.settings.homeSections.descriptions.session');
  const projectsDescription = t('mobile.settings.homeSections.descriptions.projects');
  const playlistsDescription = t('mobile.settings.homeSections.descriptions.playlists');
  const climbingNowDescription = t('mobile.settings.homeSections.descriptions.climbingNow');
  const betaDescription = t('mobile.settings.homeSections.descriptions.beta');
  const feedDescription = t('mobile.settings.homeSections.descriptions.feed');

  const rows = useMemo<SectionLayoutRowModel<HomeSectionId>[]>(() => {
    const labels: Record<HomeSectionId, string> = {
      week: weekLabel,
      board: boardLabel,
      session: sessionLabel,
      projects: projectsLabel,
      playlists: playlistsLabel,
      climbingNow: climbingNowLabel,
      beta: betaLabel,
      feed: feedLabel,
    };
    const descriptions: Record<HomeSectionId, string> = {
      week: weekDescription,
      board: boardDescription,
      session: sessionDescription,
      projects: projectsDescription,
      playlists: playlistsDescription,
      climbingNow: climbingNowDescription,
      beta: betaDescription,
      feed: feedDescription,
    };
    // The feed keeps its place at the bottom: a switch and no arrows, in its own group.
    return layout.order.map((id) => ({
      id,
      label: labels[id],
      description: descriptions[id],
      visible: layout.visible[id],
      movable: id !== HOME_SECTIONS.lockedLast,
    }));
  }, [
    layout,
    weekLabel,
    boardLabel,
    sessionLabel,
    projectsLabel,
    playlistsLabel,
    climbingNowLabel,
    betaLabel,
    feedLabel,
    weekDescription,
    boardDescription,
    sessionDescription,
    projectsDescription,
    playlistsDescription,
    climbingNowDescription,
    betaDescription,
    feedDescription,
  ]);

  const onVisibleChange = useCallback((sectionId: HomeSectionId, visible: boolean) => {
    trackSettingChanged(ANALYTICS_PAGE, sectionId, visible);
    homeSectionsStore.setVisible(sectionId, visible);
  }, []);
  // False when the section cannot go that way, so the list neither buzzes nor
  // announces a move that did not happen.
  const onMove = useCallback((sectionId: HomeSectionId, direction: SectionMoveDirection): boolean => {
    if (!canMoveSection(HOME_SECTIONS, homeSectionsStore.getLayout(), sectionId, direction)) return false;
    trackSettingChanged(ANALYTICS_PAGE, direction === -1 ? 'moveUp' : 'moveDown', sectionId);
    homeSectionsStore.move(sectionId, direction);
    return true;
  }, []);

  const canShowAll = rows.some((row) => !row.visible);
  const canApplyFocused = !isFocusedHomeLayout(layout);
  const canRestoreDefaults = !isDefaultHomeLayout(layout);
  const showAll = useCallback(() => {
    if (!canShowAll) return;
    hapticSelection();
    trackSettingChanged(ANALYTICS_PAGE, 'preset', 'showAll');
    homeSectionsStore.setAllVisible(true);
  }, [canShowAll]);
  const applyFocused = useCallback(() => {
    if (!canApplyFocused) return;
    hapticSelection();
    trackSettingChanged(ANALYTICS_PAGE, 'preset', 'focused');
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
  }, [canApplyFocused]);
  const restoreDefaults = useCallback(() => {
    if (!canRestoreDefaults) return;
    hapticSelection();
    trackSettingChanged(ANALYTICS_PAGE, 'preset', 'default');
    homeSectionsStore.restoreDefaults();
  }, [canRestoreDefaults]);

  return {
    customizeLabel,
    description,
    footer,
    rows,
    onVisibleChange,
    onMove,
    showAllLabel,
    focusedLabel,
    restoreDefaultsLabel,
    showAll,
    applyFocused,
    restoreDefaults,
    canShowAll,
    canApplyFocused,
    canRestoreDefaults,
  };
}
