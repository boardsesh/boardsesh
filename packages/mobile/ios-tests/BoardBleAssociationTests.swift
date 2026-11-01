import CoreBluetooth
import XCTest

/// Real preparation / connect / persistence transitions for #7122. No trusted
/// connection fixture is used: only a successful token-owned connect may bind.
@available(iOS 17.0, *)
final class BoardBleAssociationTests: XCTestCase {
    private var manager: BoardBleManager!
    private var scheduler: FakeBleTimerScheduler!
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var connects: [UUID] = []
    private var cancellations: [UUID] = []

    override func setUp() {
        super.setUp()
        suiteName = "com.boardsesh.ble-association.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        scheduler = FakeBleTimerScheduler()
        manager = makeManager()
    }

    override func tearDown() {
        manager = nil
        scheduler = nil
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func makeManager() -> BoardBleManager {
        let instance = BoardBleManager(
            timerScheduler: scheduler,
            createCentralManagerEagerly: false,
            associationDefaults: defaults
        )
        instance.testHooks.sync {
            instance.testHooks.setCentralState(.poweredOn)
            instance.testHooks.setStopScanOverride {}
            instance.testHooks.setScanForPeripheralsOverride { _ in }
            instance.testHooks.setConnectPeripheralOverride { [weak self] in self?.connects.append($0.identifier) }
            instance.testHooks.setCancelPeripheralConnectionOverride { [weak self] in self?.cancellations.append($0.identifier) }
        }
        return instance
    }

    private func configuration(_ boardName: String = "moonboard", layoutId: Int = 0) -> BoardBleConfiguration {
        BoardBleConfiguration(
            boardName: boardName, layoutId: layoutId, sizeId: 0,
            apiLevel: nil, deviceName: nil, colorOverrides: [:], numRows: nil
        )
    }

    private func characteristic() -> CBMutableCharacteristic {
        CBMutableCharacteristic(
            type: CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"),
            properties: .writeWithoutResponse, value: nil, permissions: [.writeable]
        )
    }

    private func prepare(_ configuration: BoardBleConfiguration, key: String) -> String {
        var token: String?
        manager.testHooks.sync {
            manager.prepareBoardConnection(configuration, configKey: key) { result in
                switch result {
                case .success(let value): token = value
                case .failure(let error): XCTFail("preparation failed: \(error)")
                }
            }
        }
        XCTAssertNotNil(token)
        return token ?? ""
    }

    private func establish(_ peripheral: FakeWritablePeripheral, configuration: BoardBleConfiguration, key: String) {
        let token = prepare(configuration, key: key)
        var results: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(peripheral)
            manager.connectPreparedBoard(deviceId: peripheral.identifier.uuidString, preparationToken: token) {
                results.append($0)
            }
        }
        manager.testHooks.fireConnectionReady(peripheral: peripheral, characteristic: characteristic())
        XCTAssertEqual(results.count, 1)
        if case .failure(let error) = results.first { XCTFail("connection failed: \(error)") }
        XCTAssertEqual(manager.connectedDeviceInfo?.configKey, key)
        XCTAssertEqual(manager.testHooks.sync { manager.testHooks.boundPeripheralUuid }, peripheral.identifier)
    }

    private func assertBulbRefused(file: StaticString = #filePath, line: UInt = #line) {
        let connectCount = connects.count
        var results: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.reconnectToLastKnownBoard(origin: .liveActivityIntent) { results.append($0) }
        }
        XCTAssertEqual(results.count, 1, file: file, line: line)
        if case .success = results.first { XCTFail("stale board must not reconnect", file: file, line: line) }
        XCTAssertEqual(connects.count, connectCount, file: file, line: line)
        XCTAssertNil(manager.connectedDeviceInfo, file: file, line: line)
    }

    func testCancelledPickerInvalidatesCrossBrandAndSameBrandPairings() {
        for target in [configuration("kilter"), configuration("moonboard", layoutId: 1)] {
            let old = FakeWritablePeripheral(name: "MoonBoard")
            establish(old, configuration: configuration(), key: "old-wall")
            let writesBeforePreparation = old.writtenChunks.count

            _ = prepare(target, key: "new-wall") // Picker cancelled: no native connect.

            assertBulbRefused()
            manager.testHooks.sync {
                manager.displayCurrentItem(items: [], currentIndex: 0)
                manager.write(data: Data([0x01])) { error, _ in XCTAssertNotNil(error) }
            }
            XCTAssertEqual(old.writtenChunks.count, writesBeforePreparation)
            XCTAssertNil(manager.testHooks.sync { manager.testHooks.boundPeripheralUuid })
            XCTAssertTrue(cancellations.contains(old.identifier))
        }
    }

    func testFailedConnectRemainsUnboundAfterRestartAndRestoration() {
        let old = FakeWritablePeripheral(name: "MoonBoard")
        establish(old, configuration: configuration(), key: "old-wall")
        let target = FakeWritablePeripheral(name: "Kilter")
        let token = prepare(configuration("kilter"), key: "new-wall")
        var results: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(target)
            manager.connectPreparedBoard(deviceId: target.identifier.uuidString, preparationToken: token) { results.append($0) }
        }
        manager.testHooks.fireDidFailToConnect(peripheral: target, error: BoardBleError.deviceNotFound)
        XCTAssertEqual(results.count, 1)
        assertBulbRefused()

        manager = makeManager()
        manager.testHooks.sync { manager.testHooks.restorePeripherals([old, target]) }
        XCTAssertNil(manager.connectedDeviceId)
        XCTAssertTrue(cancellations.contains(old.identifier))
        XCTAssertTrue(cancellations.contains(target.identifier))
        assertBulbRefused()
    }

    func testLingeringOldLinkCannotBypassSnapshotBulbOrWriteGuards() {
        let old = FakeWritablePeripheral(name: "MoonBoard")
        establish(old, configuration: configuration(), key: "old-wall")
        _ = prepare(configuration("kilter"), key: "new-wall")
        let writesBefore = old.writtenChunks.count
        manager.testHooks.sync {
            manager.testHooks.setUnboundConnection(peripheral: old, characteristic: characteristic())
            manager.displayCurrentItem(items: [], currentIndex: 0)
            manager.write(data: Data([0x01])) { error, _ in XCTAssertNotNil(error) }
        }
        assertBulbRefused()
        XCTAssertEqual(old.writtenChunks.count, writesBefore)
        manager.testHooks.fireConnectionReady(peripheral: old, characteristic: characteristic())
        XCTAssertNil(manager.connectedDeviceInfo)
    }

    func testStalePickerTokenCannotConnectUsingNewerConfiguration() {
        let oldToken = prepare(configuration(), key: "wall-a")
        let currentToken = prepare(configuration("kilter"), key: "wall-b")
        let old = FakeWritablePeripheral()
        var staleResults: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(old)
            manager.connectPreparedBoard(deviceId: old.identifier.uuidString, preparationToken: oldToken) { staleResults.append($0) }
        }
        XCTAssertEqual(staleResults.count, 1)
        XCTAssertTrue(connects.isEmpty)
        assertBulbRefused()

        let current = FakeWritablePeripheral(name: "Kilter")
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(current)
            manager.connectPreparedBoard(deviceId: current.identifier.uuidString, preparationToken: currentToken) { _ in }
        }
        manager.testHooks.fireConnectionReady(peripheral: current, characteristic: characteristic())
        XCTAssertEqual(manager.connectedDeviceInfo?.deviceId, current.identifier.uuidString)
        XCTAssertEqual(manager.connectedDeviceInfo?.configKey, "wall-b")
    }

    func testOldReadyCallbackCannotBindOrCompleteNewAttempt() {
        let old = FakeWritablePeripheral()
        let oldToken = prepare(configuration(), key: "wall-a")
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(old)
            manager.connectPreparedBoard(deviceId: old.identifier.uuidString, preparationToken: oldToken) { _ in }
        }
        let current = FakeWritablePeripheral(name: "Kilter")
        let currentToken = prepare(configuration("kilter"), key: "wall-b")
        var currentResults: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(current)
            manager.connectPreparedBoard(deviceId: current.identifier.uuidString, preparationToken: currentToken) { currentResults.append($0) }
        }

        manager.testHooks.fireConnectionReady(peripheral: old, characteristic: characteristic())
        XCTAssertTrue(currentResults.isEmpty)
        XCTAssertNil(manager.connectedDeviceInfo)
        manager.testHooks.fireConnectionReady(peripheral: current, characteristic: characteristic())
        XCTAssertEqual(currentResults.count, 1)
        XCTAssertEqual(manager.connectedDeviceInfo?.configKey, "wall-b")
    }

    func testConfigurationUpdatesRequireBothKeyAndDeviceIdentity() {
        let peripheral = FakeWritablePeripheral(name: "MoonBoard")
        establish(peripheral, configuration: configuration(), key: "wall-a")
        manager.testHooks.sync {
            manager.configure(configuration("kilter"), configKey: "wall-b", deviceId: peripheral.identifier.uuidString)
            manager.configure(configuration("kilter"), configKey: "wall-a", deviceId: UUID().uuidString)
            manager.displayCurrentItem(items: [], currentIndex: 0)
        }
        XCTAssertEqual(peripheral.writtenChunks.last?.data, Data("l##".utf8))
        XCTAssertEqual(manager.connectedDeviceInfo?.configKey, "wall-a")
    }

    func testRestartRestoresOnlyTheBoundPeripheralAndKeepsBulbReconnect() {
        let peripheral = FakeWritablePeripheral(name: "MoonBoard")
        establish(peripheral, configuration: configuration(), key: "wall-a")
        manager = makeManager()
        let other = FakeWritablePeripheral(name: "MoonBoard")
        manager.testHooks.sync { manager.testHooks.restorePeripherals([other, peripheral]) }
        manager.testHooks.fireConnectionReady(peripheral: peripheral, characteristic: characteristic())
        XCTAssertTrue(cancellations.contains(other.identifier))
        XCTAssertEqual(manager.connectedDeviceInfo?.configKey, "wall-a")
        var reconnectSucceeded = false
        manager.testHooks.sync {
            manager.reconnectToLastKnownBoard(origin: .liveActivityIntent) { result in
                if case .success = result { reconnectSucceeded = true }
            }
        }
        XCTAssertTrue(reconnectSucceeded)
    }

    func testLegacyIndependentConfigAndLastDeviceCannotAuthorizeRestoration() throws {
        let peripheral = FakeWritablePeripheral(name: "MoonBoard")
        defaults.set(try JSONEncoder().encode(configuration("kilter")), forKey: SharedConstants.bleBoardConfigKey)
        defaults.set(peripheral.identifier.uuidString, forKey: SharedConstants.bleLastPeripheralUuidKey)
        manager = makeManager()
        manager.testHooks.sync { manager.testHooks.restorePeripherals([peripheral]) }
        XCTAssertTrue(cancellations.contains(peripheral.identifier))
        XCTAssertNil(manager.connectedDeviceId)
        assertBulbRefused()
    }

    func testTokenlessConnectAndPreviouslyConsumedTokenAreRefused() {
        let peripheral = FakeWritablePeripheral()
        let token = prepare(configuration(), key: "wall-a")
        var refused = 0
        manager.testHooks.sync {
            manager.testHooks.setDiscoveredPeripheral(peripheral)
            manager.connect(deviceId: peripheral.identifier.uuidString) { if case .failure = $0 { refused += 1 } }
            manager.connectPreparedBoard(deviceId: peripheral.identifier.uuidString, preparationToken: token) { _ in }
        }
        XCTAssertEqual(refused, 1)
        manager.testHooks.fireConnectionReady(peripheral: peripheral, characteristic: characteristic())
        manager.testHooks.sync {
            manager.connectPreparedBoard(deviceId: peripheral.identifier.uuidString, preparationToken: token) { if case .failure = $0 { refused += 1 } }
        }
        XCTAssertEqual(refused, 2)
        XCTAssertEqual(connects, [peripheral.identifier])
    }

    func testAwaitingOldDisplayCannotWriteAfterAnotherPreparation() async {
        _ = prepare(configuration(), key: "wall-a")
        let pendingDisplay = Task {
            await manager.displayCurrentItemAwaitingReady(items: [], currentIndex: 0, readyTimeout: 2)
        }
        var waiterRegistered = false
        for _ in 0..<1_000 {
            waiterRegistered = manager.testHooks.sync { manager.testHooks.hasReadyWaiters }
            if waiterRegistered { break }
            await Task.yield()
        }
        XCTAssertTrue(waiterRegistered)
        let current = FakeWritablePeripheral(name: "MoonBoard")
        establish(current, configuration: configuration(), key: "wall-b")
        let displayed = await pendingDisplay.value
        XCTAssertFalse(displayed)
        XCTAssertTrue(current.writtenChunks.isEmpty)
    }
}
