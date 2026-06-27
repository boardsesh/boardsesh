import CoreBluetooth
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

    func testMoonboardPacketEncodesRolesAndSerialPositions() {
        // Parity with packages/shared/ble-protocol/src/__tests__/moonboard.test.ts:
        // p1r42 -> S at serial position 0, p2r43 -> P at serial position 35.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p2r43")

        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l#S0,P35#")
        XCTAssertEqual(result.skippedRoleCount, 0)
        XCTAssertEqual(result.skippedPositionCount, 0)
        XCTAssertEqual(result.totalPlacements, 2)
    }

    func testMoonboardPacketSkipsUnknownRolesAndOutOfRangeHolds() {
        // Role 45 (foot) is not a MoonBoard LED role; hold id 199 is past the
        // 198-hold grid. Both are dropped, the valid start hold still lights.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p5r45p199r43")

        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l#S0#")
        XCTAssertEqual(result.skippedRoleCount, 1)
        XCTAssertEqual(result.skippedPositionCount, 1)
        XCTAssertEqual(result.totalPlacements, 3)
    }

    func testMoonboardPacketIsEmptyWhenNothingEncodes() {
        // No clear-all: an empty or all-skipped frame must produce no packet so
        // the BLE manager refuses to write and leaves the wall lit as-is.
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "").packet.isEmpty)
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "p1r45").packet.isEmpty)
    }

    func testMoonboardSerialPositionMirrorsGridMath() {
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 1), 0)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 2), 35)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 198), 197)
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 0))
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 199))
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

    // The write type is gated on board family. Aurora (Kilter/Tension) drove the
    // wall with write-without-response through the entire Capacitor era and the
    // first RN port, so it ALWAYS takes that path — even when iOS reports the
    // characteristic without the `.writeWithoutResponse` bit (seen on iOS 26.x,
    // which routed Aurora to a stalling write-with-response path). Only the
    // original MoonBoard LED box (UART advertises `.write` only; CoreBluetooth
    // silently drops a `.withoutResponse` write to it) falls back to
    // `.withResponse`.
    func testPreferredWriteTypeIsMoonboardGated() {
        // Aurora: always without-response, regardless of advertised properties.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .writeWithoutResponse, boardName: "kilter"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "kilter"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "tension"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.read], boardName: "tension"), .withoutResponse)
        // Unknown / nil board (e.g. a JS write before configureBoard): safe
        // without-response default, never the stalling with-response path.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: nil), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.read], boardName: nil), .withoutResponse)
        // MoonBoard: choose from the advertised properties (the 00bda53a2 fix).
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "moonboard"), .withResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .writeWithoutResponse, boardName: "moonboard"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.write, .writeWithoutResponse], boardName: "moonboard"), .withoutResponse)
        // Defensive default: a characteristic advertising neither write property
        // can't be written either way (CoreBluetooth drops/ rejects the write and
        // the wall stays dark) — we just don't pick the unacknowledged path for it.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.read], boardName: "moonboard"), .withResponse)
    }

    // MARK: - Aurora packet encoding (parity with @boardsesh/ble-protocol)

    private func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Color byte of a single-LED v3 packet:
    /// [SOH, LEN, CHK, STX, T, posLo, posHi, color, ETX].
    private func singleLedColorByte(_ result: BoardBlePacketResult) -> UInt8? {
        let bytes = [UInt8](result.packet)
        guard bytes.count == 9 else { return nil }
        return bytes[7]
    }

    func testAuroraPacketByteExactMatchesValidatedKilter12x12() {
        // 3rd-party validated payload for Kilter Original 12x12 (Layout 1) — the
        // same ground-truth fixture as the web bluetooth-packet.test.ts. Locks
        // Swift ↔ TS ↔ hardware parity for the v3 encoder.
        let result = BoardBleEncoding.makeAuroraPacket(
            frames: "p1379r44p1395r44p1447r45p1464r45",
            placementPositions: [1379: 68, 1395: 476, 1447: 0, 1464: 33],
            boardName: "kilter"
        )
        XCTAssertEqual(hex(result.packet), "010dbb02544400e3dc01e30000f42100f403")
    }

    func testAuroraPacketByteExactMatchesValidatedKilter8x12Original() {
        let result = BoardBleEncoding.makeAuroraPacket(
            frames: "p1382r44p1392r44p1450r45p1461r45",
            placementPositions: [1382: 56, 1392: 311, 1450: 0, 1461: 21],
            boardName: "kilter"
        )
        XCTAssertEqual(hex(result.packet), "010d7802543800e33701e30000f41500f403")
    }

    func testAuroraHoldStateColorsMatchCanonicalMap() {
        // Indirect holdStateMap parity: each role's canonical LED color must
        // encode to the same v3 color byte as @boardsesh/board-constants. A drift
        // in the hand-copied Swift map would flip one of these bytes.
        func color(_ frames: String, _ board: String) -> UInt8? {
            singleLedColorByte(
                BoardBleEncoding.makeAuroraPacket(frames: frames, placementPositions: [1: 10], boardName: board)
            )
        }
        // kilter: 42 STARTING #00FF00, 43 HAND #00FFFF, 44 FINISH #FF00FF, 45 FOOT #FFAA00
        XCTAssertEqual(color("p1r42", "kilter"), 0x1C)
        XCTAssertEqual(color("p1r43", "kilter"), 0x1F)
        XCTAssertEqual(color("p1r44", "kilter"), 0xE3)
        XCTAssertEqual(color("p1r45", "kilter"), 0xF4)
        // tension: 1 STARTING #00FF00, 3 FINISH #FF0000
        XCTAssertEqual(color("p1r1", "tension"), 0x1C)
        XCTAssertEqual(color("p1r3", "tension"), 0xE0)
        // decoy (common Aurora role map): 3 FINISH #FF0000
        XCTAssertEqual(color("p1r3", "decoy"), 0xE0)
    }

    func testAuroraColorOverrideSanitization() {
        let positions = [1: 10]
        // A valid 6-digit hex override is honoured (red).
        XCTAssertEqual(
            singleLedColorByte(
                BoardBleEncoding.makeAuroraPacket(
                    frames: "p1r42",
                    placementPositions: positions,
                    boardName: "kilter",
                    colorOverrides: ["STARTING": "#FF0000"]
                )
            ),
            0xE0
        )
        // Malformed overrides fall back to the canonical color (green 0x1C), NOT
        // black — parity with the TS SIX_DIGIT_HEX_PATTERN guard.
        for bad in ["#fff", "red", "#FF00FF00", "12345g"] {
            XCTAssertEqual(
                singleLedColorByte(
                    BoardBleEncoding.makeAuroraPacket(
                        frames: "p1r42",
                        placementPositions: positions,
                        boardName: "kilter",
                        colorOverrides: ["STARTING": bad]
                    )
                ),
                0x1C,
                "override \"\(bad)\" should fall back to the canonical green"
            )
        }
    }

    func testParseApiLevelMatchesFirstAtSign() {
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Kilter Board#abc123@3"), 3)
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Kilter Board"), 2)
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: nil), 2)
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Board@4"), 4)
        // The FIRST '@' with digits wins (mirrors TS /@(\d+)/), not the last —
        // the old `.backwards` implementation would have returned 9 here.
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Board@2@9"), 2)
        // First '@' has no digits after it; fall through to the next.
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Board@x@5"), 5)
    }

    func testRedBearLabWriteCharacteristicUsesWriteWithResponse() {
        // The original MoonBoard (RedBearLab) write characteristic (713d0003)
        // advertises `.write` only, so iOS must pace it with write-with-response.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "moonboard"), .withResponse)
    }
}
