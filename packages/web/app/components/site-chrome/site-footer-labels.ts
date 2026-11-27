import type { TFunction } from 'i18next';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import { isBoardTypeVisible } from '@boardsesh/board-config/visibility';
import { boardTypeLabel } from '@boardsesh/board-constants/board-type-labels';
import { LOCALE_LABELS, type Locale } from '@/app/lib/i18n/config';

const defaultBoardNames = SUPPORTED_BOARDS.filter((board) => board !== 'spray' && isBoardTypeVisible(board));

export function getSiteFooterLabels(
  t: TFunction<'common'>,
  privacyChoices: string,
  locale: Locale,
  boardNames: readonly BoardName[] = defaultBoardNames,
) {
  const boards = boardNames.map(boardTypeLabel).join(', ');
  return {
    climb: t('footer.journeys.climb'),
    supportedBoards: t('footer.journeys.supportedBoards'),
    appGuides: t('footer.journeys.appGuides'),
    gyms: t('footer.links.gyms'),
    playlists: t('footer.links.playlists'),
    auroraMigration: t('footer.links.auroraMigration'),
    walls: t('footer.journeys.walls'),
    setupSpray: t('footer.journeys.setupSpray'),
    claimGym: t('footer.journeys.claimGym'),
    partners: t('footer.journeys.partners'),
    project: t('footer.journeys.project'),
    about: t('footer.links.about'),
    support: t('footer.links.support'),
    source: t('footer.journeys.source'),
    roadmap: t('footer.journeys.roadmap'),
    discord: t('footer.journeys.discord'),
    developers: t('footer.journeys.developers'),
    helpHeading: t('footer.journeys.help'),
    helpLink: t('footer.links.help'),
    bluetooth: t('footer.journeys.bluetooth'),
    reportBug: t('footer.journeys.reportBug'),
    legal: t('footer.links.legal'),
    privacy: t('footer.links.privacy'),
    homeAriaLabel: t('ariaLabels.home'),
    tagline: t('footer.tagline'),
    openBrowser: t('footer.openBrowser'),
    startClimbingAriaLabel: t('ariaLabels.startClimbing'),
    navLabel: t('footer.navLabel'),
    trademarkNote: t('footer.trademarkNote', { boards }),
    storeTrademarks: t('footer.storeTrademarks'),
    privacyChoices,
    languageSwitcherAriaLabel: t('languageSwitcher.ariaLabelWithCurrent', { language: LOCALE_LABELS[locale] }),
  };
}

export type SiteFooterLabels = ReturnType<typeof getSiteFooterLabels>;
