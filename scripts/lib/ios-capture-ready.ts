/** Keep retries bounded and require new application evidence after every relaunch. */
export function waitForIosCaptureReady({
  waitReady,
  relaunch,
  beforeRetry,
}: {
  waitReady: () => boolean;
  relaunch: (attempt: number) => void;
  beforeRetry: (attempt: number) => void;
}): boolean {
  if (waitReady()) return true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    beforeRetry(attempt);
    relaunch(attempt);
    if (waitReady()) return true;
  }
  return false;
}
