// Which expo-file-system transport a board-artifact download rides (issue
// #4394, issue #4390).
//
// Pure and dependency-free on purpose: `Platform.OS` is passed in, so the whole
// matrix — including the corner where one flag is set and the other is not — is
// pinned by a plain unit test with no React Native in the module graph.
//
// The three arms:
//   download-file-async  today's shipped `File.downloadFileAsync`. iOS: a
//                        foreground `URLSession` (`.default`, delegateQueue nil
//                        on the legacy path). Android: a shared OkHttpClient.
//   task-foreground      `File.createDownloadTask(..., sessionType: 'foreground')`.
//                        On Android this is a genuinely different client (the
//                        task builds its own OkHttpClient with 60 s timeouts),
//                        not a relabel; on iOS it is a default-config session
//                        with `delegateQueue: .main`, which doubles as a
//                        main-thread-contention probe.
//   task-background      iOS only: `URLSessionConfiguration.background`
//                        (isDiscretionary false, sessionSendsLaunchEvents true),
//                        so the transfer keeps running while the process is
//                        suspended. The transport half of #4390 on iOS.

export type SnapshotDownloadStrategy = 'download-file-async' | 'task-foreground' | 'task-background';

export function resolveSnapshotDownloadStrategy(input: {
  taskApiFlag: boolean | undefined;
  backgroundSessionFlag: boolean | undefined;
  /** `Platform.OS`. */
  platform: string;
}): SnapshotDownloadStrategy {
  // UNRESOLVED reads as the SHIPPED path, on both platforms. Production OTAs
  // auto-publish on every push to main, and a PostHog key that does not exist
  // yet reads `undefined` on every device — so an "undefined → task-background"
  // default would flip the whole iOS fleet the hour this merges, before any of
  // the on-device QA that is the only way to prove the path.
  //
  // The downside is not symmetric. A background URLSession runs out of
  // nsurlsessiond, a different process from the in-process default-config
  // sessions the gzip cutover was validated against; if it does not transparently
  // gunzip, snapshot-source raises SnapshotPermanentMissError, which at the
  // download stage burns the structural budget AND marks the paged fallback — a
  // durable settle that flipping the flag back does not undo.
  //
  // So: roll out by SETTING the flag, never by merging.
  if (input.taskApiFlag !== true) return 'download-file-async';
  // Android's native side ignores `sessionType` entirely, so reporting
  // 'task-background' there would be a lie in the telemetry.
  if (input.platform !== 'ios') return 'task-foreground';
  return input.backgroundSessionFlag === false ? 'task-foreground' : 'task-background';
}
