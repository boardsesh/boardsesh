import type { MoreFormModel, MoreRow, MoreSection } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

type Toggle = { enabled: boolean; onChange: (enabled: boolean) => void };

export type DeveloperModelInput = {
  t: SettingsTranslate;
  /** Branch and QA notes injected into a dev build, or `null` outside one. */
  devMetadataSection: MoreSection | null;
  /**
   * Dev, tester and admin tooling, or `null` for anyone else. Each flag gates
   * one row; the "Force server unreachable" switch is always there.
   */
  devTools: {
    /** Needs expo-dev-client's native launcher, only linked into dev-client builds. */
    showDevServerSwitcher: boolean;
    showFeatureFlags: boolean;
    showOfflineWrites: boolean;
    /** Dev builds only: the PR picker, opened against a fake PR. */
    showQaPicker: boolean;
    /** Admins: it rewrites the silhouettes every climber's board renders. */
    showOutlineEditor: boolean;
    showSentryDiagnostics: boolean;
    forceServerUnreachable: Toggle;
  } | null;
  /** The tab-bar geometry overlay, or `null` outside a dev, preview or pr-channel session. */
  bottomChromeDiagnostics: Toggle | null;
  /** An EAS preview dev-client build: offer the branch switcher. */
  showPreviewBuild: boolean;
  onNavigate: (href: string) => void;
};

/**
 * "Developer": the tools for dev builds, testers and admins. Nobody else sees
 * the row on the Settings root, and the page guards its own route.
 *
 * Labels are English on purpose (i18n-ignored), like the tools' own screens,
 * except the server-unreachable switch: testers run the app in their own
 * language, and that row is the one that says what the switch does.
 */
export function buildDeveloperModel(input: DeveloperModelInput): MoreFormModel {
  const { t, devTools, onNavigate } = input;
  const sections: MoreSection[] = [];

  if (input.devMetadataSection) sections.push(input.devMetadataSection);

  if (devTools) {
    const rows: MoreRow[] = [];
    if (devTools.showDevServerSwitcher) {
      rows.push({
        kind: 'nav',
        key: 'metroServers',
        label: t('mobile.settings.metroServersTitle'),
        subtitle: t('mobile.settings.metroServersSubtitle'),
        icon: 'devServers',
        onPress: () => onNavigate('/settings/dev-servers'),
      });
    }
    if (devTools.showFeatureFlags) {
      rows.push({
        kind: 'nav',
        key: 'featureFlags',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'Feature Flags',
        // i18n-ignore-next-line
        subtitle: 'Force feature flags on or off',
        icon: 'featureFlags',
        onPress: () => onNavigate('/settings/feature-flags'),
      });
    }
    if (devTools.showOfflineWrites) {
      rows.push({
        kind: 'nav',
        key: 'offlineWrites',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'Offline Writes',
        // i18n-ignore-next-line
        subtitle: 'Hold the SQLite write lock, inject faults, inspect the outbox',
        icon: 'featureFlags',
        onPress: () => onNavigate('/settings/dev-offline-writes'),
      });
    }
    if (devTools.showQaPicker) {
      rows.push({
        kind: 'nav',
        key: 'qaPick',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'QA: pick a PR (dev)',
        // i18n-ignore-next-line
        subtitle: 'Open the tester PR picker; surfing itself only works in a store build',
        icon: 'otaChannel',
        onPress: () => onNavigate('/qa/pick?prNumbers=1'),
      });
    }
    if (devTools.showOutlineEditor) {
      rows.push({
        kind: 'nav',
        key: 'outlineEditor',
        // i18n-ignore-next-line — admin-only dev tooling
        label: 'Hold Outlines',
        // i18n-ignore-next-line
        subtitle: 'Redraw a traced hold silhouette, or annotate its LED ring',
        // Board look, not featureFlags: this row edits how the board is DRAWN,
        // and two rows above it already carry the flag icon.
        icon: 'boardLook',
        onPress: () => onNavigate('/settings/outline-editor'),
      });
    }
    if (devTools.showSentryDiagnostics) {
      rows.push({
        kind: 'nav',
        key: 'sentryDiagnostics',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'Sentry Diagnostics',
        // i18n-ignore-next-line
        subtitle: 'Verify handled, uncaught, and native crash reporting',
        icon: 'otaChannel',
        onPress: () => onNavigate('/settings/sentry-diagnostics'),
      });
    }
    // Pretend the server is down, so the banner, the per-surface placards and
    // the outbox can all be exercised without unplugging anything.
    rows.push({
      kind: 'toggle',
      key: 'forceServerUnreachable',
      label: t('mobile.settings.dev.forceServerUnreachable'),
      subtitle: t('mobile.settings.dev.forceServerUnreachableDescription'),
      value: devTools.forceServerUnreachable.enabled,
      onValueChange: devTools.forceServerUnreachable.onChange,
    });
    sections.push({ key: 'development', title: t('mobile.settings.development'), rows });
  }

  if (input.bottomChromeDiagnostics) {
    sections.push({
      key: 'diagnostics',
      rows: [
        {
          kind: 'toggle',
          key: 'bottomChromeDiagnostics',
          // i18n-ignore-next-line — tester-only diagnostics
          label: 'Bottom chrome diagnostics',
          // i18n-ignore-next-line
          subtitle: 'Overlay live tab-bar geometry values',
          value: input.bottomChromeDiagnostics.enabled,
          onValueChange: input.bottomChromeDiagnostics.onChange,
        },
      ],
    });
  }

  if (input.showPreviewBuild) {
    sections.push({
      key: 'previewBuild',
      // i18n-ignore-next-line — preview-only section
      title: 'Preview Build',
      rows: [
        {
          kind: 'nav',
          key: 'branchSwitcher',
          // i18n-ignore-next-line
          label: 'Branch Switcher',
          // i18n-ignore-next-line
          subtitle: 'Switch EAS Update branch',
          icon: 'branchSwitcher',
          onPress: () => onNavigate('/settings/branch-switcher'),
        },
      ],
    });
  }

  return { sections };
}
