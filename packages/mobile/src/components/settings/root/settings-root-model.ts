import type { MoreFormModel, MoreNavRow, MoreSection } from '../../MoreForm.types';
import { buildSyncIssuesSection, type SyncIssuesSectionInput } from './sync-issues-section';
import {
  SETTINGS_ROOT_ICONS,
  settingsPageTitle,
  type SettingsRootPage,
  type SettingsTranslate,
} from './settings-pages';

/**
 * The middle group of the Settings root, most used first: people who used each
 * part of Settings in the 90 days before it was split into pages (PostHog).
 * Connected apps 409, Account 404, Board look 264, Offline 106, General 58;
 * Climbs and Board lighting left no signal. Re-rank here once `Setting Changed`
 * has data; nothing else needs to change.
 */
export const SETTINGS_ROOT_ORDER = [
  'integrations',
  'account',
  'boardLook',
  'offline',
  'general',
  'climbs',
  'boardLighting',
] as const satisfies readonly SettingsRootPage[];

/** Last on the root, and only for the climbers and builds they apply to. */
const TESTING_PAGES = ['earlyAccess', 'developer'] as const satisfies readonly SettingsRootPage[];

/** The pages that only show for some climbers, builds or flags. Every other page always shows. */
export type SettingsRootConditionalPage = 'account' | 'offline' | 'earlyAccess' | 'developer';

export type SettingsRootModelInput = {
  t: SettingsTranslate;
  /**
   * Stuck writes, or `null` when there are none. The connectivity banner points
   * here, so it stays first on the root.
   */
  syncIssues: SyncIssuesSectionInput | null;
  visible: Record<SettingsRootConditionalPage, boolean>;
  /** The setting a row's page holds, drawn trailing. Missing means no value. */
  values: Partial<Record<SettingsRootPage, string>>;
  onOpen: (page: SettingsRootPage) => void;
};

function isConditionalPage(page: SettingsRootPage): page is SettingsRootConditionalPage {
  return page === 'account' || page === 'offline' || page === 'earlyAccess' || page === 'developer';
}

/**
 * The Settings root as plain data: a short list of pages, Privacy first.
 *
 * Every row is a noun that matches the title of the page it opens, with an icon
 * and, where it helps, the current value. No section headers and no subtitles:
 * the list is short enough to read at a glance, and the detail lives one tap in.
 */
export function buildSettingsRootModel(input: SettingsRootModelInput): MoreFormModel {
  const { t, syncIssues, visible, values, onOpen } = input;
  const isVisible = (page: SettingsRootPage) => !isConditionalPage(page) || visible[page];
  const pageRow = (page: SettingsRootPage): MoreNavRow => ({
    kind: 'nav',
    key: page,
    label: settingsPageTitle(page, t),
    icon: SETTINGS_ROOT_ICONS[page],
    value: values[page],
    onPress: () => onOpen(page),
  });

  const sections: MoreSection[] = [];

  // First, and only when writes are stuck failing, so it is noticed when it
  // matters and invisible otherwise.
  if (syncIssues) sections.push(buildSyncIssuesSection(t, syncIssues));

  // Signed in or out: analytics consent and session recording live there too.
  sections.push({ key: 'privacy', rows: [pageRow('privacy')] });
  sections.push({ key: 'pages', rows: SETTINGS_ROOT_ORDER.filter(isVisible).map(pageRow) });

  const testingRows = TESTING_PAGES.filter(isVisible).map(pageRow);
  if (testingRows.length > 0) {
    sections.push({ key: 'testing', rows: testingRows });
  }

  return { sections };
}
