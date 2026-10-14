import type { ReleaseContextInput } from '@boardsesh/shared-schema';
import type { TFunction } from 'i18next';
import { otaBranchKind, parsePrBranch } from '../lib/qa/pr-branch';

export function appReleaseLabel(context: ReleaseContextInput & { automaticCanary?: boolean | null }) {
  const branchKind = otaBranchKind(context.branch ?? null);
  if (branchKind === 'preview')
    return { key: 'mobile.changelog.updates.preview', prNumber: parsePrBranch(context.branch) };
  if (branchKind === 'staging' || context.channel === 'staging') return { key: 'mobile.changelog.updates.staging' };
  if (branchKind === 'early-updates') return { key: 'mobile.changelog.updates.early' };
  if (context.automaticCanary === true) return { key: 'mobile.changelog.updates.canary' };
  if (context.channel === 'production') return { key: 'mobile.changelog.updates.regular' };
  if (context.channel) return { key: 'mobile.changelog.updates.other', channel: context.channel };
  return { key: 'mobile.changelog.updates.native' };
}

/** Keep every release label discoverable by the translation checks. */
export function translateAppReleaseLabel(
  releaseLabel: ReturnType<typeof appReleaseLabel>,
  t: TFunction<'common'>,
): string {
  switch (releaseLabel.key) {
    case 'mobile.changelog.updates.preview':
      return t('mobile.changelog.updates.preview', releaseLabel);
    case 'mobile.changelog.updates.staging':
      return t('mobile.changelog.updates.staging');
    case 'mobile.changelog.updates.early':
      return t('mobile.changelog.updates.early');
    case 'mobile.changelog.updates.canary':
      return t('mobile.changelog.updates.canary');
    case 'mobile.changelog.updates.regular':
      return t('mobile.changelog.updates.regular');
    case 'mobile.changelog.updates.other':
      return t('mobile.changelog.updates.other', releaseLabel);
    default:
      return t('mobile.changelog.updates.native');
  }
}

/** Only supplies a card view model; actual update operations and reports keep their real identity. */
export function screenshotReleaseScenario(): 'regular' | 'canary' | 'preview' | null {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return null;
  const scenario = process.env.EXPO_PUBLIC_SCREENSHOT_RELEASE_SCENARIO;
  return scenario === 'regular' || scenario === 'canary' || scenario === 'preview' ? scenario : null;
}
