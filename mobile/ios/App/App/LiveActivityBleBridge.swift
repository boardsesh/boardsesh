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
}

/// Owns a single `UIBackgroundTaskIdentifier`.
///
/// **Designed for short-lived stack use** — pair `begin(name:)` with an
/// explicit `end()`, typically via `defer { task.end() }` (as
/// `LiveActivityBleBridge.writeBoardForIntent` does). The class deliberately
/// has **no production `deinit`-based cleanup**: `deinit` can't run
/// `@MainActor` methods in Swift 5/6 (the deinit is implicitly nonisolated),
/// so a property-stored instance whose owner is released without calling
/// `end()` will leak the task identifier (the expiration handler eventually
/// fires and ends it, but iOS may have already begun reclaiming budget).
/// A `#if DEBUG` deinit asserts `taskId == .invalid` as a development-time
/// safety net to surface the leak at the point of release. The type is
/// non-`private` purely so `BleIntentBackgroundTaskTests` can verify the
/// idempotency contract — production callers should treat it as an
/// implementation detail of `LiveActivityBleBridge`.
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

    #if DEBUG
        // Only observes the `Sendable` sentinel — never calls a `@MainActor`
        // method, which an implicitly-nonisolated deinit cannot reach.
        deinit {
            assert(
                taskId == .invalid,
                "BleIntentBackgroundTask deallocated without end() — caller stored it as a property and leaked the UIBackgroundTaskIdentifier. Use defer { task.end() } or call end() explicitly."
            )
        }
    #endif
}
