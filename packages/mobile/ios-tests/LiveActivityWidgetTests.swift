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

    func testReconnectDiagnosticKeepsBleFailureWhenTakeControlAlsoFails() {
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .bleFailure,
                networkResult: .serverRejected
            ),
            .bleFailure
        )
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .bleFailure,
                networkResult: .retryableFailure
            ),
            .bleFailure
        )
    }

    func testReconnectDiagnosticRecordsNetworkFailureAfterSuccessfulBleReconnect() {
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .success,
                networkResult: .serverRejected
            ),
            .serverRejected
        )
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .success,
                networkResult: .retryableFailure
            ),
            .retryableNetworkFailure
        )
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

    func testBoardBleConfigurationDecodesPayloadWithoutAdjacentHoldField() throws {
        let json = """
        {
          "boardName": "moonboard",
          "layoutId": 1,
          "sizeId": 2,
          "apiLevel": null,
          "deviceName": "MoonBoard",
          "colorOverrides": {},
          "numRows": 18
        }
        """

        let configuration = try JSONDecoder().decode(BoardBleConfiguration.self, from: Data(json.utf8))

        XCTAssertNil(configuration.lightAdjacentHolds)
        XCTAssertFalse(configuration.lightAdjacentHolds ?? false)
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

    func testMoonboardPacketClearsForEmptyFrames() {
        // Empty frames = deliberate clear-all: `l##` clears every LED on community
        // firmware (JS parity). totalPlacements 0 (nothing to skip) is what keeps
        // the caller's all-skipped guard from refusing it.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "")
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l##")
        XCTAssertEqual(result.totalPlacements, 0)
        XCTAssertEqual(result.skippedRoleCount, 0)
        XCTAssertEqual(result.skippedPositionCount, 0)
    }

    func testMoonboardPacketIsEmptyWhenAllPlacementsSkipped() {
        // A non-empty climb whose holds all drop (role 45 is not a MoonBoard LED
        // role) must produce no packet so the BLE manager refuses to write and
        // leaves the wall lit as-is — never falls through to the clear-all frame.
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "p1r45").packet.isEmpty)
    }

    func testMoonboardPacketIsEmptyForMalformedFrames() {
        // Corrupt/truncated frames that PARSE to nothing are not a clear: the
        // clear-all gate is the raw empty string, so these must hit the
        // zero-encodable refusal (empty packet), never emit `l##` (#3420).
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "p12").packet.isEmpty)
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "pXr42").packet.isEmpty)
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "garbage").packet.isEmpty)
    }

    func testMoonboardPacketPrefixesV2AdditionalLedMarker() {
        // Parity with moonboard.test.ts "V2 additional-LED prefix": lightAdjacentHolds
        // prepends `~D` to a non-empty frame, asking the firmware to also light each
        // hold's firmware-defined neighbour LED.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p2r43p198r44", lightAdjacentHolds: true)
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "~Dl#S0,P35,E197#")
    }

    func testMoonboardPacketOmitsV2PrefixByDefault() {
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42")
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l#S0#")
    }

    func testMoonboardPacketNeverPrefixesClearAll() {
        // The clear-all `l##` never gets the V2 marker, even when requested —
        // prefixing it has no effect and would needlessly exercise the firmware's
        // empty-string parsing path.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "", lightAdjacentHolds: true)
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l##")
    }

    func testMoonboardPacketNeverPrefixesAllSkippedFrame() {
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "p1r45", lightAdjacentHolds: true).packet.isEmpty)
    }

    func testMoonboardSerialPositionMirrorsGridMath() {
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 1), 0)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 2), 35)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 198), 197)
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 0))
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 199))
    }

    // MARK: - Session queue sync (SessionQueueState.swift)

    private func makeQueueState(uuids: [String], currentIndex: Int) -> QueueStateReducer.QueueState {
        let items = uuids.map { makeQueueItem(uuid: $0, climbUuid: "climb-\($0)", climbName: "Climb \($0)") }
        return QueueStateReducer.QueueState(items: items, currentIndex: currentIndex)
    }

    func testFullSyncIsAcceptedRegardlessOfSequenceGap() {
        // A FullSync is an authoritative snapshot sent on every (re)subscribe.
        // Gap-checking it against the previous connection's sequence caused an
        // infinite reconnect loop after ≥2 events were missed while offline.
        let fullSync = QueueUpdateEvent.fullSync(items: [], currentItem: nil, sequence: 12)
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: fullSync, lastKnown: 3),
            .apply(newLastSequence: 12)
        )

        // Deltas still gap-check: one step ahead applies, a jump resyncs.
        let delta = QueueUpdateEvent.itemRemoved(uuid: "q1", sequence: 5)
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: delta, lastKnown: 4),
            .apply(newLastSequence: 5)
        )
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: delta, lastKnown: 3),
            .resync
        )
        // First event after a (re)connect (lastKnown reset to -1) always applies.
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: delta, lastKnown: -1),
            .apply(newLastSequence: 5)
        )
    }

    func testClimbMirroredUpdatesOnlyTheMatchingItem() {
        var state = makeQueueState(uuids: ["A", "B"], currentIndex: 0)
        state = QueueStateReducer.apply(.climbMirrored(uuid: "B", mirrored: true, sequence: 1), to: state)
        XCTAssertFalse(state.items[0].mirrored)
        XCTAssertTrue(state.items[1].mirrored)
        XCTAssertEqual(state.currentIndex, 0)

        // A nil or unknown uuid is a no-op on the state (the manager still
        // persists + repaints unconditionally after every event, so downstream
        // behaviour matches the pre-refactor code).
        let unchanged = state
        state = QueueStateReducer.apply(.climbMirrored(uuid: nil, mirrored: true, sequence: 2), to: state)
        XCTAssertEqual(state, unchanged)
        state = QueueStateReducer.apply(.climbMirrored(uuid: "missing", mirrored: true, sequence: 3), to: state)
        XCTAssertEqual(state, unchanged)
    }

    func testQueueMutationsAheadOfCurrentKeepTheCurrentItem() {
        // Remove ahead of current: [A, B, C, D] current C → [B, C, D] current C.
        var state = makeQueueState(uuids: ["A", "B", "C", "D"], currentIndex: 2)
        state = QueueStateReducer.apply(.itemRemoved(uuid: "A", sequence: 1), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["B", "C", "D"])
        XCTAssertEqual(state.currentIndex, 1)

        // Insert ahead of current keeps following the item.
        let inserted = makeQueueItem(uuid: "X", climbUuid: "climb-X", climbName: "Climb X")
        state = QueueStateReducer.apply(.itemAdded(item: inserted, position: 0, sequence: 2), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["X", "B", "C", "D"])
        XCTAssertEqual(state.currentIndex, 2)

        // Reorder across the current item keeps following it too.
        state = QueueStateReducer.apply(.reordered(uuid: "D", oldIndex: 3, newIndex: 0, sequence: 3), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["D", "X", "B", "C"])
        XCTAssertEqual(state.currentIndex, 3)

        // Reordering the CURRENT item itself follows it to its new position.
        state = QueueStateReducer.apply(.reordered(uuid: "C", oldIndex: 3, newIndex: 0, sequence: 4), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["C", "D", "X", "B"])
        XCTAssertEqual(state.currentIndex, 0)
    }

    func testRemovingTheCurrentItemFallsToItsSuccessor() {
        var state = makeQueueState(uuids: ["A", "B", "C"], currentIndex: 1)
        state = QueueStateReducer.apply(.itemRemoved(uuid: "B", sequence: 1), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["A", "C"])
        XCTAssertEqual(state.currentIndex, 1) // now C

        // Removing the last item while it is current clamps to the new tail.
        state = QueueStateReducer.apply(.itemRemoved(uuid: "C", sequence: 2), to: state)
        XCTAssertEqual(state.currentIndex, 0)

        // Emptying the queue leaves index 0 into an empty array — every
        // consumer bounds-checks: SharedQueueState.currentItem returns nil, and
        // the implicit re-light then leaves the wall alone (#4544) while the
        // explicit displayCurrentItem path still clears. So this must stay a
        // representable, non-crashing state.
        state = QueueStateReducer.apply(.itemRemoved(uuid: "A", sequence: 3), to: state)
        XCTAssertTrue(state.items.isEmpty)
        XCTAssertEqual(state.currentIndex, 0)
        SharedQueueState.save(items: state.items, currentIndex: state.currentIndex, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))
    }

    func testGraphQLErrorRoutingCoversSubscriptionAndMutationIds() {
        // A subscription-level error must reconnect — it used to fall through
        // the mutation-only handling and was silently dropped while server
        // pings kept the connection looking healthy.
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "1", subscriptionId: "1"),
            .reconnect
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "join-session", subscriptionId: "1"),
            .reconnect
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "mutation-abc123", subscriptionId: "1"),
            .revertOptimisticNavigation(correlationId: "abc123")
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "something-else", subscriptionId: "1"),
            .ignore
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: nil, subscriptionId: "1"),
            .ignore
        )
    }

    func testOffQueueCurrentClimbIsAppendedNotIgnored() {
        // Mirrors the JS reducer's shouldAddToQueue: a peer navigating to a
        // search result (not a queue member) must not leave the stale index
        // repainting the previous climb over theirs.
        let offQueue = makeQueueItem(uuid: "S", climbUuid: "climb-S", climbName: "Search Pick")
        var state = makeQueueState(uuids: ["A", "B"], currentIndex: 0)
        state = QueueStateReducer.apply(.currentClimbChanged(item: offQueue, sequence: 1), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "S"])
        XCTAssertEqual(state.currentIndex, 2)

        // An in-queue current climb just moves the index — no duplicate append.
        state = QueueStateReducer.apply(
            .currentClimbChanged(item: state.items[1], sequence: 2), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "S"])
        XCTAssertEqual(state.currentIndex, 1)
    }

    func testFullSyncWithOffQueueCurrentItemAppendsIt() {
        let items = ["A", "B"].map { makeQueueItem(uuid: $0, climbUuid: "climb-\($0)", climbName: "Climb \($0)") }
        let offQueue = makeQueueItem(uuid: "S", climbUuid: "climb-S", climbName: "Search Pick")
        let state = QueueStateReducer.apply(
            .fullSync(items: items, currentItem: offQueue, sequence: 7),
            to: makeQueueState(uuids: [], currentIndex: 0)
        )
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "S"])
        XCTAssertEqual(state.currentIndex, 2)
    }

    func testMoonboardSerialPositionMiniGridMath() {
        // Parity with moonboard.test.ts §Mini (numRows = 12): the Mini LED strip
        // is 11×12, so the odd-column serpentine reversal folds at row 12 (#3392).
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 1, numRows: 12), 0)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 2, numRows: 12), 23)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 11, numRows: 12), 120)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 12, numRows: 12), 1)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 123, numRows: 12), 12)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 132, numRows: 12), 131)
        // Past the 132-LED Mini strip; valid only on the 18-row wall.
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 133, numRows: 12))
    }

    func testMoonboardPacketEncodesMiniPositions() {
        // Same holds address different LEDs on the two grids: B1 is serial 35 on
        // the 18-row wall but 23 on the 12-row Mini.
        let mini = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p2r43p132r44", numRows: 12)
        XCTAssertEqual(String(decoding: mini.packet, as: UTF8.self), "l#S0,P23,E131#")
        XCTAssertEqual(mini.skippedPositionCount, 0)

        let standard = BoardBleEncoding.makeMoonboardPacket(frames: "p2r43")
        XCTAssertEqual(String(decoding: standard.packet, as: UTF8.self), "l#P35#")
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

    // The disconnect-reason dict feeds the JS `disconnected` event
    // (NativeBleDisconnectEvent) and, through it, the `Bluetooth Disconnected`
    // analytics event — key names and the nil-for-clean contract are load-bearing.
    func testDisconnectReasonBodyIsNilForCleanDisconnect() {
        XCTAssertNil(BoardBleEncoding.disconnectReasonBody(from: nil))
    }

    func testDisconnectReasonBodyCarriesCBErrorFields() {
        let timeout = BoardBleEncoding.disconnectReasonBody(from: CBError(.connectionTimeout))
        XCTAssertEqual(timeout?["errorCode"] as? Int, CBError.connectionTimeout.rawValue)
        XCTAssertEqual(timeout?["errorDomain"] as? String, CBErrorDomain)
        XCTAssertFalse((timeout?["errorDescription"] as? String ?? "").isEmpty)
        // The takeover-vs-idle distinction rides on the code: peer-terminated
        // (another central grabbing the last-connection-wins board) must stay
        // distinguishable from the range/idle timeout above.
        let peerDropped = BoardBleEncoding.disconnectReasonBody(from: CBError(.peripheralDisconnected))
        XCTAssertNotEqual(peerDropped?["errorCode"] as? Int, timeout?["errorCode"] as? Int)
    }

    func testDisconnectReasonBodyWrapsArbitraryNSError() {
        let error = NSError(domain: "com.example.test", code: 42, userInfo: [NSLocalizedDescriptionKey: "boom"])
        let body = BoardBleEncoding.disconnectReasonBody(from: error)
        XCTAssertEqual(body?["errorCode"] as? Int, 42)
        XCTAssertEqual(body?["errorDomain"] as? String, "com.example.test")
        XCTAssertEqual(body?["errorDescription"] as? String, "boom")
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

    // Transport chunk sizing (#3230). Aurora without-response chunks come from
    // the negotiated maximumWriteValueLength clamped to [20, 244] — never the
    // ATT-512-derived 509 the failing iOS 26.5 cohort clusters at. MoonBoard
    // (both controller generations) and any with-response path stay at 20.
    // Twin of `effectiveChunkSizeForMtu` in
    // packages/shared/ble-protocol/src/transport.ts, with one domain
    // difference: this side takes maximumWriteValueLength, which iOS reports
    // as a PAYLOAD length (ATT MTU − 3), while the TS side takes the raw MTU —
    // so the matrices differ by exactly 3 (TS mtu 23 ↔ Swift length 20).
    func testEffectiveChunkSizeClampsAuroraAndPinsMoonboard() {
        // Aurora without-response: clamp to the ATT-247 ceiling (244 payload).
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withoutResponse, boardName: "kilter"), 244)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 512, writeType: .withoutResponse, boardName: "tension"), 244)
        // Pass through negotiated payload lengths inside the window.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 244, writeType: .withoutResponse, boardName: "kilter"), 244)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 182, writeType: .withoutResponse, boardName: "kilter"), 182)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 23, writeType: .withoutResponse, boardName: "kilter"), 23)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 252, writeType: .withoutResponse, boardName: "tension"), 244)
        // Floor at the classic 20: the BLE-default link reports payload 20
        // (ATT 23 − 3); anything below is degenerate and must not shrink chunks.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 20, writeType: .withoutResponse, boardName: "kilter"), 20)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 19, writeType: .withoutResponse, boardName: "kilter"), 20)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 0, writeType: .withoutResponse, boardName: "kilter"), 20)
        // nil board (a JS write before configureBoard) is Aurora-shaped: clamped MTU sizing.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withoutResponse, boardName: nil), 244)
        // MoonBoard stays on the proven 20-byte chunks on BOTH write types.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withoutResponse, boardName: "moonboard"), 20)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withResponse, boardName: "moonboard"), 20)
        // Any with-response path stays at 20 regardless of board.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 512, writeType: .withResponse, boardName: "kilter"), 20)
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
        for bad in ["#fff", "red", "#FF00FF00", "12345g", "ab#cdef"] {
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

}

@available(iOS 17.0, *)
private final class IntentDiagnosticTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var currentDate: Date

    init(currentDate: Date) {
        self.currentDate = currentDate
    }

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return currentDate
    }

    func advance(by interval: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        currentDate = currentDate.addingTimeInterval(interval)
    }
}

@available(iOS 17.0, *)
final class LiveActivityIntentDiagnosticStoreTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!
    private var clock = IntentDiagnosticTestClock(
        currentDate: Date(timeIntervalSince1970: 2_000_000_000)
    )

    override func setUp() {
        super.setUp()
        suiteName = "com.boardsesh.rn.intent-diagnostic-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        clock = IntentDiagnosticTestClock(currentDate: Date(timeIntervalSince1970: 2_000_000_000))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    private func makeStore(
        processId: UUID = UUID(),
        appVersion: String = "2.0.0",
        buildNumber: String = "481",
        maxRecords: Int = 16,
        timeToLive: TimeInterval = 24 * 60 * 60,
        incompleteGrace: TimeInterval = 30
    ) -> LiveActivityIntentDiagnosticStore {
        let clock = self.clock
        return LiveActivityIntentDiagnosticStore(
            defaults: defaults,
            storageKey: "intent-diagnostic-tests",
            processId: processId,
            appVersion: appVersion,
            buildNumber: buildNumber,
            maxRecords: maxRecords,
            timeToLive: timeToLive,
            incompleteGrace: incompleteGrace,
            now: { clock.now() }
        )
    }

    func testRunLifecycleAndNormalEarlyCompletionAreDurableAndIdempotent() throws {
        let store = makeStore()
        let run = store.begin(kind: .nextClimb)

        XCTAssertEqual(store.recordsSnapshot().single?.lastStage, .entered)
        run.mark(.networkStarted)
        XCTAssertEqual(store.recordsSnapshot().single?.lastStage, .networkStarted)

        // Models an ordinary guard return (for example queue bounds). The
        // production intent uses defer, so the same completion always runs.
        run.complete(.navigationOutOfBounds)
        run.mark(.bleStarted)
        run.complete(.success)

        let completed = try XCTUnwrap(store.recordsSnapshot().single)
        XCTAssertEqual(completed.lastStage, .completed)
        XCTAssertEqual(completed.completionClass, .navigationOutOfBounds)
        XCTAssertNil(LiveActivityInterruptedIntentDiagnostic(record: completed))
    }

    func testSameProcessAndCompletedRecordsAreNeverConsumed() {
        let processId = UUID()
        let store = makeStore(processId: processId)
        _ = store.begin(kind: .previousClimb)
        let completed = store.begin(kind: .takeControl)
        completed.complete(.alreadyAllowed)
        clock.advance(by: 60)

        XCTAssertTrue(store.consumeInterruptedRuns().isEmpty)
        XCTAssertEqual(store.recordsSnapshot().count, 2)
    }

    func testPreviousProcessRecordWaitsForGraceThenConsumesOnce() throws {
        let firstProcess = makeStore(processId: UUID())
        _ = firstProcess.begin(kind: .nextClimb)

        clock.advance(by: 29)
        let foregroundProcess = makeStore(processId: UUID())
        XCTAssertTrue(foregroundProcess.consumeInterruptedRuns().isEmpty)

        clock.advance(by: 2)
        let consumed = foregroundProcess.consumeInterruptedRuns()
        XCTAssertEqual(consumed.count, 1)
        let interrupted = try XCTUnwrap(consumed.single)
        XCTAssertEqual(interrupted.intentKind, .nextClimb)
        XCTAssertNotEqual(interrupted.lastStage, .completed)
        XCTAssertNil(interrupted.completionClass)
        let bridgeDiagnostic = try XCTUnwrap(LiveActivityInterruptedIntentDiagnostic(record: interrupted))
        XCTAssertEqual(bridgeDiagnostic.lastStage, .entered)
        XCTAssertEqual(bridgeDiagnostic.bridgePayload["lastStage"] as? String, "entered")
        XCTAssertNil(bridgeDiagnostic.bridgePayload["completionClass"])
        XCTAssertTrue(foregroundProcess.consumeInterruptedRuns().isEmpty)

        // Recreating the consumer with the same durable store still cannot
        // return the consumed run a second time.
        let secondConsumer = makeStore(processId: UUID())
        XCTAssertTrue(secondConsumer.consumeInterruptedRuns().isEmpty)
    }

    func testReactRootMarkerTouchesOnlyIncompleteRunsFromCurrentProcess() {
        let oldProcess = makeStore(processId: UUID())
        _ = oldProcess.begin(kind: .nextClimb)

        let currentProcess = makeStore(processId: UUID())
        _ = currentProcess.begin(kind: .reconnectBoard)
        let completed = currentProcess.begin(kind: .takeControl)
        completed.complete(.success)
        currentProcess.markReactRootMounted()

        let records = currentProcess.recordsSnapshot()
        XCTAssertFalse(records.first(where: { $0.intentKind == .nextClimb })?.reactRootMounted ?? true)
        XCTAssertTrue(records.first(where: { $0.intentKind == .reconnectBoard })?.reactRootMounted ?? false)
        XCTAssertFalse(records.first(where: { $0.intentKind == .takeControl })?.reactRootMounted ?? true)
    }

    func testTimeToLiveAndBuildValidationDiscardInsteadOfReport() {
        let oldBuild = makeStore(processId: UUID(), buildNumber: "480")
        _ = oldBuild.begin(kind: .nextClimb)
        clock.advance(by: 31)

        let newBuild = makeStore(processId: UUID(), buildNumber: "481")
        XCTAssertTrue(newBuild.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(newBuild.recordsSnapshot().isEmpty)

        let currentBuild = makeStore(processId: UUID(), timeToLive: 60)
        _ = currentBuild.begin(kind: .previousClimb)
        clock.advance(by: 61)
        let laterProcess = makeStore(processId: UUID(), timeToLive: 60)
        XCTAssertTrue(laterProcess.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(laterProcess.recordsSnapshot().isEmpty)
    }

    func testCorruptAndWrongSchemaPayloadsFailClosed() {
        defaults.set(Data("not-json".utf8), forKey: "intent-diagnostic-tests")
        let store = makeStore()
        XCTAssertTrue(store.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(store.recordsSnapshot().isEmpty)

        let wrongSchema = Data("{\"schemaVersion\":2,\"records\":[],\"consumed\":[]}".utf8)
        defaults.set(wrongSchema, forKey: "intent-diagnostic-tests")
        XCTAssertTrue(store.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(store.recordsSnapshot().isEmpty)
    }

    func testRingBufferKeepsOnlyNewestBoundedRecords() {
        let store = makeStore(maxRecords: 4)
        for index in 0..<10 {
            _ = store.begin(kind: index.isMultiple(of: 2) ? .nextClimb : .previousClimb)
            clock.advance(by: 1)
        }

        let records = store.recordsSnapshot()
        XCTAssertEqual(records.count, 4)
        XCTAssertEqual(Set(records.map(\.runId)).count, 4)
    }

    func testInterruptedStageProjectionCoversEveryNonCompletedStage() {
        let storedInterruptedStages = Set(
            LiveActivityIntentDiagnosticStage.allCases
                .filter { $0 != .completed }
                .map(\.rawValue)
        )
        let bridgeStages = Set(LiveActivityInterruptedIntentDiagnosticStage.allCases.map(\.rawValue))

        XCTAssertEqual(bridgeStages, storedInterruptedStages)
        for storedStage in LiveActivityIntentDiagnosticStage.allCases {
            let projected = LiveActivityInterruptedIntentDiagnosticStage(rawValue: storedStage.rawValue)
            if storedStage == .completed {
                XCTAssertNil(projected)
            } else {
                XCTAssertEqual(projected?.rawValue, storedStage.rawValue)
            }
        }
    }

    func testPersistedAndBridgedFieldsAreBoundedAndIdentifierFree() throws {
        let store = makeStore(
            appVersion: "2.0.0<script>alert(1)</script>",
            buildNumber: "481\nBearer secret"
        )
        _ = store.begin(kind: .reconnectBoard)
        let record = try XCTUnwrap(store.recordsSnapshot().single)

        XCTAssertEqual(record.appVersion, "2.0.0scriptalert1script")
        XCTAssertEqual(record.buildNumber, "481Bearersecret")
        XCTAssertLessThanOrEqual(record.appVersion.count, 64)
        XCTAssertNotNil(UUID(uuidString: record.runId))
        XCTAssertNotNil(UUID(uuidString: record.processId))

        let bridgeDiagnostic = try XCTUnwrap(LiveActivityInterruptedIntentDiagnostic(record: record))
        let bridgeJson = try JSONSerialization.data(withJSONObject: bridgeDiagnostic.bridgePayload)
        let bridgeText = try XCTUnwrap(String(data: bridgeJson, encoding: .utf8)).lowercased()
        for forbiddenKey in ["userid", "climb", "session", "server", "endpoint", "peripheral", "authtoken"] {
            XCTAssertFalse(bridgeText.contains(forbiddenKey), "unexpected identifier field: \(forbiddenKey)")
        }
    }
}

private extension Array {
    var single: Element? {
        count == 1 ? first : nil
    }
}
