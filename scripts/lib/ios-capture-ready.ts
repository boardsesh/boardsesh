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
/** Termination must finish before taking the next process's evidence boundary. */
export function launchIosCaptureReady<Baseline>({
  snapshot,
  launch,
  terminate,
  waitReady,
  beforeRetry,
  giveUp = () => false,
}: {
  snapshot: () => Baseline;
  launch: () => boolean;
  terminate: () => boolean;
  waitReady: (baseline: Baseline) => boolean;
  beforeRetry: (attempt: number) => void;
  giveUp?: () => boolean;
}): boolean {
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      if (giveUp()) return false;
      beforeRetry(attempt);
      if (!terminate()) return false;
    }
    const baseline = snapshot();
    if (!launch()) return false;
    if (waitReady(baseline)) return true;
  }
  return false;
}
