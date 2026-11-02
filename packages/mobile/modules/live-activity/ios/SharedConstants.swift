import Foundation

// Two byte-identical copies of this file ship: one in
// modules/live-activity/ios/ (the app) and one in targets/BoardseshWidgets/
// (the widget extension). Edit both together; widget-target-drift.test.ts
// fails CI when they differ.

// MARK: - App Group & Shared Defaults

enum SharedConstants {
    static let appGroupId = "group.com.boardsesh.app"

    // MARK: UserDefaults Keys

    static let queueItemsKey = "bs_queue_items"
    static let currentIndexKey = "bs_current_index"
    static let sessionIdKey = "bs_session_id"
    /// Backend origin (e.g. https://ws.boardsesh.com). Used by the widget for
    /// the board-render compatibility route `/api/internal/board-render`.
    static let serverUrlKey = "bs_server_url"
    /// Fully-qualified backend `/api/widget/navigate` URL (e.g.
    /// https://ws.boardsesh.com/api/widget/navigate). The widget POSTs button
    /// taps here. Kept fully qualified rather than derived from `serverUrlKey`
    /// so the native contract remains explicit.
    static let widgetMirrorUrlKey = "bs_widget_mirror_url"
    static let supportsMirroringKey = "bs_supports_mirroring"
    static let queueSequenceKey = "bs_queue_sequence"
    static let pendingMirrorKey = "bs_pending_mirror"
    /// A mirror tap whose server request never got an authoritative answer.
    /// Written by `MirrorClimbIntent` on a retryable failure and replayed by the
    /// main app over the WebSocket, the same shape of recovery `pendingActionKey`
    /// gives navigation. Distinct from `pendingMirrorKey`, which holds a receipt
    /// the server already confirmed.
    static let pendingMirrorRequestKey = "bs_pending_mirror_request"
    static let widgetNavigateUrlKey = "bs_widget_navigate_url"
    /// Fully-qualified backend `/api/widget/take-control` URL. The widget
    /// POSTs non-driver lightbulb taps here before enabling local navigation.
    static let widgetTakeControlUrlKey = "bs_widget_take_control_url"
    static let boardNameKey = "bs_board_name"
    static let layoutIdKey = "bs_layout_id"
    static let sizeIdKey = "bs_size_id"
    static let setIdsKey = "bs_set_ids"
    /// File paths to the bundled board-background webp layer(s) for the active
    /// board, resolved on the JS side (expo-asset) and staged here by
    /// `startSession`. ThumbnailFetcher composites these behind the server's
    /// holds-only overlay so the widget shows the board photo without fetching
    /// board art over the network (the no-network-board-art rule). Empty when no
    /// bundled background resolved — the overlay is then written as-is.
    static let boardBackgroundPathsKey = "bs_board_background_paths"
    /// The climber's requested board-render look ("classic" | "aura"), staged
    /// by `startSession` and refreshed by session updates so a settings change
    /// reaches a running activity. Read when building the server thumbnail URL
    /// and the cached thumbnail's filename (`SharedBoardRenderMode`); absent —
    /// an older OTA'd JS bundle that never writes it — resolves to aura, the
    /// app and server default.
    static let renderModeKey = "bs_render_mode"
    /// Version of the cached Live Activity thumbnail's content contract. When it
    /// differs from `ThumbnailFetcher.cacheVersion`, the (update-surviving) App
    /// Group thumbnail cache is purged so an upgraded build doesn't serve the
    /// previous build's images (e.g. overlay-only thumbnails from before board
    /// compositing).
    static let thumbnailCacheVersionKey = "bs_thumbnail_cache_version"
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
    /// CBPeripheral.identifier (a per-install, per-device stable UUID — not the
    /// hardware address) of the last successfully connected board. Persisted by
    /// BoardBleManager on connect and cleared on a deliberate disconnect, so the
    /// Live Activity lightbulb's ReconnectBoardIntent can retrieve + reconnect to
    /// the same board without a fresh device pick. Left intact on an unexpected
    /// drop precisely so that reconnect path stays available.
    static let bleLastPeripheralUuidKey = "bs_ble_last_peripheral_uuid"
    /// Learned Aurora write-with-response fallbacks keyed by board serial when
    /// available, otherwise by CoreBluetooth's app-install-scoped peripheral UUID.
    static let bleWriteWithResponseBoardsKey = "bs_ble_write_with_response_boards"
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
    /// Last-known board-connection state from THIS device's POV
    /// ("connectedByMe" | "heldByPeer" | "disconnected"). Mirrors the pushed
    /// `ClimbSessionAttributes.ContentState.boardConnection` into the App Group
    /// so widget intents (which run without the pushed state) and the native
    /// WebSocket content-state builder have a fallback source of truth.
    static let boardConnectionKey = "bs_board_connection"
    /// Display name of the peer holding the board when `boardConnectionKey` is
    /// "heldByPeer" (absent otherwise). Companion to `boardConnectionKey`.
    static let holderDisplayNameKey = "bs_holder_display_name"
    /// The climber's rest timer (#6513) as a `SharedRestTimerState` JSON blob,
    /// written by JS through `updateRestTimer`. Lives ONLY here, never in the
    /// pushed `ContentState`: the backend re-sends the whole content state on
    /// every queue change and every 90 s without it, and the native builders
    /// and intents construct fresh states, so a pushed field would be wiped on
    /// every one of those paths. The widget reads it at render time.
    static let restTimerKey = "bs_rest_timer"
    /// This phone's keep-lighting window (2.7) as a `SharedLightingWindowState`
    /// JSON blob: off, a window with an end, or an open-ended drive. Lives only
    /// here, never in the pushed `ContentState`, for the same reason as
    /// `restTimerKey`: a crewmate's queue edit makes the backend re-send the
    /// whole content state, which would wipe the countdown. JS writes it through
    /// `updateLightingWindow`; a lock-screen Next or Previous writes it natively
    /// (`SharedLightingWindowRuntime.recordPress`) while JS may be suspended,
    /// and JS adopts that write when it next runs.
    static let lightingWindowKey = "bs_lighting_window"
    /// Settings › Board's keep-lighting choices as a `SharedKeepLightingConfig`
    /// JSON blob, written by JS through `updateKeepLightingConfig` while a
    /// session runs, so a lock-screen press can open or renew the window the
    /// way Put on board would without asking JS.
    static let keepLightingConfigKey = "bs_keep_lighting_config"

    // MARK: Darwin Notification

    static let queueNavigateNotification = "com.boardsesh.app.queueNavigate"

    /// Fired by the widget extension when `/api/widget/navigate` responds 410
    /// Gone, signaling that the cached APNs push token is bound to a different
    /// session and the main app should re-register.
    static let pushRegistrationStaleNotification = "com.boardsesh.app.pushRegistrationStale"

    /// Fallback for the Live Activity lightbulb's ReconnectBoardIntent: if iOS
    /// runs that intent in the widget extension (which can't link BoardBleManager),
    /// it posts this so the live main app reconnects BLE to the last known board.
    static let bleReconnectNotification = "com.boardsesh.app.bleReconnect"

    // MARK: Live Activity

    /// Minimum seconds between consecutive ActivityKit pushes.
    /// Redundant JS-side updates that arrive within this window are skipped
    /// because the native WebSocket callback already applied the state.
    /// Only truly redundant pushes are skipped: a push whose content differs
    /// from the last pushed state always goes through (a dropped
    /// content-changing update would leave the widget on the wrong climb
    /// until some later update).
    static let liveActivityDedupWindow: TimeInterval = 0.5

    /// How far in the future every ActivityKit update pushes the stale date.
    /// The server-side APNs heartbeat (`packages/backend/src/services/apns/
    /// heartbeat.ts`) re-sends the latest content state every 90 s while a
    /// push token is registered, so 10 minutes gives ~6× headroom against
    /// missed pushes. Shared with the widget-extension intents — they used a
    /// 180 s stale date, which flipped the activity to "Session ended" three
    /// minutes after a lock-screen tap whenever no heartbeat covered the
    /// session (push registration pending, local session).
    static let liveActivityStaleInterval: TimeInterval = 10 * 60

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

// MARK: - Shared Board Render Mode

enum SharedBoardRenderMode {
    static let aura = "aura"
    static let classic = "classic"

    /// Validated saved look: anything but "classic" — absent key, garbage, an
    /// older JS bundle that never writes it — resolves to aura, the app
    /// default since 2.4 and the server's default for an absent param.
    static func resolve(from defaults: UserDefaults?) -> String {
        defaults?.string(forKey: SharedConstants.renderModeKey) == classic ? classic : aura
    }

    /// One filename contract for ThumbnailFetcher (module target) and the
    /// widget's loadThumbnail (extension target): the mode is part of the name
    /// so a look change never serves the other mode's cached bytes.
    static func thumbnailFileName(climbUuid: String, renderMode: String) -> String {
        "\(climbUuid)-\(renderMode).webp"
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

    /// `renderMode` lets a caller pin the look it resolved earlier in the same
    /// operation (ThumbnailFetcher pairs the URL with a mode-suffixed cache
    /// filename); nil resolves the saved look from `defaults`.
    static func boardRenderUrl(for item: SharedQueueItem, from defaults: UserDefaults, renderMode: String? = nil) -> URL? {
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
            // 2.0: let the server composite the board photo behind the holds
            // overlay (matches the legacy Capacitor app, which renders correctly).
            // On-device bundled-board-art compositing is deferred — see the
            // "offline board art" revisit issue. The widget then just displays the
            // finished image; no local webp decode/composite needed.
            URLQueryItem(name: "include_background", value: "1"),
            // Darken the board photo behind the holds so the lit climb reads
            // clearly at thumbnail size — mirrors the mobile climb list's
            // LayeredClimbImage `dim` (rgba(0,0,0,0.18)). Bump
            // ThumbnailFetcher.cacheVersion whenever this value changes.
            URLQueryItem(name: "dim_background", value: "0.18"),
            // The climber's saved board look. Sent explicitly for BOTH values —
            // every Boardsesh caller names its render mode rather than leaning
            // on the server default (docs/og-climb.md convention). The mode is
            // also baked into the cached thumbnail's filename, so no cache
            // version bump is needed when a climber flips the setting.
            URLQueryItem(name: "render_mode", value: renderMode ?? SharedBoardRenderMode.resolve(from: defaults)),
        ]

        return components?.url
    }
}

// MARK: - Shared Widget Wall Control

struct SharedWidgetWallControl {
    let navigationAllowed: Bool
    let requiresServerAuthorization: Bool
}

enum SharedWidgetTakeControlAction: Equatable {
    case enableLocalNavigation
    case alreadyAllowed
    case requestServerAuthorization
}

enum SharedWidgetWallControlState {
    static func save(navigationAllowed: Bool, isPartySession: Bool, to defaults: UserDefaults) {
        defaults.set(navigationAllowed, forKey: SharedConstants.widgetNavigationAllowedKey)
        defaults.set(isPartySession, forKey: SharedConstants.partySessionKey)
    }

    /// Mirror of the pushed `ContentState.boardConnection` / `.holderDisplayName`
    /// into the App Group, so widget intents (which run without the pushed
    /// state) and the native WebSocket content-state builder have a fallback
    /// source of truth. Pass nil to clear (e.g. a heldByPeer state with an
    /// anonymous holder leaves the display name absent).
    static func saveBoardConnection(_ boardConnection: String?, holderDisplayName: String?, to defaults: UserDefaults) {
        if let boardConnection {
            defaults.set(boardConnection, forKey: SharedConstants.boardConnectionKey)
        } else {
            defaults.removeObject(forKey: SharedConstants.boardConnectionKey)
        }
        if let holderDisplayName {
            defaults.set(holderDisplayName, forKey: SharedConstants.holderDisplayNameKey)
        } else {
            defaults.removeObject(forKey: SharedConstants.holderDisplayNameKey)
        }
    }

    static func loadBoardConnection(from defaults: UserDefaults) -> (boardConnection: String?, holderDisplayName: String?) {
        (
            defaults.string(forKey: SharedConstants.boardConnectionKey),
            defaults.string(forKey: SharedConstants.holderDisplayNameKey)
        )
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

enum SharedWidgetTakeControlRuntime {
    static func action(for wallControl: SharedWidgetWallControl) -> SharedWidgetTakeControlAction {
        if !wallControl.requiresServerAuthorization {
            return .enableLocalNavigation
        }
        if wallControl.navigationAllowed {
            return .alreadyAllowed
        }
        return .requestServerAuthorization
    }

    static func markControlClaimed(isPartySession: Bool, to defaults: UserDefaults) {
        SharedWidgetWallControlState.save(
            navigationAllowed: true,
            isPartySession: isPartySession,
            to: defaults
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

    /// True for an already-formatted display V-grade: "V" then digits, with an
    /// optional trailing "+" ("V5", "v12", "V5+"). Plain character checks, so
    /// nothing in the widget's static setup can throw.
    private static func isDisplayVGrade(_ grade: String) -> Bool {
        var rest = Substring(grade)
        guard let first = rest.first, first == "V" || first == "v" else { return false }
        rest = rest.dropFirst()
        if rest.last == "+" { rest = rest.dropLast() }
        return !rest.isEmpty && rest.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// The grade the widget shows, whatever path delivered it.
    ///
    /// The native update paths already run `formatVGrade`, but the backend's
    /// APNs push sends the raw difficulty ("6a/V3"), so without this the card
    /// flipped between a coloured "V3" and an uncoloured "6a/V3" depending on
    /// which source updated it last. Idempotent: a value that is already a
    /// display V-grade ("V5+") passes through untouched, where `formatVGrade`
    /// alone would drop the "+".
    static func displayGrade(_ difficulty: String) -> String {
        let trimmed = difficulty.trimmingCharacters(in: .whitespacesAndNewlines)
        if isDisplayVGrade(trimmed) {
            return trimmed.uppercased()
        }
        return formatVGrade(trimmed)
    }
}

// MARK: - Shared Rest Timer (#6513)

/// The rest timer snapshot JS hands the widget through the App Group. Epoch
/// milliseconds as Doubles, never `Date`: synthesized Codable would encode a
/// `Date` as seconds since 2001, which no other writer of this key speaks.
///
/// JS works out the status (it owns the rest-timer state machine); the widget
/// only decides, at render time, whether a running rest has passed its
/// deadline, and rolls a fixed-window cadence on to its current window.
struct SharedRestTimerState: Codable, Equatable {
    static let currentVersion = 1

    static let statusRunning = "running"
    static let statusPaused = "paused"
    static let statusWaiting = "waiting"
    static let statusQueueEnded = "queueEnded"
    static let statusCountUp = "countUp"

    let v: Int
    let sessionId: String
    let status: String
    /// When the current countdown or count-up started. Nil while waiting.
    let startMs: Double?
    /// When the current rest or fixed window ends. Nil for count-up / waiting.
    let deadlineMs: Double?
    /// Fixed-window length in seconds (`onTheMinute`); nil for `afterTick`.
    let periodSeconds: Double?
    /// The rest-length setting; nil when the length is Off.
    let targetSeconds: Double?
    /// Frozen value for paused / waiting: seconds left (+) or over (−). A
    /// queue-ended snapshot is live and carries timing instead; this is only
    /// its fallback when it has none.
    let frozenSignedSeconds: Double?

    /// Seconds fields stay within a day either way.
    static let maxAbsSeconds: Double = 86_400
    /// Epoch milliseconds stay between 2000-01-01 and 2100-01-01.
    static let minEpochMs: Double = 946_684_800_000
    static let maxEpochMs: Double = 4_102_444_800_000

    /// Whether every number is one the widget can draw. `JSONEncoder` rejects
    /// NaN and infinity but writes 1e300 happily, and `Int(1e300)` traps — in
    /// the widget extension that takes the whole card down. A snapshot outside
    /// these bounds renders as "no timer".
    var isWithinBounds: Bool {
        let seconds = [targetSeconds, periodSeconds, frozenSignedSeconds].compactMap { $0 }
        let millis = [startMs, deadlineMs].compactMap { $0 }
        return seconds.allSatisfy { $0.isFinite && abs($0) <= Self.maxAbsSeconds }
            && millis.allSatisfy { $0.isFinite && $0 >= Self.minEpochMs && $0 <= Self.maxEpochMs }
    }
}

enum SharedRestTimerStore {
    /// Nil for an absent key, unreadable bytes, a version this build does not
    /// know, or numbers out of bounds — an unknown shape renders as "no
    /// timer", never as a guess.
    static func load(from defaults: UserDefaults) -> SharedRestTimerState? {
        guard let data = defaults.data(forKey: SharedConstants.restTimerKey),
              let state = try? JSONDecoder().decode(SharedRestTimerState.self, from: data),
              state.v == SharedRestTimerState.currentVersion,
              state.isWithinBounds
        else { return nil }
        return state
    }

    /// Stores the snapshot. One that cannot be encoded (a non-finite number,
    /// which `JSONEncoder` rejects) clears the key instead: the previous
    /// snapshot left in place would keep counting a rest that has changed.
    /// Returns whether the new snapshot was stored.
    @discardableResult
    static func save(_ state: SharedRestTimerState, to defaults: UserDefaults) -> Bool {
        // A snapshot `load` would reject is never written: clearing instead
        // keeps the App Group free of a value the widget can't draw.
        guard state.isWithinBounds, let data = try? JSONEncoder().encode(state) else {
            defaults.removeObject(forKey: SharedConstants.restTimerKey)
            return false
        }
        defaults.set(data, forKey: SharedConstants.restTimerKey)
        return true
    }

    /// Removes the snapshot. Returns whether there was one, so a caller can
    /// skip redrawing for a timer that was never on screen.
    @discardableResult
    static func clear(in defaults: UserDefaults) -> Bool {
        let existed = defaults.object(forKey: SharedConstants.restTimerKey) != nil
        defaults.removeObject(forKey: SharedConstants.restTimerKey)
        return existed
    }
}

/// What the widget draws for the rest timer at one render instant.
enum RestTimerRenderPhase: Equatable {
    /// Armed, nothing to count from yet. Carries the frozen value to show.
    case waiting(signedSeconds: Int)
    /// Counting down inside the rest or window. `start <= deadline` always:
    /// `Text(timerInterval:)` traps on an inverted range.
    case running(start: Date, deadline: Date)
    /// Past the deadline of a rest that does not roll over.
    case over(deadline: Date)
    case paused(signedSeconds: Int)
    /// A queue-ended snapshot with no timing to count from: its frozen value.
    /// One with timing resolves to `running` / `over` / `countUp` instead,
    /// flagged `muted` on the `ResolvedRestTimer`.
    case queueEnded(signedSeconds: Int)
    /// No rest length: counts up from `start`.
    case countUp(start: Date)
}

struct ResolvedRestTimer: Equatable {
    let phase: RestTimerRenderPhase
    /// Fixed-window length when the cadence is `onTheMinute`.
    let periodSeconds: Int?
    let targetSeconds: Int?
    /// The queue has run out. The clock keeps counting, as the app's pill
    /// does, but is drawn muted under "Queue's empty" — never the over red.
    var muted: Bool = false

    /// Nil hides the timer: no snapshot, another session's snapshot, an
    /// unknown status, or a running snapshot with nothing to count against.
    static func resolve(state: SharedRestTimerState?, sessionId: String, now: Date) -> ResolvedRestTimer? {
        guard let state, state.sessionId == sessionId, state.isWithinBounds else { return nil }
        let period = state.periodSeconds.flatMap { $0 > 0 ? $0 : nil }
        let target = state.targetSeconds.flatMap { $0 > 0 ? $0 : nil }
        let frozen = wholeSeconds(state.frozenSignedSeconds ?? target ?? 0)

        let phase: RestTimerRenderPhase
        switch state.status {
        case SharedRestTimerState.statusWaiting:
            phase = .waiting(signedSeconds: frozen)
        case SharedRestTimerState.statusPaused:
            phase = .paused(signedSeconds: frozen)
        case SharedRestTimerState.statusQueueEnded:
            // Live, like the pill: the clock of the rest it replaced. Only a
            // snapshot with no timing at all falls back to its frozen value.
            phase = liveClock(state: state, period: period, target: target, now: now)
                ?? .queueEnded(signedSeconds: frozen)
        case SharedRestTimerState.statusCountUp:
            guard let startMs = state.startMs else { return nil }
            phase = .countUp(start: min(Date(timeIntervalSince1970: startMs / 1000), now))
        case SharedRestTimerState.statusRunning:
            guard state.deadlineMs != nil,
                  let clock = liveClock(state: state, period: period, target: target, now: now)
            else { return nil }
            phase = clock
        default:
            return nil
        }

        return ResolvedRestTimer(
            phase: phase,
            periodSeconds: period.map { wholeSeconds($0) },
            targetSeconds: target.map { wholeSeconds($0) },
            muted: state.status == SharedRestTimerState.statusQueueEnded
        )
    }

    /// Whole seconds from a Double without a trap: non-finite reads as 0, and
    /// anything beyond a day either way is pinned to a day.
    static func wholeSeconds(_ value: Double) -> Int {
        guard value.isFinite else { return 0 }
        let bound = SharedRestTimerState.maxAbsSeconds
        return Int(min(max(value, -bound), bound).rounded(.towardZero))
    }

    /// The clock a snapshot's timing describes at `now`: a countdown to its
    /// deadline (rolling a fixed window on in whole windows), the overrun once
    /// a non-rolling deadline has passed, or a count-up from its start. Nil
    /// when it carries no timing.
    private static func liveClock(
        state: SharedRestTimerState,
        period: Double?,
        target: Double?,
        now: Date
    ) -> RestTimerRenderPhase? {
        if let deadlineMs = state.deadlineMs {
            var deadline = Date(timeIntervalSince1970: deadlineMs / 1000)
            var start = state.startMs.map { Date(timeIntervalSince1970: $0 / 1000) }
            if let period, now >= deadline {
                // A fixed window that ended while nobody could re-render: roll
                // forward in whole windows so the cadence keeps its phase.
                let windowsBehind = floor(now.timeIntervalSince(deadline) / period) + 1
                deadline = deadline.addingTimeInterval(windowsBehind * period)
                start = deadline.addingTimeInterval(-period)
            }
            if now >= deadline {
                return .over(deadline: deadline)
            }
            let fallbackStart = deadline.addingTimeInterval(-(period ?? target ?? 0))
            return .running(start: min(start ?? fallbackStart, deadline), deadline: deadline)
        }
        if let startMs = state.startMs {
            return .countUp(start: min(Date(timeIntervalSince1970: startMs / 1000), now))
        }
        return nil
    }
}

enum RestTimerFormat {
    /// `m:ss`, widening to `h:mm:ss` past an hour — the app's
    /// `formatRestTimerElapsed`. Negative input formats its magnitude.
    static func clock(_ seconds: Int) -> String {
        let total = abs(seconds)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours == 0 {
            return String(format: "%d:%02d", minutes, secs)
        }
        return String(format: "%d:%02d:%02d", hours, minutes, secs)
    }

    /// Signed clock for a countdown allowed to run past zero, with a true
    /// minus sign (U+2212) so it lines up with the widget's live overrun.
    static func signedClock(_ seconds: Int) -> String {
        seconds < 0 ? "\u{2212}\(clock(seconds))" : clock(seconds)
    }
}

// MARK: - Shared Lighting Window (2.7 keep-lighting)

/// This phone's keep-lighting window as the Lock Screen, the Dynamic Island and
/// the lock-screen intents share it through the App Group. Epoch milliseconds
/// as Doubles, like `SharedRestTimerState`, so JS and native speak one format.
///
/// Two writers: JS (`source == "app"`) on every change of its drive, and a
/// lock-screen Next or Previous (`source == "lockScreen"`) that lit the wall
/// while JS may have been suspended. JS adopts a lock-screen write once, by its
/// `updatedAtMs`, and then writes its own.
struct SharedLightingWindowState: Codable, Equatable {
    static let currentVersion = 1

    /// Nothing keeps lighting: a pick is a preview.
    static let modeOff = "off"
    /// Each pick lights until `endsAtMs`, and each climb that lights renews it.
    static let modeWindow = "window"
    /// Every pick lights until the climber stops it.
    static let modeDriving = "driving"

    static let sourceApp = "app"
    static let sourceLockScreen = "lockScreen"

    /// Settings › Board's general choice opened it.
    static let familyGeneral = "general"
    /// The MoonBoard choice opened it.
    static let familyMoonboard = "moonboard"

    let v: Int
    let sessionId: String
    let mode: String
    /// When the window ends. Nil outside a window.
    let endsAtMs: Double?
    /// The window's length, so a lock-screen press renews it by its own
    /// length rather than whatever the setting says now. Nil outside a window.
    let windowSeconds: Double?
    /// Which choice opened it (`familyGeneral` / `familyMoonboard`), nil when unknown.
    let family: String?
    let source: String
    /// When this snapshot was written.
    let updatedAtMs: Double

    /// Whether every number is one the widget can draw: the epoch bounds and
    /// the one-day cap the rest timer uses. A snapshot outside them renders as
    /// previews, never as a guess.
    var isWithinBounds: Bool {
        let millis = [endsAtMs, updatedAtMs].compactMap { $0 }
        let secondsOk = windowSeconds.map { $0.isFinite && $0 > 0 && $0 <= SharedRestTimerState.maxAbsSeconds } ?? true
        return secondsOk && millis.allSatisfy {
            $0.isFinite && $0 >= SharedRestTimerState.minEpochMs && $0 <= SharedRestTimerState.maxEpochMs
        }
    }

    /// Same picture on the card: everything but who wrote it and when. A JS
    /// write that only takes over a lock-screen window it adopted needs no redraw.
    func drawsLike(_ other: SharedLightingWindowState?) -> Bool {
        guard let other else { return false }
        return sessionId == other.sessionId && mode == other.mode
            && endsAtMs == other.endsAtMs && windowSeconds == other.windowSeconds
    }
}

enum SharedLightingWindowStore {
    /// Nil for an absent key, unreadable bytes, an unknown version, or numbers
    /// out of bounds.
    static func load(from defaults: UserDefaults) -> SharedLightingWindowState? {
        guard let data = defaults.data(forKey: SharedConstants.lightingWindowKey),
              let state = try? JSONDecoder().decode(SharedLightingWindowState.self, from: data),
              state.v == SharedLightingWindowState.currentVersion,
              state.isWithinBounds
        else { return nil }
        return state
    }

    /// Stores the snapshot, or clears the key when it can't be stored: the old
    /// one left in place would keep a window on the card that has changed.
    @discardableResult
    static func save(_ state: SharedLightingWindowState, to defaults: UserDefaults) -> Bool {
        guard state.isWithinBounds, let data = try? JSONEncoder().encode(state) else {
            defaults.removeObject(forKey: SharedConstants.lightingWindowKey)
            return false
        }
        defaults.set(data, forKey: SharedConstants.lightingWindowKey)
        return true
    }

    /// Removes the snapshot. Returns whether there was one.
    @discardableResult
    static func clear(in defaults: UserDefaults) -> Bool {
        let existed = defaults.object(forKey: SharedConstants.lightingWindowKey) != nil
        defaults.removeObject(forKey: SharedConstants.lightingWindowKey)
        return existed
    }
}

/// Settings › Board's keep-lighting choices, as JS mirrors them for the
/// lock-screen intents. The choices are the app's `KeepLightingChoice` strings
/// (`off`, `30`, `45`, `60`, `until_stopped`); the rest are the inputs
/// `resolveKeepLightingPlan` (src/lib/keep-lighting.ts) reads.
struct SharedKeepLightingConfig: Codable, Equatable {
    static let currentVersion = 1

    let v: Int
    /// The general choice, for every board but a MoonBoard.
    let keepLighting: String
    /// The MoonBoard choice. It applies in a crew session too.
    let moonboardKeepLighting: String
    /// "In a session too": the general choice applies with a crew.
    let drivesInSession: Bool
    /// A crew is in the session (the roster's crew, after its arrival dwell).
    let inCrew: Bool
    /// The session's board is a MoonBoard.
    let moonboard: Bool
    /// False where a press would not keep lighting in the app either: the
    /// swipe flag (keep-lighting's kill switch) is off, or the climber lights
    /// every pick solo with Light the board as I swipe.
    let enabled: Bool
}

enum SharedKeepLightingConfigStore {
    static func load(from defaults: UserDefaults) -> SharedKeepLightingConfig? {
        guard let data = defaults.data(forKey: SharedConstants.keepLightingConfigKey),
              let config = try? JSONDecoder().decode(SharedKeepLightingConfig.self, from: data),
              config.v == SharedKeepLightingConfig.currentVersion
        else { return nil }
        return config
    }

    static func save(_ config: SharedKeepLightingConfig, to defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(config) else {
            defaults.removeObject(forKey: SharedConstants.keepLightingConfigKey)
            return
        }
        defaults.set(data, forKey: SharedConstants.keepLightingConfigKey)
    }

    static func clear(in defaults: UserDefaults) {
        defaults.removeObject(forKey: SharedConstants.keepLightingConfigKey)
    }
}

/// What a lock-screen press keeps lighting once its climb is up.
enum SharedKeepLightingPlan: Equatable {
    case window(seconds: Double, family: String)
    case driving(family: String)
}

enum SharedKeepLighting {
    static let untilStopped = "until_stopped"
    /// The longest window a choice may ask for. The app offers 60 s; a newer
    /// bundle's longer choice still works up to this.
    static let maxWindowSeconds: Double = 3_600

    /// One choice's plan: Until I stop drives, a number of seconds opens a
    /// window, and Off (or a value this build can't read) lights one climb.
    static func plan(forChoice choice: String, family: String) -> SharedKeepLightingPlan? {
        if choice == untilStopped { return .driving(family: family) }
        guard let seconds = Double(choice), seconds.isFinite, seconds > 0, seconds <= maxWindowSeconds else {
            return nil
        }
        return .window(seconds: seconds, family: family)
    }

    /// The plan for a press, as `resolveKeepLightingPlan` reads it: a MoonBoard
    /// takes its own choice, in a crew too; every other board takes the general
    /// choice, and with a crew only while "In a session too" is on.
    static func plan(for config: SharedKeepLightingConfig?) -> SharedKeepLightingPlan? {
        guard let config, config.enabled else { return nil }
        if config.moonboard {
            return plan(forChoice: config.moonboardKeepLighting, family: SharedLightingWindowState.familyMoonboard)
        }
        if config.inCrew && !config.drivesInSession { return nil }
        return plan(forChoice: config.keepLighting, family: SharedLightingWindowState.familyGeneral)
    }
}

enum SharedLightingWindowRuntime {
    /// The snapshot a lock-screen Next or Previous leaves once it lit the wall,
    /// or nil when the press changes nothing.
    ///
    /// - A drive goes on as it is.
    /// - An open window is renewed by its own length, like a climb that lights in the app.
    /// - Otherwise the settings decide: a window, a drive, or (Off) one climb.
    static func afterPress(
        current: SharedLightingWindowState?,
        config: SharedKeepLightingConfig?,
        sessionId: String,
        now: Date
    ) -> SharedLightingWindowState? {
        let nowMs = now.timeIntervalSince1970 * 1000
        if let current, current.sessionId == sessionId, current.isWithinBounds {
            if current.mode == SharedLightingWindowState.modeDriving { return nil }
            if current.mode == SharedLightingWindowState.modeWindow,
               let endsAtMs = current.endsAtMs, endsAtMs > nowMs,
               let seconds = current.windowSeconds, seconds > 0 {
                return window(sessionId: sessionId, seconds: seconds, family: current.family, nowMs: nowMs)
            }
        }
        switch SharedKeepLighting.plan(for: config) {
        case nil:
            return nil
        case let .window(seconds, family)?:
            return window(sessionId: sessionId, seconds: seconds, family: family, nowMs: nowMs)
        case let .driving(family)?:
            return SharedLightingWindowState(
                v: SharedLightingWindowState.currentVersion,
                sessionId: sessionId,
                mode: SharedLightingWindowState.modeDriving,
                endsAtMs: nil,
                windowSeconds: nil,
                family: family,
                source: SharedLightingWindowState.sourceLockScreen,
                updatedAtMs: nowMs
            )
        }
    }

    /// Opens or renews the window for a press on this session's card, and
    /// stores it. Returns what it stored, or nil when nothing changed.
    @discardableResult
    static func recordPress(in defaults: UserDefaults, now: Date = Date()) -> SharedLightingWindowState? {
        guard let sessionId = defaults.string(forKey: SharedConstants.sessionIdKey), !sessionId.isEmpty,
              let next = afterPress(
                  current: SharedLightingWindowStore.load(from: defaults),
                  config: SharedKeepLightingConfigStore.load(from: defaults),
                  sessionId: sessionId,
                  now: now
              ),
              SharedLightingWindowStore.save(next, to: defaults)
        else { return nil }
        return next
    }

    private static func window(sessionId: String, seconds: Double, family: String?, nowMs: Double) -> SharedLightingWindowState {
        SharedLightingWindowState(
            v: SharedLightingWindowState.currentVersion,
            sessionId: sessionId,
            mode: SharedLightingWindowState.modeWindow,
            endsAtMs: nowMs + seconds * 1000,
            windowSeconds: seconds,
            family: family,
            source: SharedLightingWindowState.sourceLockScreen,
            updatedAtMs: nowMs
        )
    }
}

/// What the card draws for the wall's lighting at one render instant.
enum LightingRenderPhase: Equatable {
    /// Nothing keeps lighting: the bulb alone. Picks are previews.
    case previews
    /// Each pick lights until `end`. `start <= end` always:
    /// `Text(timerInterval:)` and `ProgressView(timerInterval:)` trap on an
    /// inverted range.
    case window(start: Date, end: Date)
    /// Every pick lights until the climber stops.
    case driving

    /// The lighting at `now` for this session's card. A window past its end
    /// reads as previews: the widget runs no code at the deadline, so the next
    /// render after it decides.
    static func resolve(state: SharedLightingWindowState?, sessionId: String, now: Date) -> LightingRenderPhase {
        guard let state, state.sessionId == sessionId, state.isWithinBounds else { return .previews }
        switch state.mode {
        case SharedLightingWindowState.modeDriving:
            return .driving
        case SharedLightingWindowState.modeWindow:
            guard let endsAtMs = state.endsAtMs else { return .previews }
            let end = Date(timeIntervalSince1970: endsAtMs / 1000)
            guard end > now else { return .previews }
            let start = state.windowSeconds.map { end.addingTimeInterval(-$0) } ?? now
            return .window(start: min(start, end), end: end)
        default:
            return .previews
        }
    }
}
