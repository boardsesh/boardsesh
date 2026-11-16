import { metroLogOffset, readMetroLogSince } from './metro-dev-server';
import { sleepSeconds } from './exec';

export interface CaptureLogBoundary {
  path: string;
  offset: number;
  /** Compact native logs use simulator/host local time, without a timezone suffix. */
  nativeSince?: string;
}

/** Take this after termination and before launch/navigation, never before termination. */
export function snapshotCaptureLogs(paths: readonly string[], nativePath?: string): CaptureLogBoundary[] {
  const now = new Date();
  const pad = (number: number, digits = 2) => String(number).padStart(digits, '0');
  const nativeSince = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  return paths.map((path) => ({ path, offset: metroLogOffset(path), ...(path === nativePath ? { nativeSince } : {}) }));
}

export function readCaptureLogs(boundaries: readonly CaptureLogBoundary[]): string {
  return boundaries
    .map(({ path, offset, nativeSince }) => {
      const text = readMetroLogSince(offset, path);
      if (!nativeSince) return text;
      // Offset alone is insufficient: log stream may deliver an old process's
      // buffered event after termination. Require its original event time too.
      return text
        .split('\n')
        .filter((line) => {
          const timestamp = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) /.exec(line)?.[1];
          return timestamp !== undefined && timestamp >= nativeSince;
        })
        .join('\n');
    })
    .join('\n');
}

/** Native JS logs remain authoritative when Metro drops console forwarding. */
export function waitForCaptureLogLine(
  matches: (line: string) => boolean,
  boundaries: readonly CaptureLogBoundary[],
  timeoutSeconds: number,
): string | null {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const found = readCaptureLogs(boundaries).split('\n').find(matches);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return null;
    sleepSeconds(0.25);
  }
}
