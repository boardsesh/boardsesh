import CoreBluetooth
import XCTest

/// Coverage for the implicit re-light's reading of the App-Group queue copy
/// (#4544): when that copy holds no current climb, the wall must be left alone
/// rather than cleared. The explicit-arguments path — the one
/// SessionWebSocketManager repaints from live session state — must keep
/// clearing, because there an empty queue is authoritative rather than absent.
///
/// Everything runs against an ISOLATED `UserDefaults` suite through
/// `testHooks.displaySharedCurrentItem(defaults:)`, mirroring
/// `LiveActivityWidgetTests`, so a developer machine's real app-group defaults
/// are never read or written. The seam sits below whatever authorisation gate
/// wraps the connect-path callers, so these assertions hold regardless of how
/// a connect is gated.
@available(iOS 17.0, *)
final class BoardBleImplicitRelightStateTests: XCTestCase {
    private var scheduler: FakeBleTimerScheduler!
    private var manager: BoardBleManager!
    private var suiteName: String!
    private var defaults: UserDefaults!
    private var cancelledPeripheralIds: [UUID] = []
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")

    override func setUp() {
        super.setUp()
        suiteName = "com.boardsesh.rn.implicit-relight-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)

        cancelledPeripheralIds = []
        scheduler = FakeBleTimerScheduler()
        manager = BoardBleManager(timerScheduler: scheduler, createCentralManagerEagerly: false)
        let hooks = manager.testHooks
        hooks.sync {
            // A dev machine's app-group defaults could leak a persisted config.
            hooks.setConfiguration(nil)
            hooks.setCancelPeripheralConnectionOverride { [weak self] peripheral in
                self?.cancelledPeripheralIds.append(peripheral.identifier)
            }
        }
    }

    override func tearDown() {
        manager.testHooks.sync {
            manager.testHooks.setCancelPeripheralConnectionOverride(nil)
        }
        manager = nil
        scheduler = nil
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    // MARK: - Helpers
    //
    // `FakeWritablePeripheral` and `FakeBleTimerScheduler` are top-level and
    // shared, but BoardBleWriteFlowTests' own construction helpers are private
    // members of that suite, so they are copied rather than reused.

    private func makeCharacteristic(
        uuid: CBUUID? = nil,
        properties: CBCharacteristicProperties = .writeWithoutResponse
    ) -> CBMutableCharacteristic {
        CBMutableCharacteristic(
            type: uuid ?? uartWriteCharacteristicUuid,
            properties: properties,
            value: nil,
            permissions: [.writeable]
        )
    }

    /// MoonBoard specifically: `makeMoonboardPacket(frames: "")` returns the
    /// 3-byte `l##` clear-all, so an unwanted clear writes real bytes a test can
    /// catch instead of being an invisible no-op.
    private func moonboardConfiguration() -> BoardBleConfiguration {
        BoardBleConfiguration(
            boardName: "moonboard",
            layoutId: 0,
            sizeId: 0,
            apiLevel: nil,
            deviceName: nil,
            colorOverrides: [:],
            numRows: nil
        )
    }

    private func queueItem(frames: String = "p1r42", mirrored: Bool = false) -> SharedQueueItem {
        SharedQueueItem(
            uuid: "queue-item",
            climbUuid: "climb-item",
            climbName: "Test climb",
            difficulty: "6c+/V5",
            angle: 40,
            frames: frames,
            setterUsername: "tester",
            mirrored: mirrored
        )
    }

    /// Seed BOTH the configuration and the connection. `clearBoardOnBleQueue`
    /// bails at its own guards when either is missing, so a test that seeded
    /// only one would pass even with the bug present.
    private func installConnection(_ peripheral: FakeWritablePeripheral) {
        let hooks = manager.testHooks
        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: makeCharacteristic())
        }
    }

    // MARK: - The implicit, shared-state re-light

    func testImplicitRelightWithNoSharedQueueStateLeavesTheWallAlone() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral)

        // The isolated suite has never been written to — the state of every
        // install whose climber has not published a queue yet.
        manager.testHooks.displaySharedCurrentItem(defaults: defaults)

        XCTAssertTrue(
            peripheral.writtenChunks.isEmpty,
            "an absent App-Group queue copy must not clear the wall (#4544)"
        )
    }

    /// Distinct from the absent-state case above: here JS did publish, and what
    /// it published is an empty queue. `SharedQueueState.currentItem` returns
    /// nil for both, and neither is a licence to clear — an explicit clear
    /// comes through `write(hex:)` with empty frames, not through this loader.
    func testImplicitRelightWithAnExplicitlyEmptySharedQueueLeavesTheWallAlone() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral)

        SharedQueueState.save(items: [], currentIndex: 0, to: defaults)
        manager.testHooks.displaySharedCurrentItem(defaults: defaults)

        XCTAssertTrue(
            peripheral.writtenChunks.isEmpty,
            "a published-but-empty queue must not clear the wall either (#4544)"
        )
    }

    func testImplicitRelightWithAnOutOfRangeSharedIndexLeavesTheWallAlone() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral)

        // Stale index rather than absent state: a queue was published, then the
        // index ran past its end.
        SharedQueueState.save(items: [queueItem()], currentIndex: 5, to: defaults)
        manager.testHooks.displaySharedCurrentItem(defaults: defaults)

        XCTAssertTrue(
            peripheral.writtenChunks.isEmpty,
            "a stale out-of-range index must not clear the wall (#4544)"
        )
    }

    func testImplicitRelightWithAValidSharedCurrentClimbStillLights() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral)

        SharedQueueState.save(items: [queueItem()], currentIndex: 0, to: defaults)
        manager.testHooks.displaySharedCurrentItem(defaults: defaults)

        // Only the first chunk goes out synchronously; the rest pace on
        // chunkDelay timers this test deliberately does not fire.
        XCTAssertGreaterThanOrEqual(
            peripheral.writtenChunks.count,
            1,
            "a real current climb must still re-light the wall"
        )
    }

    // MARK: - The explicit, caller-supplied path

    /// The live-session repaint (SessionWebSocketManager) hands in items and an
    /// index directly; an out-of-range index there means "no current climb" and
    /// must still dark the wall. No connect flow, and no reset of
    /// `writtenChunks` (it is `private(set)`) — the assertion is on the delta.
    func testExplicitDisplayCurrentItemWithNoCurrentClimbStillClears() {
        let peripheral = FakeWritablePeripheral()
        let writtenBefore = peripheral.writtenChunks.count

        let hooks = manager.testHooks
        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: makeCharacteristic())
            manager.displayCurrentItem(items: [], currentIndex: 0)
        }

        XCTAssertEqual(peripheral.writtenChunks.count, writtenBefore + 1)
        XCTAssertEqual(peripheral.writtenChunks.last?.data, Data("l##".utf8))
    }
}
