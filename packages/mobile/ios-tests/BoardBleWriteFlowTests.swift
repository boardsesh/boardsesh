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
    private(set) var writtenChunks: [(data: Data, type: CBCharacteristicWriteType)] = []

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

    func writeValue(_ data: Data, for _: CBCharacteristic, type: CBCharacteristicWriteType) {
        writtenChunks.append((data: data, type: type))
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

    private func makeCharacteristic(properties: CBCharacteristicProperties = .writeWithoutResponse) -> CBMutableCharacteristic {
        CBMutableCharacteristic(
            type: uartWriteCharacteristicUuid,
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
    func testWatchdogTripRecordsCanSendAtTripFalseAndFailsWritesWithTimeout() {
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
        XCTAssertTrue(peripheral.writtenChunks.isEmpty)

        fireLatestOneShot(label: "writeResumeWatchdog")

        XCTAssertEqual(completionError as? BoardBleError, .writeTimedOut)
        XCTAssertEqual(completionTelemetry?.watchdogTripped, true)
        XCTAssertEqual(completionTelemetry?.canSendAtTrip, false)
        XCTAssertTrue(scheduler.repeatingTimers[0].cancelled)
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveries }, 1)
        XCTAssertEqual(hooks.sync { hooks.writeStallRecoveringPeripheralId }, peripheral.identifier)
        XCTAssertEqual(cancelledPeripheralIds, [peripheral.identifier])
        XCTAssertNotNil(scheduler.lastOneShot(label: "writeStallRecoveryWatchdog"))
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
    func testWatchdogTripBeyondRecoveryBudgetFailsWithRecoveryFailedAndEmitsDisconnect() {
        let hooks = manager.testHooks
        let peripheral = FakeWritablePeripheral(canSendDefault: false, maxWriteValueLength: 20)
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

        fireLatestOneShot(label: "writeResumeWatchdog")

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
        // MoonBoard + `.write`-only characteristic -> the with-response path.
        let characteristic = makeCharacteristic(properties: .write)
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
        XCTAssertEqual(peripheral.writtenChunks[0].type, .withResponse)
        XCTAssertEqual(peripheral.writtenChunks[0].data.count, 20)
        XCTAssertNotNil(scheduler.lastOneShot(label: "writeAckWatchdog"))
        XCTAssertEqual(completionCount, 0)

        hooks.fireWriteAck(error: nil) // -> chunk 2
        XCTAssertEqual(peripheral.writtenChunks.count, 2)

        hooks.fireWriteAck(error: nil) // -> completion
        XCTAssertEqual(peripheral.writtenChunks.count, 2)
        XCTAssertTrue(peripheral.writtenChunks.allSatisfy { $0.type == .withResponse })
        XCTAssertEqual(completionCount, 1)
        XCTAssertNil(completionError)
        XCTAssertEqual(completionTelemetry?.writeType, "withResponse")
    }
}
