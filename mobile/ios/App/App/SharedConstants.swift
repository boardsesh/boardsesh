import Foundation

// MARK: - App Group & Shared Defaults

enum SharedConstants {
    static let appGroupId = "group.com.boardsesh.app"

    // MARK: UserDefaults Keys

    static let queueItemsKey = "bs_queue_items"
    static let currentIndexKey = "bs_current_index"
    static let sessionIdKey = "bs_session_id"
    /// Web origin (e.g. https://www.boardsesh.com). Used by the widget for
    /// Next.js-hosted routes like `/api/internal/board-render`.
    static let serverUrlKey = "bs_server_url"
    /// Fully-qualified backend `/api/widget/navigate` URL (e.g.
    /// https://ws.boardsesh.com/api/widget/navigate). The widget POSTs button
    /// taps here. Distinct from `serverUrlKey` because the backend lives on a
    /// different host than the web app.
    static let widgetNavigateUrlKey = "bs_widget_navigate_url"
    /// Fully-qualified backend `/api/widget/take-control` URL. The widget
    /// POSTs non-driver lightbulb taps here before enabling local navigation.
    static let widgetTakeControlUrlKey = "bs_widget_take_control_url"
    static let boardNameKey = "bs_board_name"
    static let layoutIdKey = "bs_layout_id"
    static let sizeIdKey = "bs_size_id"
    static let setIdsKey = "bs_set_ids"
    static let pendingActionKey = "bs_pending_action"
    /// Action ("next" | "previous") associated with the most recent Darwin
    /// notification. Always written by the intent; the Darwin handler reads
    /// it before notifying JS. Distinct from `pendingActionKey`, which is
    /// only written when the HTTP path failed and a WebSocket-mutation
    /// fallback is required.
    static let widgetNavigateActionKey = "bs_widget_navigate_action"
    /// CorrelationId associated with the most recent Darwin notification.
    /// On HTTP success this is `'widget-navigate'` (matches the constant the
    /// backend's `/api/widget/navigate` handler uses when broadcasting
    /// `CurrentClimbChanged`). On HTTP failure this is the UUID the Darwin
    /// handler generates for its WebSocket-mutation fallback. The JS bridge
    /// adds whichever value to `pendingCurrentClimbUpdates` so the matching
    /// server echo is treated as own-echo.
    static let widgetNavigateCorrelationIdKey = "bs_widget_navigate_correlation_id"
    static let bleBoardConfigKey = "bs_ble_board_config"
    /// Legacy key — auth token now lives in `SharedKeychain` under
    /// `SharedKeychain.authTokenKey`. Kept here only so upgrade paths can
    /// `removeObject` any leftover plaintext value from earlier installs.
    static let authTokenKey = "bs_auth_token"
    /// Legacy key — APNs Live Activity push token now lives in
    /// `SharedKeychain` under `SharedKeychain.livePushTokenKey`. Kept here
    /// only for the same migration cleanup as `authTokenKey`.
    static let livePushTokenKey = "bs_live_push_token"
    /// Whether the current app-side session state allows widget Previous/Next
    /// to control the wall. For party sessions JS keeps this true only for the
    /// current driver; for local sessions it stays true.
    static let widgetNavigationAllowedKey = "bs_widget_navigation_allowed"
    /// Distinguishes real party sessions from local-only Live Activities whose
    /// generated sessionId is only an ActivityKit identifier.
    static let partySessionKey = "bs_party_session"

    // MARK: Darwin Notification

    static let queueNavigateNotification = "com.boardsesh.app.queueNavigate"

    /// Fired by the widget extension when `/api/widget/navigate` responds 410
    /// Gone, signaling that the cached APNs push token is bound to a different
    /// session and the main app should re-register.
    static let pushRegistrationStaleNotification = "com.boardsesh.app.pushRegistrationStale"

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
    let mirrored: Bool

    init(
        uuid: String,
        climbUuid: String,
        climbName: String,
        difficulty: String,
        angle: Int,
        frames: String,
        setterUsername: String,
        mirrored: Bool = false
    ) {
        self.uuid = uuid
        self.climbUuid = climbUuid
        self.climbName = climbName
        self.difficulty = difficulty
        self.angle = angle
        self.frames = frames
        self.setterUsername = setterUsername
        self.mirrored = mirrored
    }

    private enum CodingKeys: String, CodingKey {
        case uuid
        case climbUuid
        case climbName
        case difficulty
        case angle
        case frames
        case setterUsername
        case mirrored
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        uuid = try container.decode(String.self, forKey: .uuid)
        climbUuid = try container.decode(String.self, forKey: .climbUuid)
        climbName = try container.decode(String.self, forKey: .climbName)
        difficulty = try container.decode(String.self, forKey: .difficulty)
        angle = try container.decode(Int.self, forKey: .angle)
        frames = try container.decode(String.self, forKey: .frames)
        setterUsername = try container.decode(String.self, forKey: .setterUsername)
        mirrored = try container.decodeIfPresent(Bool.self, forKey: .mirrored) ?? false
    }
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

// MARK: - Shared Widget Wall Control

struct SharedWidgetWallControl {
    let navigationAllowed: Bool
    let requiresServerAuthorization: Bool
}

enum SharedWidgetWallControlState {
    static func save(navigationAllowed: Bool, isPartySession: Bool, to defaults: UserDefaults) {
        defaults.set(navigationAllowed, forKey: SharedConstants.widgetNavigationAllowedKey)
        defaults.set(isPartySession, forKey: SharedConstants.partySessionKey)
    }

    static func load(from defaults: UserDefaults) -> SharedWidgetWallControl {
        let storedPartySession = defaults.object(forKey: SharedConstants.partySessionKey) as? Bool
        let storedSessionId = defaults.string(forKey: SharedConstants.sessionIdKey)
        let inferredPartySession = storedSessionId.map { !$0.hasPrefix("local-") } ?? false
        let isPartySession = storedPartySession ?? inferredPartySession
        if !isPartySession {
            return SharedWidgetWallControl(navigationAllowed: true, requiresServerAuthorization: false)
        }
        return SharedWidgetWallControl(
            navigationAllowed: defaults.bool(forKey: SharedConstants.widgetNavigationAllowedKey),
            requiresServerAuthorization: true
        )
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
