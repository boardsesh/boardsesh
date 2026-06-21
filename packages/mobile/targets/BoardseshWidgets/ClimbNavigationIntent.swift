import ActivityKit
import AppIntents
import os.log

@available(iOS 17.0, *)
enum ClimbNavigationDirection: String {
    case next
    case previous

    /// Returns the new queue index, or nil if navigation is out of bounds.
    func newIndex(from currentIndex: Int, count: Int) -> Int? {
        switch self {
        case .next:
            let candidate = currentIndex + 1
            return candidate < count ? candidate : nil
        case .previous:
            let candidate = currentIndex - 1
            return (candidate >= 0 && candidate < count) ? candidate : nil
        }
    }
}

/// Shared body for `NextClimbIntent.perform()` and
/// `PreviousClimbIntent.perform()`. Compiled into both the `App` and
/// `BoardseshWidgets` targets so the same code runs whether iOS routes the
/// intent to the main app process (the desired path) or to the widget
/// extension as a fallback.
@available(iOS 17.0, *)
enum ClimbNavigationIntent {
    private static let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityIntent")

    /// CorrelationId the backend's `/api/widget/navigate` handler uses when it
    /// broadcasts `CurrentClimbChanged` after a successful HTTP widget call.
    /// Kept in sync with `widget-navigate.ts`'s `'widget-navigate'` literal —
    /// changing one without the other breaks the JS reducer's own-echo
    /// suppression and causes the BLE-paired phone to re-fire the BLE write.
    static let httpSuccessCorrelationId = "widget-navigate"

    static func perform(direction: ClimbNavigationDirection, label: String) async {
        // One notice per intent firing — production TestFlight builds need
        // this signal to diagnose "widget UI moved but wall didn't" reports.
        // Volume is bounded by user taps so the log isn't noisy.
        logger.notice("\(label).perform() running bundle=\(Bundle.main.bundleIdentifier ?? "unknown", privacy: .public) process=\(ProcessInfo.processInfo.processName, privacy: .public) direction=\(direction.rawValue, privacy: .public)")

        guard let defaults = SharedConstants.sharedDefaults else { return }
        // No navigationAllowed gate: the widget only shows Prev/Next when this
        // device holds the board (connectedByMe — see SessionFooter), so reaching
        // here means we may drive. Gating visibility rather than the intent fixes
        // Prev/Next no-op'ing when the persisted navigationAllowed flag drifted
        // from the shown state. `wallControl` is still read below to decide whether
        // the party-session server POST runs.
        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        let (items, currentIndex) = SharedQueueState.load(from: defaults)
        guard let newIndex = direction.newIndex(from: currentIndex, count: items.count) else {
            return
        }

        let navigationResult: WidgetNavigationResult
        if wallControl.requiresServerAuthorization {
            navigationResult = await WidgetNetworking.sendNavigation(action: direction.rawValue, currentIndex: newIndex)
        } else {
            navigationResult = .success
        }

        guard navigationResult != .serverRejected else {
            logger.notice("\(label).perform() rejected by server; skipping local widget, BLE, and JS fallback updates")
            return
        }

        SharedQueueState.saveCurrentIndex(newIndex, to: defaults)

        let newItem = items[newIndex]
        let newState = ClimbSessionAttributes.ContentState(
            climbName: newItem.climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(newItem.difficulty),
            angle: newItem.angle,
            currentIndex: newIndex,
            totalClimbs: items.count,
            hasNext: newIndex < items.count - 1,
            hasPrevious: newIndex > 0,
            climbUuid: newItem.climbUuid,
            // Prev/Next are only shown when this device drives the wall, so the
            // optimistic frame keeps the bulb lit + controls shown.
            boardConnection: "connectedByMe",
            holderDisplayName: nil
        )

        for activity in Activity<ClimbSessionAttributes>.activities {
            guard activity.activityState == .active else { continue }
            let content = ActivityContent(state: newState, staleDate: Date().addingTimeInterval(180))
            await activity.update(content)
        }

        // Direct BLE writes happen only after the server accepts party-session
        // navigation, or for local-only sessions. Retryable HTTP failures use
        // the Darwin/WebSocket fallback, whose mutation path owns repainting.
        #if !WIDGET_EXTENSION
        let bleWriteTask: Task<Void, Never>?
        if navigationResult == .success {
            bleWriteTask = Task {
                await LiveActivityBleBridge.writeBoardForIntent(items: items, currentIndex: newIndex)
            }
        } else {
            bleWriteTask = nil
        }
        #endif

        // Always tell the JS side that navigation happened so its reducer can
        // run the optimistic `dispatchWidgetNavigation` path on board routes.
        // On HTTP success we use the static correlationId the backend will
        // echo back; on failure we set pendingActionKey so the Darwin handler
        // (in the main app) sends a WebSocket mutation fallback with a fresh
        // UUID before notifying JS.
        defaults.set(direction.rawValue, forKey: SharedConstants.widgetNavigateActionKey)
        if navigationResult == .success && wallControl.requiresServerAuthorization {
            defaults.set(httpSuccessCorrelationId, forKey: SharedConstants.widgetNavigateCorrelationIdKey)
            defaults.removeObject(forKey: SharedConstants.pendingActionKey)
        } else if navigationResult == .retryableFailure {
            // Mutation-fallback path: handler generates its own UUID, writes
            // it back to widgetNavigateCorrelationIdKey, then notifies JS.
            defaults.set(direction.rawValue, forKey: SharedConstants.pendingActionKey)
            defaults.removeObject(forKey: SharedConstants.widgetNavigateCorrelationIdKey)
        } else {
            defaults.set(UUID().uuidString, forKey: SharedConstants.widgetNavigateCorrelationIdKey)
            defaults.removeObject(forKey: SharedConstants.pendingActionKey)
        }

        // Wait for the native BLE write to drain before waking JS via the
        // Darwin notification. Without this, the JS-side BluetoothAutoSender
        // can dispatch its own write for the same climb while BoardBleManager
        // is still chunking out the intent's packet — at best it interleaves
        // wastefully on the UART, at worst it stalls a marginal connection.
        // Serializing here means BoardBleManager's queue has fully drained
        // by the time AutoSender's write enqueues, so the same-content
        // re-send is a fast no-op against the wall's last-frame buffer.
        #if !WIDGET_EXTENSION
        if let bleWriteTask {
            await bleWriteTask.value
        }
        #endif

        postQueueNavigateDarwinNotification()
    }

    private static func postQueueNavigateDarwinNotification() {
        let name = SharedConstants.queueNavigateNotification as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil, nil, true
        )
    }
}
