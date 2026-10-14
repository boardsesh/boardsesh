import type {
  PrivacyResourceAudience,
  PrivacySettings,
  UpdatePrivacySettingsInput,
} from '@boardsesh/graphql/operations/privacy';
import type { MoreFormModel, MoreOption, MoreRow, MoreSection } from '../MoreForm.types';
import type { PrivacyTranslate } from './privacy-settings-changes';

/**
 * The defaults the server stores for new sessions. Narrower than
 * `SESSION_AUDIENCES`: "anyone with the link" is a per-session choice, and the
 * server rejects it as a default (`updateSettingsSchema` in the privacy
 * resolvers), so offering it here could only ever fail to save.
 */
export const DEFAULT_SESSION_AUDIENCES = [
  'public',
  'followers',
  'invite_only',
] as const satisfies readonly PrivacyResourceAudience[];

/** Row keys for the two writes that can be cancelled at a confirm, tracked by hand. */
export const PRIVATE_ACCOUNT_ROW_KEY = 'privateAccount';
export const SESSION_DEFAULT_ROW_KEY = 'sessionDefault';
/** The analytics consent switch, which `Setting Changed` never reports. */
export const ANALYTICS_ROW_KEY = 'analytics';

export type PrivacyModelInput = {
  t: PrivacyTranslate;
  /** Checked first: a signed-out climber only gets analytics and the policy. */
  signedIn: boolean;
  /** The server's saved settings; `undefined` until the first read lands. */
  settings: PrivacySettings | undefined;
  /** The first read is in flight (not merely disabled or paused). */
  settingsLoading: boolean;
  /** The settings read, or the profile read it waits on, failed and there is nothing saved to show. */
  settingsLoadFailed: boolean;
  offline: boolean;
  /** The latest account, session-default or anonymity write failed (or the fresh read before it). */
  saveFailed: boolean;
  /** Any privacy write is in flight; every writing row waits for it. */
  writePending: boolean;
  /** The in-flight `updatePrivacySettings` input, `undefined` when none. */
  pendingUpdate: UpdatePrivacySettingsInput | undefined;
  /** The in-flight anonymity choice, `undefined` when none. */
  pendingAnonymous: boolean | undefined;
  /**
   * A change the climber made that has not landed: waiting on its confirm
   * dialog, or on its write. Drawn as if chosen, so a cancel or a failed write
   * moves the value back and the native control (whose own state already moved)
   * resyncs to it.
   */
  confirming: { isPrivate?: boolean; sessionAudience?: PrivacyResourceAudience };
  /** Incoming follow requests waiting for an answer. */
  pendingRequestCount: number;
  analytics: {
    /** The consent choice the switch shows. */
    preference: boolean;
    /** Analytics is on by default where this climber is, so say so. */
    regionDefault: boolean;
  };
  sessionRecording: { value: boolean; disabled: boolean };
  onRetry: () => void;
  onPrivateAccountChange: (nextIsPrivate: boolean) => void;
  onSessionAudienceSelect: (audienceKey: string) => void;
  onAnonymousOnForeignBoardsChange: (next: boolean) => void;
  onOpenFollowRequests: () => void;
  onOpenFollowers: () => void;
  onReviewBoards: () => void;
  onAnalyticsChange: (next: boolean) => void;
  onSessionRecordingChange: (next: boolean) => void;
  onExportData: () => void;
  onOpenPrivacyPolicy: () => void;
};

/** What each privacy row shows: a held change, then an in-flight write, then the server. */
export function displayedPrivacyValues({
  settings,
  confirming,
  pendingUpdate,
  pendingAnonymous,
}: Pick<PrivacyModelInput, 'confirming' | 'pendingUpdate' | 'pendingAnonymous'> & { settings: PrivacySettings }) {
  return {
    isPrivate: confirming.isPrivate ?? pendingUpdate?.isPrivate ?? settings.isPrivate,
    sessionAudience:
      confirming.sessionAudience ?? pendingUpdate?.defaultSessionAudience ?? settings.defaultSessionAudience,
    anonymousOnForeignBoards: pendingAnonymous ?? settings.anonymousOnForeignBoards,
  };
}

/** The follow-requests badge: nothing at zero, capped so it never outgrows the row. */
export function followRequestBadge(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count > 99 ? '99+' : String(count);
}

function audienceLabel(audience: PrivacyResourceAudience, t: PrivacyTranslate): string {
  switch (audience) {
    case 'public':
      return t('settings:privacy.audiences.public');
    case 'followers':
      return t('settings:privacy.audiences.followers');
    case 'only_me':
      return t('settings:privacy.audiences.onlyMe');
    case 'unlisted':
      return t('settings:privacy.audiences.unlisted');
    case 'invite_only':
      return t('settings:privacy.audiences.invited');
  }
}

/**
 * The Privacy page as plain data: every privacy control in one place.
 *
 * Nothing here saves on a button. Each switch and the select write once, the
 * moment they change, and every writing row locks while a write is in flight or
 * the phone is offline, so two writes never race and a change can't be queued
 * against a server it can't reach.
 */
export function buildPrivacyModel(input: PrivacyModelInput): MoreFormModel {
  const { t, signedIn, settings } = input;
  const sections: MoreSection[] = [];
  const writeLocked = input.writePending || input.offline;

  if (signedIn) {
    const statusRows: MoreRow[] = [];
    if (!settings && input.settingsLoading) {
      statusRows.push({ kind: 'value', key: 'loading', label: t('settings:privacy.loadingSettings'), busy: true });
    } else if (!settings && input.settingsLoadFailed) {
      statusRows.push({ kind: 'value', key: 'loadFailed', label: t('settings:privacy.loadSettingsFailed') });
      statusRows.push({
        kind: 'button',
        key: 'retry',
        label: t('common:actions.retry'),
        disabled: input.offline,
        onPress: input.onRetry,
      });
    }
    if (input.offline) statusRows.push({ kind: 'value', key: 'offline', label: t('settings:privacy.offline') });
    if (input.saveFailed) {
      statusRows.push({ kind: 'value', key: 'saveFailed', label: t('settings:privacy.saveFailed') });
    }
    if (statusRows.length > 0) sections.push({ key: 'status', rows: statusRows });
  }

  if (signedIn && settings) {
    const displayed = displayedPrivacyValues({ ...input, settings });
    const enabled = settings.enabled === true;

    if (enabled) {
      sections.push({
        key: 'account',
        footer: t('settings:privacy.privateExplanation'),
        rows: [
          {
            kind: 'toggle',
            key: PRIVATE_ACCOUNT_ROW_KEY,
            label: t('settings:privacy.privateAccount'),
            value: displayed.isPrivate,
            disabled: writeLocked,
            onValueChange: input.onPrivateAccountChange,
          },
        ],
      });

      const badge = followRequestBadge(input.pendingRequestCount);
      const peopleRows: MoreRow[] = [];
      // A public account has no requests to answer, so the row only earns its
      // place while private, or while old requests still wait.
      if (displayed.isPrivate || badge) {
        peopleRows.push({
          kind: 'nav',
          key: 'followRequests',
          label: t('settings:privacy.requests'),
          badge,
          onPress: input.onOpenFollowRequests,
        });
      }
      peopleRows.push({
        kind: 'nav',
        key: 'followers',
        label: t('settings:privacy.followers'),
        onPress: input.onOpenFollowers,
      });
      sections.push({ key: 'people', rows: peopleRows });

      const audienceOptions: MoreOption[] = DEFAULT_SESSION_AUDIENCES.map((audience) => ({
        key: audience,
        label: audienceLabel(audience, t),
      }));
      // A default saved some other way still shows as itself, not as a blank menu.
      if (!audienceOptions.some((option) => option.key === displayed.sessionAudience)) {
        audienceOptions.push({ key: displayed.sessionAudience, label: audienceLabel(displayed.sessionAudience, t) });
      }
      sections.push({
        key: 'sessionDefault',
        footer: t('settings:privacy.sessionDefaultFooter'),
        rows: [
          {
            kind: 'select',
            key: SESSION_DEFAULT_ROW_KEY,
            label: t('settings:privacy.sessionDefault'),
            options: audienceOptions,
            selectedKey: displayed.sessionAudience,
            disabled: writeLocked,
            onSelect: input.onSessionAudienceSelect,
          },
        ],
      });
    } else {
      // Account audience, session defaults and follow requests need the server's
      // privacy controls; the anonymity switch below does not.
      sections.push({
        key: 'account',
        rows: [
          {
            kind: 'info',
            key: 'accountControlsLater',
            label: t('settings:privacy.accountAudience'),
            body: t('settings:privacy.accountControlsLater'),
          },
        ],
      });
    }

    // A plain preference: saves whether or not account privacy controls are on.
    sections.push({
      key: 'boards',
      footer: t('settings:privacy.anonymousOnForeignBoardsDescription'),
      rows: [
        {
          kind: 'toggle',
          key: 'anonymousOnForeignBoards',
          label: t('settings:privacy.anonymousOnForeignBoards'),
          value: displayed.anonymousOnForeignBoards,
          disabled: writeLocked,
          onValueChange: input.onAnonymousOnForeignBoardsChange,
        },
      ],
    });

    if (enabled) {
      sections.push({
        key: 'boardAccess',
        footer: t('settings:privacy.boardReview'),
        rows: [
          {
            kind: 'nav',
            key: 'reviewBoards',
            label: t('settings:privacy.reviewBoards'),
            onPress: input.onReviewBoards,
          },
        ],
      });
    }
  }

  // Local consent, not a server write: works signed out and offline alike.
  sections.push({
    key: 'analytics',
    title: t('consent:settingsTitle'),
    footer: input.analytics.regionDefault
      ? `${t('consent:regionDefaultNote')} ${t('consent:settingsBody')}`
      : t('consent:settingsBody'),
    rows: [
      {
        kind: 'toggle',
        key: ANALYTICS_ROW_KEY,
        label: t('consent:analyticsLabel'),
        value: input.analytics.preference,
        onValueChange: input.onAnalyticsChange,
      },
    ],
  });
  sections.push({
    key: 'sessionRecording',
    footer: t('common:mobile.settings.diagnostics.recordingDescription'),
    rows: [
      {
        kind: 'toggle',
        key: 'sessionRecording',
        label: t('common:mobile.settings.diagnostics.recording'),
        value: input.sessionRecording.value,
        disabled: input.sessionRecording.disabled,
        onValueChange: input.onSessionRecordingChange,
      },
    ],
  });

  const dataRows: MoreRow[] = [];
  if (signedIn) {
    dataRows.push({
      kind: 'nav',
      key: 'exportData',
      label: t('settings:export.title'),
      icon: 'export',
      onPress: input.onExportData,
    });
  }
  dataRows.push({
    kind: 'nav',
    key: 'privacyPolicy',
    label: t('settings:privacy.policy'),
    icon: 'policy',
    external: true,
    onPress: input.onOpenPrivacyPolicy,
  });
  sections.push({ key: 'data', title: t('settings:privacy.yourData'), rows: dataRows });

  return { sections };
}
