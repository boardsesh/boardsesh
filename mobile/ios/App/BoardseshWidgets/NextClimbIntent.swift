import ActivityKit
import AppIntents

@available(iOS 17.0, *)
struct NextClimbIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Next Climb"
    static var description = IntentDescription("Navigate to the next climb in the queue")

    func perform() async throws -> some IntentResult {
        guard let defaults = SharedConstants.sharedDefaults else {
            return .result()
        }

        let (items, currentIndex) = SharedQueueState.load(from: defaults)

        let nextIndex = currentIndex + 1
        guard nextIndex < items.count else {
            return .result()
        }

        // Persist the new index so the main app picks it up.
        SharedQueueState.saveCurrentIndex(nextIndex, to: defaults)

        // Optimistically update every active Live Activity.
        let nextItem = items[nextIndex]
        let newState = ClimbSessionAttributes.ContentState(
            climbName: nextItem.climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(nextItem.difficulty),
            angle: nextItem.angle,
            currentIndex: nextIndex,
            totalClimbs: items.count,
            hasNext: nextIndex < items.count - 1,
            hasPrevious: nextIndex > 0,
            climbUuid: nextItem.climbUuid
        )

        for activity in Activity<ClimbSessionAttributes>.activities {
            // ActivityKit's update() is non-throwing, but only update active
            // activities — calling update on ended/dismissed activities is a no-op
            // but logs warnings in the system.
            guard activity.activityState == .active else { continue }
            let content = ActivityContent(state: newState, staleDate: Date().addingTimeInterval(180))
            await activity.update(content)
        }

        // Send navigation to the backend directly via HTTP. This works even
        // when the main app is suspended. Only fall back to the Darwin
        // notification path (which wakes the main app to send a WS mutation)
        // if the HTTP request fails.
        let httpSuccess = await WidgetNetworking.sendNavigation(action: "next", currentIndex: nextIndex)
        if !httpSuccess {
            defaults.set("next", forKey: SharedConstants.pendingActionKey)
            postDarwinNotification()
        }

        return .result()
    }

    private func postDarwinNotification() {
        let name = SharedConstants.queueNavigateNotification as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil, nil, true
        )
    }
}
