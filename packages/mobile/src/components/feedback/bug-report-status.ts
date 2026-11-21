import type { AppFeedbackStatus } from '@boardsesh/shared-schema';
import type { TFunction } from 'i18next';

export function bugReportStatusLabel(status: AppFeedbackStatus, t: TFunction): string {
  switch (status) {
    case 'new':
      return t('bugReports.statusNew');
    case 'in_progress':
      return t('bugReports.statusInProgress');
    case 'resolved':
      return t('bugReports.statusResolved');
    case 'wont_fix':
      return t('bugReports.statusWontFix');
  }
}
