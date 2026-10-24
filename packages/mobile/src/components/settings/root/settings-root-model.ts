import type { MoreFormModel, MoreNavRow, MoreSection } from '../../MoreForm.types';
import { buildSyncIssuesSection, type SyncIssuesSectionInput } from './sync-issues-section';
import {
  SETTINGS_ROOT_ICONS,
  settingsPageTitle,
  type SettingsRootPage,
  type SettingsTranslate,
} from './settings-pages';

/**
 * The Settings root, group by group, top to bottom.
 *
 * Owner decision 2026-10-14 (QA verdict 85): General first, then Privacy,
 * Account and Connected apps, the names climbers know from their phone's own
 * settings; Board and Climbs & grades in a group of their own (Home joined them on
 * 2026-10-18, QA on #6546: what the app shows you, beside how it looks); the testing pages
 * last. For context, people who used each part of Settings in the 90 days before
 * it was split into pages (PostHog): Connected apps 409, Account 404, Board look
 * 264, Offline 106, General 58; Climbs and Board lighting left no signal.
 */
export const SETTINGS_ROOT_ORDER = [
  { key: 'app', pages: ['general', 'privacy', 'account', 'integrations'] },
  { key: 'climbing', pages: ['board', 'climbs', 'home', 'timers'] },
  { key: 'testing', pages: ['earlyAccess', 'developer'] },
] as const satisfies readonly { key: string; pages: readonly SettingsRootPage[] }[];

/** The pages that only show for some climbers, builds or flags. Every other page always shows. */
export type SettingsRootConditionalPage = 'account' | 'earlyAccess' | 'developer';

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
  return page === 'account' || page === 'earlyAccess' || page === 'developer';
}

/**
 * The Settings root as plain data: a short list of pages in three groups.
 *
 * Every row is a noun that matches the title of the page it opens, with an icon
 * and, where it helps, the current value. No section headers and no subtitles:
 * the list is short enough to read at a glance, and the detail lives one tap in.
 * A group whose pages are all hidden leaves no empty group behind.
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

  for (const group of SETTINGS_ROOT_ORDER) {
    const pages: readonly SettingsRootPage[] = group.pages;
    const rows = pages.filter(isVisible).map(pageRow);
    if (rows.length > 0) sections.push({ key: group.key, rows });
  }

  return { sections };
}
