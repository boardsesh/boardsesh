import CoreBluetooth
import XCTest

/// Coverage for the implicit re-light gate (#4499): a connect request that
/// CoreBluetooth honours long after it was made must not repaint the wall from
/// the persisted shared queue.
///
/// `displaySharedCurrentItemOnBleQueue` reads the app-group defaults, which is
/// exactly the dev-machine leak `setConfiguration` exists to avoid — so every
/// assertion here is on the manager's own attempt/suppression counters, never on
/// bytes written to the fake peripheral.
@available(iOS 17.0, *)
final class BoardBleRelightAuthorizationTests: XCTestCase {
    private var scheduler: FakeBleTimerScheduler!
    private var manager: BoardBleManager!
    private var cancelledPeripheralIds: [UUID] = []
    private var connectedPeripheralIds: [UUID] = []
    private var savedBoardConfigData: Data?
    private var savedLastPeripheralUuid: String?
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")

    override func setUp() {
        super.setUp()
        // This suite drives `configure()` and the real connection success point,
        // both of which persist into the app group. Snapshot and restore so a
        // dev machine's own board config / last board survives the run.
        savedBoardConfigData = SharedConstants.sharedDefaults?.data(forKey: SharedConstants.bleBoardConfigKey)
        savedLastPeripheralUuid = SharedConstants.sharedDefaults?
            .string(forKey: SharedConstants.bleLastPeripheralUuidKey)
        cancelledPeripheralIds = []
        connectedPeripheralIds = []
        scheduler = FakeBleTimerScheduler()
        manager = BoardBleManager(timerScheduler: scheduler, createCentralManagerEagerly: false)
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(nil)
            manager.testHooks.setStopScanOverride {}
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
        restore(savedBoardConfigData, forKey: SharedConstants.bleBoardConfigKey)
        restore(savedLastPeripheralUuid, forKey: SharedConstants.bleLastPeripheralUuidKey)
        super.tearDown()
    }

    private func restore<Value>(_ value: Value?, forKey key: String) {
        guard let defaults = SharedConstants.sharedDefaults else { return }
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
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

    private func installConnection(peripheral: FakeWritablePeripheral) {
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(moonboardConfiguration())
            manager.testHooks.setConnection(
                peripheral: peripheral,
                characteristic: makeWriteCharacteristic()
            )
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

    private var attempts: Int { manager.testHooks.sync { manager.testHooks.implicitRelightAttempts } }
    private var suppressions: Int { manager.testHooks.sync { manager.testHooks.implicitRelightSuppressions } }

    // MARK: - The pure decision

    func testRelightDecisionMatrixAcrossOriginsAndAges() {
        let now = Date()
        let maxAge: TimeInterval = 120
        let authorizedOrigins: [BoardBleConnectOrigin] = [.userConnect, .liveActivityIntent, .writeStallRecovery]

        for origin in authorizedOrigins {
            // Fresh, and exactly on the bound, are both honoured.
            for age in [0, 1, maxAge] as [TimeInterval] {
                XCTAssertTrue(
                    BoardBleManager.shouldPerformImplicitRelight(
                        origin: origin,
                        requestedAt: now.addingTimeInterval(-age),
                        now: now,
                        maxRequestAge: maxAge
                    ),
                    "\(origin.rawValue) at age \(age) should authorise a re-light"
                )
            }
            // Past the bound, and a backwards clock jump, both fail closed.
            for age in [maxAge + 0.001, 3600, 86_400 * 3, -1] as [TimeInterval] {
                XCTAssertFalse(
                    BoardBleManager.shouldPerformImplicitRelight(
                        origin: origin,
                        requestedAt: now.addingTimeInterval(-age),
                        now: now,
                        maxRequestAge: maxAge
                    ),
                    "\(origin.rawValue) at age \(age) should not authorise a re-light"
                )
            }
            // A missing stamp is unknowable, so it fails closed too.
            XCTAssertFalse(
                BoardBleManager.shouldPerformImplicitRelight(
                    origin: origin,
                    requestedAt: nil,
                    now: now,
                    maxRequestAge: maxAge
                )
            )
        }

        // A restored link is never authorised, at any age.
        for age in [0, 1, maxAge, maxAge + 1] as [TimeInterval] {
            XCTAssertFalse(
                BoardBleManager.shouldPerformImplicitRelight(
                    origin: .restored,
                    requestedAt: now.addingTimeInterval(-age),
                    now: now,
                    maxRequestAge: maxAge
                )
            )
        }

        // No origin at all — the state a disconnect leaves behind.
        XCTAssertFalse(
            BoardBleManager.shouldPerformImplicitRelight(
                origin: nil,
                requestedAt: now,
                now: now,
                maxRequestAge: maxAge
            )
        )
    }

    func testConfiguredMaxRequestAgeIsTheDocumentedTwoMinutes() {
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.implicitRelightMaxRequestAge }, 120)
    }

    // MARK: - The connect paths

    func testFreshUserConnectRelightsOnce() {
        let peripheral = FakeWritablePeripheral()
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(moonboardConfiguration())
            manager.testHooks.setDiscoveredPeripheral(peripheral)
            manager.connect(deviceId: peripheral.identifier.uuidString) { _ in }
        }

        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.connectRequestOrigin },
            BoardBleConnectOrigin.userConnect
        )
        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])

        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )

        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(suppressions, 0)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.implicitRelightAuthorizedForConnection })
    }

    func testFreshWriteStallRecoveryStillRelights() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral: peripheral)

        manager.testHooks.sync { manager.write(data: Data([0x01])) { _, _ in } }
        fireLatestOneShot(label: "writeAckWatchdog")
        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)

        XCTAssertEqual(connectedPeripheralIds, [peripheral.identifier])
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.connectRequestOrigin },
            BoardBleConnectOrigin.writeStallRecovery
        )

        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )

        // The #3181 regression guard: an unwedged link repaints the wall.
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(suppressions, 0)
    }

    func testStaleWriteStallRecoveryIsSuppressedButKeepsTheLink() {
        let peripheral = FakeWritablePeripheral()
        var connectedEvents: [String] = []
        installConnection(peripheral: peripheral)
        manager.testHooks.sync {
            manager.setEventHandlers(
                onScanResult: nil,
                onDisconnect: nil,
                onConnected: { deviceId, _ in connectedEvents.append(deviceId) }
            )
            manager.write(data: Data([0x01])) { _, _ in }
        }
        fireLatestOneShot(label: "writeAckWatchdog")
        manager.testHooks.fireDidDisconnect(peripheral: peripheral, error: nil)
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingConnect })

        // The phone suspended inside the connect window; CoreBluetooth honours
        // the request an hour later, when the board is back in range.
        manager.testHooks.sync {
            manager.testHooks.setConnectRequest(
                origin: .writeStallRecovery,
                requestedAt: Date(timeIntervalSinceNow: -3600)
            )
        }
        let cancelsBeforeReady = cancelledPeripheralIds.count

        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )

        XCTAssertEqual(attempts, 0)
        XCTAssertEqual(suppressions, 1)
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.implicitRelightAuthorizedForConnection })
        // The link is kept, not reversed: the pending connect settles, JS still
        // hears about it, and nothing is cancelled.
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.hasPendingConnect })
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.writeStallRecoveringPeripheralId })
        XCTAssertEqual(connectedEvents, [peripheral.identifier.uuidString])
        XCTAssertEqual(cancelledPeripheralIds.count, cancelsBeforeReady)
        XCTAssertEqual(manager.connectedDeviceId, peripheral.identifier.uuidString)
    }

    func testRestoredConnectionIsSuppressedAndRetained() {
        let peripheral = FakeWritablePeripheral()
        var connectedEvents: [String] = []
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(moonboardConfiguration())
            manager.setEventHandlers(
                onScanResult: nil,
                onDisconnect: nil,
                onConnected: { deviceId, _ in connectedEvents.append(deviceId) }
            )
            manager.testHooks.setConnectRequest(origin: .restored, requestedAt: nil)
        }

        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )

        XCTAssertEqual(attempts, 0)
        XCTAssertEqual(suppressions, 1)
        XCTAssertEqual(connectedEvents, [peripheral.identifier.uuidString])
        XCTAssertEqual(manager.connectedDeviceId, peripheral.identifier.uuidString)
        XCTAssertTrue(cancelledPeripheralIds.isEmpty)
    }

    func testLiveActivityReconnectOnAnAlreadyLiveLinkRelights() {
        let peripheral = FakeWritablePeripheral()
        var reconnectResults: [Result<Void, Error>] = []
        installConnection(peripheral: peripheral)

        manager.testHooks.sync {
            manager.reconnectToLastKnownBoard(origin: .liveActivityIntent) { reconnectResults.append($0) }
        }

        XCTAssertEqual(reconnectResults.count, 1)
        XCTAssertEqual(
            manager.testHooks.sync { manager.testHooks.connectRequestOrigin },
            BoardBleConnectOrigin.liveActivityIntent
        )
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(suppressions, 0)
    }

    // MARK: - configureBoard

    func testForegroundConfigureRelightsEvenOnASuppressedConnection() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral: peripheral)
        manager.testHooks.sync {
            manager.testHooks.setConnectRequest(origin: .restored, requestedAt: nil)
        }
        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )
        XCTAssertEqual(attempts, 0)

        // The user opened the app on the restored link and changed a colour.
        manager.testHooks.sync {
            manager.testHooks.configure(moonboardConfiguration(), appActive: true)
        }

        XCTAssertEqual(attempts, 1)
    }

    func testBackgroundConfigureIsSuppressedOnASuppressedConnection() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral: peripheral)
        manager.testHooks.sync {
            manager.testHooks.setConnectRequest(origin: .restored, requestedAt: nil)
        }
        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )
        let suppressionsAfterConnect = suppressions

        // A background BLE wake booted React Native, which adopted the
        // connection and pushed its config.
        manager.testHooks.sync {
            manager.testHooks.configure(moonboardConfiguration(), appActive: false)
        }

        XCTAssertEqual(attempts, 0)
        XCTAssertEqual(suppressions, suppressionsAfterConnect + 1)
    }

    func testBackgroundConfigureStillRelightsAnAuthorizedConnection() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral: peripheral)
        manager.testHooks.sync {
            manager.testHooks.setConnectRequest(origin: .liveActivityIntent, requestedAt: Date())
        }
        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )
        XCTAssertEqual(attempts, 1)

        // The lightbulb reconnect JS adopts while still backgrounded.
        manager.testHooks.sync {
            manager.testHooks.configure(moonboardConfiguration(), appActive: false)
        }

        XCTAssertEqual(attempts, 2)
    }

    // MARK: - Provenance lifecycle

    func testDisconnectForgetsWhoAskedSoALaterConnectCannotInheritIt() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral: peripheral)
        manager.testHooks.sync {
            manager.testHooks.setConnectRequest(origin: .userConnect, requestedAt: Date())
            manager.disconnect()
        }

        XCTAssertNil(manager.testHooks.sync { manager.testHooks.connectRequestOrigin })
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.connectRequestedAt })

        manager.testHooks.fireConnectionReady(
            peripheral: peripheral,
            characteristic: makeWriteCharacteristic()
        )

        XCTAssertEqual(attempts, 0)
        XCTAssertEqual(suppressions, 1)
    }

    func testBluetoothTurningOffForgetsWhoAsked() {
        let peripheral = FakeWritablePeripheral()
        installConnection(peripheral: peripheral)
        manager.testHooks.sync {
            manager.testHooks.setConnectRequest(origin: .userConnect, requestedAt: Date())
        }

        manager.testHooks.fireCentralStateUpdate(.poweredOff)

        XCTAssertNil(manager.testHooks.sync { manager.testHooks.connectRequestOrigin })
        XCTAssertNil(manager.testHooks.sync { manager.testHooks.connectRequestedAt })
    }
}
