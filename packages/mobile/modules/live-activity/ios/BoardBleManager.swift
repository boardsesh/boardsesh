import CoreBluetooth
import Foundation
import os.log

struct BoardBleScanResult {
    let deviceId: String
    let name: String?
    let rssi: Int
    /// Service UUIDs from the advertisement packet. The JS layer filters scan
    /// results by these (plus name patterns) now that the scan itself runs
    /// unfiltered — a native service-UUID filter would hide MoonBoard
    /// controllers, which don't reliably advertise the UART service UUID.
    let serviceUuids: [String]
}

enum BoardBleError: LocalizedError {
    case bluetoothUnavailable
    case deviceNotFound
    case connectTimedOut
    case uartServiceMissing
    case writeCharacteristicMissing
    case notConnected
    case invalidHex
    case writeCancelled
    case superseded
    case writeTimedOut
    case writeRecoveryFailed

    var errorDescription: String? {
        switch self {
        case .bluetoothUnavailable:
            return "Bluetooth is not available"
        case .deviceNotFound:
            return "Bluetooth device was not found"
        case .connectTimedOut:
            return "Bluetooth connection timed out"
        case .uartServiceMissing:
            return "UART service was not found"
        case .writeCharacteristicMissing:
            return "UART write characteristic was not found"
        case .notConnected:
            return "No board is connected"
        case .invalidHex:
            return "Invalid hex payload"
        case .writeCancelled:
            return "BLE write cancelled"
        case .superseded:
            return "Bluetooth connection attempt was superseded by a newer one"
        case .writeTimedOut:
            // CONTRACT: the JS `isBleWriteTimeoutError` classifier
            // (packages/shared/ble-protocol/src/connection-error.ts) matches this
            // message via /write timed out/i to keep the self-healing severity
            // downgrade + recovery metric. Keep the literal substring "write timed
            // out" if you reword this.
            return "BLE write timed out waiting for the board to accept data"
        case .writeRecoveryFailed:
            // Hard failure surfaced when write-stall recovery is exhausted. Worded
            // to AVOID both the disconnect classifier (so the JS write-failure path
            // doesn't call native disconnect() and clear the stored board) and the
            // /write timed out/ matcher (so it reports as a real error, not a
            // self-healed warning). See connection-error.ts.
            return "BLE write failed; board stopped accepting data and recovery attempts were exhausted"
        }
    }
}

final class BoardBleManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let shared = BoardBleManager()

    private struct WriteRequest {
        let chunks: [Data]
        let connectionGeneration: UInt64
        let writeGeneration: UInt64
        let completion: (Error?) -> Void
    }

    private let logger = Logger(subsystem: "com.boardsesh.app", category: "BoardBleManager")
    private let bleQueue = DispatchQueue(label: "com.boardsesh.app.board-ble.queue")
    private let bleQueueKey = DispatchSpecificKey<Void>()
    private let auroraServiceUuid = CBUUID(string: "4488B571-7806-4DF6-BCFF-A2897E4953FF")
    private let uartServiceUuid = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    private let chunkSize = 20
    private let chunkDelay: TimeInterval = 0.005
    private let connectTimeout: TimeInterval = 8
    // How long a write parked on `canSendWriteWithoutResponse` may wait for
    // peripheralIsReady before the queue is failed. Generous: a healthy link
    // drains its transmit buffer in milliseconds.
    private let writeResumeTimeout: TimeInterval = 5
    // How many CONSECUTIVE write stalls (with no successful write between them)
    // we recover from by cycling the connection before giving up and surfacing
    // the disconnect to JS. A fresh GATT link clears CoreBluetooth's wedged
    // transmit state; bounding it stops a permanently dead link from spinning in
    // a reconnect loop. The counter resets whenever a write fully drains (#3181).
    private let maxWriteStallRecoveries = 2

    private lazy var centralManager = CBCentralManager(
        delegate: self,
        queue: bleQueue,
        options: [CBCentralManagerOptionRestoreIdentifierKey: "com.boardsesh.app.board-ble"]
    )

    private var discoveredPeripherals: [String: CBPeripheral] = [:]
    private var discoveredNames: [String: String] = [:]
    // What was last emitted to JS for each device in the CURRENT scan
    // (name + advertised UUIDs). With allow-duplicates on and (on newer JS)
    // an unfiltered scan, didDiscover fires continuously for every nearby
    // device; without this gate every repeat advertisement would cross the
    // native→JS bridge. Cleared on every startScan so a fresh scan re-emits.
    private var emittedScanResults: [String: String] = [:]
    private var connectedPeripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var pendingConnectCompletion: ((Result<Void, Error>) -> Void)?
    private var connectTimeoutWorkItem: DispatchWorkItem?
    private var scanRequested = false
    private var scanServices: [CBUUID] = []
    // Set while the Live Activity lightbulb's reconnect-by-last-known-board is
    // falling back to a scan: connect as soon as this UUID advertises.
    private var reconnectScanTargetUuid: UUID?
    private var reconnectScanCompletion: ((Result<Void, Error>) -> Void)?
    private var reconnectScanTimeoutWorkItem: DispatchWorkItem?
    private var intentionalDisconnectGenerations: [UUID: UInt64] = [:]
    private var peripheralGenerations: [UUID: UInt64] = [:]
    private var connectionGeneration: UInt64 = 0
    private var writeQueue: [WriteRequest] = []
    private var writeGeneration: UInt64 = 0
    private var isWriting = false
    private var pendingWriteResume: (() -> Void)?
    private var pendingWriteResumeWatchdog: DispatchWorkItem?
    // Write-stall recovery (#3181). `writeStallRecoveries` counts consecutive
    // stalls (reset on any drained write). `writeStallRecoveringPeripheralId` is
    // the board whose congested link we deliberately cycled; it is set across the
    // whole recovery window (cancel → deferred reconnect → characteristics
    // discovered) so that: (1) only the matching didDisconnectPeripheral triggers
    // the reconnect — never an unrelated peripheral's intentional disconnect —
    // and (2) a write that lands during the brief disconnected window surfaces
    // the self-healing `writeTimedOut` rather than `notConnected`, which the JS
    // classifier would mistake for a hard drop and tear the link down. Cleared by
    // any successful (re)connect, a deliberate disconnect, or Bluetooth-off.
    private var writeStallRecoveries = 0
    private var writeStallRecoveringPeripheralId: UUID?
    // Fail-closed safety net for the recover window: if the cancel's
    // `didDisconnectPeripheral` never arrives (a wedged link while Bluetooth
    // stays on), this fires so the window can't strand forever (wall dark, JS
    // still "connected"). Cancelled the moment the reconnect actually starts —
    // from there the reconnect's own connect timeout owns the deadline (#3181).
    private var writeStallRecoveryWatchdog: DispatchWorkItem?
    private var configuration: BoardBleConfiguration?
    private lazy var readyWaiters = WaiterPool(queue: bleQueue)
    private lazy var drainWaiters = WaiterPool(queue: bleQueue)

    private var onScanResult: ((BoardBleScanResult) -> Void)?
    private var onDisconnect: ((String) -> Void)?
    /// Fired whenever a connection becomes fully usable (write characteristic
    /// discovered) — JS-initiated connects, widget-intent reconnects and
    /// CoreBluetooth state restoration alike. The JS layer uses it to adopt
    /// natively-established connections so the in-app lightbulb matches the
    /// wall. Payload: (deviceId, deviceName).
    private var onConnected: ((String, String?) -> Void)?

    override private init() {
        super.init()
        bleQueue.setSpecific(key: bleQueueKey, value: ())
        runOnBleQueueSync {
            configuration = readConfiguration()
            _ = centralManager
        }
    }

    var isAvailable: Bool {
        runOnBleQueueSync {
            isAvailableOnBleQueue
        }
    }

    var connectedDeviceId: String? {
        runOnBleQueueSync {
            connectedPeripheral?.identifier.uuidString
        }
    }

    /// The currently-connected, write-ready board (id + best-known name), or
    /// nil. Exposed to JS as `getConnectedDevice` so a foregrounding app can
    /// adopt a connection established while it was backgrounded (widget
    /// reconnect) even if the `connected` event was missed.
    var connectedDeviceInfo: (deviceId: String, name: String?)? {
        runOnBleQueueSync {
            guard let peripheral = connectedPeripheral, writeCharacteristic != nil else { return nil }
            let deviceId = peripheral.identifier.uuidString
            return (deviceId, discoveredNames[deviceId] ?? peripheral.name)
        }
    }

    func setEventHandlers(
        onScanResult: ((BoardBleScanResult) -> Void)?,
        onDisconnect: ((String) -> Void)?,
        onConnected: ((String, String?) -> Void)? = nil
    ) {
        runOnBleQueue { [weak self] in
            self?.onScanResult = onScanResult
            self?.onDisconnect = onDisconnect
            self?.onConnected = onConnected
        }
    }

    func configure(_ configuration: BoardBleConfiguration) {
        runOnBleQueue { [weak self] in
            guard let self else { return }
            self.configuration = configuration
            self.writeConfiguration(configuration)
            self.displaySharedCurrentItemOnBleQueue()
        }
    }

    func startScan(serviceUuids: [String], completion: @escaping (Result<Void, Error>) -> Void) {
        runOnBleQueue { [weak self] in
            self?.startScanOnBleQueue(serviceUuids: serviceUuids, completion: completion)
        }
    }

    func stopScan() {
        runOnBleQueue { [weak self] in
            self?.stopScanOnBleQueue()
        }
    }

    func connect(deviceId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        runOnBleQueue { [weak self] in
            self?.connectOnBleQueue(deviceId: deviceId, completion: completion)
        }
    }

    func disconnect(completion: (() -> Void)? = nil) {
        runOnBleQueue { [weak self] in
            self?.disconnectOnBleQueue(completion: completion)
        }
    }

    /// Reconnect to the last successfully connected board (persisted peripheral
    /// UUID) without a device picker. Drives the Live Activity lightbulb's
    /// ReconnectBoardIntent. Tries a direct retrieve-by-identifier first (no
    /// scan, works while backgrounded); falls back to a time-boxed scan that
    /// connects when the stored UUID advertises.
    ///
    /// The JS layer hears about the reconnect through the bridged `connected`
    /// event (fired from didDiscoverCharacteristicsFor) and adopts the
    /// connection; if the event fired while JS was suspended, the foreground
    /// `getConnectedDevice` check in useBoardBluetooth picks it up instead.
    func reconnectToLastKnownBoard(completion: @escaping (Result<Void, Error>) -> Void) {
        runOnBleQueue { [weak self] in
            self?.reconnectToLastKnownBoardOnBleQueue(completion: completion)
        }
    }

    func write(hex: String, completion: @escaping (Result<Void, Error>) -> Void) {
        guard let data = Data(hexString: hex) else {
            completion(.failure(BoardBleError.invalidHex))
            return
        }
        write(data: data) { error in
            if let error {
                completion(.failure(error))
            } else {
                completion(.success(()))
            }
        }
    }

    func write(data: Data, completion: ((Error?) -> Void)? = nil) {
        runOnBleQueue { [weak self] in
            self?.writeOnBleQueue(data: data, completion: completion)
        }
    }

    func cancelWrites() {
        runOnBleQueue { [weak self] in
            self?.failQueuedWrites(BoardBleError.writeCancelled)
        }
    }

    func displayCurrentItem(items: [SharedQueueItem], currentIndex: Int) {
        runOnBleQueue { [weak self] in
            self?.displayCurrentItemOnBleQueue(items: items, currentIndex: currentIndex)
        }
    }

    func display(item: SharedQueueItem) {
        runOnBleQueue { [weak self] in
            self?.displayItemOnBleQueue(item)
        }
    }

    /// Awaits BLE readiness (peripheral + write characteristic discovered) up to
    /// `readyTimeout`, enqueues the display write, then waits up to
    /// `drainTimeout` for the UART chunks to flush. Designed for Live Activity
    /// intents that wake the main app in the background: CoreBluetooth state
    /// restoration is asynchronous, so a write issued immediately after wake
    /// would silently no-op against the `connectedPeripheral == nil` guard.
    /// If `readyTimeout` elapses before readiness, the write is still
    /// attempted; the existing `notConnected` guard in `writeOnBleQueue` will
    /// no-op cleanly. The not-ready case is logged at `error` level so a
    /// "widget UI moved but wall didn't" report can be diagnosed from
    /// Console.app without recompiling under DEBUG.
    func displayCurrentItemAwaitingReady(
        items: [SharedQueueItem],
        currentIndex: Int,
        readyTimeout: TimeInterval,
        drainTimeout: TimeInterval = 1.5
    ) async {
        await waitUntilReady(timeout: readyTimeout)
        let ready = runOnBleQueueSync { isReadyForWrite }
        if !ready {
            let state = runOnBleQueueSync { (
                centralState: centralManager.state.rawValue,
                hasPeripheral: connectedPeripheral != nil,
                hasWriteChar: writeCharacteristic != nil
            ) }
            logger.error("displayCurrentItemAwaitingReady: not ready after \(readyTimeout, privacy: .public)s — centralState=\(state.centralState, privacy: .public) peripheral=\(state.hasPeripheral, privacy: .public) writeChar=\(state.hasWriteChar, privacy: .public); BLE write will no-op until the JS layer's BluetoothAutoSender re-fires")
        }
        displayCurrentItem(items: items, currentIndex: currentIndex)
        await waitForWriteDrain(timeout: drainTimeout)
    }

    private var isAvailableOnBleQueue: Bool {
        switch centralManager.state {
        case .poweredOn, .unknown, .resetting:
            return true
        case .poweredOff, .unsupported, .unauthorized:
            return false
        @unknown default:
            return false
        }
    }

    private func startScanOnBleQueue(serviceUuids: [String], completion: @escaping (Result<Void, Error>) -> Void) {
        // An empty list means "scan unfiltered" (withServices: nil): the JS
        // layer filters results itself so MoonBoard controllers — which don't
        // reliably advertise the UART service UUID — still surface. Older JS
        // bundles always pass explicit UUIDs and keep the filtered behaviour.
        let uuids = serviceUuids.compactMap { CBUUID(string: $0) }
        scanServices = uuids
        scanRequested = true
        emittedScanResults = [:]

        guard centralManager.state == .poweredOn else {
            if isAvailableOnBleQueue {
                completion(.success(()))
            } else {
                completion(.failure(BoardBleError.bluetoothUnavailable))
            }
            return
        }

        centralManager.scanForPeripherals(
            withServices: scanServices.isEmpty ? nil : scanServices,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        completion(.success(()))
    }

    private func stopScanOnBleQueue() {
        scanRequested = false
        if centralManager.isScanning {
            centralManager.stopScan()
        }
    }

    private func connectOnBleQueue(deviceId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        // Supersede any in-flight reconnect-by-last-known scan: this is a no-op
        // when called from the reconnect path itself (which already nils the scan
        // state first), but settles a stranded scan immediately when an unrelated
        // connect interleaves instead of letting it linger until its timeout.
        failReconnectScan(BoardBleError.notConnected)

        guard centralManager.state == .poweredOn else {
            completion(.failure(BoardBleError.bluetoothUnavailable))
            return
        }

        if connectedPeripheral?.identifier.uuidString == deviceId, writeCharacteristic != nil {
            completion(.success(()))
            displaySharedCurrentItemOnBleQueue()
            return
        }

        guard let peripheral = discoveredPeripherals[deviceId] else {
            completion(.failure(BoardBleError.deviceNotFound))
            return
        }

        // Starting a fresh connection. Unless this is the same board's write-stall
        // recovery reconnect (which routes through here with the SAME id and must
        // keep its in-progress budget so recovery stays bounded), a connect to a
        // DIFFERENT board supersedes any in-flight recovery: clear the recovery
        // window + watchdog so a stale didDisconnect for the old board can't hijack
        // this connect, and reset the budget for the new link (#3181).
        if writeStallRecoveringPeripheralId != peripheral.identifier {
            writeStallRecoveringPeripheralId = nil
            writeStallRecoveries = 0
            writeStallRecoveryWatchdog?.cancel()
            writeStallRecoveryWatchdog = nil
        }

        stopScanOnBleQueue()
        failQueuedWrites(BoardBleError.writeCancelled)
        // Settle any still-pending connect before starting this one. Silently
        // overwriting pendingConnectCompletion would orphan the prior attempt's
        // JS promise (it would never resolve), and its still-scheduled timeout
        // work item could later misfire against THIS attempt: for a different
        // target device the old peripheral's generation entry survives the
        // bump below, so the stale timeout's guards both pass and it would
        // call completePendingConnect against the new completion.
        // completePendingConnect also cancels that stale timeout work item.
        completePendingConnect(.failure(BoardBleError.superseded))
        connectionGeneration += 1
        let generation = connectionGeneration
        intentionalDisconnectGenerations.removeValue(forKey: peripheral.identifier)
        pendingConnectCompletion = completion
        connectedPeripheral = peripheral
        writeCharacteristic = nil
        peripheralGenerations[peripheral.identifier] = generation
        peripheral.delegate = self

        let timeoutWorkItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.pendingConnectCompletion != nil else { return }
            guard self.peripheralGenerations[peripheral.identifier] == generation else { return }
            self.peripheralGenerations.removeValue(forKey: peripheral.identifier)
            if self.connectedPeripheral?.identifier == peripheral.identifier {
                self.connectedPeripheral = nil
                self.writeCharacteristic = nil
            }
            self.centralManager.cancelPeripheralConnection(peripheral)
            self.completePendingConnect(.failure(BoardBleError.connectTimedOut))
        }
        connectTimeoutWorkItem = timeoutWorkItem
        bleQueue.asyncAfter(deadline: .now() + connectTimeout, execute: timeoutWorkItem)

        centralManager.connect(peripheral, options: [
            CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
        ])
    }

    private func reconnectToLastKnownBoardOnBleQueue(completion: @escaping (Result<Void, Error>) -> Void) {
        // Already connected — re-light the wall and report success.
        if connectedPeripheral != nil, writeCharacteristic != nil {
            completion(.success(()))
            displaySharedCurrentItemOnBleQueue()
            return
        }
        guard centralManager.state == .poweredOn else {
            completion(.failure(BoardBleError.bluetoothUnavailable))
            return
        }
        guard let defaults = SharedConstants.sharedDefaults,
              let uuidString = defaults.string(forKey: SharedConstants.bleLastPeripheralUuidKey),
              let uuid = UUID(uuidString: uuidString)
        else {
            completion(.failure(BoardBleError.deviceNotFound))
            return
        }

        // Fast path: the system still has this peripheral cached — connect
        // directly without scanning (works while backgrounded).
        if let peripheral = centralManager.retrievePeripherals(withIdentifiers: [uuid]).first {
            discoveredPeripherals[uuidString] = peripheral
            if let name = peripheral.name {
                discoveredNames[uuidString] = name
            }
            connectOnBleQueue(deviceId: uuidString, completion: completion)
            return
        }

        // Fallback: scan, and connect when the stored UUID advertises.
        beginReconnectScanOnBleQueue(targetUuid: uuid, completion: completion)
    }

    private func beginReconnectScanOnBleQueue(targetUuid: UUID, completion: @escaping (Result<Void, Error>) -> Void) {
        reconnectScanTargetUuid = targetUuid
        reconnectScanCompletion = completion

        let timeout = DispatchWorkItem { [weak self] in
            self?.failReconnectScan(BoardBleError.connectTimedOut)
        }
        reconnectScanTimeoutWorkItem = timeout
        bleQueue.asyncAfter(deadline: .now() + connectTimeout, execute: timeout)

        // Filter on both the Aurora advertised service and the UART service so a
        // MoonBoard (which advertises UART) is matchable too, mirroring the JS
        // adapter's scan filter.
        startScanOnBleQueue(serviceUuids: [auroraServiceUuid.uuidString, uartServiceUuid.uuidString]) { [weak self] result in
            if case .failure(let error) = result {
                self?.failReconnectScan(error)
            }
        }
    }

    /// Settle a pending reconnect scan with a failure (timeout or scan error),
    /// firing the stored completion exactly once and tearing down the scan.
    private func failReconnectScan(_ error: Error) {
        guard let completion = reconnectScanCompletion else { return }
        reconnectScanCompletion = nil
        reconnectScanTargetUuid = nil
        reconnectScanTimeoutWorkItem?.cancel()
        reconnectScanTimeoutWorkItem = nil
        stopScanOnBleQueue()
        completion(.failure(error))
    }

    private func persistLastConnectedPeripheral(_ peripheral: CBPeripheral) {
        SharedConstants.sharedDefaults?.set(
            peripheral.identifier.uuidString,
            forKey: SharedConstants.bleLastPeripheralUuidKey
        )
    }

    private func clearLastConnectedPeripheral() {
        SharedConstants.sharedDefaults?.removeObject(forKey: SharedConstants.bleLastPeripheralUuidKey)
    }

    private func disconnectOnBleQueue(completion: (() -> Void)? = nil) {
        connectionGeneration += 1
        // A deliberate disconnect supersedes any in-flight write-stall recovery
        // (#3181): drop the recovery window and reset the budget.
        writeStallRecoveringPeripheralId = nil
        writeStallRecoveries = 0
        // Settle any in-flight reconnect-by-last-known scan before tearing down.
        failReconnectScan(BoardBleError.notConnected)
        // A deliberate disconnect forgets the board so the widget lightbulb won't
        // silently reconnect to it later. An unexpected drop leaves it intact.
        clearLastConnectedPeripheral()
        stopScanOnBleQueue()
        failQueuedWrites(BoardBleError.notConnected)
        completePendingConnect(.failure(BoardBleError.notConnected))

        guard let peripheral = connectedPeripheral else {
            writeCharacteristic = nil
            completion?()
            return
        }

        intentionalDisconnectGenerations[peripheral.identifier] = connectionGeneration
        peripheralGenerations[peripheral.identifier] = connectionGeneration
        centralManager.cancelPeripheralConnection(peripheral)
        writeCharacteristic = nil
        connectedPeripheral = nil
        completion?()
    }

    private func writeOnBleQueue(data: Data, completion: ((Error?) -> Void)? = nil) {
        guard connectedPeripheral != nil, writeCharacteristic != nil else {
            // During a write-stall recovery the link is briefly down between the
            // cancel and the reconnect. Surface the self-healing `writeTimedOut`
            // (a warning JS rides out with `isConnected` kept) rather than
            // `notConnected`, which the JS classifier treats as a hard drop and
            // would tear the connection down mid-recovery (#3181).
            completion?(writeStallRecoveringPeripheralId != nil ? BoardBleError.writeTimedOut : BoardBleError.notConnected)
            return
        }

        let chunks = stride(from: 0, to: data.count, by: chunkSize).map { offset in
            data.subdata(in: offset..<min(offset + chunkSize, data.count))
        }

        writeQueue.append(
            WriteRequest(
                chunks: chunks,
                connectionGeneration: connectionGeneration,
                writeGeneration: writeGeneration,
                completion: completion ?? { _ in }
            )
        )
        processWriteQueue()
    }

    private func displaySharedCurrentItemOnBleQueue() {
        guard let defaults = SharedConstants.sharedDefaults else { return }
        let (items, currentIndex) = SharedQueueState.load(from: defaults)
        displayCurrentItemOnBleQueue(items: items, currentIndex: currentIndex)
    }

    private func displayCurrentItemOnBleQueue(items: [SharedQueueItem], currentIndex: Int) {
        guard currentIndex >= 0, currentIndex < items.count else {
            clearBoardOnBleQueue()
            return
        }
        displayItemOnBleQueue(items[currentIndex])
    }

    private func clearBoardOnBleQueue() {
        guard let configuration else { return }
        guard connectedPeripheral != nil, writeCharacteristic != nil else { return }

        // MoonBoard has no clear-all command (an empty `l##` frame is a no-op on
        // the controller and the JS layer refuses to send it), so leave the wall
        // lit as-is rather than writing an Aurora clear packet to it.
        if configuration.boardName == "moonboard" { return }

        let result = BoardBleEncoding.makeAuroraPacket(
            frames: "",
            placementPositions: [:],
            boardName: configuration.boardName,
            apiLevel: apiLevelOnBleQueue(configuration: configuration),
            colorOverrides: configuration.colorOverrides
        )

        guard !result.packet.isEmpty else { return }
        writeOnBleQueue(data: result.packet) { [weak self] error in
            if let error {
                self?.logger.error("BLE clear failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func displayItemOnBleQueue(_ item: SharedQueueItem) {
        guard let configuration else { return }
        guard connectedPeripheral != nil, writeCharacteristic != nil else { return }

        // MoonBoard encodes straight from grid coordinates into the ASCII `l#…#`
        // frame format — it has no LED placement map and the Aurora binary
        // encoder can't drive it (no `moonboard` role map). Without this branch a
        // native re-light (widget intent or write-stall recovery reconnect) would
        // silently write nothing and the wall would stay dark. Mirroring isn't
        // supported on MoonBoard (boardSupportsMirroring is false), so frames go
        // out as-is.
        if configuration.boardName == "moonboard" {
            let result = BoardBleEncoding.makeMoonboardPacket(frames: item.frames)
            guard !result.packet.isEmpty else {
                // Every hold was unrecognised/out-of-range, or the climb has no
                // holds. Refuse to write rather than dark the wall — there is no
                // MoonBoard clear-all.
                logger.warning("Skipping MoonBoard BLE write: no encodable holds for climb \(item.climbUuid, privacy: .public)")
                return
            }
            writeOnBleQueue(data: result.packet) { [weak self] error in
                if let error {
                    self?.logger.error("BLE write failed: \(error.localizedDescription, privacy: .public)")
                }
            }
            return
        }

        let ledPlacements = BoardPlacementData.getLedPlacements(
            boardName: configuration.boardName,
            layoutId: configuration.layoutId,
            sizeId: configuration.sizeId
        )
        guard !ledPlacements.isEmpty || item.frames.isEmpty else {
            logger.error("Missing LED placement data for \(configuration.boardName, privacy: .public) layout=\(configuration.layoutId, privacy: .public) size=\(configuration.sizeId, privacy: .public)")
            return
        }

        let framesToSend: String
        if item.mirrored {
            guard let mirroredFrames = BoardBleEncoding.mirroredFrames(
                frames: item.frames,
                boardName: configuration.boardName,
                layoutId: configuration.layoutId
            ) else {
                logger.warning("Cannot mirror frames for climb \(item.climbUuid, privacy: .public)")
                return
            }
            framesToSend = mirroredFrames
        } else {
            framesToSend = item.frames
        }

        let result = BoardBleEncoding.makeAuroraPacket(
            frames: framesToSend,
            placementPositions: ledPlacements,
            boardName: configuration.boardName,
            apiLevel: apiLevelOnBleQueue(configuration: configuration),
            colorOverrides: configuration.colorOverrides
        )

        guard !result.packet.isEmpty || framesToSend.isEmpty else {
            logger.warning("Skipping BLE write because no placements resolved for climb \(item.climbUuid, privacy: .public)")
            return
        }

        writeOnBleQueue(data: result.packet) { [weak self] error in
            if let error {
                self?.logger.error("BLE write failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            // Defensive: during state restoration after an intent-driven
            // background launch, `didDiscoverCharacteristicsFor` (which
            // normally calls `readyWaiters.signalAll()`) can land before
            // the central transitions to `.poweredOn`. In that ordering,
            // `isReadyForWrite` was still false when the waiter was
            // enqueued, and signalAll's earlier call hit an empty pool.
            // Resignal here so the waiter unblocks immediately instead of
            // sitting until its timeout fires.
            if isReadyForWrite {
                readyWaiters.signalAll()
            }
            if scanRequested {
                // Empty scanServices = unfiltered scan (see startScanOnBleQueue).
                central.scanForPeripherals(withServices: scanServices.isEmpty ? nil : scanServices, options: [
                    CBCentralManagerScanOptionAllowDuplicatesKey: true,
                ])
            }
        } else {
            // Bluetooth went away mid-recovery: the deferred reconnect's
            // didDisconnect may never arrive, so close the write-stall recovery
            // window and reset the budget. Otherwise a later intentional
            // disconnect could be mistaken for a stall recovery, writes would
            // keep parking on the window, or a post-power-on session would start
            // with a depleted budget (#3181).
            writeStallRecoveringPeripheralId = nil
            writeStallRecoveries = 0
        }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
              let peripheral = peripherals.first
        else {
            return
        }

        // More than one restored peripheral means a superseded connect attempt
        // was still mid-flight at suspension. Keep only the first; cancel the
        // rest so they don't linger as system-held connections — these boards
        // are last-connection-wins, so a phantom link blocks the wall.
        for extra in peripherals.dropFirst() {
            logger.info("Cancelling extra restored BLE peripheral \(extra.identifier.uuidString, privacy: .public)")
            central.cancelPeripheralConnection(extra)
        }

        let deviceId = peripheral.identifier.uuidString
        connectionGeneration += 1
        discoveredPeripherals[deviceId] = peripheral
        peripheral.delegate = self

        switch peripheral.state {
        case .connected:
            peripheralGenerations[peripheral.identifier] = connectionGeneration
            connectedPeripheral = peripheral
            logger.info("Restored BLE peripheral \(deviceId, privacy: .public)")
            peripheral.discoverServices([uartServiceUuid])
        case .connecting:
            // The restored connect request is still pending; didConnect will
            // run service discovery when the link comes up (the generation set
            // here keeps its guard satisfied).
            peripheralGenerations[peripheral.identifier] = connectionGeneration
            connectedPeripheral = peripheral
            logger.info("Restored BLE peripheral \(deviceId, privacy: .public) still connecting")
        default:
            // Disconnected or disconnecting: nothing usable to restore, and
            // adopting it would leave a half-open connectedPeripheral with no
            // write characteristic.
            logger.info("Restored BLE peripheral \(deviceId, privacy: .public) not connected (state=\(peripheral.state.rawValue, privacy: .public)); ignoring")
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let deviceId = peripheral.identifier.uuidString
        let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = localName ?? peripheral.name
        discoveredPeripherals[deviceId] = peripheral
        if let name {
            discoveredNames[deviceId] = name
        }
        // Overflow UUIDs cover peripherals whose advertisement is too full to
        // carry the service list in the main packet.
        let advertisedServiceUuids = ((advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? [])
            + (advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? []))
            .map { $0.uuidString }
        // Only cross the bridge when something material changed for this
        // device (first sighting, name arriving in a later scan response, or
        // a different advertised UUID set).
        let emissionKey = "\(name ?? "")|\(advertisedServiceUuids.joined(separator: ","))"
        if emittedScanResults[deviceId] != emissionKey {
            emittedScanResults[deviceId] = emissionKey
            onScanResult?(BoardBleScanResult(deviceId: deviceId, name: name, rssi: RSSI.intValue, serviceUuids: advertisedServiceUuids))
        }

        // Reconnect-by-last-known-board scan fallback: the stored board just
        // advertised — hand its completion to connectOnBleQueue (which stops the
        // scan and connects). Fires exactly once.
        if let targetUuid = reconnectScanTargetUuid, peripheral.identifier == targetUuid,
           let completion = reconnectScanCompletion {
            reconnectScanCompletion = nil
            reconnectScanTargetUuid = nil
            reconnectScanTimeoutWorkItem?.cancel()
            reconnectScanTimeoutWorkItem = nil
            connectOnBleQueue(deviceId: deviceId, completion: completion)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheralGenerations[peripheral.identifier] == connectionGeneration else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.delegate = self
        peripheral.discoverServices([uartServiceUuid])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheralGenerations[peripheral.identifier] == connectionGeneration else { return }
        // Every connect attempt (user-initiated picker connect, or the Live Activity
        // lightbulb's reconnectToLastKnownBoard) sets pendingConnectCompletion, so a
        // failure here just settles that one attempt. No auto-reconnect: we never
        // silently retry a board another device may have legitimately taken.
        peripheralGenerations.removeValue(forKey: peripheral.identifier)
        if connectedPeripheral?.identifier == peripheral.identifier {
            connectedPeripheral = nil
            writeCharacteristic = nil
        }
        completePendingConnect(.failure(error ?? BoardBleError.notConnected))
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let deviceId = peripheral.identifier.uuidString
        let wasCurrentPeripheral = connectedPeripheral?.identifier == peripheral.identifier
        let intentionalDisconnectGeneration = intentionalDisconnectGenerations.removeValue(forKey: peripheral.identifier)

        if let intentionalDisconnectGeneration {
            if peripheralGenerations[peripheral.identifier] == intentionalDisconnectGeneration {
                peripheralGenerations.removeValue(forKey: peripheral.identifier)
            }
            // Write-stall recovery (#3181): the congested link we deliberately
            // dropped is now fully torn down, so reconnect to the same board.
            // Gated on the peripheral id so an unrelated intentional disconnect
            // (user disconnect, a different board's connect supersede) can't be
            // mistaken for a stall recovery. Deferring to here (rather than
            // reconnecting inside handleWriteStall) serialises
            // teardown-then-reconnect for the same peripheral id and avoids a late
            // didDisconnect tearing the new link back down. didDisconnect already
            // consumed the intentional flag above, so this fires at most once per
            // cancel. On success, didDiscoverCharacteristicsFor clears the window
            // and re-lights the wall (the counter resets when that write drains);
            // on failure we surface the disconnect to JS and reset the budget.
            if writeStallRecoveringPeripheralId == peripheral.identifier {
                // The reconnect is starting; its own connect timeout now owns the
                // deadline, so retire the cancel→didDisconnect safety net.
                writeStallRecoveryWatchdog?.cancel()
                writeStallRecoveryWatchdog = nil
                reconnectToLastKnownBoardOnBleQueue { [weak self] result in
                    guard let self else { return }
                    if case .failure(let error) = result {
                        self.logger.error("BLE write-stall reconnect failed: \(error.localizedDescription, privacy: .public)")
                        self.writeStallRecoveringPeripheralId = nil
                        self.writeStallRecoveries = 0
                        self.onDisconnect?(deviceId)
                    }
                }
            }
            return
        }

        guard wasCurrentPeripheral else {
            peripheralGenerations.removeValue(forKey: peripheral.identifier)
            return
        }

        connectedPeripheral = nil
        writeCharacteristic = nil
        failQueuedWrites(error ?? BoardBleError.notConnected)
        onDisconnect?(deviceId)

        // No auto-reconnect. These boards are last-connection-wins, so silently
        // re-grabbing the link would steal the wall back from whoever took it — a
        // ping-pong that flickers the LEDs. Reconnection is user-initiated only:
        // the in-app device picker, or the Live Activity lightbulb
        // (reconnectToLastKnownBoard).
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        // Identity AND generation, mirroring didConnect: a stale discovery
        // callback from a superseded connect attempt to the same device must
        // not complete the newer attempt early.
        guard connectedPeripheral?.identifier == peripheral.identifier,
              peripheralGenerations[peripheral.identifier] == connectionGeneration
        else { return }
        if let error {
            failConnectionSetup(peripheral, error: error)
            return
        }

        guard let service = peripheral.services?.first(where: { $0.uuid == uartServiceUuid }) else {
            failConnectionSetup(peripheral, error: BoardBleError.uartServiceMissing)
            return
        }

        peripheral.discoverCharacteristics([uartWriteCharacteristicUuid], for: service)
    }

    /// A connection that reached service discovery but can't become
    /// write-ready is useless — tear it down instead of leaving a half-open
    /// peripheral (`connectedPeripheral` set, `writeCharacteristic` nil) that
    /// blocks later reconnects. Settles the pending JS connect when one exists
    /// (picker connect / widget reconnect); during state restoration there is
    /// no pending completion and the teardown itself is the fix.
    private func failConnectionSetup(_ peripheral: CBPeripheral, error: Error) {
        logger.error("BLE connection setup failed for \(peripheral.identifier.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
        peripheralGenerations.removeValue(forKey: peripheral.identifier)
        if connectedPeripheral?.identifier == peripheral.identifier {
            connectedPeripheral = nil
            writeCharacteristic = nil
        }
        centralManager.cancelPeripheralConnection(peripheral)
        completePendingConnect(.failure(error))
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard connectedPeripheral?.identifier == peripheral.identifier,
              peripheralGenerations[peripheral.identifier] == connectionGeneration
        else { return }
        if let error {
            failConnectionSetup(peripheral, error: error)
            return
        }

        guard let characteristic = service.characteristics?.first(where: { $0.uuid == uartWriteCharacteristicUuid }) else {
            failConnectionSetup(peripheral, error: BoardBleError.writeCharacteristicMissing)
            return
        }

        connectedPeripheral = peripheral
        writeCharacteristic = characteristic
        // Any successful (re)connect closes a write-stall recovery window (#3181)
        // — writes flow normally again from here.
        writeStallRecoveringPeripheralId = nil
        // Remember the board so the Live Activity lightbulb can reconnect to it
        // by identifier later, no device pick required.
        persistLastConnectedPeripheral(peripheral)
        completePendingConnect(.success(()))
        logger.info("Connected to board BLE peripheral \(peripheral.identifier.uuidString, privacy: .public)")
        // Tell JS the link is usable. This is the single success point for
        // every connect path (JS connect, widget reconnect, state
        // restoration), so the JS layer can adopt connections it didn't
        // initiate.
        let connectedDeviceId = peripheral.identifier.uuidString
        onConnected?(connectedDeviceId, discoveredNames[connectedDeviceId] ?? peripheral.name)
        let hadPendingReadyWaiters = readyWaiters.hasPendingWaiters
        readyWaiters.signalAll()
        // Skip the implicit shared-state write when an intent is waiting on
        // readiness — the intent's awaited code will issue its own
        // displayCurrentItem with the same shared state, and we'd otherwise
        // write the identical packet twice.
        if !hadPendingReadyWaiters {
            displaySharedCurrentItemOnBleQueue()
        }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        pendingWriteResumeWatchdog?.cancel()
        pendingWriteResumeWatchdog = nil
        let resume = pendingWriteResume
        pendingWriteResume = nil
        resume?()
    }

    // MARK: - Private

    private func runOnBleQueue(_ operation: @escaping () -> Void) {
        if DispatchQueue.getSpecific(key: bleQueueKey) != nil {
            operation()
        } else {
            bleQueue.async {
                operation()
            }
        }
    }

    private func runOnBleQueueSync<T>(_ operation: () -> T) -> T {
        if DispatchQueue.getSpecific(key: bleQueueKey) != nil {
            return operation()
        }
        return bleQueue.sync(execute: operation)
    }

    private var isReadyForWrite: Bool {
        centralManager.state == .poweredOn
            && connectedPeripheral != nil
            && writeCharacteristic != nil
    }

    private func waitUntilReady(timeout: TimeInterval) async {
        await readyWaiters.wait(timeout: timeout) { [weak self] in
            self?.isReadyForWrite ?? true
        }
    }

    private func waitForWriteDrain(timeout: TimeInterval) async {
        await drainWaiters.wait(timeout: timeout) { [weak self] in
            guard let self else { return true }
            return self.writeQueue.isEmpty && !self.isWriting
        }
    }

    /// Resume any drain waiters now that the write queue may have emptied.
    /// Called from `processWriteQueue` (when its top-of-function guard
    /// indicates we're drained) and `failQueuedWrites`.
    private func notifyDrainWaitersIfDrainedOnBleQueue() {
        guard writeQueue.isEmpty, !isWriting else { return }
        drainWaiters.signalAll()
    }

    private func apiLevelOnBleQueue(configuration: BoardBleConfiguration) -> Int {
        let connectedDeviceName: String?
        if let connectedPeripheral {
            connectedDeviceName = discoveredNames[connectedPeripheral.identifier.uuidString] ?? connectedPeripheral.name
        } else {
            connectedDeviceName = nil
        }
        return configuration.apiLevel ?? BoardBleEncoding.parseApiLevel(
            deviceName: connectedDeviceName ?? configuration.deviceName
        )
    }

    private func completePendingConnect(_ result: Result<Void, Error>) {
        connectTimeoutWorkItem?.cancel()
        connectTimeoutWorkItem = nil
        let completion = pendingConnectCompletion
        pendingConnectCompletion = nil
        completion?(result)
    }

    private func processWriteQueue() {
        if isWriting {
            // A chunk is already in flight; the post-chunk path will call us
            // again. Nothing to do here.
            return
        }
        if writeQueue.isEmpty {
            // Drained. Resume any tasks awaiting `waitForWriteDrain`.
            notifyDrainWaitersIfDrainedOnBleQueue()
            return
        }
        isWriting = true
        let request = writeQueue[0]
        writeChunk(
            requestIndex: 0,
            chunkIndex: 0,
            connectionGeneration: request.connectionGeneration,
            writeGeneration: request.writeGeneration
        )
    }

    private func writeChunk(
        requestIndex: Int,
        chunkIndex: Int,
        connectionGeneration: UInt64,
        writeGeneration: UInt64
    ) {
        guard connectionGeneration == self.connectionGeneration, writeGeneration == self.writeGeneration else {
            // The connection or write generation flipped under us (disconnect,
            // reconnect, state restoration, or write cancellation). Bail out
            // and re-arm so `isWriting` can't get stranded `true`. Dispatched
            // back through `bleQueue` rather than tail-called so the stack
            // stays bounded even if the queue contains many stale-generation
            // requests in a row (current code paths clear the queue on
            // generation bumps so this is defensive).
            isWriting = false
            bleQueue.async { [weak self] in self?.processWriteQueue() }
            return
        }
        guard requestIndex < writeQueue.count else {
            isWriting = false
            bleQueue.async { [weak self] in self?.processWriteQueue() }
            return
        }
        let request = writeQueue[requestIndex]
        guard request.connectionGeneration == connectionGeneration, request.writeGeneration == writeGeneration else {
            isWriting = false
            bleQueue.async { [weak self] in self?.processWriteQueue() }
            return
        }

        guard let peripheral = connectedPeripheral, let characteristic = writeCharacteristic else {
            let request = writeQueue.removeFirst()
            request.completion(BoardBleError.notConnected)
            isWriting = false
            processWriteQueue()
            return
        }

        guard chunkIndex < request.chunks.count else {
            _ = writeQueue.removeFirst()
            // A write got through end-to-end: the link is healthy, so refresh the
            // write-stall recovery budget (#3181).
            writeStallRecoveries = 0
            request.completion(nil)
            isWriting = false
            processWriteQueue()
            return
        }

        guard peripheral.canSendWriteWithoutResponse else {
            pendingWriteResume = { [weak self] in
                self?.writeChunk(
                    requestIndex: requestIndex,
                    chunkIndex: chunkIndex,
                    connectionGeneration: connectionGeneration,
                    writeGeneration: writeGeneration
                )
            }
            // Watchdog: peripheralIsReady is the ONLY resume signal, and a
            // marginal link can simply never deliver it (without ever
            // disconnecting either). Unbounded, `isWriting` would stay true
            // forever and the wall would freeze until a manual disconnect.
            let watchdog = DispatchWorkItem { [weak self] in
                guard let self, self.pendingWriteResume != nil else { return }
                self.logger.error("BLE write stalled: peripheral never became ready for write-without-response; attempting recovery")
                self.handleWriteStall()
            }
            pendingWriteResumeWatchdog?.cancel()
            pendingWriteResumeWatchdog = watchdog
            bleQueue.asyncAfter(deadline: .now() + writeResumeTimeout, execute: watchdog)
            return
        }

        peripheral.writeValue(request.chunks[chunkIndex], for: characteristic, type: .withoutResponse)
        bleQueue.asyncAfter(deadline: .now() + chunkDelay) { [weak self] in
            self?.writeChunk(
                requestIndex: requestIndex,
                chunkIndex: chunkIndex + 1,
                connectionGeneration: connectionGeneration,
                writeGeneration: writeGeneration
            )
        }
    }

    private func failQueuedWrites(_ error: Error) {
        writeGeneration += 1
        let queuedWrites = writeQueue
        writeQueue = []
        isWriting = false
        pendingWriteResume = nil
        pendingWriteResumeWatchdog?.cancel()
        pendingWriteResumeWatchdog = nil
        for request in queuedWrites {
            request.completion(error)
        }
        notifyDrainWaitersIfDrainedOnBleQueue()
    }

    /// Recovery for a write that parked on `canSendWriteWithoutResponse` and
    /// never received `peripheralIsReady` within `writeResumeTimeout` — a
    /// marginal link that stays connected but stops accepting data. The old
    /// behaviour dropped the write outright, so the wall stayed dark until a
    /// manual re-tap or reconnect (#3181).
    ///
    /// A fresh GATT connection is the only reliable way to clear CoreBluetooth's
    /// wedged transmit state, so we cycle the link: settle the stalled writes
    /// (so the JS `write()` promise resolves and never leaks — there is no
    /// JS-side write timeout), then intentionally disconnect the current
    /// peripheral and reconnect to it by identifier. The reconnect's success
    /// path re-lights the wall via the existing
    /// `displaySharedCurrentItemOnBleQueue` in didDiscoverCharacteristicsFor.
    ///
    /// Unlike an *unexpected* drop (didDisconnectPeripheral), reconnecting here
    /// doesn't risk stealing a last-connection-wins board from someone else: we
    /// still hold the link and are recovering our own congested connection to
    /// the board the user is actively driving. There is a brief window between
    /// the cancel and the reconnect where another device could grab the board;
    /// it's bounded (at most `maxWriteStallRecoveries` cycles) and the recovering
    /// user is the one actively on the wall, so contention is unlikely.
    ///
    /// Bounded by `maxWriteStallRecoveries` CONSECUTIVE stalls (the counter
    /// resets on any successful write drain) so a permanently dead link can't
    /// spin in a reconnect loop — once the budget is spent we tear the link down
    /// and surface the disconnect to JS so the lightbulb reflects reality and
    /// the user can re-tap.
    private func handleWriteStall() {
        guard let peripheral = connectedPeripheral else {
            // No link to recover (a disconnect already settled and emptied the
            // queue). Settle defensively; harmless on an empty queue.
            failQueuedWrites(BoardBleError.writeTimedOut)
            return
        }
        let deviceId = peripheral.identifier.uuidString

        guard writeStallRecoveries < maxWriteStallRecoveries else {
            // Budget spent: a fresh connection didn't help, so this is a genuine
            // send failure, not a self-healing stall. Settle the queued writes with
            // `writeRecoveryFailed` — NOT `writeTimedOut` (which JS would downgrade
            // to an "auto-recovered" warning, mislabeling a dark wall) and NOT a
            // disconnect-classified error (which would make the JS write-failure
            // path call native disconnect() and clear the stored board). JS tears
            // down via the onDisconnect event below; the persisted board is kept so
            // the user / Live Activity lightbulb can reconnect on demand (we do NOT
            // clear bleLastPeripheralUuidKey).
            logger.error("BLE write-stall recovery budget exhausted; surfacing disconnect for \(deviceId, privacy: .public)")
            failQueuedWrites(BoardBleError.writeRecoveryFailed)
            writeStallRecoveries = 0
            writeStallRecoveringPeripheralId = nil
            cancelConnectionIntentionallyOnBleQueue(peripheral)
            onDisconnect?(deviceId)
            return
        }

        // Recoverable stall: settle the queued writes with the self-healing
        // `writeTimedOut` (no JS promise leak; JS keeps `isConnected` true while we
        // reconnect — a write timeout is not a disconnect on the JS side), then
        // intentionally drop the congested link and reconnect to the same board.
        // The reconnect is DEFERRED to the cancel's didDisconnect callback:
        // reconnecting synchronously to the SAME peripheral id would let
        // connectOnBleQueue clear the intentional flag, and a late didDisconnect
        // from the cancelled link would then wrongly tear down the new connection.
        failQueuedWrites(BoardBleError.writeTimedOut)
        writeStallRecoveries += 1
        logger.error("BLE write-stall recovery \(self.writeStallRecoveries, privacy: .public)/\(self.maxWriteStallRecoveries, privacy: .public): cycling the connection for \(deviceId, privacy: .public)")
        writeStallRecoveringPeripheralId = peripheral.identifier
        cancelConnectionIntentionallyOnBleQueue(peripheral)
        // NOTE: bleLastPeripheralUuidKey is intentionally NOT cleared so the
        // deferred reconnectToLastKnownBoard can find this board.

        // Guard only the cancel → didDisconnect gap. `didDisconnectPeripheral`'s
        // recovery arm cancels this and hands the deadline to the reconnect's own
        // connect timeout; if didDisconnect never lands, this fails closed.
        let recoveringId = peripheral.identifier
        let recoveryWatchdog = DispatchWorkItem { [weak self] in
            guard let self, self.writeStallRecoveringPeripheralId == recoveringId else { return }
            self.logger.error("BLE write-stall recovery stalled before reconnect (no didDisconnect); surfacing disconnect for \(recoveringId.uuidString, privacy: .public)")
            self.writeStallRecoveringPeripheralId = nil
            self.writeStallRecoveries = 0
            self.writeCharacteristic = nil
            self.connectedPeripheral = nil
            self.onDisconnect?(recoveringId.uuidString)
        }
        writeStallRecoveryWatchdog?.cancel()
        writeStallRecoveryWatchdog = recoveryWatchdog
        bleQueue.asyncAfter(deadline: .now() + connectTimeout, execute: recoveryWatchdog)
    }

    /// Intentionally drop the current link: bump the generation, mark the
    /// disconnect intentional (so didDisconnectPeripheral suppresses the
    /// onDisconnect-to-JS and invalidates the old link's stale callbacks), cancel,
    /// and null the connection. Shared by the write-stall recovery paths (#3181).
    private func cancelConnectionIntentionallyOnBleQueue(_ peripheral: CBPeripheral) {
        connectionGeneration += 1
        intentionalDisconnectGenerations[peripheral.identifier] = connectionGeneration
        peripheralGenerations[peripheral.identifier] = connectionGeneration
        centralManager.cancelPeripheralConnection(peripheral)
        writeCharacteristic = nil
        connectedPeripheral = nil
    }

    private func readConfiguration() -> BoardBleConfiguration? {
        guard let defaults = SharedConstants.sharedDefaults,
              let data = defaults.data(forKey: SharedConstants.bleBoardConfigKey)
        else {
            return nil
        }
        return try? JSONDecoder().decode(BoardBleConfiguration.self, from: data)
    }

    private func writeConfiguration(_ configuration: BoardBleConfiguration) {
        guard let defaults = SharedConstants.sharedDefaults,
              let data = try? JSONEncoder().encode(configuration)
        else {
            return
        }
        defaults.set(data, forKey: SharedConstants.bleBoardConfigKey)
    }
}

private extension Data {
    init?(hexString: String) {
        let clean = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count % 2 == 0 else { return nil }

        var bytes: [UInt8] = []
        bytes.reserveCapacity(clean.count / 2)
        var index = clean.startIndex

        while index < clean.endIndex {
            let nextIndex = clean.index(index, offsetBy: 2)
            guard let byte = UInt8(clean[index..<nextIndex], radix: 16) else { return nil }
            bytes.append(byte)
            index = nextIndex
        }

        self = Data(bytes)
    }
}
