/** Explicit board-hero intent, shared across the Climbs route and its player. */
export type ScreenshotDriveRequest = {
  sequence: number;
  boardUuid: string;
  climbUuid: string;
};

let request: ScreenshotDriveRequest | null = null;
let sequence = 0;
let attemptedSequence: number | null = null;
const listeners = new Set<() => void>();

export function requestScreenshotDrive(boardUuid: string, climbUuid: string): void {
  if (
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' ||
    process.env.EXPO_PUBLIC_SCREENSHOT_DRIVING !== '1' ||
    process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE !== '1'
  )
    return;
  request = { sequence: ++sequence, boardUuid, climbUuid };
  for (const listener of listeners) listener();
}

/** A route and a retained pane share one attempt, even across native remounts. */
export function claimScreenshotDriveAttempt(requestSequence: number): boolean {
  if (request?.sequence !== requestSequence || attemptedSequence === requestSequence) return false;
  attemptedSequence = requestSequence;
  return true;
}

export function clearScreenshotDriveRequest(): void {
  if (!request) return;
  request = null;
  for (const listener of listeners) listener();
}

export function getScreenshotDriveRequest(): ScreenshotDriveRequest | null {
  return request;
}

export function subscribeScreenshotDriveRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
