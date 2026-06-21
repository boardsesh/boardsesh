import Foundation
import UIKit

/// Shared bridge invoked from `LiveActivityIntent.perform()` when it runs in
/// the main app process. Only compiled into the `App` target — the widget
/// extension cannot link `BoardBleManager` or call `UIApplication`, and the
/// intent files gate the call site behind `#if !WIDGET_EXTENSION`.
@available(iOS 17.0, *)
enum LiveActivityBleBridge {
    /// Awaits BLE readiness and issues a board display write inside a
    /// `beginBackgroundTask` window. Pinned to `@MainActor` so `defer { task.end() }`
    /// can call into the `@MainActor`-isolated background-task wrapper
    /// synchronously on any exit path — including a future where
    /// `displayCurrentItemAwaitingReady` becomes cancellation-aware and
    /// throws `CancellationError`. The `await` on the BLE work hops off
    /// main actor for the duration, so main actor is only briefly held at
    /// function entry/exit.
    @MainActor
    static func writeBoardForIntent(items: [SharedQueueItem], currentIndex: Int) async {
        let task = BleIntentBackgroundTask()
        task.begin(name: "ble-display-intent")
        defer { task.end() }
        await BoardBleManager.shared.displayCurrentItemAwaitingReady(
            items: items,
            currentIndex: currentIndex,
            readyTimeout: 3.0
        )
    }

    /// Reconnect to the last known board for the Live Activity lightbulb's
    /// ReconnectBoardIntent, inside a `beginBackgroundTask` window so the connect
    /// can finish even if the tap arrives while the app is suspended. Returns
    /// whether the board reconnected; on success BoardBleManager re-lights the
    /// wall from the shared queue state.
    @MainActor
    static func reconnectForIntent() async -> Bool {
        let task = BleIntentBackgroundTask()
        task.begin(name: "ble-reconnect-intent")
        defer { task.end() }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            BoardBleManager.shared.reconnectToLastKnownBoard { result in
                switch result {
                case .success:
                    continuation.resume(returning: true)
                case .failure:
                    continuation.resume(returning: false)
                }
            }
        }
    }
}

/// Owns a single `UIBackgroundTaskIdentifier`.
///
/// **Designed for short-lived stack use** — pair `begin(name:)` with an
/// explicit `end()`, typically via `defer { task.end() }` (as
/// `LiveActivityBleBridge.writeBoardForIntent` does). The class deliberately
/// has **no `deinit`-based cleanup**: `deinit` can't run `@MainActor` methods
/// in Swift 5, so a property-stored instance whose owner is released without
/// calling `end()` will leak the task identifier (the expiration handler
/// eventually fires and ends it, but iOS may have already begun reclaiming
/// budget). The type is non-`private` purely so `BleIntentBackgroundTaskTests`
/// can verify the idempotency contract — production callers should treat it
/// as an implementation detail of `LiveActivityBleBridge`.
///
/// `@MainActor`-isolated so `UIApplication.shared` (also `@MainActor`-isolated
/// under Swift 6 strict concurrency) can be accessed without locks. The
/// expiration-handler closure passed to `beginBackgroundTask` is documented
/// to run on the main thread, which we assert via `MainActor.assumeIsolated`
/// — without that hop the strict-concurrency compile fails because the
/// closure itself isn't actor-isolated.
@MainActor
final class BleIntentBackgroundTask {
    private var taskId: UIBackgroundTaskIdentifier = .invalid

    func begin(name: String) {
        guard taskId == .invalid else { return }
        taskId = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated {
                self?.end()
            }
        }
    }

    /// Idempotent — safe to call from the expiration handler and from the
    /// `defer { task.end() }` site. Whichever runs second observes
    /// `taskId == .invalid` and no-ops.
    func end() {
        guard taskId != .invalid else { return }
        let id = taskId
        taskId = .invalid
        UIApplication.shared.endBackgroundTask(id)
    }
}
