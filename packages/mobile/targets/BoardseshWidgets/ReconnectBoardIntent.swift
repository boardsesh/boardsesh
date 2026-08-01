import ActivityKit
import AppIntents
import os.log

/// Live Activity lightbulb intent: reconnect Bluetooth to the last known board
/// and, in a party session, claim wall control (become the driver). Like the
/// navigation intents, iOS routes `perform()` to the main app process where
/// BoardBleManager lives; the BLE call is gated behind `#if !WIDGET_EXTENSION`
/// so the widget-extension copy still compiles without linking it.
///
/// This file is duplicated byte-for-byte into `targets/BoardseshWidgets/` —
/// each Xcode target compiles its own binary, so keep the two copies identical.
@available(iOS 17.0, *)
struct ReconnectBoardIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Reconnect Board"
    static var description = IntentDescription("Reconnect Bluetooth to your last board")

    private static let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityIntent")

    #if !WIDGET_EXTENSION || BOARDSESH_TESTS
    /// A later take-control failure must not hide an earlier BLE reconnect
    /// failure: the first failed prerequisite is the most useful diagnostic.
    static func diagnosticCompletionClass(
        current: LiveActivityIntentCompletionClass,
        networkResult: WidgetNavigationResult
    ) -> LiveActivityIntentCompletionClass {
        guard current == .success else { return current }
        switch networkResult {
        case .success:
            return .success
        case .serverRejected:
            return .serverRejected
        case .retryableFailure:
            return .retryableNetworkFailure
        }
    }
    #endif

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        let diagnosticRun = LiveActivityIntentDiagnostics.begin(kind: .reconnectBoard)
        var completionClass = LiveActivityIntentCompletionClass.success
        defer { diagnosticRun.complete(completionClass) }
        #endif

        Self.logger.notice("ReconnectBoardIntent.perform() running process=\(ProcessInfo.processInfo.processName, privacy: .public)")

        // Reconnect BLE to the last board. In the main app process (the path iOS
        // takes for a registered LiveActivityIntent) this calls BoardBleManager
        // directly. If iOS instead runs the intent in the widget extension — which
        // can't link BoardBleManager — fall back to a Darwin notification so the
        // live main app does the reconnect, mirroring ClimbNavigationIntent.
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.bleStarted)
        let reconnected = await LiveActivityBleBridge.reconnectForIntent()
        diagnosticRun.mark(reconnected ? .bleFinishedSuccess : .bleFinishedFailure)
        if !reconnected {
            completionClass = .bleFailure
        }
        #else
        postBleReconnectDarwinNotification()
        #endif

        // In a party session the climber who grabs the board also claims wall
        // control. Mirrors TakeControlIntent's server-authorized path; a no-op for
        // local sessions and when this device is already the driver.
        if let defaults = SharedConstants.sharedDefaults {
            let wallControl = SharedWidgetWallControlState.load(from: defaults)
            if wallControl.requiresServerAuthorization, !wallControl.navigationAllowed {
                #if !WIDGET_EXTENSION
                diagnosticRun.mark(.networkStarted)
                #endif
                let result = await WidgetNetworking.sendTakeControl()
                #if !WIDGET_EXTENSION
                switch result {
                case .success:
                    diagnosticRun.mark(.networkFinishedSuccess)
                case .serverRejected:
                    diagnosticRun.mark(.networkFinishedTerminal)
                case .retryableFailure:
                    diagnosticRun.mark(.networkFinishedRetryable)
                }
                completionClass = Self.diagnosticCompletionClass(current: completionClass, networkResult: result)
                #endif
                if result == .success {
                    SharedWidgetWallControlState.save(navigationAllowed: true, isPartySession: true, to: defaults)
                }
            }
        }

        await refreshActivities()
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.activityKitUpdated)
        #endif
        return .result()
    }

    private func refreshActivities() async {
        for activity in Activity<ClimbSessionAttributes>.activities {
            guard activity.activityState == .active else { continue }
            let content = ActivityContent(state: activity.content.state, staleDate: Date().addingTimeInterval(SharedConstants.liveActivityStaleInterval))
            await activity.update(content)
        }
    }

    /// Widget-extension fallback path: wake the live main app (where
    /// BoardBleManager lives) to reconnect. LiveActivityModule observes this and
    /// calls reconnectToLastKnownBoard. No-op if no main-app observer is alive.
    private func postBleReconnectDarwinNotification() {
        let name = SharedConstants.bleReconnectNotification as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil, nil, true
        )
    }
}
