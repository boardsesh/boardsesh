import CoreBluetooth
import XCTest

/// Characterization coverage for `didDisconnectPeripheral`. The tests drive the
/// same queue-bound helper as CoreBluetooth's delegate callback, with no native
/// Bluetooth stack or timing sleeps.
@available(iOS 17.0, *)
final class BoardBleDisconnectTests: XCTestCase {
    private var scheduler: FakeBleTimerScheduler!
    private var manager: BoardBleManager!
    private var cancelledPeripheralIds: [UUID] = []
    private var connectedPeripheralIds: [UUID] = []
    private var stopScanCallCount = 0
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")

    override func setUp() {
        super.setUp()
        cancelledPeripheralIds = []
        connectedPeripheralIds = []
        stopScanCallCount = 0
        scheduler = FakeBleTimerScheduler()
        manager = BoardBleManager(timerScheduler: scheduler, createCentralManagerEagerly: false)
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(nil)
            manager.testHooks.setStopScanOverride { [weak self] in
                self?.stopScanCallCount += 1
            }
            manager.testHooks.setCancelPeripheralConnectionOverride { [weak self] peripheral in
                self?.cancelledPeripheralIds.append(peripheral.identifier)
            }
            manager.testHooks.setConnectPeripheralOverride { [weak self] peripheral in
                self?.connectedPeripheralIds.append(peripheral.identifier)
            }
            manager.testHooks.setCentralState(.poweredOn)
        }
    }

    override func tearDown() {
        manager.testHooks.sync {
            manager.testHooks.setStopScanOverride(nil)
            manager.testHooks.setCancelPeripheralConnectionOverride(nil)
            manager.testHooks.setConnectPeripheralOverride(nil)
            manager.testHooks.setCentralState(nil)
        }
        manager = nil
        scheduler = nil
        super.tearDown()
    }

    private func makeWriteCharacteristic() -> CBMutableCharacteristic {
        CBMutableCharacteristic(
            type: uartWriteCharacteristicUuid,
            properties: .write,
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

    private func installConnection(
        peripheral: FakeWritablePeripheral,
        onDisconnect: @escaping (String, [String: Any]?) -> Void
    ) {
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(moonboardConfiguration())
            manager.setEventHandlers(
                onScanResult: nil,
                onDisconnect: onDisconnect,
                onConnected: nil
            )
            manager.testHooks.setConnection(
                peripheral: peripheral,
                characteristic: makeWriteCharacteristic()
            )
        }
    }

    private func enqueueTwoWrites(onSettle: @escaping (Error?) -> Void) {
        manager.testHooks.sync {
            manager.write(data: Data([0x01])) { error, _ in onSettle(error) }
            manager.write(data: Data([0x02])) { error, _ in onSettle(error) }
        }
    }

    private func fireLatestOneShot(label: String) {
        manager.testHooks.sync {
            guard let timer = scheduler.lastOneShot(label: label) else {
                XCTFail("expected a scheduled \(label) timer")
                return
            }
            timer.fire()
        }
    }

    func testIntentionalDisconnectConsumesMarkerAndSuppressesEvent() {
        let peripheral = FakeWritablePeripheral()
        var disconnectEventCount = 0
        installConnection(peripheral: peripheral) { _, _ in disconnectEventCount += 1 }

        manager.testHooks.sync { manager.disconnect() }

        let intentionalGeneration = manager.testHooks.sync {
            manager.testHooks.intentionalDisconnectGeneration(for: peripheral.identifier)
        }
        XCTAssertNotNil(intentionalGeneration)
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.peripheralGeneration(for: peripheral.identifier) },
            intentionalGeneration
        )
        XCTAssertEqual(cancelledPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(stopScanCallCount, 1)
        XCTAssertNil(manager.connectedDeviceId)
        XCTAssertEqual(disconnectEventCount, 0)

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)

        XCTAssertNil(
            manager.testHooks.sync {
                manager.testHooks.intentionalDisconnectGeneration(for: peripheral.identifier)
            }
        )
        XCTAssertNil(
            manager.testHooks.sync { manager.testHooks.peripheralGeneration(for: peripheral.identifier) }
        )
        XCTAssertEqual(disconnectEventCount, 0)
        XCTAssertEqual(cancelledPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(stopScanCallCount, 1)
    }

    func testStaleDifferentPeripheralDisconnectLeavesCurrentWriteQueueUntouched() {
        let currentPeripheral = FakeWritablePeripheral()
        let stalePeripheral = FakeWritablePeripheral()
        var disconnectEventCount = 0
        var settledErrors: [Error?] = []
        installConnection(peripheral: currentPeripheral) { _, _ in disconnectEventCount += 1 }
        enqueueTwoWrites { settledErrors.append($0) }
        // Seed a generation for the stale peripheral so the guard's cleanup line
        // (removing a non-current peripheral's entry) has something to remove.
        manager.testHooks.sync {
            manager.testHooks.setPeripheralGeneration(7, for: stalePeripheral.identifier)
        }

        let pendingWatchdog = scheduler.lastOneShot(label: "writeAckWatchdog")
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeQueueDepth }, 2)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingWriteAck })

        manager.testHooks.fireDidDisconnect(peripheral: stalePeripheral, error: nil)

        XCTAssertNil(
            manager.testHooks.sync { manager.testHooks.peripheralGeneration(for: stalePeripheral.identifier) }
        )
        XCTAssertEqual(manager.connectedDeviceId, currentPeripheral.identifier.uuidString)
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeQueueDepth }, 2)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.isWriting })
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingWriteAck })
        XCTAssertFalse(pendingWatchdog?.cancelled ?? true)
        XCTAssertEqual(disconnectEventCount, 0)
        XCTAssertTrue(settledErrors.isEmpty)

        manager.testHooks.fireWriteAck(error: nil)
        manager.testHooks.fireWriteAck(error: nil)

        XCTAssertEqual(settledErrors.count, 2)
        XCTAssertTrue(settledErrors.allSatisfy { $0 == nil })
        XCTAssertEqual(currentPeripheral.writtenChunks.count, 2)
    }

    func testCurrentCleanDisconnectSettlesQueueCancelsWatchdogAndEmitsOnce() {
        let peripheral = FakeWritablePeripheral()
        var disconnectEvents: [(deviceId: String, body: [String: Any]?)] = []
        var settledErrors: [Error?] = []
        installConnection(peripheral: peripheral) { deviceId, body in
            disconnectEvents.append((deviceId: deviceId, body: body))
        }
        enqueueTwoWrites { settledErrors.append($0) }
        let pendingWatchdog = scheduler.lastOneShot(label: "writeAckWatchdog")

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)

        XCTAssertNil(manager.connectedDeviceId)
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeQueueDepth }, 0)
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.isWriting })
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.hasPendingWriteAck })
        XCTAssertTrue(pendingWatchdog?.cancelled ?? false)
        XCTAssertEqual(settledErrors.count, 2)
        XCTAssertTrue(settledErrors.allSatisfy {
            $0?.localizedDescription == BoardBleError.notConnected.localizedDescription
        })
        XCTAssertEqual(disconnectEvents.count, 1)
        XCTAssertEqual(disconnectEvents.first?.deviceId, peripheral.identifier.uuidString)
        XCTAssertNil(disconnectEvents.first?.body)
        // No auto-reconnect on an unexpected drop: these boards are
        // last-connection-wins, so a silent re-grab would steal the wall back.
        // The manager must not cancel, rescan, or reconnect on this path.
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(stopScanCallCount, 0)

        manager.testHooks.fireWriteAck(error: nil)
        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)
        pendingWatchdog?.fire()
        XCTAssertEqual(settledErrors.count, 2)
        XCTAssertEqual(disconnectEvents.count, 1)
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(stopScanCallCount, 0)
    }

    func testCurrentErrorDisconnectForwardsNSErrorToWritesAndEvent() {
        let peripheral = FakeWritablePeripheral()
        let disconnectError = NSError(
            domain: "BoardBleDisconnectTests",
            code: 37,
            userInfo: [NSLocalizedDescriptionKey: "Radio link vanished"]
        )
        var disconnectEvents: [(deviceId: String, body: [String: Any]?)] = []
        var settledErrors: [Error?] = []
        installConnection(peripheral: peripheral) { deviceId, body in
            disconnectEvents.append((deviceId: deviceId, body: body))
        }
        enqueueTwoWrites { settledErrors.append($0) }
        let pendingWatchdog = scheduler.lastOneShot(label: "writeAckWatchdog")

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: disconnectError)

        XCTAssertNil(manager.connectedDeviceId)
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeQueueDepth }, 0)
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.isWriting })
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.hasPendingWriteAck })
        XCTAssertTrue(pendingWatchdog?.cancelled ?? false)
        XCTAssertEqual(settledErrors.count, 2)
        for settledError in settledErrors {
            let nsError = settledError as? NSError
            XCTAssertEqual(nsError?.domain, disconnectError.domain)
            XCTAssertEqual(nsError?.code, disconnectError.code)
            XCTAssertEqual(nsError?.localizedDescription, disconnectError.localizedDescription)
        }
        XCTAssertEqual(disconnectEvents.count, 1)
        XCTAssertEqual(disconnectEvents.first?.deviceId, peripheral.identifier.uuidString)
        XCTAssertEqual(disconnectEvents.first?.body?["errorDomain"] as? String, disconnectError.domain)
        XCTAssertEqual(disconnectEvents.first?.body?["errorCode"] as? Int, disconnectError.code)
        XCTAssertEqual(
            disconnectEvents.first?.body?["errorDescription"] as? String,
            disconnectError.localizedDescription
        )
        // No auto-reconnect on an error drop either (same board-stealing rule).
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(stopScanCallCount, 0)

        manager.testHooks.fireWriteAck(error: nil)
        pendingWatchdog?.fire()
        XCTAssertEqual(settledErrors.count, 2)
        XCTAssertEqual(disconnectEvents.count, 1)
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
        XCTAssertEqual(stopScanCallCount, 0)
    }

    func testImmediateSamePeripheralReconnectWaitsForCancellationCallback() {
        let peripheral = FakeWritablePeripheral()
        var disconnectEventCount = 0
        var disconnectCompletionCalled = false
        var connectResults: [Result<Void, Error>] = []
        installConnection(peripheral: peripheral) { _, _ in disconnectEventCount += 1 }

        manager.testHooks.sync {
            manager.disconnect { disconnectCompletionCalled = true }
            manager.connect(deviceId: peripheral.identifier.uuidString) { connectResults.append($0) }
        }

        XCTAssertTrue(disconnectCompletionCalled)
        XCTAssertTrue(connectedPeripheralIds.isEmpty)
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.deferredConnectPeripheralId }, peripheral.identifier)
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.hasPendingConnect })
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds },
            Set([peripheral.identifier])
        )

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.deferredConnectPeripheralId })
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds.isEmpty })
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingConnect })
        XCTAssertNotNil(scheduler.lastOneShot(label: "connectTimeout"))
        XCTAssertEqual(disconnectEventCount, 0)
        XCTAssertTrue(connectResults.isEmpty)

        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )
        XCTAssertEqual(connectResults.count, 1)
        if case .failure(let error) = connectResults[0] {
            XCTFail("expected reconnect success, got \(error)")
        }
        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(disconnectEventCount, 0)
    }

    func testCancelledConnectingPeripheralSettlesBarrierThroughDidFailToConnect() {
        let peripheral = FakeWritablePeripheral()
        var firstConnectError: Error?
        var reconnectResults: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(peripheral)
            manager.connect(deviceId: peripheral.identifier.uuidString) { result in
                if case .failure(let error) = result { firstConnectError = error }
            }
            manager.disconnect()
            manager.connect(deviceId: peripheral.identifier.uuidString) { reconnectResults.append($0) }
        }

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(
            firstConnectError?.localizedDescription,
            BoardBleError.notConnected.localizedDescription
        )
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.deferredConnectPeripheralId }, peripheral.identifier)

        manager.testHooks.fireDidFailToConnect(peripheral: peripheral, error: BoardBleError.notConnected)

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier, peripheral.identifier])
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingConnect })
        XCTAssertTrue(reconnectResults.isEmpty)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds.isEmpty })
    }

    func testDifferentPeripheralConnectsImmediatelyWhileOldBarrierRemains() {
        let oldPeripheral = FakeWritablePeripheral()
        let newPeripheral = FakeWritablePeripheral()
        var disconnectEventCount = 0
        installConnection(peripheral: oldPeripheral) { _, _ in disconnectEventCount += 1 }

        manager.testHooks.sync {
            manager.disconnect()
            manager.testHooks.setDiscoveredPeripheral(newPeripheral)
            manager.connect(deviceId: newPeripheral.identifier.uuidString) { _ in }
        }

        XCTAssertEqual(connectedPeripheralIds, [newPeripheral.identifier])
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds },
            Set([oldPeripheral.identifier])
        )

        manager.testHooks.fireDidDisconnect(peripheral: oldPeripheral, error: nil)

        XCTAssertEqual(connectedPeripheralIds, [newPeripheral.identifier])
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds.isEmpty })
        XCTAssertEqual(disconnectEventCount, 0)
    }

    func testNewestSamePeripheralDeferredRequestSupersedesOlderWaiter() {
        let peripheral = FakeWritablePeripheral()
        var firstError: Error?
        var secondResults: [Result<Void, Error>] = []
        installConnection(peripheral: peripheral) { _, _ in }

        manager.testHooks.sync {
            manager.disconnect()
            manager.connect(deviceId: peripheral.identifier.uuidString) { result in
                if case .failure(let error) = result { firstError = error }
            }
            manager.connect(deviceId: peripheral.identifier.uuidString) { secondResults.append($0) }
        }

        XCTAssertEqual(firstError?.localizedDescription, BoardBleError.superseded.localizedDescription)
        XCTAssertTrue(secondResults.isEmpty)
        XCTAssertTrue(connectedPeripheralIds.isEmpty)

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertTrue(secondResults.isEmpty)
    }

    func testExplicitDisconnectRejectsDeferredConnectWithoutConsumingBarrier() {
        let peripheral = FakeWritablePeripheral()
        var deferredError: Error?
        installConnection(peripheral: peripheral) { _, _ in }

        manager.testHooks.sync {
            manager.disconnect()
            manager.connect(deviceId: peripheral.identifier.uuidString) { result in
                if case .failure(let error) = result { deferredError = error }
            }
            manager.disconnect()
        }

        XCTAssertEqual(deferredError?.localizedDescription, BoardBleError.notConnected.localizedDescription)
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.deferredConnectPeripheralId })
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds },
            Set([peripheral.identifier])
        )

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)
        XCTAssertTrue(connectedPeripheralIds.isEmpty)
    }

    func testBarrierWatchdogRejectsWaiterWithoutForcingConnectAndRetainsBarrier() {
        let peripheral = FakeWritablePeripheral()
        var deferredError: Error?
        var retryAfterExpiryError: Error?
        installConnection(peripheral: peripheral) { _, _ in }

        manager.testHooks.sync {
            manager.disconnect()
            manager.connect(deviceId: peripheral.identifier.uuidString) { result in
                if case .failure(let error) = result { deferredError = error }
            }
        }
        fireLatestOneShot(label: "managerCancellationBarrierWatchdog")

        XCTAssertEqual(deferredError?.localizedDescription, BoardBleError.connectTimedOut.localizedDescription)
        XCTAssertTrue(connectedPeripheralIds.isEmpty)
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds },
            Set([peripheral.identifier])
        )

        manager.testHooks.sync {
            manager.connect(deviceId: peripheral.identifier.uuidString) { result in
                if case .failure(let error) = result { retryAfterExpiryError = error }
            }
        }
        XCTAssertEqual(
            retryAfterExpiryError?.localizedDescription,
            BoardBleError.connectTimedOut.localizedDescription
        )
        XCTAssertTrue(connectedPeripheralIds.isEmpty)

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds.isEmpty })
        XCTAssertTrue(connectedPeripheralIds.isEmpty)
    }

    func testBluetoothUnavailableRejectsDeferredConnectAndClearsCancellationState() {
        let peripheral = FakeWritablePeripheral()
        var deferredError: Error?
        installConnection(peripheral: peripheral) { _, _ in }

        manager.testHooks.sync {
            manager.disconnect()
            manager.connect(deviceId: peripheral.identifier.uuidString) { result in
                if case .failure(let error) = result { deferredError = error }
            }
        }
        let barrierWatchdog = scheduler.lastOneShot(label: "managerCancellationBarrierWatchdog")

        manager.testHooks.fireCentralStateUpdate(.poweredOff)

        XCTAssertEqual(
            deferredError?.localizedDescription,
            BoardBleError.bluetoothUnavailable.localizedDescription
        )
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds.isEmpty })
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.deferredConnectPeripheralId })
        XCTAssertNil(
            manager.testHooks.sync {
                manager.testHooks.intentionalDisconnectGeneration(for: peripheral.identifier)
            }
        )
        XCTAssertTrue(barrierWatchdog?.cancelled ?? false)
    }

    func testBluetoothUnavailableClearsExpiredBarrierWithoutResettlingWaiter() {
        let peripheral = FakeWritablePeripheral()
        var deferredResults: [Result<Void, Error>] = []
        installConnection(peripheral: peripheral) { _, _ in }

        manager.testHooks.sync {
            manager.disconnect()
            manager.connect(deviceId: peripheral.identifier.uuidString) { deferredResults.append($0) }
        }
        let barrierWatchdog = scheduler.lastOneShot(label: "managerCancellationBarrierWatchdog")
        fireLatestOneShot(label: "managerCancellationBarrierWatchdog")

        XCTAssertEqual(deferredResults.count, 1)
        if case .failure(let error) = deferredResults[0] {
            XCTAssertEqual(error.localizedDescription, BoardBleError.connectTimedOut.localizedDescription)
        } else {
            XCTFail("expected the expired barrier to time out its waiter")
        }
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds },
            Set([peripheral.identifier])
        )

        manager.testHooks.fireCentralStateUpdate(.poweredOff)

        XCTAssertEqual(deferredResults.count, 1)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds.isEmpty })
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.deferredConnectPeripheralId })
        XCTAssertNil(
            manager.testHooks.sync {
                manager.testHooks.intentionalDisconnectGeneration(for: peripheral.identifier)
            }
        )
        XCTAssertTrue(barrierWatchdog?.cancelled ?? false)
    }

    func testWriteStallSamePeripheralWaiterJoinsExactlyOneRecoveryReconnect() {
        let peripheral = FakeWritablePeripheral()
        var writeError: Error?
        var reconnectResults: [Result<Void, Error>] = []
        var disconnectEventCount = 0
        installConnection(peripheral: peripheral) { _, _ in disconnectEventCount += 1 }

        manager.testHooks.sync {
            manager.write(data: Data([0x01])) { error, _ in writeError = error }
        }
        fireLatestOneShot(label: "writeAckWatchdog")
        manager.testHooks.sync {
            manager.connect(deviceId: peripheral.identifier.uuidString) { reconnectResults.append($0) }
        }

        XCTAssertEqual(writeError?.localizedDescription, BoardBleError.writeTimedOut.localizedDescription)
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeStallRecoveries }, 1)
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.deferredConnectPeripheralId }, peripheral.identifier)
        XCTAssertTrue(connectedPeripheralIds.isEmpty)

        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingConnect })
        XCTAssertTrue(
            scheduler.lastOneShot(label: "writeStallRecoveryWatchdog")?.cancelled ?? false
        )
        XCTAssertEqual(disconnectEventCount, 0)

        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )
        XCTAssertEqual(reconnectResults.count, 1)
        if case .failure(let error) = reconnectResults[0] {
            XCTFail("expected recovery success, got \(error)")
        }
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.writeStallRecoveringPeripheralId })
        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(disconnectEventCount, 0)
    }

    func testWriteStallAutomaticReconnectFailurePreservesFailureEvent() {
        let peripheral = FakeWritablePeripheral()
        let reconnectError = NSError(
            domain: "BoardBleDisconnectTests",
            code: 91,
            userInfo: [NSLocalizedDescriptionKey: "Recovery connect failed"]
        )
        var disconnectBodies: [[String: Any]?] = []
        installConnection(peripheral: peripheral) { _, body in disconnectBodies.append(body) }

        manager.testHooks.sync {
            manager.write(data: Data([0x01])) { _, _ in }
        }
        fireLatestOneShot(label: "writeAckWatchdog")
        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingConnect })
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeStallRecoveries }, 1)
        XCTAssertTrue(disconnectBodies.isEmpty)

        manager.testHooks.fireDidFailToConnect(peripheral: peripheral, error: reconnectError)

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.hasPendingConnect })
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.writeStallRecoveringPeripheralId })
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeStallRecoveries }, 0)
        XCTAssertEqual(disconnectBodies.count, 1)
        XCTAssertEqual(disconnectBodies[0]?["context"] as? String, "write_stall_recovery_failed")
        XCTAssertEqual(
            disconnectBodies[0]?["errorDescription"] as? String,
            reconnectError.localizedDescription
        )
    }

    func testDifferentPeripheralSupersedesDeferredWriteStallReconnect() {
        let recoveringPeripheral = FakeWritablePeripheral()
        let winningPeripheral = FakeWritablePeripheral()
        var recoveringWaiterError: Error?
        installConnection(peripheral: recoveringPeripheral) { _, _ in }

        manager.testHooks.sync {
            manager.write(data: Data([0x01])) { _, _ in }
        }
        fireLatestOneShot(label: "writeAckWatchdog")
        manager.testHooks.sync {
            manager.connect(deviceId: recoveringPeripheral.identifier.uuidString) { result in
                if case .failure(let error) = result { recoveringWaiterError = error }
            }
            manager.testHooks.setDiscoveredPeripheral(winningPeripheral)
            manager.connect(deviceId: winningPeripheral.identifier.uuidString) { _ in }
        }

        XCTAssertEqual(
            recoveringWaiterError?.localizedDescription,
            BoardBleError.superseded.localizedDescription
        )
        XCTAssertEqual(connectedPeripheralIds, [winningPeripheral.identifier])
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.writeStallRecoveringPeripheralId })
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeStallRecoveries }, 0)
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.managerCancellationBarrierIds },
            Set([recoveringPeripheral.identifier])
        )

        manager.testHooks.fireDidDisconnect(peripheral: recoveringPeripheral, error: nil)
        XCTAssertEqual(connectedPeripheralIds, [winningPeripheral.identifier])
    }
}
