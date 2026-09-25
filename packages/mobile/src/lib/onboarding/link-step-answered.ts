import { getPreference, setPreference } from '../preference-store';

// App-sandbox storage keeps this answer's lifetime aligned with first-run state.
const STORAGE_KEY = 'onboardingLinkStepAnswered';

export async function hasAnsweredLinkStep(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return true;
  try {
    return (await getPreference<boolean>(STORAGE_KEY)) === true;
  } catch {
    return true;
  }
}

// Record a link or decline, never merely showing the question.
export async function markLinkStepAnswered(): Promise<void> {
  await setPreference(STORAGE_KEY, true);
}
