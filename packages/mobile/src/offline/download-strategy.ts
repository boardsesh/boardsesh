// Which fixed expo-file-system transport a board-artifact download rides
// (issues #4394 / #4390).
//
// Pure and dependency-free on purpose: `Platform.OS` is passed in, so both
// native arms are pinned by a plain unit test with no React Native graph.
//
// The two arms:
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

export type SnapshotDownloadStrategy = 'task-foreground' | 'task-background';

export function resolveSnapshotDownloadStrategy(platform: string): SnapshotDownloadStrategy {
  // Android's native side ignores `sessionType` entirely, so reporting
  // 'task-background' there would be a lie in the telemetry.
  return platform === 'ios' ? 'task-background' : 'task-foreground';
}
