import Constants from 'expo-constants';
import type { MoreInfoRow, MoreSection } from './MoreForm.types';

type DevMetadata = {
  branchName?: unknown;
  qaNotes?: unknown;
  qaNotesFilePath?: unknown;
};

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Turns the injected dev metadata into rows owned by MoreForm's scroll container.
 * Kept pure so the manifest's odd null serialization can be covered in Vitest.
 */
export function buildDevMetadataSection(value: unknown): MoreSection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const devMetadata = value as DevMetadata;
  // Expo's dev-client manifest serializes null extra values as `{}`. Only retain
  // genuine strings so those objects never become native Text children.
  const branchName = asText(devMetadata.branchName);
  const qaNotes = asText(devMetadata.qaNotes);
  const qaNotesFilePath = asText(devMetadata.qaNotesFilePath);
  const rows: MoreInfoRow[] = [];

  if (branchName) {
    rows.push({
      kind: 'info',
      key: 'devBranch',
      // i18n-ignore-next-line — dev-only metadata, never shown in production builds
      label: 'Branch',
      body: branchName,
      selectable: true,
    });
  }

  if (qaNotes) {
    rows.push({
      kind: 'info',
      key: 'devQaNotes',
      // i18n-ignore-next-line — dev-only metadata, never shown in production builds
      label: 'QA Notes',
      body: qaNotes,
      detail: qaNotesFilePath ?? undefined,
      selectable: true,
    });
  }

  if (rows.length === 0) {
    return null;
  }

  return {
    key: 'devBuild',
    // i18n-ignore-next-line — dev-only metadata, never shown in production builds
    title: 'Dev Build',
    rows,
  };
}

export function getDevMetadataSection(): MoreSection | null {
  if (!__DEV__) {
    return null;
  }

  const extra = Constants.expoConfig?.extra;
  if (!extra || typeof extra !== 'object' || !('devMetadata' in extra)) {
    return null;
  }

  return buildDevMetadataSection(extra.devMetadata);
}
