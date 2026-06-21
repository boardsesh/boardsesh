import { Linking } from 'react-native';
import { reportError } from './error-reporting';

/** Where partnership enquiries (board manufacturers etc.) should land. */
export const PARTNERSHIPS_EMAIL = 'partnerships@boardsesh.com';

/**
 * Opens the mail composer to the partnerships inbox. Returns false (and reports
 * the error) when no mail handler is available, so the caller can surface a toast.
 */
export async function openPartnershipsEmail(): Promise<boolean> {
  const subject = encodeURIComponent('Boardsesh partnership');
  const url = `mailto:${PARTNERSHIPS_EMAIL}?subject=${subject}`;
  try {
    await Linking.openURL(url);
    return true;
  } catch (error) {
    reportError(error, { tags: { source: 'about-partnerships' } });
    return false;
  }
}
