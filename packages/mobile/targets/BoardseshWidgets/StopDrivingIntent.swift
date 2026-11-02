import ActivityKit
import AppIntents
import Foundation
import os.log

/// Live Activity bulb while this phone drives the wall (2.7): stop driving,
/// as the frosted "You are driving the wall" button does in the app. The wall
/// keeps its climb and the link stays; the next pick is a preview again. With
/// Disconnect Bluetooth when driving ends on, the app then frees the board
/// without forgetting it, as for any stop.
///
/// It needs no Bluetooth, so it runs the same in the app process and in the
/// widget extension: it stores the stop in the App Group
/// (`SharedLightingWindowRuntime.recordStop`), redraws the card, and posts a
/// Darwin notification so a live app's JS stops its drive now. JS adopts the
/// stored stop when it next runs either way (`lock-screen-lighting.ts`).
///
/// This file is duplicated byte-for-byte into `targets/BoardseshWidgets/` —
/// each Xcode target compiles its own binary, so keep the two copies identical.
@available(iOS 17.0, *)
struct StopDrivingIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop Driving"
    static let description = IntentDescription("Stop driving the wall: your next pick is a preview")

    private static let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityIntent")

    /// How long the intent waits for the app's JS to adopt the stop (its own
    /// "off" over the stored stop) before it returns, keeping a just-woken app
    /// running while it does. That is all the wait covers: JS writes the "off"
    /// as it stops the drive, a moment before its driving-ends effect frees
    /// the board (Disconnect Bluetooth when driving ends). The release usually
    /// runs in the same wake; if iOS suspends the app first, it runs when the
    /// app next resumes. The card is right meanwhile either way: it reads the
    /// stop from the App Group, and JS pushes the disconnect when it lands.
    static let appSettleTimeout: TimeInterval = 2.0
    private static let appSettlePollInterval: UInt64 = 100_000_000

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        let diagnosticRun = LiveActivityIntentDiagnostics.begin(kind: .stopDriving)
        var completionClass = LiveActivityIntentCompletionClass.success
        defer { diagnosticRun.complete(completionClass) }
        #endif

        Self.logger.notice("StopDrivingIntent.perform() running process=\(ProcessInfo.processInfo.processName, privacy: .public)")

        guard let defaults = SharedConstants.sharedDefaults else {
            #if !WIDGET_EXTENSION
            completionClass = .sharedDefaultsUnavailable
            #endif
            return .result()
        }

        guard let stop = SharedLightingWindowRuntime.recordStop(in: defaults) else {
            // Nothing was driving any more (a timed drive ran out between the
            // card's render and the tap): redraw so the card shows that.
            await Self.redraw()
            #if !WIDGET_EXTENSION
            diagnosticRun.mark(.activityKitUpdated)
            completionClass = .nothingDriving
            #endif
            return .result()
        }

        await Self.redraw()
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.activityKitUpdated)
        #endif
        Self.postDriveStopDarwinNotification()
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.darwinPosted)
        #endif
        await Self.waitForApp(toSettle: stop, in: defaults)
        return .result()
    }

    /// The app process redraws from the committed queue and cancels the redraw
    /// it had armed for a timed drive's end; the widget extension has no
    /// LiveActivityManager and bumps the running card's revision directly.
    private static func redraw() async {
        #if !WIDGET_EXTENSION
        await LiveActivityManager.shared.rerenderForLightingWindow()
        #else
        await redrawActivities()
        #endif
    }

    /// Whether JS has written over the lock-screen stop (it adopted the stop
    /// and wrote its own "off"), so the stop no longer waits on it.
    static func appSettled(_ stop: SharedLightingWindowState, current: SharedLightingWindowState?) -> Bool {
        guard let current else { return true }
        return current.source != SharedLightingWindowState.sourceLockScreen || current.updatedAtMs != stop.updatedAtMs
    }

    private static func waitForApp(toSettle stop: SharedLightingWindowState, in defaults: UserDefaults) async {
        let deadline = Date().addingTimeInterval(appSettleTimeout)
        while Date() < deadline {
            if appSettled(stop, current: SharedLightingWindowStore.load(from: defaults)) { return }
            try? await Task.sleep(nanoseconds: appSettlePollInterval)
        }
    }

    /// Widget-extension path: no LiveActivityManager here, so bump
    /// `lightingRevision` on the running card directly so ActivityKit redraws
    /// it from the App Group.
    private static func redrawActivities() async {
        let sessionId = SharedConstants.sharedDefaults?.string(forKey: SharedConstants.sessionIdKey)
        for activity in Activity<ClimbSessionAttributes>.activities {
            guard activity.activityState == .active, activity.attributes.sessionId == sessionId else { continue }
            var state = activity.content.state
            state.lightingRevision = (state.lightingRevision ?? 0) &+ 1
            let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(SharedConstants.liveActivityStaleInterval))
            await activity.update(content)
        }
    }

    private static func postDriveStopDarwinNotification() {
        let name = SharedConstants.driveStopNotification as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil, nil, true
        )
    }
}
