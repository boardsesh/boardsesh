import Foundation

// MARK: - App Group & Shared Defaults

enum SharedConstants {
    static let appGroupId = "group.com.boardsesh.app"

    // MARK: UserDefaults Keys

    static let queueItemsKey = "bs_queue_items"
    static let currentIndexKey = "bs_current_index"
    static let sessionIdKey = "bs_session_id"
    static let serverUrlKey = "bs_server_url"
    static let boardNameKey = "bs_board_name"
    static let layoutIdKey = "bs_layout_id"
    static let sizeIdKey = "bs_size_id"
    static let setIdsKey = "bs_set_ids"
    static let pendingActionKey = "bs_pending_action"
    static let authTokenKey = "bs_auth_token"

    // MARK: Darwin Notification

    static let queueNavigateNotification = "com.boardsesh.app.queueNavigate"

    // MARK: Live Activity

    /// Minimum seconds between consecutive ActivityKit pushes.
    /// Redundant JS-side updates that arrive within this window are skipped
    /// because the native WebSocket callback already applied the state.
    static let liveActivityDedupWindow: TimeInterval = 0.5

    // MARK: Helpers

    static var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: appGroupId)
    }

    static var sharedContainerUrl: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    }
}

// MARK: - Shared Queue Item

struct SharedQueueItem: Codable, Hashable {
    let uuid: String
    let climbUuid: String
    let climbName: String
    let difficulty: String
    let angle: Int
    let frames: String
    let setterUsername: String
}

// MARK: - Shared Queue State

enum SharedQueueState {
    static func load(from defaults: UserDefaults) -> (items: [SharedQueueItem], currentIndex: Int) {
        let currentIndex = defaults.integer(forKey: SharedConstants.currentIndexKey)

        guard let data = defaults.data(forKey: SharedConstants.queueItemsKey),
              let items = try? JSONDecoder().decode([SharedQueueItem].self, from: data)
        else {
            return (items: [], currentIndex: 0)
        }

        return (items: items, currentIndex: currentIndex)
    }

    static func save(items: [SharedQueueItem], currentIndex: Int, to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(items) {
            defaults.set(data, forKey: SharedConstants.queueItemsKey)
        }
        saveCurrentIndex(currentIndex, to: defaults)
    }

    /// Write only the current index without re-encoding the items array.
    /// Use this for climb navigation where only the index changes.
    static func saveCurrentIndex(_ currentIndex: Int, to defaults: UserDefaults) {
        defaults.set(currentIndex, forKey: SharedConstants.currentIndexKey)
    }

    static func currentItem(from defaults: UserDefaults) -> SharedQueueItem? {
        let (items, currentIndex) = load(from: defaults)
        guard currentIndex >= 0, currentIndex < items.count else { return nil }
        return items[currentIndex]
    }

    static func boardRenderUrl(for item: SharedQueueItem, from defaults: UserDefaults) -> URL? {
        guard let serverUrl = defaults.string(forKey: SharedConstants.serverUrlKey),
              let boardName = defaults.string(forKey: SharedConstants.boardNameKey),
              let setIds = defaults.string(forKey: SharedConstants.setIdsKey)
        else {
            return nil
        }

        let layoutId = defaults.integer(forKey: SharedConstants.layoutIdKey)
        let sizeId = defaults.integer(forKey: SharedConstants.sizeIdKey)

        var components = URLComponents(string: "\(serverUrl)/api/internal/board-render")
        components?.queryItems = [
            URLQueryItem(name: "board_name", value: boardName),
            URLQueryItem(name: "layout_id", value: String(layoutId)),
            URLQueryItem(name: "size_id", value: String(sizeId)),
            URLQueryItem(name: "set_ids", value: setIds),
            URLQueryItem(name: "frames", value: item.frames),
            URLQueryItem(name: "thumbnail", value: "1"),
            URLQueryItem(name: "include_background", value: "1"),
        ]

        return components?.url
    }
}

// MARK: - V-Grade Formatting

enum VGradeFormatter {
    /// V-grades that map from more than one Font grade.
    /// When the Font grade has "+", these V-grades get a "+" suffix for disambiguation.
    /// Derived from BOULDER_GRADES in packages/web/app/lib/board-data.ts:
    ///   V0 (4a,4b,4c), V1 (5a,5b), V3 (6a,6a+), V4 (6b,6b+), V5 (6c,6c+), V8 (7b,7b+)
    private static let vGradesWithMultipleFontGrades: Set<String> = [
        "V0", "V1", "V3", "V4", "V5", "V8"
    ]

    private static let vGradeRegex = try! NSRegularExpression(pattern: "V\\d+", options: .caseInsensitive)

    /// Format a raw difficulty string to a V-grade display label.
    ///
    /// Examples:
    /// - "6c+/V5" -> "V5+"  (V5 has multiple font grades, font part has "+")
    /// - "7a+/V7" -> "V7"   (V7 has only one font grade)
    /// - "6c/V5"  -> "V5"   (font part has no "+")
    /// - "V3"     -> "V3"   (bare V-grade)
    /// - ""       -> ""     (empty input)
    static func formatVGrade(_ difficulty: String) -> String {
        guard !difficulty.isEmpty else { return "" }

        let nsRange = NSRange(difficulty.startIndex..<difficulty.endIndex, in: difficulty)
        guard let match = vGradeRegex.firstMatch(in: difficulty, range: nsRange),
              let range = Range(match.range, in: difficulty)
        else {
            return difficulty
        }
        let vGrade = String(difficulty[range]).uppercased()

        if let slashIndex = difficulty.firstIndex(of: "/"), slashIndex > difficulty.startIndex {
            let fontPart = String(difficulty[difficulty.startIndex..<slashIndex])
            if fontPart.hasSuffix("+") && vGradesWithMultipleFontGrades.contains(vGrade) {
                return "\(vGrade)+"
            }
        }

        return vGrade
    }
}
