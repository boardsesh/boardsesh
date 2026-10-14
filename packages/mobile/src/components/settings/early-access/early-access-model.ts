import type { MoreFormModel, MoreRow, MoreSection } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

export type EarlyAccessModelInput = {
  t: SettingsTranslate;
  /**
   * PR previews (docs/crowdsourced-qa-mobile.md), or `null` on a binary that
   * cannot load one.
   */
  previews: {
    /** The PR this bundle is a preview of, or `null` when on a regular update. */
    prNumber: number | null;
    onOpenTestPlan: () => void;
    onOpenPicker: () => void;
    /** Testers only: offer the picker on every launch. */
    promptOnLaunch: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
  } | null;
};

/**
 * "Early access": trying a change before it ships. "Get updates early" lives in
 * What's New → Update options (#6476), next to the rest of the release controls.
 */
export function buildEarlyAccessModel(input: EarlyAccessModelInput): MoreFormModel {
  const { t, previews } = input;
  const sections: MoreSection[] = [];

  // The everyone-facing way into the crowdsourced-QA flow. The screen it opens
  // is also where "Previews are switched off" / "Nothing to test right now" gets
  // SAID, so the row stays put when the list is empty: a hidden button and an
  // empty list look identical from the outside, and that is exactly the
  // confusion this row exists to end.
  if (previews) {
    const rows: MoreRow[] = [
      previews.prNumber !== null
        ? {
            kind: 'nav',
            key: 'qaBrief',
            label: t('mobile.settings.previews.testPlanTitle', { prNumber: previews.prNumber }),
            subtitle: t('mobile.settings.previews.testPlanSubtitle'),
            icon: 'branchSwitcher',
            onPress: previews.onOpenTestPlan,
          }
        : {
            kind: 'nav',
            key: 'qaPick',
            label: t('mobile.settings.previews.pickTitle'),
            subtitle: t('mobile.settings.previews.pickSubtitle'),
            icon: 'branchSwitcher',
            onPress: previews.onOpenPicker,
          },
    ];
    if (previews.promptOnLaunch) {
      rows.push({
        kind: 'toggle',
        key: 'qaPromptOnLaunch',
        label: t('mobile.settings.previews.promptOnLaunchTitle'),
        subtitle: t('mobile.settings.previews.promptOnLaunchSubtitle'),
        value: previews.promptOnLaunch.enabled,
        onValueChange: previews.promptOnLaunch.onChange,
      });
    }
    sections.push({ key: 'previews', title: t('mobile.settings.previews.title'), rows });
  }

  return { sections };
}
