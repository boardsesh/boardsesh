import CoreBluetooth
import XCTest

// Parity suite for the Swift Woods encoder + the BoardBleManager Woods
// dispatch (#3314). The byte-exact fixtures mirror
// packages/shared/ble-protocol/src/__tests__/woods.test.ts — keep the two in
// lockstep, and docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md is the wire authority.
@available(iOS 17.0, *)
final class WoodsBoardBleTests: XCTestCase {

    private func ledMap(_ sizeId: Int) -> [Int: Int] {
        guard let map = WoodsBoardData.ledMap(forSizeId: sizeId) else {
            XCTFail("expected a Woods LED table for size_id \(sizeId)")
            return [:]
        }
        return map
    }

    private func ascii(_ result: BoardBlePacketResult) -> String {
        String(decoding: result.packet, as: UTF8.self)
    }

    // MARK: - WoodsBoardData (spec §7 table shapes)

    func testLedMapsMatchSpecTableShapes() {
        let eightByTen = ledMap(1)
        let twelveByTwelve = ledMap(2)

        XCTAssertEqual(eightByTen.count, 485)
        XCTAssertEqual(twelveByTwelve.count, 894)
        XCTAssertEqual(eightByTen.keys.min(), 0)
        XCTAssertEqual(eightByTen.keys.max(), 484)
        XCTAssertEqual(twelveByTwelve.keys.min(), 0)
        XCTAssertEqual(twelveByTwelve.keys.max(), 893)
        XCTAssertEqual(eightByTen.values.max(), 484)
        XCTAssertEqual(twelveByTwelve.values.max(), 897)
        // Anchor entries used throughout the byte-exact fixtures below.
        XCTAssertEqual(eightByTen[0], 24)
        XCTAssertEqual(eightByTen[1], 25)
        XCTAssertEqual(twelveByTwelve[0], 28)
        XCTAssertEqual(twelveByTwelve[1], 29)
    }

    func testLedMapSizeIdMappingFollowsWoodsConfig() {
        // WOODS_SIZES in packages/shared/board-config/src/woods-config.ts:
        // size_id 1 = 8x10, size_id 2 = 12x12; anything else is unknown and the
        // caller must refuse the write instead of darkening the wall.
        XCTAssertEqual(WoodsBoardData.ledMap(forSizeId: 1)?[0], 24)
        XCTAssertEqual(WoodsBoardData.ledMap(forSizeId: 2)?[0], 28)
        XCTAssertNil(WoodsBoardData.ledMap(forSizeId: 3))
        XCTAssertNil(WoodsBoardData.ledMap(forSizeId: 0))
    }

    // MARK: - makeWoodsPacket (parity with woods.test.ts)

    func testEncodesSpecWorkedExampleOn12x12() {
        // Spec §10 worked example.
        let result = BoardBleEncoding.makeWoodsPacket(frames: "p0r4p5r2p7r3", ledMap: ledMap(2))
        XCTAssertEqual(ascii(result), "28,4,237,2,341,3,!")
        XCTAssertEqual(result.skippedRoleCount, 0)
        XCTAssertEqual(result.skippedPositionCount, 0)
        XCTAssertEqual(result.totalPlacements, 3)
    }

    func testEncodesSingleHold() {
        let result = BoardBleEncoding.makeWoodsPacket(frames: "p0r4", ledMap: ledMap(2))
        XCTAssertEqual(ascii(result), "28,4,!")
    }

    func testEncodesAllFourWireRolesOn8x10() {
        // Foot 1 / Hand 2 / Finish 3 / Start 4 (spec §6).
        let result = BoardBleEncoding.makeWoodsPacket(frames: "p0r1p1r2p2r3p3r4", ledMap: ledMap(1))
        XCTAssertEqual(ascii(result), "24,1,25,2,116,3,117,4,!")
    }

    func testUsesThePerSizeTable() {
        XCTAssertEqual(ascii(BoardBleEncoding.makeWoodsPacket(frames: "p1r2", ledMap: ledMap(2))), "29,2,!")
        XCTAssertEqual(ascii(BoardBleEncoding.makeWoodsPacket(frames: "p1r2", ledMap: ledMap(1))), "25,2,!")
    }

    func testEmptyFramesIsTheDeliberateClear() {
        // Zero pairs = bare terminator (spec §5); no LED table involved.
        let result = BoardBleEncoding.makeWoodsPacket(frames: "", ledMap: [:])
        XCTAssertEqual(ascii(result), ",!")
        XCTAssertEqual(result.totalPlacements, 0)
    }

    func testRefusesAuroraMultiFrameClimbs() {
        // The JS encoder throws WoodsMultiFrameError; the Swift failure mode is
        // the empty packet the manager already treats as refuse-to-write.
        let result = BoardBleEncoding.makeWoodsPacket(frames: "p0r4,p5r2", ledMap: ledMap(2))
        XCTAssertTrue(result.packet.isEmpty)
    }

    func testSkipsUnknownRoleCodesAndCountsThem() {
        let result = BoardBleEncoding.makeWoodsPacket(frames: "p0r4p1r9", ledMap: ledMap(2))
        XCTAssertEqual(ascii(result), "28,4,!")
        XCTAssertEqual(result.skippedRoleCount, 1)
        XCTAssertEqual(result.skippedPositionCount, 0)
        XCTAssertEqual(result.totalPlacements, 2)
    }

    func testSkipsUnmappedPositionsAndCountsThem() {
        let result = BoardBleEncoding.makeWoodsPacket(frames: "p0r4p999r2", ledMap: ledMap(2))
        XCTAssertEqual(ascii(result), "28,4,!")
        XCTAssertEqual(result.skippedRoleCount, 0)
        XCTAssertEqual(result.skippedPositionCount, 1)
        XCTAssertEqual(result.totalPlacements, 2)
    }

    func testBucketsMalformedPlacementUnderValidRoleAsSkippedPosition() {
        // Role is checked first, then placement — the JS side counts a
        // non-numeric placement with a valid role as a skipped POSITION
        // (Number('X') is NaN, so the map lookup misses), and the two sides'
        // skip telemetry must agree.
        let result = BoardBleEncoding.makeWoodsPacket(frames: "p0r4pXr4", ledMap: ledMap(2))
        XCTAssertEqual(ascii(result), "28,4,!")
        XCTAssertEqual(result.skippedRoleCount, 0)
        XCTAssertEqual(result.skippedPositionCount, 1)
        XCTAssertEqual(result.totalPlacements, 2)
    }

    func testRefusesWhenEveryPlacementSkips() {
        // A non-empty climb that encodes to nothing must never emit the bare
        // `,!` — that would silently dark the wall while reporting success
        // (mirrors the JS dispatcher guard in use-board-bluetooth.ts).
        let allSkipped = BoardBleEncoding.makeWoodsPacket(frames: "p999r2", ledMap: ledMap(2))
        XCTAssertTrue(allSkipped.packet.isEmpty)
        XCTAssertEqual(allSkipped.skippedPositionCount, 1)
        XCTAssertEqual(allSkipped.totalPlacements, 1)
    }

    func testRefusesMalformedFramesInsteadOfClearing() {
        // 'garbage' splits into one token whose role is non-numeric → one
        // skipped role (same as JS: Number('bage') is NaN).
        let garbage = BoardBleEncoding.makeWoodsPacket(frames: "garbage", ledMap: ledMap(2))
        XCTAssertTrue(garbage.packet.isEmpty)
        XCTAssertEqual(garbage.skippedRoleCount, 1)
        XCTAssertEqual(garbage.totalPlacements, 1)

        let missingRole = BoardBleEncoding.makeWoodsPacket(frames: "p12", ledMap: ledMap(2))
        XCTAssertTrue(missingRole.packet.isEmpty)
        XCTAssertEqual(missingRole.skippedRoleCount, 1)
        XCTAssertEqual(missingRole.totalPlacements, 1)

        // All-separator input tokenizes to nothing. JS lets this degenerate
        // case fall through to `,!`; Swift is deliberately stricter and
        // refuses (see the makeWoodsPacket comment).
        let separatorsOnly = BoardBleEncoding.makeWoodsPacket(frames: "ppp", ledMap: ledMap(2))
        XCTAssertTrue(separatorsOnly.packet.isEmpty)
        XCTAssertEqual(separatorsOnly.totalPlacements, 0)
    }
}

// MARK: - Manager dispatch (the woods arm in displayItemOnBleQueue)

/// Drives the production display path against an isolated defaults suite and a
/// fake peripheral, in the style of BoardBleWriteFlowTests: everything settles
/// through `testHooks.sync {}`, acks fire inline, no sleeps.
@available(iOS 17.0, *)
final class WoodsBoardBleManagerTests: XCTestCase {
    private var scheduler: FakeBleTimerScheduler!
    private var manager: BoardBleManager!
    private var suiteName: String!
    private var defaults: UserDefaults!
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")

    override func setUp() {
        super.setUp()
        scheduler = FakeBleTimerScheduler()
        manager = BoardBleManager(timerScheduler: scheduler, createCentralManagerEagerly: false)
        suiteName = "com.boardsesh.rn.woods-ble-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(nil)
        }
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        manager = nil
        scheduler = nil
        super.tearDown()
    }

    private func woodsConfiguration(sizeId: Int = 2) -> BoardBleConfiguration {
        BoardBleConfiguration(
            boardName: "woods",
            layoutId: 1,
            sizeId: sizeId,
            apiLevel: nil,
            deviceName: "Woods Board v2",
            colorOverrides: [:],
            numRows: nil
        )
    }

    private func woodsItem(frames: String, mirrored: Bool = false) -> SharedQueueItem {
        SharedQueueItem(
            uuid: "queue-item",
            climbUuid: "climb-item",
            climbName: "Woods climb",
            difficulty: "7a/V6",
            angle: 40,
            frames: frames,
            setterUsername: "tester",
            mirrored: mirrored
        )
    }

    private func makeCharacteristic() -> CBMutableCharacteristic {
        // NUS RX advertises `.write` (acknowledged) — the property set Woods
        // hardware exposes.
        CBMutableCharacteristic(
            type: uartWriteCharacteristicUuid,
            properties: .write,
            value: nil,
            permissions: [.writeable]
        )
    }

    /// Seed connection + config + shared queue, run the implicit re-light, and
    /// pump with-response acks until the write queue drains.
    private func displayWoods(
        frames: String,
        sizeId: Int = 2,
        mirrored: Bool = false
    ) -> FakeWritablePeripheral {
        let peripheral = FakeWritablePeripheral(name: "Woods Board v2")
        let characteristic = makeCharacteristic()
        let hooks = manager.testHooks
        hooks.sync {
            hooks.setConfiguration(woodsConfiguration(sizeId: sizeId))
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }
        SharedQueueState.save(items: [woodsItem(frames: frames, mirrored: mirrored)], currentIndex: 0, to: defaults)
        hooks.displaySharedCurrentItem(defaults: defaults)
        // With-response flow: each chunk waits for its ack before the next.
        for _ in 0..<100 {
            let writing = hooks.sync { hooks.isWriting }
            if !writing { break }
            hooks.fireWriteAck(error: nil)
        }
        return peripheral
    }

    private func reassembled(_ peripheral: FakeWritablePeripheral) -> String {
        String(decoding: peripheral.writtenChunks.reduce(Data()) { $0 + $1.data }, as: UTF8.self)
    }

    func testDisplaysAWoodsClimbAsAcknowledged20ByteAsciiChunks() {
        // 6 holds on 8x10 → 35 ASCII bytes → exactly 20 + 15.
        let peripheral = displayWoods(frames: "p0r2p1r2p2r2p3r2p4r2p5r2", sizeId: 1)

        XCTAssertEqual(reassembled(peripheral), "24,2,25,2,116,2,117,2,208,2,209,2,!")
        XCTAssertEqual(peripheral.writtenChunks.map(\.data.count), [20, 15])
        for chunk in peripheral.writtenChunks {
            XCTAssertEqual(chunk.type, .withResponse)
            XCTAssertEqual(chunk.characteristicUuid, uartWriteCharacteristicUuid)
        }
    }

    func testDisplayUsesTheConfiguredSizeTable() {
        let peripheral = displayWoods(frames: "p0r4p5r2p7r3", sizeId: 2)
        XCTAssertEqual(reassembled(peripheral), "28,4,237,2,341,3,!")
    }

    func testMirroredItemSendsRawFrames() {
        // Woods mirroring is JS-side geometry; the manager must not route a
        // mirrored item through BoardBleEncoding.mirroredFrames (no Woods rows
        // in BoardPlacementData — it would refuse every climb).
        let peripheral = displayWoods(frames: "p0r4", mirrored: true)
        XCTAssertEqual(reassembled(peripheral), "28,4,!")
        XCTAssertEqual(peripheral.writtenChunks.first?.type, .withResponse)
    }

    func testEmptyFramesItemClearsWithTheWoodsTerminatorNotAnAuroraPacket() {
        // Branch-order regression guard: before the woods arm existed, an
        // empty-frames woods item slipped past the LED-placement guard and
        // wrote an *Aurora* clear packet to the Woods wall.
        let peripheral = displayWoods(frames: "")
        XCTAssertEqual(reassembled(peripheral), ",!")
        XCTAssertEqual(peripheral.writtenChunks.first?.type, .withResponse)
    }

    func testRefusesAnAllSkippedClimbWithoutWriting() {
        let peripheral = displayWoods(frames: "p999r2p998r2")
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
    }

    func testRefusesAnUnknownWoodsSizeWithoutWriting() {
        let peripheral = displayWoods(frames: "p0r4", sizeId: 99)
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
    }

    func testClearPathEmitsTheWoodsTerminator() async {
        // Out-of-range index → clearBoardOnBleQueue → the woods arm's `,!`.
        let peripheral = FakeWritablePeripheral(name: "Woods Board v2")
        let characteristic = makeCharacteristic()
        let hooks = manager.testHooks
        hooks.sync {
            hooks.setConfiguration(woodsConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        let ackPump = Task {
            for _ in 0..<10_000 {
                if Task.isCancelled { return }
                let writing = hooks.sync { hooks.isWriting }
                if writing { hooks.fireWriteAck(error: nil) }
                await Task.yield()
            }
        }
        let cleared = await hooks.displayCurrentItemAwaitingDrain(items: [], currentIndex: 0, drainTimeout: 5.0)
        ackPump.cancel()

        XCTAssertTrue(cleared)
        XCTAssertEqual(reassembled(peripheral), ",!")
        XCTAssertEqual(peripheral.writtenChunks.first?.type, .withResponse)
    }
}
