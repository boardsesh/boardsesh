import ActivityKit
import Foundation
import os.log

// MARK: - LiveActivityManager

@available(iOS 16.1, *)
actor LiveActivityManager {

    // MARK: - Singleton

    static let shared = LiveActivityManager()

    // MARK: - Properties

    private var currentActivity: Activity<ClimbSessionAttributes>?
    private let thumbnailFetcher = ThumbnailFetcher()
    private let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityManager")

    /// Callback invoked when the ActivityKit push token is updated.
    private var onPushTokenUpdate: (@Sendable (String) -> Void)?

    /// Sets the push token update callback.
    func setOnPushTokenUpdate(_ callback: (@Sendable (String) -> Void)?) {
        onPushTokenUpdate = callback
    }

    /// Task tracking the push token observation loop.
    private var pushTokenTask: Task<Void, Never>?

    /// Timestamp of the last ActivityKit update, used for deduplication.
    private var lastUpdateTime: Date?

    /// How far in the future the stale date is set. The ping timeout timer
    /// refreshes this every 60s, so 3 minutes gives a comfortable 2× margin
    /// during normal operation. After a force-quit the activity goes stale
    /// in 3 minutes instead of lingering for 30.
    private let staleInterval: TimeInterval = 3 * 60

    // MARK: - Init

    private init() {}

    // MARK: - Availability

    /// Whether Live Activities are supported and the user has granted permission.
    nonisolated var isAvailable: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // MARK: - Start

    /// Starts a new Live Activity for a climbing session.
    ///
    /// Any existing activities (including stale ones from previous sessions)
    /// are ended before the new one is created.
    ///
    /// - Throws: If Live Activities are not available or ActivityKit rejects
    ///   the request (e.g., too many concurrent activities).
    func startActivity(
        boardName: String,
        sessionId: String,
        initialState: ClimbSessionAttributes.ContentState
    ) async throws {
        guard isAvailable else {
            logger.warning("Live Activities are not enabled; skipping start")
            return
        }

        // Clean up any existing activities first.
        await endAllActivities()

        let attributes = ClimbSessionAttributes(boardName: boardName, sessionId: sessionId)
        let content = ActivityContent(state: initialState, staleDate: Date().addingTimeInterval(staleInterval))

        do {
            currentActivity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: .token
            )
            logger.info("Started Live Activity for session \(sessionId, privacy: .public)")
            observePushTokenUpdates(for: currentActivity!)
        } catch {
            logger.error("Failed to start Live Activity: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    // MARK: - Push Token Observation

    private func observePushTokenUpdates(for activity: Activity<ClimbSessionAttributes>) {
        pushTokenTask?.cancel()
        pushTokenTask = Task { [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                guard !Task.isCancelled else { break }
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                self?.logger.info("Push token updated: \(token.prefix(8), privacy: .public)...")
                self?.onPushTokenUpdate?(token)
            }
        }
    }

    // MARK: - Update

    /// Updates the current Live Activity with new climb data.
    ///
    /// Also triggers a background thumbnail pre-fetch for adjacent queue items
    /// so the widget extension can display them without delay.
    func updateActivity(state: ClimbSessionAttributes.ContentState) async {
        guard let activity = currentActivity else {
            logger.debug("No active Live Activity to update")
            return
        }

        // The ping timeout timer refreshes the stale date every 60s while
        // the native WebSocket is healthy, and each JS updateActivity call
        // also resets it. If all update paths fail for the stale interval,
        // the activity shows "Session ended" as a signal.
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(staleInterval))
        await activity.update(content)
        lastUpdateTime = Date()
        logger.info("Updated Live Activity: \(state.climbName, privacy: .public) (\(state.currentIndex + 1)/\(state.totalClimbs))")

        // Fire-and-forget thumbnail pre-fetch for the current and adjacent items.
        // Strong capture of thumbnailFetcher is intentional: it's owned by the
        // singleton LiveActivityManager, so it outlives the task.
        Task.detached(priority: .utility) { [thumbnailFetcher] in
            guard let defaults = SharedConstants.sharedDefaults else { return }
            let (items, currentIndex) = SharedQueueState.load(from: defaults)
            await thumbnailFetcher.preFetchAdjacentThumbnails(
                queue: items,
                currentIndex: currentIndex
            )
        }
    }

    /// Returns time since the last ActivityKit update, or nil if no update has occurred.
    func timeSinceLastUpdate() -> TimeInterval? {
        guard let lastUpdateTime else { return nil }
        return Date().timeIntervalSince(lastUpdateTime)
    }

    // MARK: - Refresh Stale Date

    /// Pushes the stale deadline forward without changing the displayed content.
    /// Call this periodically (e.g. on WebSocket ping) to keep the activity alive.
    func refreshStaleDate() async {
        guard let activity = currentActivity else { return }
        let content = ActivityContent(state: activity.content.state, staleDate: Date().addingTimeInterval(staleInterval))
        await activity.update(content)
    }

    // MARK: - End

    /// Ends all Live Activities, including the tracked one and any stale
    /// activities from previous sessions that may still be visible.
    func endAllActivities() async {
        pushTokenTask?.cancel()
        pushTokenTask = nil

        // End the currently tracked activity.
        if let activity = currentActivity {
            let activityId = activity.id
            await activity.end(nil, dismissalPolicy: .immediate)
            logger.info("Ended tracked Live Activity \(activityId, privacy: .public)")
            currentActivity = nil
        }

        // Also clean up any stale activities that might linger from crashes
        // or previous sessions.
        for activity in Activity<ClimbSessionAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    // MARK: - Stale / Orphan Cleanup

    /// Ends only activities whose stale date has already passed.
    /// Safe to call at any time — active (non-stale) activities are untouched.
    func endStaleActivities() async {
        for activity in Activity<ClimbSessionAttributes>.activities {
            if activity.content.staleDate.map({ $0 < Date() }) ?? false {
                await activity.end(nil, dismissalPolicy: .immediate)
                logger.info("Ended stale activity \(activity.id, privacy: .public)")
            }
        }
    }

    /// Ends orphaned activities when no session is actively managed by this
    /// process. Safe to call on launch/foreground — does nothing if a session
    /// is currently tracked (i.e. `startActivity` was called this launch).
    func cleanupOrphanedActivities() async {
        guard currentActivity == nil else { return }
        for activity in Activity<ClimbSessionAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
            logger.info("Cleaned up orphaned activity \(activity.id, privacy: .public)")
        }
    }

    // MARK: - Content State Builder

    /// Builds a `ContentState` from the current shared queue state.
    ///
    /// Returns `nil` if the queue is empty or the index is out of bounds.
    nonisolated static func buildContentState(
        items: [SharedQueueItem],
        currentIndex: Int
    ) -> ClimbSessionAttributes.ContentState? {
        guard !items.isEmpty,
              currentIndex >= 0,
              currentIndex < items.count
        else {
            return nil
        }

        let item = items[currentIndex]

        return ClimbSessionAttributes.ContentState(
            climbName: item.climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(item.difficulty),
            angle: item.angle,
            currentIndex: currentIndex,
            totalClimbs: items.count,
            hasNext: currentIndex < items.count - 1,
            hasPrevious: currentIndex > 0,
            climbUuid: item.climbUuid
        )
    }
}
