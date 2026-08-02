import CoreBluetooth
import XCTest

// MARK: - Fakes

/// A `WritableBlePeripheral` with no CoreBluetooth backing. `canSendScript`
/// pops one value per read of `canSendWriteWithoutResponse` (mirroring the way
/// the real property can flip between the BLE manager's reads), falling back to
/// `canSendDefault` once the script is drained.
@available(iOS 17.0, *)
final class FakeWritablePeripheral: WritableBlePeripheral {
    let identifier: UUID
    let name: String?
    var canSendDefault: Bool
    var canSendScript: [Bool]
    var maxWriteValueLength: Int
    private(set) var writtenChunks: [(data: Data, characteristicUuid: CBUUID, type: CBCharacteristicWriteType)] = []

    init(
        identifier: UUID = UUID(),
        name: String? = "Test Board",
        canSendDefault: Bool = true,
        canSendScript: [Bool] = [],
        maxWriteValueLength: Int = 20
    ) {
        self.identifier = identifier
        self.name = name
        self.canSendDefault = canSendDefault
        self.canSendScript = canSendScript
        self.maxWriteValueLength = maxWriteValueLength
    }

    var canSendWriteWithoutResponse: Bool {
        if !canSendScript.isEmpty {
            return canSendScript.removeFirst()
        }
        return canSendDefault
    }

    func maximumWriteValueLength(for _: CBCharacteristicWriteType) -> Int {
        maxWriteValueLength
    }

    func writeValue(_ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType) {
        writtenChunks.append((data: data, characteristicUuid: characteristic.uuid, type: type))
    }
}

/// One-shot fake. `fire()` runs the handler inline exactly once, and never once
/// cancelled — modelling a `DispatchWorkItem` that already ran or was cancelled.
@available(iOS 17.0, *)
final class FakeOneShotTimer: BleOneShotTimer {
    let label: String
    private let handler: () -> Void
    private(set) var cancelled = false
    private(set) var fired = false

    init(label: String, handler: @escaping () -> Void) {
        self.label = label
        self.handler = handler
    }

    func cancel() {
        cancelled = true
    }

    func fire() {
        guard !cancelled, !fired else { return }
        fired = true
        handler()
    }
}

/// Repeating fake mirroring `DispatchSourceTimer`. `fire()` runs the stored
/// handler inline (inert once cancelled). `fire(ignoringCancellation: true)`
/// simulates a tick already enqueued when `cancel()` ran, exercising the
/// manager's `===` identity self-guard.
@available(iOS 17.0, *)
final class FakeRepeatingTimer: BleRepeatingTimer {
    private(set) var activated = false
    private(set) var cancelled = false
    private var handler: (() -> Void)?

    func setEventHandler(_ handler: @escaping () -> Void) {
        self.handler = handler
    }

    func schedule(interval _: TimeInterval, leeway _: DispatchTimeInterval) {}

    func activate() {
        activated = true
    }

    func cancel() {
        cancelled = true
    }

    func fire(ignoringCancellation: Bool = false) {
        guard let handler else { return }
        if cancelled, !ignoringCancellation { return }
        handler()
    }
}

@available(iOS 17.0, *)
final class FakeBleTimerScheduler: BleTimerScheduling {
    private(set) var oneShotTimers: [FakeOneShotTimer] = []
    private(set) var repeatingTimers: [FakeRepeatingTimer] = []

    func scheduleOneShot(after _: TimeInterval, label: String, _ handler: @escaping () -> Void) -> BleOneShotTimer {
        let timer = FakeOneShotTimer(label: label, handler: handler)
        oneShotTimers.append(timer)
        return timer
    }

    func makeRepeatingTimer() -> BleRepeatingTimer {
        let timer = FakeRepeatingTimer()
        repeatingTimers.append(timer)
        return timer
    }

    func oneShots(label: String) -> [FakeOneShotTimer] {
        oneShotTimers.filter { $0.label == label }
    }

    func lastOneShot(label: String) -> FakeOneShotTimer? {
        oneShots(label: label).last
    }
}

// MARK: - Tests

/// Characterization suite for the `BoardBleManager` write flow-control path
/// (#3366). Every action is funnelled through `testHooks.sync {}` so the BLE
/// serial queue's dispatch-specific reentrancy runs nested hops inline; the fake
/// timers fire inline. No `XCTestExpectation`, no sleeps.
@available(iOS 17.0, *)
final class BoardBleWriteFlowTests: XCTestCase {
    private var scheduler: FakeBleTimerScheduler!
    private var manager: BoardBleManager!
    private var cancelledPeripheralIds: [UUID] = []
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")

    override func setUp() {
        super.setUp()
        cancelledPeripheralIds = []
        scheduler = FakeBleTimerScheduler()
        manager = BoardBleManager(timerScheduler: scheduler, createCentralManagerEagerly: false)
        let hooks = manager.testHooks
        hooks.sync {
            // A dev machine's app-group defaults could leak a persisted config.
            hooks.setConfiguration(nil)
            // Intercept the sole concrete cancelPeripheralConnection call so a
            // fake peripheral never has to be a CBPeripheral and no
            // CBCentralManager is instantiated.
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
        super.tearDown()
    }

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

    private func kilterConfiguration() -> BoardBleConfiguration {
        BoardBleConfiguration(
            boardName: "kilter",
            layoutId: 1,
            sizeId: 1,
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

    private func waitForWriteQueueDepth(_ expectedDepth: Int) async {
        for _ in 0..<1_000 {
            if manager.testHooks.sync({ manager.testHooks.writeQueueDepth }) == expectedDepth {
                return
            }
            await Task.yield()
        }
        XCTFail("write queue did not reach depth \(expectedDepth)")
    }

    /// Fire the most recently scheduled one-shot with `label`, on the BLE queue.
    private func fireLatestOneShot(label: String) {
        manager.testHooks.sync {
            guard let timer = scheduler.lastOneShot(label: label) else {
                XCTFail("expected a scheduled \(label) timer")
                return
            }
            timer.fire()
        }
    }

    // 1
    func testHappyPathWritesChunksSequentiallyWithChunkDelay() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 50).map { UInt8($0) })

        var completionError: Error?
        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, telemetry in
                completionError = error
                completionTelemetry = telemetry
                completionCount += 1
            }
        }

        // Only the first chunk goes out synchronously; the rest pace on chunkDelay.
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(completionCount, 0)

        fireLatestOneShot(label: "chunkDelay") // -> chunk 2
        fireLatestOneShot(label: "chunkDelay") // -> chunk 3
        fireLatestOneShot(label: "chunkDelay") // -> completion

        XCTAssertEqual(peripheral.writtenChunks.count, 3)
        XCTAssertEqual(peripheral.writtenChunks[0].data, payload.subdata(in: 0 ..< 20))
        XCTAssertEqual(peripheral.writtenChunks[1].data, payload.subdata(in: 20 ..< 40))
        XCTAssertEqual(peripheral.writtenChunks[2].data, payload.subdata(in: 40 ..< 50))
        XCTAssertTrue(peripheral.writtenChunks.allSatisfy { $0.type == .withoutResponse })
        XCTAssertEqual(completionCount, 1)
        XCTAssertNil(completionError)
        XCTAssertEqual(completionTelemetry?.chunkCount, 3)
        XCTAssertEqual(completionTelemetry?.parkCount, 0)
        XCTAssertEqual(completionTelemetry?.writeType, "withoutResponse")
        XCTAssertEqual(completionTelemetry?.writeTypeSource, BoardBleWriteTypeSource.defaultWithoutResponse.rawValue)
    }

    // 2
    func testParkedWriteResumesViaPollerWhenCanSendFlipsWithoutDelegate() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, telemetry in
                completionTelemetry = telemetry
                completionCount += 1
            }
        }

        // Parked: no chunk, poller activated, watchdog armed, resume pending.
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertEqual(scheduler.repeatingTimers.count, 1)
        XCTAssertTrue(scheduler.repeatingTimers[0].activated)
        XCTAssertNotNil(scheduler.lastOneShot(label: "writeResumeWatchdog"))
        XCTAssertTrue(hooks.sync { hooks.hasPendingWriteResume })

        // Tick while still false: stays parked.
        hooks.sync { scheduler.repeatingTimers[0].fire() }
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertTrue(hooks.sync { hooks.hasPendingWriteResume })

        // Flip true and tick: resumes via the poller and finishes.
        peripheral.canSendDefault = true
        hooks.sync { scheduler.repeatingTimers[0].fire() }
        fireLatestOneShot(label: "chunkDelay")

        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(completionCount, 1)
        XCTAssertEqual(completionTelemetry?.lastResumeSource, "poll")
        XCTAssertEqual(completionTelemetry?.parkCount, 1)
        XCTAssertEqual(completionTelemetry?.peripheralIsReadyFired, false)
        XCTAssertEqual(completionTelemetry?.watchdogTripped, false)
        XCTAssertTrue(scheduler.repeatingTimers[0].cancelled)
        XCTAssertTrue(scheduler.lastOneShot(label: "writeResumeWatchdog")?.cancelled ?? false)
    }

    // 3
    func testPeripheralIsReadyCallbackResumesAndCancelsPoller() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, telemetry in
                completionTelemetry = telemetry
                completionCount += 1
            }
        }
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)

        // The delegate callback resumes the parked write, cancelling the poller
        // without any tick having fired.
        peripheral.canSendDefault = true
        hooks.firePeripheralIsReady()
        fireLatestOneShot(label: "chunkDelay")

        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(completionCount, 1)
        XCTAssertEqual(completionTelemetry?.lastResumeSource, "callback")
        XCTAssertEqual(completionTelemetry?.peripheralIsReadyFired, true)
        XCTAssertTrue(scheduler.repeatingTimers[0].cancelled)

        // A stale tick from the cancelled poller (already enqueued when cancel
        // ran) writes nothing: the `===` identity guard bails.
        hooks.sync { scheduler.repeatingTimers[0].fire(ignoringCancellation: true) }
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
    }

    // 4
    func testSynchronousReparkInstallsFreshPollerAndWatchdog() {
        let hooks = manager.testHooks
        // park read = false, poller-tick read = true, writeChunk re-read = false.
        let peripheral = FakeWritablePeripheral(
            canSendDefault: true,
            canSendScript: [false, true, false],
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, telemetry in
                completionTelemetry = telemetry
                completionCount += 1
            }
        }
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertEqual(scheduler.repeatingTimers.count, 1)
        XCTAssertTrue(scheduler.repeatingTimers[0].activated)

        // Poller#1 tick reads true -> resume -> writeChunk re-reads false -> re-park.
        hooks.sync { scheduler.repeatingTimers[0].fire() }

        // Every scripted read was consumed exactly where expected — a leftover
        // entry means a read the scenario never made (the default would then
        // silently answer later reads and mask it).
        XCTAssertTrue(peripheral.canSendScript.isEmpty)
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertEqual(completionCount, 0)
        XCTAssertEqual(hooks.sync { hooks.currentTelemetry?.parkCount }, 2)
        // A fresh poller + watchdog replaced the retired pair.
        XCTAssertEqual(scheduler.repeatingTimers.count, 2)
        XCTAssertTrue(scheduler.repeatingTimers[0].cancelled)
        XCTAssertTrue(scheduler.repeatingTimers[1].activated)
        XCTAssertFalse(scheduler.repeatingTimers[1].cancelled)
        let resumeWatchdogs = scheduler.oneShots(label: "writeResumeWatchdog")
        XCTAssertEqual(resumeWatchdogs.count, 2)
        XCTAssertTrue(resumeWatchdogs[0].cancelled)
        XCTAssertFalse(resumeWatchdogs[1].cancelled)
        XCTAssertTrue(hooks.sync { hooks.hasPendingWriteResume })

        // Second poller tick with canSend truly true completes the write.
        peripheral.canSendDefault = true
        hooks.sync { scheduler.repeatingTimers[1].fire() }
        fireLatestOneShot(label: "chunkDelay")

        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(completionCount, 1)
        XCTAssertEqual(completionTelemetry?.lastResumeSource, "poll")
    }

    // 5
    // iOS 26.x "stuck false" signature: the watchdog trips with
    // canSendWriteWithoutResponse still false and peripheralIsReady never fired.
    // Rather than cycle the link (which never clears the stuck property and leaves
    // the wall dark), latch past the gate for this connection and push the parked
    // write through — the false reading is a lie, the radio takes the write.
    func testWatchdogTripWithStuckFalseBypassesGateAndCompletesWrite() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionError: Error?
        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, telemetry in
                completionError = error
                completionTelemetry = telemetry
                completionCount += 1
            }
        }
        // Parked, not written, gate still armed.
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertFalse(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })

        // Watchdog trips with canSend STILL false -> latch bypass, resume the
        // parked write, write the chunk despite the false gate.
        fireLatestOneShot(label: "writeResumeWatchdog")

        XCTAssertTrue(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(completionCount, 0)
        // No link cycle: the board is not disconnected and the recovery budget is
        // untouched.
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveries }, 0)
        XCTAssertNil(scheduler.lastOneShot(label: "writeStallRecoveryWatchdog"))
        // Poller + watchdog retired by the resume.
        XCTAssertTrue(scheduler.repeatingTimers[0].cancelled)
        XCTAssertTrue(scheduler.lastOneShot(label: "writeResumeWatchdog")?.cancelled ?? false)

        // The trailing chunkDelay completes the write successfully.
        fireLatestOneShot(label: "chunkDelay")
        XCTAssertEqual(completionCount, 1)
        XCTAssertNil(completionError)
        XCTAssertEqual(completionTelemetry?.watchdogTripped, true)
        XCTAssertEqual(completionTelemetry?.canSendAtTrip, false)
        XCTAssertEqual(completionTelemetry?.lastResumeSource, "bypass")
        XCTAssertEqual(completionTelemetry?.finalWriteType, "withoutResponse")
        XCTAssertEqual(completionTelemetry?.writeTypeSource, BoardBleWriteTypeSource.defaultWithoutResponse.rawValue)
        XCTAssertFalse(hooks.sync {
            hooks.hasLearnedWriteWithResponseEntry(identity: "peripheral:\(peripheral.identifier.uuidString)")
        })
    }

    // 5b
    // Once bypass is latched, later writes on the SAME connection skip the gate
    // entirely — no park, no watchdog — even with canSend still false.
    func testBypassLatchMakesSubsequentWritesSkipTheGate() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: Data((0 ..< 10).map { UInt8($0) })) { _, _ in }
        }
        fireLatestOneShot(label: "writeResumeWatchdog") // latch bypass, write first send
        fireLatestOneShot(label: "chunkDelay") // complete first send
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertTrue(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })

        // Second send: writes immediately, no park (hasPendingWriteResume stays
        // false), canSend never consulted as a gate.
        let repeatingTimersBefore = scheduler.repeatingTimers.count
        hooks.sync {
            manager.write(data: Data((100 ..< 105).map { UInt8($0) })) { _, _ in }
        }
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertEqual(peripheral.writtenChunks[1].data, Data((100 ..< 105).map { UInt8($0) }))
        XCTAssertFalse(hooks.sync { hooks.hasPendingWriteResume })
        // No new poller was armed for the second write.
        XCTAssertEqual(scheduler.repeatingTimers.count, repeatingTimersBefore)
    }

    // 5c
    // A fresh connection re-arms the gate: the bypass latch must not persist
    // across reconnects, so a healthy new link earns normal backpressure again.
    func testReconnectClearsBypassLatch() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: Data((0 ..< 10).map { UInt8($0) })) { _, _ in }
        }
        fireLatestOneShot(label: "writeResumeWatchdog") // latch bypass, resume + write chunk
        fireLatestOneShot(label: "chunkDelay") // drain the first write (clears isWriting/queue)
        XCTAssertTrue(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })
        XCTAssertFalse(hooks.sync { hooks.isWriting })

        // Reconnect (new characteristic) clears the latch.
        hooks.sync { hooks.setConnection(peripheral: peripheral, characteristic: characteristic) }
        XCTAssertFalse(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })

        // The next write on the re-armed link parks again on the false gate.
        hooks.sync {
            manager.write(data: Data((0 ..< 10).map { UInt8($0) })) { _, _ in }
        }
        XCTAssertTrue(hooks.sync { hooks.hasPendingWriteResume })
    }

    // 5d
    // A Kilter box whose RX characteristic advertises ONLY `.write` (no
    // `.writeWithoutResponse` bit — the original MoonBoard box's signature, and
    // some Kilter-built controllers). The app starts it on without-response
    // (Aurora default), the write parks and the watchdog trips with canSend stuck
    // false. Because the characteristic can't take a no-response write at all,
    // switch THIS connection to write-with-response instead of bypassing the gate,
    // and remember the board so a reconnect skips the stall.
    func testWatchdogTripOnWriteOnlyCharacteristicSwitchesToWriteWithResponse() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 244)
        let characteristic = makeCharacteristic(properties: .write)
        let payload = Data((0 ..< 50).map { UInt8($0) })

        var completionError: Error?
        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, telemetry in
                completionError = error
                completionTelemetry = telemetry
                completionCount += 1
            }
        }
        // Started on the Aurora without-response path: parked on the false gate,
        // neither latch set yet.
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertFalse(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertFalse(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })
        XCTAssertFalse(hooks.sync {
            hooks.hasLearnedWriteWithResponseEntry(identity: "peripheral:\(peripheral.identifier.uuidString)")
        })

        // Watchdog trips with canSend STILL false -> `.write`-only characteristic
        // -> switch to write-with-response and fire the chunk on that path.
        fireLatestOneShot(label: "writeResumeWatchdog")

        XCTAssertTrue(hooks.sync { hooks.forceWriteWithResponse })
        // Did NOT take the stuck-false bypass (that keeps without-response).
        XCTAssertFalse(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })
        // The board is remembered for next time.
        XCTAssertTrue(hooks.sync { hooks.writeWithResponsePeripheralIds.contains(peripheral.identifier) })
        XCTAssertFalse(hooks.sync {
            hooks.hasLearnedWriteWithResponseEntry(identity: "peripheral:\(peripheral.identifier.uuidString)")
        })
        // The fallback request is rebuilt into 20-byte with-response chunks
        // before the parked write resumes. The original without-response request
        // would have been one 50-byte chunk at this negotiated MTU.
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(peripheral.writtenChunks[0].type, .withResponse)
        XCTAssertEqual(peripheral.writtenChunks[0].data, payload.subdata(in: 0 ..< 20))
        XCTAssertNotNil(scheduler.lastOneShot(label: "writeAckWatchdog"))
        XCTAssertEqual(completionCount, 0)
        // No link cycle: not disconnected, recovery budget untouched.
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveries }, 0)

        // The board's acks complete all fallback chunks.
        hooks.fireWriteAck(error: nil)
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertEqual(peripheral.writtenChunks[1].type, .withResponse)
        XCTAssertEqual(peripheral.writtenChunks[1].data, payload.subdata(in: 20 ..< 40))
        XCTAssertEqual(completionCount, 0)

        hooks.fireWriteAck(error: nil)
        XCTAssertEqual(peripheral.writtenChunks.count, 3)
        XCTAssertEqual(peripheral.writtenChunks[2].type, .withResponse)
        XCTAssertEqual(peripheral.writtenChunks[2].data, payload.subdata(in: 40 ..< 50))
        XCTAssertEqual(completionCount, 0)

        hooks.fireWriteAck(error: nil)
        XCTAssertEqual(completionCount, 1)
        XCTAssertNil(completionError)
        XCTAssertEqual(completionTelemetry?.watchdogTripped, true)
        XCTAssertEqual(completionTelemetry?.canSendAtTrip, false)
        XCTAssertEqual(completionTelemetry?.lastResumeSource, "withResponse")
        XCTAssertEqual(completionTelemetry?.initialWriteType, "withoutResponse")
        XCTAssertEqual(completionTelemetry?.finalWriteType, "withResponse")
        XCTAssertEqual(completionTelemetry?.writeTypeSource, BoardBleWriteTypeSource.watchdogFallback.rawValue)
        XCTAssertEqual(completionTelemetry?.chunkSize, 20)
        XCTAssertEqual(completionTelemetry?.chunkCount, 3)
        XCTAssertTrue(hooks.sync {
            hooks.hasLearnedWriteWithResponseEntry(identity: "peripheral:\(peripheral.identifier.uuidString)")
        })
    }

    // 5e
    // Once a board is learned to need write-with-response, a reconnect starts it
    // on that path immediately — no repeat of the one-time without-response stall.
    func testLearnedWriteWithResponsePersistsAcrossReconnect() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .write)

        // First connection: learn via the stall -> switch -> ack.
        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: Data((0 ..< 10).map { UInt8($0) })) { _, _ in }
        }
        fireLatestOneShot(label: "writeResumeWatchdog")
        hooks.fireWriteAck(error: nil)
        XCTAssertTrue(hooks.sync { hooks.forceWriteWithResponse })

        // Reconnect to the same board: the latch is re-seeded from the learned set
        // straight away.
        hooks.sync { hooks.setConnection(peripheral: peripheral, characteristic: characteristic) }
        XCTAssertTrue(hooks.sync { hooks.forceWriteWithResponse })

        // A fresh write goes out with-response with NO park — even though canSend
        // is still false, the without-response gate is never consulted.
        let writtenBefore = peripheral.writtenChunks.count
        hooks.sync {
            manager.write(data: Data((100 ..< 110).map { UInt8($0) })) { _, _ in }
        }
        XCTAssertEqual(peripheral.writtenChunks.count, writtenBefore + 1)
        XCTAssertEqual(peripheral.writtenChunks.last?.type, .withResponse)
        XCTAssertFalse(hooks.sync { hooks.hasPendingWriteResume })
    }

    // 5f
    func testWriteOnlyFallbackDoesNotPersistWhenWithResponseAckFails() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .write)

        var completionError: Error?
        var secondCompletionError: Error?
        var secondCompletionCount = 0

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: Data((0 ..< 10).map { UInt8($0) })) { error, _ in
                completionError = error
            }
        }
        fireLatestOneShot(label: "writeResumeWatchdog")
        hooks.fireWriteAck(error: NSError(domain: "BoardBleWriteFlowTests", code: 1))

        XCTAssertNotNil(completionError)
        XCTAssertFalse(hooks.sync {
            hooks.hasLearnedWriteWithResponseEntry(identity: "peripheral:\(peripheral.identifier.uuidString)")
        })

        hooks.sync {
            manager.write(data: Data((100 ..< 110).map { UInt8($0) })) { error, _ in
                secondCompletionError = error
                secondCompletionCount += 1
            }
        }
        XCTAssertEqual(peripheral.writtenChunks.last?.type, .withResponse)
        hooks.fireWriteAck(error: nil)

        XCTAssertEqual(secondCompletionCount, 1)
        XCTAssertNil(secondCompletionError)
        XCTAssertFalse(hooks.sync {
            hooks.hasLearnedWriteWithResponseEntry(identity: "peripheral:\(peripheral.identifier.uuidString)")
        })
    }

    // 5g
    // Issue #3235 reversible fallback. A `.write`-only-reading box that ALSO never
    // acks a with-response write (a marginal box, or a stale GATT cache that
    // dropped `.writeWithoutResponse` from a box that really wants without-response)
    // must not get link-cycled/disconnected. After the switch to with-response
    // stalls too, revert THIS connection to the without-response gate bypass and
    // re-fire the same chunk — identical to the pre-fix behaviour.
    func testForcedWithResponseAlsoStallsRevertsToWithoutResponseBypass() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .write)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionError: Error?
        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, telemetry in
                completionError = error
                completionTelemetry = telemetry
                completionCount += 1
            }
        }

        // Without-response stalls -> switch to with-response (chunk out with-response).
        fireLatestOneShot(label: "writeResumeWatchdog")
        XCTAssertTrue(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(peripheral.writtenChunks[0].type, .withResponse)

        // With-response ALSO never acks -> revert to without-response bypass and
        // re-fire the SAME chunk without-response. No link cycle, board learned-set
        // cleared, gate now bypassed.
        fireLatestOneShot(label: "writeAckWatchdog")
        XCTAssertFalse(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertTrue(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })
        XCTAssertTrue(hooks.sync { hooks.writeWithResponsePeripheralIds.isEmpty })
        XCTAssertFalse(hooks.sync {
            hooks.hasLearnedWriteWithResponseEntry(identity: "peripheral:\(peripheral.identifier.uuidString)")
        })
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertEqual(peripheral.writtenChunks[1].type, .withoutResponse)
        // Crucially NOT cycled/disconnected — that is the whole point vs today.
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveries }, 0)
        XCTAssertEqual(completionCount, 0)

        // The trailing chunkDelay completes the (now without-response) write.
        fireLatestOneShot(label: "chunkDelay")
        XCTAssertEqual(completionCount, 1)
        XCTAssertNil(completionError)
        XCTAssertEqual(completionTelemetry?.lastResumeSource, "withResponseRevert")
        XCTAssertEqual(completionTelemetry?.writeType, "withoutResponse")
        XCTAssertEqual(completionTelemetry?.writeTypeSource, BoardBleWriteTypeSource.defaultWithoutResponse.rawValue)
    }

    // 5h
    func testPersistedSerialIdentitySeedsWriteWithResponseOnReconnect() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(
            name: "Kilter Board#751737@2",
            canSendDefault: false,
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .write)
        let learnedAt = Date().timeIntervalSince1970

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setLearnedWriteWithResponseEntry(identity: "aurora:751737", learnedAt: learnedAt)
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        XCTAssertTrue(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertEqual(hooks.sync { hooks.forceWriteWithResponseSource }, .learnedPersistentFallback)

        let writtenBefore = peripheral.writtenChunks.count
        hooks.sync {
            manager.write(data: Data((100 ..< 110).map { UInt8($0) })) { _, _ in }
        }

        XCTAssertEqual(peripheral.writtenChunks.count, writtenBefore + 1)
        XCTAssertEqual(peripheral.writtenChunks.last?.type, .withResponse)
        XCTAssertFalse(hooks.sync { hooks.hasPendingWriteResume })
    }

    // 5i
    func testExpiredPersistedWriteWithResponseIdentityIsIgnored() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(
            name: "Kilter Board#751737@2",
            canSendDefault: false,
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .write)
        let expiredLearnedAt = Date().addingTimeInterval(-(91 * 24 * 60 * 60)).timeIntervalSince1970

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setLearnedWriteWithResponseEntry(identity: "aurora:751737", learnedAt: expiredLearnedAt)
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        XCTAssertFalse(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertFalse(hooks.sync { hooks.hasLearnedWriteWithResponseEntry(identity: "aurora:751737") })
    }

    // 5j — A bare-name Aurora box (no `#serial@apiLevel` suffix) is a mid-2025+
    // Kilter-built, write-with-response-only box. Start it on write-with-response
    // from the FIRST connect (no stall first), driven by the advertised name. A
    // healthy serial'd box never matches, so this can't regress the fleet (#3228).
    func testBareNameAuroraBoxStartsWriteWithResponseFromFirstConnect() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(
            name: "Kilter Board",
            canSendDefault: false,
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .write)

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        XCTAssertTrue(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertEqual(hooks.sync { hooks.forceWriteWithResponseSource }, .bareNameHint)

        let writtenBefore = peripheral.writtenChunks.count
        hooks.sync {
            manager.write(data: Data((0 ..< 10).map { UInt8($0) })) { _, _ in }
        }

        // First write goes out with-response immediately — no without-response stall.
        XCTAssertEqual(peripheral.writtenChunks.count, writtenBefore + 1)
        XCTAssertEqual(peripheral.writtenChunks.last?.type, .withResponse)
    }

    // 5k — A healthy box that carries a serial in its name keeps the faster
    // without-response path: the bare-name hint must NOT fire for it.
    func testSerialNamedBoxDoesNotGetBareNameHint() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(
            name: "Kilter Board#751737@3",
            canSendDefault: true,
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        XCTAssertFalse(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertNil(hooks.sync { hooks.forceWriteWithResponseSource })
    }

    // 5l — A Kilter-built (bare-name) box paces each with-response chunk 100 ms
    // apart ON TOP of the ack, matching its own app. The ack alone does not
    // advance; the next chunk waits on a `kilterChunkDelay` one-shot.
    func testBareNameKilterBoxPacesWithResponseChunksWith100msDelay() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(
            name: "Kilter Board",
            canSendDefault: false,
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .write)
        let payload = Data((0 ..< 40).map { UInt8($0) }) // 2 chunks

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, _ in }
        }

        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(peripheral.writtenChunks[0].type, .withResponse)

        // Ack alone does NOT advance — the next chunk waits on the 100 ms delay.
        hooks.fireWriteAck(error: nil)
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertNotNil(scheduler.lastOneShot(label: "kilterChunkDelay"))

        // Firing the delay sends chunk 2.
        fireLatestOneShot(label: "kilterChunkDelay")
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertTrue(peripheral.writtenChunks.allSatisfy { $0.type == .withResponse })
    }

    // 5m — A serial'd Aurora box that reached with-response via the learned
    // fallback is NOT a bare-name Kilter box: it stays ack-only (the fast path),
    // so the ack advances the next chunk immediately with no `kilterChunkDelay`.
    func testAuroraWithResponseFallbackDoesNotAdd100msDelay() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(
            name: "Kilter Board#751737@2",
            canSendDefault: false,
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .write)
        let payload = Data((0 ..< 40).map { UInt8($0) }) // 2 chunks

        hooks.sync {
            hooks.setConfiguration(kilterConfiguration())
            hooks.setLearnedWriteWithResponseEntry(identity: "aurora:751737", learnedAt: Date().timeIntervalSince1970)
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, _ in }
        }

        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(hooks.sync { hooks.forceWriteWithResponseSource }, .learnedPersistentFallback)

        // Ack advances immediately — no delay timer for a serial'd Aurora box.
        hooks.fireWriteAck(error: nil)
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertTrue(peripheral.writtenChunks.allSatisfy { $0.type == .withResponse })
    }

    // 6
    func testWatchdogTripRecordsCanSendAtTripTrueWhenPollerMissedFlip() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionTelemetry: BoardBleWriteTelemetry?

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, telemetry in
                completionTelemetry = telemetry
            }
        }

        // The property flipped true but no poller tick observed it.
        peripheral.canSendDefault = true
        fireLatestOneShot(label: "writeResumeWatchdog")

        XCTAssertEqual(completionTelemetry?.watchdogTripped, true)
        XCTAssertEqual(completionTelemetry?.canSendAtTrip, true)
    }

    // 7
    func testWatchdogTripWithPeripheralGoneOmitsCanSendAtTrip() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionError: Error?
        var completionTelemetry: BoardBleWriteTelemetry?

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, telemetry in
                completionError = error
                completionTelemetry = telemetry
            }
        }

        // The peripheral vanished before the watchdog ran.
        hooks.sync { hooks.setConnection(peripheral: nil, characteristic: nil) }
        fireLatestOneShot(label: "writeResumeWatchdog")

        XCTAssertEqual(completionError as? BoardBleError, .writeTimedOut)
        XCTAssertEqual(completionTelemetry?.watchdogTripped, true)
        XCTAssertNil(completionTelemetry?.canSendAtTrip)
        // No link to cycle: the intentional-cancel path is not taken and the
        // recovery budget is untouched.
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveries }, 0)
    }

    // 8
    // The recovery-budget boundary is now reached via the poller-missed-flip
    // route (canSendAtTrip == true): stuck-false (canSendAtTrip == false) latches
    // the gate bypass instead, so it never cycles the link. This exercises the
    // remaining handleWriteStall path — beyond budget -> writeRecoveryFailed +
    // disconnect — with the property reading true at trip.
    func testWatchdogTripBeyondRecoveryBudgetFailsWithRecoveryFailedAndEmitsDisconnect() {
        let hooks = manager.testHooks
        // Park read = false; the watchdog's canSendAtTrip read = true (the poller
        // never observed the flip).
        let peripheral = FakeWritablePeripheral(
            canSendDefault: true,
            canSendScript: [false],
            maxWriteValueLength: 20
        )
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var disconnectDeviceId: String?
        var disconnectBody: [String: Any]?
        var completionError: Error?

        hooks.sync {
            manager.setEventHandlers(
                onScanResult: nil,
                onDisconnect: { deviceId, body in
                    disconnectDeviceId = deviceId
                    disconnectBody = body
                },
                onConnected: nil
            )
            // Already at the recovery budget: the next stall gives up.
            hooks.setWriteStallRecoveries(2)
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, _ in
                completionError = error
            }
        }
        // Parked on the scripted false read; the bypass latch is NOT set.
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertFalse(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })

        fireLatestOneShot(label: "writeResumeWatchdog")

        // canSendAtTrip read true -> no bypass -> handleWriteStall -> over budget.
        XCTAssertFalse(hooks.sync { hooks.bypassCanSendWriteWithoutResponse })

        XCTAssertEqual(completionError as? BoardBleError, .writeRecoveryFailed)
        XCTAssertEqual(disconnectDeviceId, peripheral.identifier.uuidString)
        XCTAssertEqual(disconnectBody?["context"] as? String, "write_stall_budget_exhausted")
        XCTAssertEqual(cancelledPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveries }, 0)
        XCTAssertNil(hooks.sync { hooks.writeStallRecoveringPeripheralId })
    }

    // 9
    func testFailQueuedWritesCancelsPollerWatchdogAndSettlesAllCompletions() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let head = Data((0 ..< 10).map { UInt8($0) })
        let second = Data((100 ..< 108).map { UInt8($0) })

        var headError: Error?
        var headTelemetry: BoardBleWriteTelemetry?
        var headSettled = false
        var secondError: Error?
        var secondTelemetryWasNil = false
        var secondSettled = false

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: head) { error, telemetry in
                headError = error
                headTelemetry = telemetry
                headSettled = true
            }
            manager.write(data: second) { error, telemetry in
                secondError = error
                secondTelemetryWasNil = telemetry == nil
                secondSettled = true
            }
        }
        // Head parked, second queued behind it.
        XCTAssertTrue(hooks.sync { hooks.hasPendingWriteResume })
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 2)
        let generationBeforeCancel = hooks.sync { hooks.writeGeneration }

        manager.cancelWrites()
        // cancelWrites hops through runOnBleQueue; settle it with a barrier.
        hooks.sync {}

        XCTAssertTrue(headSettled)
        XCTAssertEqual(headError as? BoardBleError, .writeCancelled)
        XCTAssertEqual(headTelemetry?.parkCount, 1)
        XCTAssertTrue(secondSettled)
        XCTAssertEqual(secondError as? BoardBleError, .writeCancelled)
        XCTAssertTrue(secondTelemetryWasNil)
        XCTAssertTrue(scheduler.repeatingTimers[0].cancelled)
        XCTAssertTrue(scheduler.lastOneShot(label: "writeResumeWatchdog")?.cancelled ?? false)
        XCTAssertFalse(hooks.sync { hooks.hasPendingWriteResume })
        XCTAssertFalse(hooks.sync { hooks.isWriting })
        XCTAssertGreaterThan(hooks.sync { hooks.writeGeneration }, generationBeforeCancel)

        // A fresh write on the same (still-connected) peripheral proceeds.
        peripheral.canSendDefault = true
        let fresh = Data((0 ..< 5).map { UInt8($0) })
        hooks.sync {
            manager.write(data: fresh) { _, _ in }
        }
        fireLatestOneShot(label: "chunkDelay")
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(peripheral.writtenChunks[0].data, fresh)
    }

    // 10
    func testStalePollerTickAfterCancelIsInert() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, _ in }
        }
        manager.cancelWrites()
        hooks.sync {}

        // The poller was cancelled by failQueuedWrites; a tick already enqueued
        // at cancel time must write nothing even with canSend flipped true.
        peripheral.canSendDefault = true
        hooks.sync { scheduler.repeatingTimers[0].fire(ignoringCancellation: true) }

        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
    }

    // 11
    func testStaleResumeClosureAfterGenerationBumpIsInert() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        hooks.sync {
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { _, _ in }
        }
        let staleResume = hooks.sync { hooks.capturedPendingWriteResume }
        XCTAssertNotNil(staleResume)

        manager.cancelWrites()
        hooks.sync {}

        // Invoking the stale continuation after the write-generation bump: the
        // generation guard in writeChunk bails.
        peripheral.canSendDefault = true
        hooks.sync { staleResume?() }
        // Barrier for the defensive bleQueue.async reschedule in writeChunk.
        hooks.sync {}

        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
        XCTAssertFalse(hooks.sync { hooks.isWriting })
    }

    // 12
    func testWithResponseWritePacesOnAckAndArmsAckWatchdog() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 20)
        let redBearLabServiceUuid = CBUUID(string: "713D0000-503E-4C75-BA94-3148F18D941E")
        let expectedWriteUuid = CBUUID(string: "713D0003-503E-4C75-BA94-3148F18D941E")
        let selectedWriteUuid = hooks.writeCharacteristicUuidForTesting(serviceUuid: redBearLabServiceUuid)
        XCTAssertEqual(selectedWriteUuid, expectedWriteUuid)

        // The production RedBearLab service mapping selects 713D0003. Its
        // `.write`-only property must use ACK-paced write-with-response.
        let characteristic = makeCharacteristic(uuid: selectedWriteUuid, properties: .write)
        let payload = Data((0 ..< 40).map { UInt8($0) })

        var completionError: Error?
        var completionTelemetry: BoardBleWriteTelemetry?
        var completionCount = 0

        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, telemetry in
                completionError = error
                completionTelemetry = telemetry
                completionCount += 1
            }
        }

        // First chunk out with-response; paced on the ack, not chunkDelay.
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(peripheral.writtenChunks[0].characteristicUuid, expectedWriteUuid)
        XCTAssertEqual(peripheral.writtenChunks[0].type, .withResponse)
        XCTAssertEqual(peripheral.writtenChunks[0].data.count, 20)
        XCTAssertNotNil(scheduler.lastOneShot(label: "writeAckWatchdog"))
        XCTAssertEqual(completionCount, 0)

        hooks.fireWriteAck(error: nil) // -> chunk 2
        XCTAssertEqual(peripheral.writtenChunks.count, 2)

        hooks.fireWriteAck(error: nil) // -> completion
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertTrue(peripheral.writtenChunks.allSatisfy { $0.type == .withResponse })
        XCTAssertTrue(peripheral.writtenChunks.allSatisfy { $0.characteristicUuid == expectedWriteUuid })
        XCTAssertEqual(completionCount, 1)
        XCTAssertNil(completionError)
        XCTAssertEqual(completionTelemetry?.writeType, "withResponse")
        XCTAssertEqual(completionTelemetry?.writeTypeSource, BoardBleWriteTypeSource.moonboardCharacteristic.rawValue)
    }

    func testIntentDisplaySucceedsOnlyAfterItsRequestAndGlobalQueueDrain() async {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 512)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        let resultTask = Task {
            await hooks.displayCurrentItemAwaitingDrain(
                items: [queueItem()],
                currentIndex: 0,
                drainTimeout: 1
            )
        }
        await waitForWriteQueueDepth(1)

        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        fireLatestOneShot(label: "chunkDelay")

        let succeeded = await resultTask.value
        XCTAssertTrue(succeeded)
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 0)
        XCTAssertFalse(hooks.sync { hooks.isWriting })
    }

    func testIntentDisplayReportsEncodingAndEnqueueFailures() async {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 512)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }
        let encodingSucceeded = await hooks.displayCurrentItemAwaitingDrain(
            items: [queueItem(frames: "garbage")],
            currentIndex: 0,
            drainTimeout: 1
        )
        XCTAssertFalse(encodingSucceeded)
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)

        hooks.sync {
            hooks.setConnection(peripheral: nil, characteristic: nil)
        }
        let enqueueSucceeded = await hooks.displayCurrentItemAwaitingDrain(
            items: [queueItem()],
            currentIndex: 0,
            drainTimeout: 1
        )
        XCTAssertFalse(enqueueSucceeded)
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)
    }

    func testIntentDisplayReportsWriteFailureAfterQueueDrains() async {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 512)
        let characteristic = makeCharacteristic(properties: .write)

        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        let resultTask = Task {
            await hooks.displayCurrentItemAwaitingDrain(
                items: [queueItem()],
                currentIndex: 0,
                drainTimeout: 1
            )
        }
        await waitForWriteQueueDepth(1)
        hooks.fireWriteAck(error: BoardBleError.writeCancelled)

        let succeeded = await resultTask.value
        XCTAssertFalse(succeeded)
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 0)
        XCTAssertFalse(hooks.sync { hooks.isWriting })
    }

    func testIntentDisplayDrainTimeoutStaysFailureWhenWriteFinishesLater() async {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 512)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        let resultTask = Task {
            await hooks.displayCurrentItemAwaitingDrain(
                items: [queueItem()],
                currentIndex: 0,
                drainTimeout: 0
            )
        }
        await waitForWriteQueueDepth(1)

        let initialResult = await resultTask.value
        XCTAssertFalse(initialResult)
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 1)

        peripheral.canSendDefault = true
        hooks.sync { scheduler.repeatingTimers[0].fire() }
        fireLatestOneShot(label: "chunkDelay")

        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 0)
        XCTAssertFalse(hooks.sync { hooks.isWriting })
        // Reading the already-completed task again proves the late per-request
        // callback cannot turn the timed-out diagnostic result into success.
        let resultAfterLateCompletion = await resultTask.value
        XCTAssertFalse(resultAfterLateCompletion)
    }

    func testIntentDisplayNeedsGlobalDrainAfterSpecificRequestSucceeds() async {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 512)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        let resultTask = Task {
            await hooks.displayCurrentItemAwaitingDrain(
                items: [queueItem()],
                currentIndex: 0,
                drainTimeout: 1
            )
        }
        await waitForWriteQueueDepth(1)

        hooks.sync {
            manager.write(data: Data([0x01])) { _, _ in }
        }
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 2)

        // Complete the intent's own request successfully, then park a second
        // request so the existing global drain condition cannot signal.
        peripheral.canSendDefault = false
        fireLatestOneShot(label: "chunkDelay")
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 1)

        let succeeded = await resultTask.value
        XCTAssertFalse(succeeded)
        XCTAssertEqual(peripheral.writtenChunks.count, 1)

        // The unrelated queued request is not cancelled by the intent's drain
        // deadline and can still finish normally afterwards.
        peripheral.canSendDefault = true
        hooks.sync { scheduler.repeatingTimers[0].fire() }
        fireLatestOneShot(label: "chunkDelay")
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertEqual(hooks.sync { hooks.writeQueueDepth }, 0)
    }

    func testIntentDisplayPreservesIntentionalEmptyFrameClear() async {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 512)
        let characteristic = makeCharacteristic(properties: .writeWithoutResponse)

        hooks.sync {
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
        }

        let resultTask = Task {
            await hooks.displayCurrentItemAwaitingDrain(
                items: [queueItem(frames: "")],
                currentIndex: 0,
                drainTimeout: 1
            )
        }
        await waitForWriteQueueDepth(1)
        fireLatestOneShot(label: "chunkDelay")

        let succeeded = await resultTask.value
        XCTAssertTrue(succeeded)
        XCTAssertEqual(peripheral.writtenChunks.count, 1)
        XCTAssertEqual(String(data: peripheral.writtenChunks[0].data, encoding: .utf8), "l##")
    }

    func testMoonBoardAckWatchdogStartsBoundedConnectionRecovery() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: true, maxWriteValueLength: 20)
        let characteristic = makeCharacteristic(properties: .write)
        let payload = Data((0 ..< 10).map { UInt8($0) })

        var completionError: Error?
        var completionCount = 0
        var disconnectEventCount = 0

        hooks.sync {
            manager.setEventHandlers(
                onScanResult: nil,
                onDisconnect: { _, _ in disconnectEventCount += 1 }
            )
            hooks.setConfiguration(moonboardConfiguration())
            hooks.setConnection(peripheral: peripheral, characteristic: characteristic)
            manager.write(data: payload) { error, _ in
                completionError = error
                completionCount += 1
            }
        }

        XCTAssertEqual(peripheral.writtenChunks.map(\.type), [.withResponse])
        XCTAssertFalse(hooks.sync { hooks.forceWriteWithResponse })
        XCTAssertTrue(hooks.sync { hooks.hasPendingWriteAck })

        fireLatestOneShot(label: "writeAckWatchdog")

        XCTAssertEqual(completionCount, 1)
        XCTAssertEqual(completionError?.localizedDescription, BoardBleError.writeTimedOut.localizedDescription)
        XCTAssertEqual(cancelledPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveries }, 1)
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveringPeripheralId }, peripheral.identifier)
        XCTAssertNotNil(scheduler.lastOneShot(label: "writeStallRecoveryWatchdog"))
        XCTAssertFalse(hooks.sync { hooks.hasPendingWriteAck })
        XCTAssertEqual(disconnectEventCount, 0)
    }
}

@available(iOS 17.0, *)
final class WaiterPoolOutcomeTests: XCTestCase {
    func testWaitReportsImmediateSignalAndTimeoutOutcomes() async {
        let queue = DispatchQueue(label: "com.boardsesh.tests.waiter-pool")
        let pool = WaiterPool(queue: queue)

        let immediateResult = await pool.wait(timeout: 1) { true }
        let timeoutResult = await pool.wait(timeout: 0) { false }
        XCTAssertTrue(immediateResult)
        XCTAssertFalse(timeoutResult)
    }

    func testWaitReportsExplicitSignal() async {
        let queue = DispatchQueue(label: "com.boardsesh.tests.waiter-pool-signal")
        let pool = WaiterPool(queue: queue)
        let resultTask = Task {
            await pool.wait(timeout: 1) { false }
        }

        var waiterWasRegistered = false
        for _ in 0..<1_000 {
            waiterWasRegistered = queue.sync { pool.hasPendingWaiters }
            if waiterWasRegistered { break }
            await Task.yield()
        }
        XCTAssertTrue(waiterWasRegistered)
        queue.sync { pool.signalAll() }

        let signaledResult = await resultTask.value
        XCTAssertTrue(signaledResult)
    }
}
