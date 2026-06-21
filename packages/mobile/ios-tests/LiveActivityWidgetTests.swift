import XCTest

@available(iOS 17.0, *)
final class LiveActivityWidgetTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "com.boardsesh.rn.live-activity-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    private func makeQueueItem(
        uuid: String = "queue-1",
        climbUuid: String = "climb-1",
        climbName: String = "Test Climb",
        difficulty: String = "6c+/V5",
        angle: Int = 40,
        mirrored: Bool = false
    ) -> SharedQueueItem {
        SharedQueueItem(
            uuid: uuid,
            climbUuid: climbUuid,
            climbName: climbName,
            difficulty: difficulty,
            angle: angle,
            frames: "p1r12p2r13",
            setterUsername: "tester",
            mirrored: mirrored
        )
    }

    func testLocalSessionAllowsNavigationWithoutServerAuthorization() {
        defaults.set("local-activity-1", forKey: SharedConstants.sessionIdKey)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertTrue(wallControl.navigationAllowed)
        XCTAssertFalse(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .enableLocalNavigation)
    }

    func testLegacyPartySessionFailsClosedWhenDriverStateMissing() {
        defaults.set("session-party-1", forKey: SharedConstants.sessionIdKey)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertFalse(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .requestServerAuthorization)
    }

    func testPartyNonDriverRequiresServerTakeControl() {
        SharedWidgetWallControlState.save(navigationAllowed: false, isPartySession: true, to: defaults)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertFalse(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .requestServerAuthorization)
    }

    func testPartyDriverDoesNotRequestTakeControlAgain() {
        SharedWidgetWallControlState.save(navigationAllowed: true, isPartySession: true, to: defaults)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertTrue(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .alreadyAllowed)
    }

    func testMarkControlClaimedEnablesPartyNavigationButKeepsAuthorization() {
        SharedWidgetWallControlState.save(navigationAllowed: false, isPartySession: true, to: defaults)

        SharedWidgetTakeControlRuntime.markControlClaimed(isPartySession: true, to: defaults)
        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertTrue(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .alreadyAllowed)
    }

    func testNavigationDirectionBounds() {
        XCTAssertEqual(ClimbNavigationDirection.next.newIndex(from: 0, count: 2), 1)
        XCTAssertNil(ClimbNavigationDirection.next.newIndex(from: 1, count: 2))
        XCTAssertEqual(ClimbNavigationDirection.previous.newIndex(from: 1, count: 2), 0)
        XCTAssertNil(ClimbNavigationDirection.previous.newIndex(from: 0, count: 2))
        XCTAssertNil(ClimbNavigationDirection.previous.newIndex(from: 3, count: 2))
    }

    func testSharedQueueItemDecodesOldPayloadWithoutMirroredField() throws {
        let json = """
        {
          "uuid": "queue-1",
          "climbUuid": "climb-1",
          "climbName": "Old Payload",
          "difficulty": "V4",
          "angle": 40,
          "frames": "p1r12",
          "setterUsername": "tester"
        }
        """

        let item = try JSONDecoder().decode(SharedQueueItem.self, from: Data(json.utf8))

        XCTAssertFalse(item.mirrored)
    }

    func testSharedQueueStateCurrentItemRequiresValidIndex() {
        let items = [
            makeQueueItem(uuid: "queue-1", climbUuid: "climb-1", climbName: "First"),
            makeQueueItem(uuid: "queue-2", climbUuid: "climb-2", climbName: "Second")
        ]
        SharedQueueState.save(items: items, currentIndex: 1, to: defaults)

        XCTAssertEqual(SharedQueueState.currentItem(from: defaults)?.climbName, "Second")

        SharedQueueState.saveCurrentIndex(2, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))

        SharedQueueState.saveCurrentIndex(-1, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))
    }

    func testBoardRenderUrlUsesSharedBoardContext() {
        defaults.set("https://www.boardsesh.com", forKey: SharedConstants.serverUrlKey)
        defaults.set("kilter", forKey: SharedConstants.boardNameKey)
        defaults.set(1, forKey: SharedConstants.layoutIdKey)
        defaults.set(12, forKey: SharedConstants.sizeIdKey)
        defaults.set("10,12", forKey: SharedConstants.setIdsKey)

        let url = SharedQueueState.boardRenderUrl(for: makeQueueItem(), from: defaults)

        XCTAssertEqual(url?.scheme, "https")
        XCTAssertEqual(url?.host, "www.boardsesh.com")
        XCTAssertEqual(url?.path, "/api/internal/board-render")
        XCTAssertTrue(url?.absoluteString.contains("board_name=kilter") ?? false)
        XCTAssertTrue(url?.absoluteString.contains("frames=p1r12p2r13") ?? false)
        XCTAssertTrue(url?.absoluteString.contains("thumbnail=1") ?? false)
        // 2.0: the thumbnail is composited server-side (matches the Capacitor app);
        // the on-device bundled-art compositing is deferred to the revisit issue.
        XCTAssertTrue(url?.absoluteString.contains("include_background=1") ?? false)
    }
}
