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
    private var stopScanCallCount = 0
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")

    override func setUp() {
        super.setUp()
        cancelledPeripheralIds = []
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
        }
    }

    override func tearDown() {
        manager.testHooks.sync {
            manager.testHooks.setStopScanOverride(nil)
            manager.testHooks.setCancelPeripheralConnectionOverride(nil)
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

        let pendingWatchdog = scheduler.lastOneShot(label: "writeAckWatchdog")
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.writeQueueDepth }, 2)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingWriteAck })

        manager.testHooks.fireDidDisconnect(peripheral: stalePeripheral, error: nil)

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

        manager.testHooks.fireWriteAck(error: nil)
        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)
        pendingWatchdog?.fire()
        XCTAssertEqual(settledErrors.count, 2)
        XCTAssertEqual(disconnectEvents.count, 1)
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

        manager.testHooks.fireWriteAck(error: nil)
        pendingWatchdog?.fire()
        XCTAssertEqual(settledErrors.count, 2)
        XCTAssertEqual(disconnectEvents.count, 1)
    }
}
