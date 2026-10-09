import { setOptOut } from 'posthog-react-native-session-replay';

let ready = false;
let revision = 0;
let latest: Promise<void> = Promise.resolve();
export function isNativeReplayPrivacyReady(): boolean {
  return ready;
}

/** Missing capability or failed purge keeps replay off while functional flags remain available. */
export async function applyNativeReplayPrivacy(granted: boolean, projectToken: string): Promise<void> {
  const requestRevision = ++revision;
  if (!granted) ready = false;
  const request = (async () => {
    try {
      await setOptOut(!granted, projectToken);
      if (requestRevision === revision) ready = granted;
    } catch {
      if (requestRevision === revision) ready = false;
    }
  })();
  latest = request;
  await request;
  // An initialization awaiting a superseded grant waits for the final policy too.
  let completedRevision = requestRevision;
  while (completedRevision !== revision) {
    completedRevision = revision;
    await latest;
  }
}
