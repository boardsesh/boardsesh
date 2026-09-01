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
    /// Advertisement manufacturer-specific data, lowercase hex. Captured for
    /// PostHog reconnaissance: newer Kilter-built boxes advertise a bare name
    /// with no `#serial@apiLevel` suffix, so the serial / LED generation may
    /// ride here (or in `serviceData`) instead. `nil` when the packet carries
    /// none. We parse nothing from it yet — this is recon only.
    let manufacturerData: String?
    /// Advertisement service-data, `{ uuid: hexBytes }`. The undocumented custom
    /// GATT UUIDs (d9b1fad4…/191b6169…/73a2a497…) would surface here if the box
    /// advertises them. `nil`/empty when the packet carries none.
    let serviceData: [String: String]?
}

/// Connect-time BLE write diagnostics, surfaced to JS (Sentry tags + analytics)
/// so a "bulb lights but the board doesn't respond" report can be diagnosed
/// without Console.app: we can see whether the characteristic advertised
/// `.writeWithoutResponse` (firmware) or not (which on iOS 26.x routed Aurora to
/// the stalling write-with-response path), and the negotiated write lengths.
struct BoardBleConnectionDiagnostics {
    let characteristicProperties: Int   // CBCharacteristicProperties.rawValue
    let supportsWriteWithoutResponse: Bool
    let chosenWriteType: String         // "withoutResponse" | "withResponse"
    let maxWriteWithResponse: Int
    let maxWriteWithoutResponse: Int
}

/// Who enqueued a write: the JS bridge (`BoardBleModule.write`) or native code
/// (widget intents, stall-recovery re-lights, clear-on-connect). Surfaced in the
/// per-write telemetry so PostHog can segment the two populations.
enum BoardBleWriteOrigin: String {
    case js
    case native
}

enum BoardBleWriteTypeSource: String {
    case defaultWithoutResponse
    case watchdogFallback
    case learnedPersistentFallback
    case moonboardCharacteristic
    // Proactive: the box advertises a bare Aurora name with no `#serial@apiLevel`
    // suffix (a mid-2025+ Kilter-built, write-with-response-only box). We start
    // this connection on with-response instead of eating the without-response
    // stall first. Name-driven, so a healthy serial'd box never trips it.
    case bareNameHint
}

/// Per-write transport telemetry (#3230): how a single queued write moved
/// through the without-response flow-control machinery. Attached to the JS
/// write promise (success) or stashed for `getLastWriteDiagnostics` (failure)
/// so `Climb Sent to Board` events carry a measurable before/after for the
/// iOS 26.5 `peripheralIsReady` stall.
struct BoardBleWriteTelemetry {
    let origin: String
    let initialWriteType: String
    var finalWriteType: String
    var writeTypeSource: String
    var chunkSize: Int
    var chunkCount: Int
    let negotiatedMaxWriteWithoutResponse: Int
    let startedAt: DispatchTime     // internal timing anchor; not surfaced
    var parkCount = 0               // times a chunk parked on canSendWriteWithoutResponse
    var peripheralIsReadyFired = false
    var lastResumeSource: String?   // "callback" | "poll"
    var maxParkMs = 0
    var totalParkMs = 0
    var watchdogTripped = false
    var canSendAtTrip: Bool?        // canSendWriteWithoutResponse when the watchdog fired
    var durationMs = 0

    var writeType: String { finalWriteType }

    var analyticsDictionary: [String: Any] {
        var dictionary: [String: Any] = [
            "origin": origin,
            "writeType": finalWriteType,
            "initialWriteType": initialWriteType,
            "finalWriteType": finalWriteType,
            "writeTypeSource": writeTypeSource,
            "chunkSize": chunkSize,
            "chunkCount": chunkCount,
            "negotiatedMaxWriteWithoutResponse": negotiatedMaxWriteWithoutResponse,
            "parkCount": parkCount,
            "peripheralIsReadyFired": peripheralIsReadyFired,
            "maxParkMs": maxParkMs,
            "totalParkMs": totalParkMs,
            "watchdogTripped": watchdogTripped,
            "durationMs": durationMs,
        ]
        if let lastResumeSource {
            dictionary["lastResumeSource"] = lastResumeSource
        }
        if let canSendAtTrip {
            dictionary["canSendAtTrip"] = canSendAtTrip
        }
        return dictionary
    }
}

private struct BoardBleWriteTypeResolution {
    let writeType: CBCharacteristicWriteType
    let source: BoardBleWriteTypeSource
}

private struct LearnedWriteWithResponseEntry: Codable {
    var learnedAt: TimeInterval
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

/// One-shot result for the specific display request issued by a Live Activity
/// intent. Display callbacks settle on `bleQueue`; the awaiting task reads the
/// result after the global drain waiter resumes. The lock makes that cross-task
/// read explicit and prevents a defensive duplicate callback from changing the
/// first result.
private final class BoardBleDisplayWriteOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var settledResult: Bool?

    func settle(succeeded: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard settledResult == nil else { return }
        settledResult = succeeded
    }

    var succeeded: Bool? {
        lock.lock()
        defer { lock.unlock() }
        return settledResult
    }
}

final class BoardBleManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    // Strict-concurrency audit: the manager is bleQueue-confined by design — all state
    // mutation happens on that serial queue — so this global is safe without claiming
    // (and over-claiming) Sendable for the whole class.
    nonisolated(unsafe) static let shared = BoardBleManager()

    private final class ManagerCancellationBarrier {
        var watchdog: BleOneShotTimer?
        var hasExpired = false
    }

    private struct DeferredConnectRequest {
        let deviceId: String
        let peripheralId: UUID
        let completion: (Result<Void, Error>) -> Void
    }

    private struct WriteRequest {
        let chunks: [Data]
        // Static preferred write type and chunk size are snapshotted at enqueue
        // so a configureBoard landing mid-request cannot re-chunk a frame. The
        // connection-level forceWriteWithResponse latch may still override the
        // actual per-chunk send type, which is what makes the fallback reversible.
        let writeType: CBCharacteristicWriteType
        let writeTypeSource: BoardBleWriteTypeSource
        // What the connection resolved to when the request was enqueued. This is
        // used for telemetry and chunk sizing only; the live latch still decides
        // each actual send in writeChunk.
        let initialWriteType: CBCharacteristicWriteType
        let initialWriteTypeSource: BoardBleWriteTypeSource
        let chunkSize: Int
        let negotiatedMaxWriteWithoutResponse: Int
        let origin: BoardBleWriteOrigin
        let connectionGeneration: UInt64
        let writeGeneration: UInt64
        let completion: (Error?, BoardBleWriteTelemetry?) -> Void
    }

    private let logger = Logger(subsystem: "com.boardsesh.app", category: "BoardBleManager")
    private let bleQueue = DispatchQueue(label: "com.boardsesh.app.board-ble.queue")
    private let bleQueueKey = DispatchSpecificKey<Void>()
    private let auroraServiceUuid = CBUUID(string: "4488B571-7806-4DF6-BCFF-A2897E4953FF")
    private let uartServiceUuid = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private let uartWriteCharacteristicUuid = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    // Original MoonBoard (RedBearLab) LED box: a second controller generation
    // whose write characteristic (713d0003, `.write`-only) lives on its own
    // service. Probed as a fallback after the Nordic UART one for the moonboard
    // family. See docs/MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md §2.1.
    private let redBearLabServiceUuid = CBUUID(string: "713D0000-503E-4C75-BA94-3148F18D941E")
    private let redBearLabWriteCharacteristicUuid = CBUUID(string: "713D0003-503E-4C75-BA94-3148F18D941E")
    private let chunkDelay: TimeInterval = 0.005
    // Bare-name Kilter-built boxes are driven like their own app: each
    // with-response chunk is paced 100 ms apart ON TOP of the `didWriteValueFor`
    // ack (the app awaits the ack AND then waits 100 ms). Aurora boxes that reach
    // with-response via the stall fallback stay ack-only (no fixed delay).
    private let kilterBoxChunkDelay: TimeInterval = 0.100
    private let connectTimeout: TimeInterval = 8
    // How long a write parked on `canSendWriteWithoutResponse` may wait for
    // peripheralIsReady before the queue is failed. Generous: a healthy link
    // drains its transmit buffer in milliseconds.
    private let writeResumeTimeout: TimeInterval = 5
    // Second resume path for a parked write (#3230): iOS 26.5 updates
    // `canSendWriteWithoutResponse` but can skip the `peripheralIsReady`
    // delegate entirely, so a poller re-checks the property while parked.
    // 50 ms ≈ 100 chances inside the 5 s watchdog; healthy parks last tens of
    // milliseconds.
    private let writeResumePollInterval: TimeInterval = 0.05
    private let learnedWriteWithResponseTtl: TimeInterval = 90 * 24 * 60 * 60
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

    private var discoveredPeripherals: [String: WritableBlePeripheral] = [:]
    private var discoveredNames: [String: String] = [:]
    // What was last emitted to JS for each device in the CURRENT scan
    // (name + advertised UUIDs). With allow-duplicates on and (on newer JS)
    // an unfiltered scan, didDiscover fires continuously for every nearby
    // device; without this gate every repeat advertisement would cross the
    // native→JS bridge. Cleared on every startScan so a fresh scan re-emits.
    private var emittedScanResults: [String: String] = [:]
    private var connectedPeripheral: WritableBlePeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var pendingConnectCompletion: ((Result<Void, Error>) -> Void)?
    private var connectTimeoutTimer: BleOneShotTimer?
    private var scanRequested = false
    private var scanServices: [CBUUID] = []
    // Set while the Live Activity lightbulb's reconnect-by-last-known-board is
    // falling back to a scan: connect as soon as this UUID advertises.
    private var reconnectScanTargetUuid: UUID?
    private var reconnectScanCompletion: ((Result<Void, Error>) -> Void)?
    private var reconnectScanTimeoutWorkItem: DispatchWorkItem?
    private var intentionalDisconnectGenerations: [UUID: UInt64] = [:]
    // CoreBluetooth's terminal callback for a manager-initiated cancellation can
    // arrive after `cancelPeripheralConnection` returns. Because the callback has
    // no connection-generation token, never start a new connection to the same
    // UUID until didDisconnect/didFailToConnect consumes this barrier. Different
    // UUIDs remain independent. One global deferred request is enough because
    // connect is last-request-wins throughout the manager.
    private var managerCancellationBarriers: [UUID: ManagerCancellationBarrier] = [:]
    // UUIDs whose EXPIRED cancellation barrier was displaced by a fresh explicit
    // connect (see connectOnBleQueue). CoreBluetooth supplies no attempt
    // identity, so the first terminal callback after displacement is
    // unattributable and conservatively swallowed. If it was the retry's
    // genuine failure, the retry's still-live timeout settles it once. Cleared
    // by that swallow, by didConnect, by a newer cancellation barrier, and
    // below .poweredOn (every old link generation is invalid there).
    private var displacedCancellationPeripheralIds: Set<UUID> = []
    private var deferredConnectRequest: DeferredConnectRequest?
    private var peripheralGenerations: [UUID: UInt64] = [:]
    private var connectionGeneration: UInt64 = 0
    // Peripherals whose targeted service probe (discoverServices([uart,
    // redBearLab])) found neither write service and for which we've already
    // retried once with a full (nil) discovery. iOS can serve a stale/partial
    // GATT cache for a targeted probe, reporting a service absent that the board
    // actually exposes; a full re-read defeats that. The set bounds the retry to
    // ONE attempt so a board that genuinely exposes neither service still fails
    // instead of looping. Reset at the start of each fresh targeted discovery
    // (didConnect / state restoration) and on teardown. See #3480.
    private var retriedFullServiceDiscovery: Set<UUID> = []
    // Service UUIDs actually discovered on the peripheral when a connect failed
    // during service/characteristic discovery. Stashed so JS can attach it to
    // the Sentry `service_missing` report (getLastConnectDiagnostics) — the
    // failure alone can't say whether the board exposed NOTHING (stale cache /
    // decoy peripheral) or an unknown third controller generation. Clear-on-read
    // via takeLastConnectFailureDiagnostics(). See #3480.
    private var lastConnectFailureDiscoveredServices: [String]?
    private var writeQueue: [WriteRequest] = []
    private var writeGeneration: UInt64 = 0
    private var isWriting = false
    private var pendingWriteResume: (() -> Void)?
    private var pendingWriteResumeWatchdog: BleOneShotTimer?
    // Poller behind the parked write (#3230): re-checks
    // `canSendWriteWithoutResponse` while `pendingWriteResume` is set, because
    // iOS 26.5 can flip the property without ever delivering the
    // `peripheralIsReady` delegate. Cancelled wherever the watchdog is.
    private var writeResumePoller: BleRepeatingTimer?
    // Latched when a write watchdog trips while `canSendWriteWithoutResponse` is
    // STILL false and `peripheralIsReady` never fired — the iOS 26.x "stuck
    // false" signature (#3230 covered "flips true, delegate silent"; this is the
    // stricter case where the property itself never recovers). On these boards
    // the false reading is a lie: the radio can accept the write, but the poller
    // and delegate never let us past the gate, so every send times out and the
    // wall stays dark. Once latched, the without-response path stops gating on
    // the property for THIS connection and writes chunks directly (still paced by
    // `chunkDelay`). Reset on every fresh connection so a healthy link re-earns
    // normal backpressure. Fixes iOS 26.5 Kilter home walls that connected but
    // never lit a climb (write_timeout with canSendAtTrip=false on every send).
    private var bypassCanSendWriteWithoutResponse = false
    // Latched when a without-response write stalls (watchdog trips, canSendAtTrip
    // false, peripheralIsReady never fired) AND the RX characteristic advertises
    // only `.write` — no `.writeWithoutResponse` bit. That is the original
    // MoonBoard box's signature, and some Kilter-built controller boxes advertise
    // the same way: CoreBluetooth SILENTLY DROPS every `.withoutResponse` write to
    // such a characteristic, so the wall connects but never lights (a fast, fake
    // "success" on iOS 26.x once the stuck-false gate is bypassed). Once latched,
    // this connection sends on the ack-paced write-WITH-response path instead.
    // Reset on every fresh connection, then re-seeded from
    // `writeWithResponsePeripheralIds` so a board already proven to need it skips
    // the stall on reconnect. Crucially BEHAVIOUR-driven, not property-driven: the
    // without-response path is always tried first on a board we haven't learned,
    // so a healthy board (or one whose `.writeWithoutResponse` bit is missing only
    // because of a stale GATT cache) is never wrongly forced onto with-response —
    // it just never trips the stall. This is what makes re-enabling with-response
    // for Aurora safe after the #3228 property-driven attempt regressed the fleet.
    private var forceWriteWithResponse = false
    private var forceWriteWithResponseSource: BoardBleWriteTypeSource?
    // True when the connected box advertises a bare Aurora name with no
    // `#serial@apiLevel` suffix — a Kilter-built box. Re-derived on every connect.
    // Gates the 100 ms inter-chunk pacing on the with-response path (Kilter only).
    private var connectedBoxIsKilterBuilt = false
    private var pendingWriteWithResponsePersistenceIdentity: String?
    // Boards (by peripheral identifier) proven this session to need
    // write-with-response. In-memory only: a re-learn on the next launch is cheap
    // and avoids a stale decision sticking after a firmware update or box swap.
    private var writeWithResponsePeripheralIds: Set<UUID> = []
    private var learnedWriteWithResponseEntries = BoardBleManager.loadLearnedWriteWithResponseEntries()
    // Telemetry for the request currently being written (#3230). Requests are
    // strictly serial (`isWriting`), so one slot suffices: seeded when a request
    // starts, finalized at whichever settle point delivers its completion.
    private var currentWriteTelemetry: BoardBleWriteTelemetry?
    private var parkStartedAt: DispatchTime?
    // Write-WITH-response pacing (the original MoonBoard LED box, whose UART RX
    // characteristic advertises only `.write`). The `didWriteValueFor` ack is
    // the resume signal — the with-response analogue of `pendingWriteResume`.
    private var pendingWriteAck: (() -> Void)?
    private var pendingWriteAckWatchdog: BleOneShotTimer?
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
    private var writeStallRecoveryWatchdog: BleOneShotTimer?
    private var configuration: BoardBleConfiguration?
    private lazy var readyWaiters = WaiterPool(queue: bleQueue)
    private lazy var drainWaiters = WaiterPool(queue: bleQueue)

    /// Injectable factory for the write flow-control timers (#3366). Production
    /// (`.shared`, or any default-arg init) uses the GCD-backed
    /// `DispatchBleTimerScheduler` — byte-for-byte the pre-refactor inline code.
    /// An init that supplies a scheduler assigns it before this lazy default can
    /// be touched, so tests get their fake instead.
    private lazy var timerScheduler: BleTimerScheduling = DispatchBleTimerScheduler(queue: bleQueue)

    #if DEBUG || BOARDSESH_TESTS
    /// Test-only interception of the CoreBluetooth scan teardown. The production
    /// path still clears `scanRequested` before reaching this seam; tests use it
    /// only to avoid touching the lazy `CBCentralManager` in an XCTest host that
    /// has no bluetooth-central background mode.
    private var stopScanOverrideForTesting: (() -> Void)?
    /// Test-only interception of the single concrete `cancelPeripheralConnection`
    /// call site so a fake peripheral never has to be a real `CBPeripheral` and no
    /// `CBCentralManager` is instantiated. nil in production/dev; set only through
    /// `TestHooks.setCancelPeripheralConnectionOverride` (same-file extension).
    private var cancelPeripheralConnectionOverrideForTesting: ((WritableBlePeripheral) -> Void)?
    /// Test-only interception of `CBCentralManager.connect`, paired with the
    /// cancellation seam above so native tests can drive the complete callback
    /// state machine without instantiating CoreBluetooth.
    private var connectPeripheralOverrideForTesting: ((WritableBlePeripheral) -> Void)?
    /// Test-only central state. nil keeps production/dev on the real manager.
    private var centralStateOverrideForTesting: CBManagerState?
    #endif

    private var onScanResult: ((BoardBleScanResult) -> Void)?
    // Second arg carries the disconnect reason (CoreBluetooth NSError code/domain/
    // description, or a write-stall `context` marker) so JS can tell a takeover
    // apart from a range/idle timeout. nil when no reason is available.
    private var onDisconnect: ((String, [String: Any]?) -> Void)?
    /// Fired whenever a connection becomes fully usable (write characteristic
    /// discovered) — JS-initiated connects, widget-intent reconnects and
    /// CoreBluetooth state restoration alike. The JS layer uses it to adopt
    /// natively-established connections so the in-app lightbulb matches the
    /// wall. Payload: (deviceId, deviceName).
    private var onConnected: ((String, String?) -> Void)?

    /// `private` keeps the singleton compiler-enforced: a second live instance
    /// would register a second `CBCentralManager` with the same restoration
    /// identifier and split connection state across two delegates.
    override private init() {
        super.init()
        completeInit(createCentralManagerEagerly: true)
    }

    #if DEBUG || BOARDSESH_TESTS
    /// Test-only isolated instance: a fake scheduler plus
    /// `createCentralManagerEagerly: false` means no CoreBluetooth stack (or
    /// permission prompt) ever spins up. Production must use `.shared`.
    init(timerScheduler: BleTimerScheduling, createCentralManagerEagerly: Bool) {
        super.init()
        // Assign before the lazy `timerScheduler` default (or anything else)
        // can touch it — nothing in completeInit reads the scheduler.
        self.timerScheduler = timerScheduler
        completeInit(createCentralManagerEagerly: createCentralManagerEagerly)
    }
    #endif

    private func completeInit(createCentralManagerEagerly: Bool) {
        bleQueue.setSpecific(key: bleQueueKey, value: ())
        runOnBleQueueSync {
            configuration = readConfiguration()
            if createCentralManagerEagerly {
                _ = centralManager
            }
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
    var connectedDeviceInfo: (deviceId: String, name: String?, diagnostics: BoardBleConnectionDiagnostics)? {
        runOnBleQueueSync {
            guard let peripheral = connectedPeripheral, let characteristic = writeCharacteristic else { return nil }
            let deviceId = peripheral.identifier.uuidString
            let diagnostics = connectionDiagnosticsOnBleQueue(peripheral: peripheral, characteristic: characteristic)
            return (deviceId, discoveredNames[deviceId] ?? peripheral.name, diagnostics)
        }
    }

    /// Service UUIDs discovered on the peripheral for the most recent connect
    /// that failed in service/characteristic discovery, or nil if there is no
    /// such failure to report. Clear-on-read so a single failure is attributed
    /// to a single analytics event. Exposed to JS as `getLastConnectDiagnostics`
    /// (read right after a `connect` rejection). See #3480.
    func takeLastConnectFailureDiagnostics() -> [String]? {
        runOnBleQueueSync {
            defer { lastConnectFailureDiscoveredServices = nil }
            return lastConnectFailureDiscoveredServices
        }
    }

    func setEventHandlers(
        onScanResult: ((BoardBleScanResult) -> Void)?,
        onDisconnect: ((String, [String: Any]?) -> Void)?,
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

    /// JS-bridge write entry point. The completion carries the per-write
    /// telemetry (#3230) on BOTH outcomes so the module can resolve it with the
    /// promise (success) or stash it for `getLastWriteDiagnostics` (failure).
    func write(hex: String, completion: @escaping (Error?, BoardBleWriteTelemetry?) -> Void) {
        guard let data = Data(hexString: hex) else {
            completion(BoardBleError.invalidHex, nil)
            return
        }
        write(data: data, origin: .js, completion: completion)
    }

    func write(data: Data, origin: BoardBleWriteOrigin = .native, completion: ((Error?, BoardBleWriteTelemetry?) -> Void)? = nil) {
        runOnBleQueue { [weak self] in
            self?.writeOnBleQueue(data: data, origin: origin, completion: completion)
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
    /// Returns true only when this display request's callback succeeds AND the
    /// global write queue drains before `drainTimeout`.
    func displayCurrentItemAwaitingReady(
        items: [SharedQueueItem],
        currentIndex: Int,
        readyTimeout: TimeInterval,
        drainTimeout: TimeInterval = 1.5
    ) async -> Bool {
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

        return await displayCurrentItemAwaitingDrain(
            items: items,
            currentIndex: currentIndex,
            drainTimeout: drainTimeout
        )
    }

    private func displayCurrentItemAwaitingDrain(
        items: [SharedQueueItem],
        currentIndex: Int,
        drainTimeout: TimeInterval
    ) async -> Bool {
        let displayOutcome = BoardBleDisplayWriteOutcome()
        // Both blocks enter the same serial queue in call order: the display
        // attempt settles or enqueues its specific request before the drain
        // waiter evaluates the global queue predicate.
        runOnBleQueue { [weak self] in
            guard let self else {
                displayOutcome.settle(succeeded: false)
                return
            }
            self.displayCurrentItemOnBleQueue(items: items, currentIndex: currentIndex) { succeeded in
                displayOutcome.settle(succeeded: succeeded)
            }
        }
        let drainedBeforeTimeout = await waitForWriteDrain(timeout: drainTimeout)

        // Success requires BOTH this display request's callback and the existing
        // global drain condition. On timeout the write is deliberately left
        // alone; a later callback may settle the one-shot outcome but cannot
        // emit a second intent diagnostic because this await has already ended.
        return drainedBeforeTimeout && displayOutcome.succeeded == true
    }

    private var isAvailableOnBleQueue: Bool {
        switch centralStateOnBleQueue {
        case .poweredOn, .unknown, .resetting:
            return true
        case .poweredOff, .unsupported, .unauthorized:
            return false
        @unknown default:
            return false
        }
    }

    private var centralStateOnBleQueue: CBManagerState {
        #if DEBUG || BOARDSESH_TESTS
        if let centralStateOverrideForTesting {
            return centralStateOverrideForTesting
        }
        #endif
        return centralManager.state
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

        guard centralStateOnBleQueue == .poweredOn else {
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
        #if DEBUG || BOARDSESH_TESTS
        if let overrideForTesting = stopScanOverrideForTesting {
            overrideForTesting()
            return
        }
        #endif
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

        guard centralStateOnBleQueue == .poweredOn else {
            completion(.failure(BoardBleError.bluetoothUnavailable))
            return
        }

        let requestedPeripheralId = UUID(uuidString: deviceId)
        if let recoveringPeripheralId = writeStallRecoveringPeripheralId,
           requestedPeripheralId != recoveringPeripheralId {
            writeStallRecoveringPeripheralId = nil
            writeStallRecoveries = 0
            writeStallRecoveryWatchdog?.cancel()
            writeStallRecoveryWatchdog = nil
        }

        // A manager cancellation for this UUID is not settled until
        // didDisconnect/didFailToConnect arrives. Starting another same-UUID
        // generation sooner is unsafe because CoreBluetooth does not identify
        // which generation owns the late callback. Retain only the newest
        // request; an unrelated UUID is free to connect immediately.
        if let peripheralId = requestedPeripheralId,
           let cancellationBarrier = managerCancellationBarriers[peripheralId] {
            if cancellationBarrier.hasExpired {
                // The watchdog expired with no terminal callback — which
                // CoreBluetooth legitimately never delivers for a cancelled
                // PENDING connect. An expired barrier must not block a fresh
                // explicit connect: insta-failing here left the board
                // permanently unconnectable for the rest of the app session
                // (picker, Live Activity lightbulb, and write-stall recovery
                // all route through this path). Displace the expired barrier
                // and proceed with a normal connect. CoreBluetooth supplies no
                // attempt identity, so the first terminal callback after this
                // displacement is unattributable and conservatively swallowed;
                // a genuine retry failure remains live for its timeout to
                // settle once.
                cancellationBarrier.watchdog?.cancel()
                managerCancellationBarriers.removeValue(forKey: peripheralId)
                displacedCancellationPeripheralIds.insert(peripheralId)
            } else {
                deferConnectUntilCancellationSettles(
                    deviceId: deviceId,
                    peripheralId: peripheralId,
                    completion: completion
                )
                return
            }
        }

        // A new request to an unblocked UUID wins over a request parked behind a
        // different UUID's barrier. The old barrier itself remains until its
        // terminal callback arrives.
        failDeferredConnect(BoardBleError.superseded)

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
        // timer could later misfire against THIS attempt: for a different
        // target device the old peripheral's generation entry survives the
        // bump below, so the stale timeout's guards both pass and it would
        // call completePendingConnect against the new completion.
        // completePendingConnect also cancels that stale timeout timer.
        completePendingConnect(.failure(BoardBleError.superseded))
        connectionGeneration += 1
        let generation = connectionGeneration
        intentionalDisconnectGenerations.removeValue(forKey: peripheral.identifier)
        pendingConnectCompletion = completion
        connectedPeripheral = peripheral
        writeCharacteristic = nil
        peripheralGenerations[peripheral.identifier] = generation
        preparePeripheralForConnection(peripheral)

        connectTimeoutTimer = timerScheduler.scheduleOneShot(after: connectTimeout, label: "connectTimeout") { [weak self] in
            guard let self else { return }
            guard self.pendingConnectCompletion != nil else { return }
            guard self.peripheralGenerations[peripheral.identifier] == generation else { return }
            self.peripheralGenerations.removeValue(forKey: peripheral.identifier)
            if self.connectedPeripheral?.identifier == peripheral.identifier {
                self.connectedPeripheral = nil
                self.writeCharacteristic = nil
            }
            self.cancelPeripheralConnection(peripheral)
            self.completePendingConnect(.failure(BoardBleError.connectTimedOut))
        }
        connectPeripheral(peripheral)
    }

    private func deferConnectUntilCancellationSettles(
        deviceId: String,
        peripheralId: UUID,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        failDeferredConnect(BoardBleError.superseded)
        // A pending connect to a DIFFERENT board must not keep racing while
        // this newer request waits out the barrier: left alone it could
        // connect, emit onConnected, and light the wall for up to the connect
        // timeout before the deferred request wins. Mirror the non-deferred
        // supersede: settle its promise now and bump the generation so its
        // late didConnect hits the stale branch's corrective cancel. (The
        // pending connect can never target the barriered UUID itself — every
        // barrier registration settles the pending connect first.)
        if pendingConnectCompletion != nil {
            completePendingConnect(.failure(BoardBleError.superseded))
            connectionGeneration += 1
            connectedPeripheral = nil
            writeCharacteristic = nil
        }
        deferredConnectRequest = DeferredConnectRequest(
            deviceId: deviceId,
            peripheralId: peripheralId,
            completion: completion
        )
    }

    private func failDeferredConnect(_ error: Error) {
        guard let deferredConnectRequest else { return }
        self.deferredConnectRequest = nil
        deferredConnectRequest.completion(.failure(error))
    }

    private func reconnectToLastKnownBoardOnBleQueue(completion: @escaping (Result<Void, Error>) -> Void) {
        // Already connected — re-light the wall and report success.
        if connectedPeripheral != nil, writeCharacteristic != nil {
            completion(.success(()))
            displaySharedCurrentItemOnBleQueue()
            return
        }
        guard centralStateOnBleQueue == .poweredOn else {
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

        // Filter on the Aurora advertised service, the Nordic UART service, and
        // the original RedBearLab service so any board generation — Aurora,
        // newer MoonBoard (UART), or original MoonBoard (RedBearLab) — is
        // matchable, mirroring the JS adapter's scan filter.
        startScanOnBleQueue(serviceUuids: [
            auroraServiceUuid.uuidString,
            uartServiceUuid.uuidString,
            redBearLabServiceUuid.uuidString,
        ]) { [weak self] result in
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

    private func persistLastConnectedPeripheral(_ peripheral: WritableBlePeripheral) {
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
        failDeferredConnect(BoardBleError.notConnected)

        guard let peripheral = connectedPeripheral else {
            writeCharacteristic = nil
            completion?()
            return
        }

        intentionalDisconnectGenerations[peripheral.identifier] = connectionGeneration
        peripheralGenerations[peripheral.identifier] = connectionGeneration
        cancelPeripheralConnection(peripheral)
        writeCharacteristic = nil
        connectedPeripheral = nil
        completion?()
    }

    private func writeOnBleQueue(data: Data, origin: BoardBleWriteOrigin = .native, completion: ((Error?, BoardBleWriteTelemetry?) -> Void)? = nil) {
        guard let peripheral = connectedPeripheral, let characteristic = writeCharacteristic else {
            // During a write-stall recovery the link is briefly down between the
            // cancel and the reconnect. Surface the self-healing `writeTimedOut`
            // (a warning JS rides out with `isConnected` kept) rather than
            // `notConnected`, which the JS classifier treats as a hard drop and
            // would tear the connection down mid-recovery (#3181).
            completion?(writeStallRecoveringPeripheralId != nil ? BoardBleError.writeTimedOut : BoardBleError.notConnected, nil)
            return
        }

        // Keep the request's reversible write type on the STATIC preferred path
        // (Aurora → without-response, MoonBoard → property-driven). The live
        // `forceWriteWithResponse` latch is applied per-chunk in `writeChunk`, so
        // clearing the latch mid-write is honoured immediately instead of being
        // frozen into `request.writeType`. Chunk sizing follows the initially
        // resolved transport, so boxes that start forced with-response still get
        // the proven classic 20-byte chunks.
        let writeType = BoardBleEncoding.preferredWriteType(
            for: characteristic.properties,
            boardName: configuration?.boardName
        )
        let writeTypeSource: BoardBleWriteTypeSource = writeType == .withResponse ? .moonboardCharacteristic : .defaultWithoutResponse
        let initialWriteResolution = resolvedWriteType(for: characteristic)
        let chunkSize = BoardBleEncoding.effectiveChunkSize(
            negotiatedMaxWriteLength: peripheral.maximumWriteValueLength(for: initialWriteResolution.writeType),
            writeType: initialWriteResolution.writeType,
            boardName: configuration?.boardName
        )
        let chunks = stride(from: 0, to: data.count, by: chunkSize).map { offset in
            data.subdata(in: offset..<min(offset + chunkSize, data.count))
        }

        writeQueue.append(
            WriteRequest(
                chunks: chunks,
                writeType: writeType,
                writeTypeSource: writeTypeSource,
                initialWriteType: initialWriteResolution.writeType,
                initialWriteTypeSource: initialWriteResolution.source,
                chunkSize: chunkSize,
                negotiatedMaxWriteWithoutResponse: peripheral.maximumWriteValueLength(for: .withoutResponse),
                origin: origin,
                connectionGeneration: connectionGeneration,
                writeGeneration: writeGeneration,
                completion: completion ?? { _, _ in }
            )
        )
        processWriteQueue()
    }

    /// Re-light the wall from the App-Group queue copy. Absence of that copy is
    /// NOT an instruction to clear (#4544): it is only ever written once JS has
    /// published a queue, so a climber who has never opened a queue on this
    /// install had every connect issue a clear-all. It looked harmless only
    /// because the JS auto-sender usually repainted a moment later.
    ///
    /// A deliberate clear stays a deliberate clear. JS `clearBoard()` writes
    /// empty frames through `write(hex:)`, and the live-session repaint
    /// (`displayCurrentItem(items:currentIndex:)`, called by
    /// SessionWebSocketManager) still clears on an out-of-range index — there
    /// the empty state is authoritative rather than merely absent.
    ///
    /// `defaults` is a default argument, re-evaluated at every call, so all
    /// production call sites keep reading the real App Group. The parameter
    /// exists only so the Swift suite can drive this against an isolated
    /// suite instead of a developer machine's app-group defaults.
    private func displaySharedCurrentItemOnBleQueue(
        defaults: UserDefaults? = SharedConstants.sharedDefaults
    ) {
        guard let defaults else { return }
        guard let item = SharedQueueState.currentItem(from: defaults) else {
            logger.info("Skipping implicit BLE re-light: no current climb in the App Group queue copy (#4544)")
            return
        }
        displayItemOnBleQueue(item)
    }

    private func displayCurrentItemOnBleQueue(
        items: [SharedQueueItem],
        currentIndex: Int,
        completion: ((Bool) -> Void)? = nil
    ) {
        guard currentIndex >= 0, currentIndex < items.count else {
            clearBoardOnBleQueue(completion: completion)
            return
        }
        displayItemOnBleQueue(items[currentIndex], completion: completion)
    }

    private func clearBoardOnBleQueue(completion: ((Bool) -> Void)? = nil) {
        guard let configuration else {
            completion?(false)
            return
        }
        guard connectedPeripheral != nil, writeCharacteristic != nil else {
            completion?(false)
            return
        }

        // `l##` (empty frame) is MoonBoard's clear-all: community firmware
        // (ArduinoMoonBoardLED) clears every LED on each incoming frame; unverified
        // on official Moon controllers (at worst a no-op). Aurora clears via its
        // own empty-frames packet. Either way a deliberate clear darks the wall,
        // matching the JS clear path.
        let result: BoardBlePacketResult
        if configuration.boardName == "moonboard" {
            // Deliberate clear — never prefix with the V2 additional-LED
            // marker (see makeMoonboardPacket / getMoonboardBluetoothPacket).
            result = BoardBleEncoding.makeMoonboardPacket(frames: "", numRows: configuration.numRows)
        } else {
            result = BoardBleEncoding.makeAuroraPacket(
                frames: "",
                placementPositions: [:],
                boardName: configuration.boardName,
                apiLevel: apiLevelOnBleQueue(configuration: configuration),
                colorOverrides: configuration.colorOverrides
            )
        }

        guard !result.packet.isEmpty else {
            completion?(false)
            return
        }
        writeOnBleQueue(data: result.packet) { [weak self] error, _ in
            if let error {
                self?.logger.error("BLE clear failed: \(error.localizedDescription, privacy: .public)")
            }
            completion?(error == nil)
        }
    }

    private func displayItemOnBleQueue(
        _ item: SharedQueueItem,
        completion: ((Bool) -> Void)? = nil
    ) {
        guard let configuration else {
            completion?(false)
            return
        }
        guard connectedPeripheral != nil, writeCharacteristic != nil else {
            completion?(false)
            return
        }

        // MoonBoard encodes straight from grid coordinates into the ASCII `l#…#`
        // frame format — it has no LED placement map and the Aurora binary
        // encoder can't drive it (no `moonboard` role map). Without this branch a
        // native re-light (widget intent or write-stall recovery reconnect) would
        // silently write nothing and the wall would stay dark. Mirroring isn't
        // supported on MoonBoard (boardSupportsMirroring is false), so frames go
        // out as-is.
        if configuration.boardName == "moonboard" {
            // numRows/lightAdjacentHolds nil (config persisted by an older
            // build) → the encoder's 18-row standard-wall / no-prefix defaults.
            let result = BoardBleEncoding.makeMoonboardPacket(
                frames: item.frames,
                numRows: configuration.numRows,
                lightAdjacentHolds: configuration.lightAdjacentHolds ?? false
            )
            guard !result.packet.isEmpty else {
                // A non-empty climb whose holds all dropped (unrecognised/out-of-
                // range) → refuse to write rather than dark the wall. Only a
                // deliberate empty-frames item clears (via `l##`, Aurora parity);
                // makeMoonboardPacket returns an empty packet for this all-skipped
                // case so it never reaches the wall.
                logger.warning("Skipping MoonBoard BLE write: no encodable holds for climb \(item.climbUuid, privacy: .public)")
                completion?(false)
                return
            }
            writeOnBleQueue(data: result.packet) { [weak self] error, _ in
                if let error {
                    self?.logger.error("BLE write failed: \(error.localizedDescription, privacy: .public)")
                }
                completion?(error == nil)
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
            completion?(false)
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
                completion?(false)
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
            completion?(false)
            return
        }

        writeOnBleQueue(data: result.packet) { [weak self] error, _ in
            if let error {
                self?.logger.error("BLE write failed: \(error.localizedDescription, privacy: .public)")
            }
            completion?(error == nil)
        }
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        handleCentralStateUpdateOnBleQueue(state: central.state) {
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
        }
    }

    /// Shared state-update body for the real delegate and the native XCTest
    /// seam. The powered-on closure keeps the concrete central manager out of
    /// tests while the unavailable transition exercises the production cleanup.
    private func handleCentralStateUpdateOnBleQueue(state: CBManagerState, onPoweredOn: () -> Void = {}) {
        if state == .poweredOn {
            onPoweredOn()
        } else {
            // Bluetooth went away mid-recovery: the deferred reconnect's
            // didDisconnect may never arrive, so close the write-stall recovery
            // window and reset the budget. Otherwise a later intentional
            // disconnect could be mistaken for a stall recovery, writes would
            // keep parking on the window, or a post-power-on session would start
            // with a depleted budget (#3181).
            writeStallRecoveringPeripheralId = nil
            writeStallRecoveries = 0
            writeStallRecoveryWatchdog?.cancel()
            writeStallRecoveryWatchdog = nil

            // Below .poweredOn CoreBluetooth may discard manager-initiated
            // cancellations without either terminal callback. This is the one
            // boundary where dropping all UUID barriers is safe: every old link
            // generation is invalid, and any waiter must fail explicitly rather
            // than remain parked across the next powered-on session.
            managerCancellationBarriers.values.forEach { $0.watchdog?.cancel() }
            managerCancellationBarriers.removeAll()
            displacedCancellationPeripheralIds.removeAll()
            intentionalDisconnectGenerations.removeAll()
            failDeferredConnect(BoardBleError.bluetoothUnavailable)
            failReconnectScan(BoardBleError.bluetoothUnavailable)
            completePendingConnect(.failure(BoardBleError.bluetoothUnavailable))

            // Below .poweredOn iOS invalidates every peripheral WITHOUT
            // delivering didDisconnectPeripheral, so an active link vanishes
            // silently — JS would keep showing "connected" until the next write
            // failed. Surface it as an explicit disconnect with a context marker
            // so analytics can tell bluetooth-off apart from a link loss.
            let disconnectedPeripheral = connectedPeripheral
            connectedPeripheral = nil
            writeCharacteristic = nil
            peripheralGenerations.removeAll()
            failQueuedWrites(BoardBleError.bluetoothUnavailable)
            if let peripheral = disconnectedPeripheral {
                let deviceId = peripheral.identifier.uuidString
                onDisconnect?(deviceId, [
                    "context": "bluetooth_unavailable",
                    "errorDescription": "central state \(state.rawValue)",
                ])
            }
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
            cancelPeripheralConnection(extra)
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
            retriedFullServiceDiscovery.remove(peripheral.identifier)
            peripheral.discoverServices(writeServiceUuids())
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
        // Undocumented advertisement payload (recon only — parsed nowhere yet):
        // manufacturer-specific data and per-UUID service data, hex-encoded.
        // Service-data keys are normalized to lowercase full-128-bit UUIDs so
        // they match the ble-plx (Android) form and group cleanly in PostHog.
        let manufacturerData = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data)
            .map { $0.hexEncodedString() }
        let serviceData = (advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data])
            .flatMap { rawServiceData -> [String: String]? in
                guard !rawServiceData.isEmpty else { return nil }
                var mapped: [String: String] = [:]
                for (uuid, bytes) in rawServiceData {
                    mapped[Self.normalizedUuidString(uuid)] = bytes.hexEncodedString()
                }
                return mapped
            }
        // Only cross the bridge when something material changed for this device
        // (first sighting, name arriving in a later scan response, a different
        // advertised UUID set, or manufacturer data first *appearing*). Use a
        // presence flag, not the payload itself: Apple Continuity devices rotate
        // their manufacturer data every advertisement, and folding the bytes into
        // the key would re-cross the bridge on every rotation for every nearby
        // iPhone/AirPod. A board's payload is static, so the JS side merges
        // whatever arrives (see upsertDiscoveredDevice).
        let manufacturerDataPresence = manufacturerData != nil ? "m" : ""
        let emissionKey = "\(name ?? "")|\(advertisedServiceUuids.joined(separator: ","))|\(manufacturerDataPresence)"
        if emittedScanResults[deviceId] != emissionKey {
            emittedScanResults[deviceId] = emissionKey
            onScanResult?(BoardBleScanResult(
                deviceId: deviceId,
                name: name,
                rssi: RSSI.intValue,
                serviceUuids: advertisedServiceUuids,
                manufacturerData: manufacturerData,
                serviceData: serviceData
            ))
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
        handleDidConnectOnBleQueue(peripheral: peripheral) {
            peripheral.delegate = self
            peripheral.discoverServices(writeServiceUuids())
        }
    }

    /// Shared delegate body for the real `didConnect` callback and the native
    /// XCTest seam. Service discovery needs a concrete `CBPeripheral`, so it
    /// stays in the delegate's closure; every manager-state decision lives here.
    private func handleDidConnectOnBleQueue(
        peripheral: WritableBlePeripheral,
        beginServiceDiscovery: () -> Void
    ) {
        guard peripheralGenerations[peripheral.identifier] == connectionGeneration else {
            // The system finished bringing up a link no live generation owns
            // (e.g. a connect that raced its own cancellation). It MUST be
            // cancelled concretely or it lingers as a system-held connection
            // that blocks the wall — these boards are last-connection-wins.
            // Cancelling a CONNECTED peripheral yields exactly one
            // didDisconnect, so when this UUID's barrier is already awaiting a
            // terminal callback the corrective cancel still goes out (it can't
            // manufacture a second callback here) and the existing barrier
            // consumes the resulting didDisconnect; no second barrier is
            // registered.
            if !registerManagerCancellationBarrierOnBleQueue(peripheralId: peripheral.identifier) {
                logger.info("Stale BLE didConnect for \(peripheral.identifier.uuidString, privacy: .public) raced an in-flight cancellation; reissuing the concrete cancel under the existing barrier")
            }
            performCancelPeripheralConnection(peripheral)
            return
        }
        // The live attempt reached didConnect. A displaced cancellation's late
        // terminal callback would have been delivered before this (CoreBluetooth
        // delivers a peripheral's callbacks in order), so the tombstone is done —
        // clear it so a later genuine drop of THIS link is never swallowed.
        displacedCancellationPeripheralIds.remove(peripheral.identifier)
        retriedFullServiceDiscovery.remove(peripheral.identifier)
        beginServiceDiscovery()
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        handleDidFailToConnectOnBleQueue(peripheral: peripheral, error: error)
    }

    /// Shared delegate body for real CoreBluetooth callbacks and the native
    /// XCTest seam. A cancellation terminal callback is consumed before the
    /// normal generation guard because the old generation was intentionally
    /// removed before cancelling.
    private func handleDidFailToConnectOnBleQueue(peripheral: WritableBlePeripheral, error: Error?) {
        if consumeManagerCancellationBarrierOnBleQueue(peripheralId: peripheral.identifier) {
            return
        }
        // CoreBluetooth supplies no attempt identity, so the first terminal
        // callback after an expired barrier is displaced is unattributable and
        // conservatively swallowed. If it was the retry's genuine failure, the
        // retry's still-live timeout settles it once, with up to the 8-second
        // connect-timeout latency accepted to avoid failing the wrong attempt.
        if displacedCancellationPeripheralIds.remove(peripheral.identifier) != nil {
            logger.info("Swallowed unattributable BLE didFailToConnect for displaced \(peripheral.identifier.uuidString, privacy: .public): \(error?.localizedDescription ?? "no error", privacy: .public)")
            return
        }
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
        handleDidDisconnectOnBleQueue(peripheral: peripheral, error: error)
    }

    /// Shared delegate body for real CoreBluetooth callbacks and the native
    /// XCTest seam. Keeping the state transition here lets tests exercise the
    /// exact callback path without manufacturing a `CBCentralManager` or
    /// `CBPeripheral`.
    private func handleDidDisconnectOnBleQueue(peripheral: WritableBlePeripheral, error: Error?) {
        let deviceId = peripheral.identifier.uuidString
        let wasCurrentPeripheral = connectedPeripheral?.identifier == peripheral.identifier

        if consumeManagerCancellationBarrierOnBleQueue(peripheralId: peripheral.identifier) {
            return
        }

        // CoreBluetooth supplies no attempt identity, so the first terminal
        // callback after an expired barrier is displaced is unattributable and
        // conservatively swallowed. If it was the retry's genuine failure, the
        // retry's still-live timeout settles it once. This is the didDisconnect
        // half of the same tombstone consumed by didFailToConnect above.
        if displacedCancellationPeripheralIds.remove(peripheral.identifier) != nil {
            logger.info("Swallowed unattributable BLE didDisconnect for displaced \(deviceId, privacy: .public): \(error?.localizedDescription ?? "no error", privacy: .public)")
            return
        }

        let intentionalDisconnectGeneration = intentionalDisconnectGenerations.removeValue(forKey: peripheral.identifier)

        if let intentionalDisconnectGeneration {
            if peripheralGenerations[peripheral.identifier] == intentionalDisconnectGeneration {
                peripheralGenerations.removeValue(forKey: peripheral.identifier)
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
        onDisconnect?(deviceId, BoardBleEncoding.disconnectReasonBody(from: error))

        // No auto-reconnect. These boards are last-connection-wins, so silently
        // re-grabbing the link would steal the wall back from whoever took it — a
        // ping-pong that flickers the LEDs. Reconnection is user-initiated only:
        // the in-app device picker, or the Live Activity lightbulb
        // (reconnectToLastKnownBoard).
    }

    /// Consume exactly one UUID barrier and decide the sole follow-up. A queued
    /// user connect owns the reconnect when present; otherwise write-stall
    /// recovery resumes automatically. Both paths share the same normal connect
    /// timeout and connection-ready success point.
    private func consumeManagerCancellationBarrierOnBleQueue(peripheralId: UUID) -> Bool {
        guard let cancellationBarrier = managerCancellationBarriers.removeValue(forKey: peripheralId) else {
            return false
        }

        cancellationBarrier.watchdog?.cancel()
        intentionalDisconnectGenerations.removeValue(forKey: peripheralId)
        peripheralGenerations.removeValue(forKey: peripheralId)

        let deferredRequest: DeferredConnectRequest?
        if deferredConnectRequest?.peripheralId == peripheralId {
            deferredRequest = deferredConnectRequest
            deferredConnectRequest = nil
        } else {
            deferredRequest = nil
        }

        if writeStallRecoveringPeripheralId == peripheralId {
            // The normal connection timeout owns the deadline from here.
            writeStallRecoveryWatchdog?.cancel()
            writeStallRecoveryWatchdog = nil
        }

        if let deferredRequest {
            let isJoiningWriteStallRecovery = writeStallRecoveringPeripheralId == peripheralId
            connectOnBleQueue(deviceId: deferredRequest.deviceId) { [weak self] result in
                deferredRequest.completion(result)
                if isJoiningWriteStallRecovery {
                    self?.finishWriteStallReconnectOnBleQueue(peripheralId: peripheralId, result: result)
                }
            }
        } else if writeStallRecoveringPeripheralId == peripheralId {
            beginWriteStallReconnectOnBleQueue(peripheralId: peripheralId)
        }
        return true
    }

    private func beginWriteStallReconnectOnBleQueue(peripheralId: UUID) {
        let completion: (Result<Void, Error>) -> Void = { [weak self] result in
            self?.finishWriteStallReconnectOnBleQueue(peripheralId: peripheralId, result: result)
        }
        let deviceId = peripheralId.uuidString
        if discoveredPeripherals[deviceId] != nil {
            connectOnBleQueue(deviceId: deviceId, completion: completion)
        } else {
            reconnectToLastKnownBoardOnBleQueue(completion: completion)
        }
    }

    private func finishWriteStallReconnectOnBleQueue(peripheralId: UUID, result: Result<Void, Error>) {
        guard case .failure(let error) = result,
              writeStallRecoveringPeripheralId == peripheralId
        else { return }
        logger.error("BLE write-stall reconnect failed: \(error.localizedDescription, privacy: .public)")
        writeStallRecoveringPeripheralId = nil
        writeStallRecoveries = 0
        onDisconnect?(peripheralId.uuidString, [
            "context": "write_stall_recovery_failed",
            "errorDescription": error.localizedDescription,
        ])
    }

    // MARK: - CBPeripheralDelegate

    /// Services to probe after connect, Nordic UART first then the original
    /// RedBearLab service. Probed UNCONDITIONALLY — not gated on
    /// `configuration?.boardName` — because `configuration` is set by
    /// configureBoard() only AFTER requestAndConnect resolves, so it is nil (fresh
    /// install) or stale during discovery. Gating here meant an original
    /// RedBearLab MoonBoard (which exposes no UART service) failed discovery on
    /// first connect and never reached configureBoard — a catch-22. Discovering
    /// an absent service is harmless on CoreBluetooth: Aurora and newer MoonBoards
    /// simply won't expose RedBearLab, the ordered list keeps the UART preference,
    /// and writeCharacteristicUuid(for:) keys on the discovered service.
    private func writeServiceUuids() -> [CBUUID] {
        [uartServiceUuid, redBearLabServiceUuid]
    }

    /// Canonical lowercase full-128-bit UUID string. `CBUUID.uuidString` returns
    /// the short 4-char form (uppercase) for 16-bit UUIDs and uppercase for
    /// 128-bit — ble-plx reports lowercase full-128-bit. Normalize so a board's
    /// service-data key is identical across platforms and groups in PostHog.
    static func normalizedUuidString(_ uuid: CBUUID) -> String {
        let raw = uuid.uuidString.lowercased()
        if raw.count == 4 {
            return "0000\(raw)-0000-1000-8000-00805f9b34fb"
        }
        return raw
    }

    /// Outcome of a `didDiscoverServices` callback.
    enum ServiceDiscoveryDecision: Equatable {
        /// A known write service is present — discover its write characteristic.
        case select(CBUUID)
        /// Neither write service present on a targeted probe; re-read the whole
        /// GATT table once (defeats a stale/partial iOS cache) before giving up.
        case retryFullDiscovery
        /// Neither write service present even after a full re-discovery — fail.
        case fail
    }

    /// Pure decision for `didDiscoverServices`, split out so the retry/fallback
    /// logic is unit-testable without a real `CBPeripheral` (#3480). Prefers the
    /// Nordic UART service, falling back to the original RedBearLab one, matching
    /// `writeServiceUuids()` ordering.
    private func serviceDiscoveryDecision(
        discoveredServiceUuids: [CBUUID],
        hasRetriedFullDiscovery: Bool
    ) -> ServiceDiscoveryDecision {
        if let match = writeServiceUuids().first(where: { discoveredServiceUuids.contains($0) }) {
            return .select(match)
        }
        return hasRetriedFullDiscovery ? .fail : .retryFullDiscovery
    }

    /// The write characteristic UUID paired with a discovered service UUID.
    private func writeCharacteristicUuid(for serviceUuid: CBUUID) -> CBUUID {
        serviceUuid == redBearLabServiceUuid ? redBearLabWriteCharacteristicUuid : uartWriteCharacteristicUuid
    }

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

        // Prefer the Nordic UART service; fall back to RedBearLab for the
        // original MoonBoard LED box. If a targeted probe finds neither, iOS may
        // be serving a stale/partial GATT cache — re-read the whole table once
        // before failing (#3480).
        let discoveredUuids = (peripheral.services ?? []).map { $0.uuid }
        switch serviceDiscoveryDecision(
            discoveredServiceUuids: discoveredUuids,
            hasRetriedFullDiscovery: retriedFullServiceDiscovery.contains(peripheral.identifier)
        ) {
        case .select(let serviceUuid):
            // Discovery resolved for this connection — drop any retry marker so it
            // doesn't linger for the peripheral's lifetime (symmetry with the
            // didConnect / failConnectionSetup cleanups).
            retriedFullServiceDiscovery.remove(peripheral.identifier)
            guard let service = peripheral.services?.first(where: { $0.uuid == serviceUuid }) else {
                // The decision was computed from this same services list, so the
                // service should still be here; treat a race as a plain miss.
                failConnectionSetup(peripheral, error: BoardBleError.uartServiceMissing)
                return
            }
            peripheral.discoverCharacteristics([writeCharacteristicUuid(for: service.uuid)], for: service)
        case .retryFullDiscovery:
            retriedFullServiceDiscovery.insert(peripheral.identifier)
            logger.info("BLE service probe found neither UART nor RedBearLab for \(peripheral.identifier.uuidString, privacy: .public); retrying full GATT discovery")
            peripheral.discoverServices(nil)
        case .fail:
            failConnectionSetup(peripheral, error: BoardBleError.uartServiceMissing)
        }
    }

    /// A connection that reached service discovery but can't become
    /// write-ready is useless — tear it down instead of leaving a half-open
    /// peripheral (`connectedPeripheral` set, `writeCharacteristic` nil) that
    /// blocks later reconnects. Settles the pending JS connect when one exists
    /// (picker connect / widget reconnect); during state restoration there is
    /// no pending completion and the teardown itself is the fix.
    private func failConnectionSetup(_ peripheral: CBPeripheral, error: Error) {
        // Record what the board DID expose so a service_missing report can tell
        // "nothing discovered" (stale cache / decoy peripheral) apart from an
        // unknown third controller generation (#3480). Read by JS via
        // getLastConnectDiagnostics right after the connect rejection.
        let discoveredServices = (peripheral.services ?? []).map { $0.uuid.uuidString }
        lastConnectFailureDiscoveredServices = discoveredServices
        logger.error("BLE connection setup failed for \(peripheral.identifier.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public) discoveredServices=[\(discoveredServices.joined(separator: ","), privacy: .public)]")
        retriedFullServiceDiscovery.remove(peripheral.identifier)
        peripheralGenerations.removeValue(forKey: peripheral.identifier)
        if connectedPeripheral?.identifier == peripheral.identifier {
            connectedPeripheral = nil
            writeCharacteristic = nil
        }
        cancelPeripheralConnection(peripheral)
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

        let writeCharUuid = writeCharacteristicUuid(for: service.uuid)
        guard let characteristic = service.characteristics?.first(where: { $0.uuid == writeCharUuid }) else {
            // Known minor divergence from the web/RN adapters, which retry the
            // other controller service when the chosen one exposes no write
            // characteristic. Not retried here because real boards are a single
            // controller generation (a UART service WITHOUT its write char while
            // ALSO exposing RedBearLab is not a real device), so this can't bite
            // hardware. Revisit if a hybrid controller ever ships.
            failConnectionSetup(peripheral, error: BoardBleError.writeCharacteristicMissing)
            return
        }

        finishConnectionSetupOnBleQueue(peripheral: peripheral, characteristic: characteristic)
    }

    /// Single write-ready success point shared by CoreBluetooth discovery and
    /// deterministic native tests. All completion, relight, persistence, and
    /// event behavior remains production behavior exercised through this helper.
    private func finishConnectionSetupOnBleQueue(
        peripheral: WritableBlePeripheral,
        characteristic: CBCharacteristic
    ) {
        connectedPeripheral = peripheral
        writeCharacteristic = characteristic
        // Any successful (re)connect closes a write-stall recovery window (#3181)
        // — writes flow normally again from here.
        writeStallRecoveringPeripheralId = nil
        // A fresh link re-earns normal backpressure: drop any stuck-false gate
        // bypass so a healthy connection isn't permanently ungated.
        bypassCanSendWriteWithoutResponse = false
        // Re-seed the with-response latch from what this connection knows — a
        // persisted learned entry, a this-session learning, or a bare-name Kilter
        // box. Persistent entries were written only after a behavior failure on a
        // `.write`-only characteristic AND a successful with-response ack, so this
        // still avoids trusting a stale property bit as the live trigger. Shared
        // with the `setConnection` test seam so the two paths can't drift.
        reseedForceWriteWithResponse(peripheral: peripheral, characteristic: characteristic)
        // Remember the board so the Live Activity lightbulb can reconnect to it
        // by identifier later, no device pick required.
        persistLastConnectedPeripheral(peripheral)
        completePendingConnect(.success(()))
        logger.info("Connected to board BLE peripheral \(peripheral.identifier.uuidString, privacy: .public)")
        // One-time write diagnostics (#3181 follow-up): records what the UART RX
        // characteristic actually advertises and which write type we'll use, so a
        // stalling board can be diagnosed from Console.app (also surfaced to JS →
        // Sentry via connectedDeviceInfo / getConnectedDevice).
        let connectionDiagnostics = connectionDiagnosticsOnBleQueue(peripheral: peripheral, characteristic: characteristic)
        logger.info("BLE write diagnostics for \(peripheral.identifier.uuidString, privacy: .public): properties=\(connectionDiagnostics.characteristicProperties, privacy: .public) supportsWriteWithoutResponse=\(connectionDiagnostics.supportsWriteWithoutResponse, privacy: .public) chosenWriteType=\(connectionDiagnostics.chosenWriteType, privacy: .public) maxWriteWithResponse=\(connectionDiagnostics.maxWriteWithResponse, privacy: .public) maxWriteWithoutResponse=\(connectionDiagnostics.maxWriteWithoutResponse, privacy: .public)")
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
        handlePeripheralIsReadyOnBleQueue()
    }

    /// Body of `peripheralIsReady(toSendWriteWithoutResponse:)`, extracted so the
    /// write flow-control tests can drive it without a real `CBPeripheral`
    /// (#3366). The delegate already ignored the peripheral arg, so this is a
    /// pure move. Runs on `bleQueue` (CoreBluetooth delivers the delegate there).
    func handlePeripheralIsReadyOnBleQueue() {
        // Recorded even when nothing is parked: the diagnostic question for
        // #3230 is whether iOS delivered this delegate at all during a request.
        currentWriteTelemetry?.peripheralIsReadyFired = true
        resumeParkedWrite(source: "callback")
    }

    /// Single resume point for a write parked on `canSendWriteWithoutResponse`,
    /// shared by the `peripheralIsReady` delegate and the #3230 poller. Strict
    /// ordering: retire BOTH wake-up sources and capture-and-nil the parked
    /// continuation BEFORE invoking it — the resume can synchronously re-park
    /// (the property is CoreBluetooth-internal and can flip back between our
    /// read and `writeChunk`'s) and install a fresh poller + watchdog, which a
    /// late cancel here would otherwise kill. Safe to call with nothing parked.
    private func resumeParkedWrite(source: String) {
        pendingWriteResumeWatchdog?.cancel()
        pendingWriteResumeWatchdog = nil
        writeResumePoller?.cancel()
        writeResumePoller = nil
        guard let resume = pendingWriteResume else { return }
        pendingWriteResume = nil
        if let parkStartedAt, var telemetry = currentWriteTelemetry {
            // Copy-mutate-writeback: reading `currentWriteTelemetry?.maxParkMs`
            // inside `max(...)` while assigning back through the same optional
            // chain is an overlapping access the Swift 6 / SDK 57 toolchain
            // rejects (exclusivity error). Mutate a local struct copy instead —
            // same idiom used by `finishWriteTelemetry` below.
            let parkMs = Int((DispatchTime.now().uptimeNanoseconds - parkStartedAt.uptimeNanoseconds) / 1_000_000)
            telemetry.maxParkMs = max(telemetry.maxParkMs, parkMs)
            telemetry.totalParkMs += parkMs
            currentWriteTelemetry = telemetry
        }
        parkStartedAt = nil
        currentWriteTelemetry?.lastResumeSource = source
        resume()
    }

    /// Second resume path for a parked write (#3230): on iOS 26.5 CoreBluetooth
    /// can update `canSendWriteWithoutResponse` without ever calling
    /// `peripheralIsReady`, leaving the park to the 5 s watchdog → link cycle →
    /// `write_timeout`. While parked, re-check the property on a repeating
    /// timer and resume the instant it flips true. The timer is created,
    /// scheduled and activated in one place and never suspended; stale ticks
    /// are provably inert via the identity guard + the `pendingWriteResume`
    /// guard (and, beyond those, `writeChunk`'s generation guards).
    private func startWriteResumePollerOnBleQueue() {
        writeResumePoller?.cancel()
        let poller = timerScheduler.makeRepeatingTimer()
        poller.setEventHandler { [weak self, weak poller] in
            guard let self, let poller, self.writeResumePoller === poller else { return }
            guard self.pendingWriteResume != nil else {
                self.writeResumePoller?.cancel()
                self.writeResumePoller = nil
                return
            }
            // Read the live connection each tick rather than capturing the
            // parked CBPeripheral: while a park exists the connected peripheral
            // can't change without failQueuedWrites cancelling this poller
            // first, and not capturing avoids keeping a dead peripheral alive.
            guard let peripheral = self.connectedPeripheral, peripheral.canSendWriteWithoutResponse else { return }
            self.resumeParkedWrite(source: "poll")
        }
        poller.schedule(
            interval: writeResumePollInterval,
            leeway: .milliseconds(20)
        )
        writeResumePoller = poller
        poller.activate()
    }

    // The ack for the write-WITH-response path. Mirrors `peripheralIsReady`:
    // cancel the stall watchdog, then capture-and-nil the parked continuation
    // BEFORE invoking it so a duplicate callback (or one racing a teardown that
    // already nil'd it) no-ops. Stale-generation acks are caught by
    // `writeChunk`'s generation guard when the continuation re-enters.
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        handleDidWriteValueOnBleQueue(error: error)
    }

    /// Body of `didWriteValueFor`, extracted so the write flow-control tests can
    /// drive the with-response ack path without a real `CBPeripheral` (#3366).
    /// The delegate used only `error` (never the peripheral/characteristic), so
    /// this is a pure move. Runs on `bleQueue`.
    func handleDidWriteValueOnBleQueue(error: Error?) {
        pendingWriteAckWatchdog?.cancel()
        pendingWriteAckWatchdog = nil
        let ack = pendingWriteAck
        pendingWriteAck = nil
        if let error {
            // Fail ONLY the in-flight queued write; don't proactively disconnect.
            // A genuine link drop is owned by didDisconnectPeripheral (which runs
            // failQueuedWrites + onDisconnect); a transient ATT error shouldn't
            // tear down the link. Mirrors the mid-write `notConnected` handling.
            logger.error("BLE write-with-response failed: \(error.localizedDescription, privacy: .public)")
            pendingWriteWithResponsePersistenceIdentity = nil
            guard !writeQueue.isEmpty else {
                isWriting = false
                processWriteQueue()
                return
            }
            let request = writeQueue.removeFirst()
            request.completion(error, finalizeCurrentWriteTelemetry())
            isWriting = false
            processWriteQueue()
            return
        }
        ack?()
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
        centralStateOnBleQueue == .poweredOn
            && connectedPeripheral != nil
            && writeCharacteristic != nil
    }

    private func waitUntilReady(timeout: TimeInterval) async {
        _ = await readyWaiters.wait(timeout: timeout) { [weak self] in
            self?.isReadyForWrite ?? true
        }
    }

    private func waitForWriteDrain(timeout: TimeInterval) async -> Bool {
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

    /// The write type this connection will ACTUALLY use for a send — reported in
    /// connection diagnostics so `bleChosenWriteType` is honest. Defaults to
    /// `BoardBleEncoding.preferredWriteType` (Aurora → without-response, MoonBoard
    /// → property-driven), but once `forceWriteWithResponse` is latched — because a
    /// without-response write demonstrably stalled on a `.write`-only characteristic
    /// (or a prior connection to this board already learned that) — Aurora also
    /// takes write-with-response. Guarded on `.write` so a characteristic that
    /// advertises neither write flavour can't be pushed onto a path it can't take.
    /// The per-chunk send decision in `writeChunk` mirrors this expression directly
    /// (it does not read this method) so a mid-write latch change is honoured.
    private func resolvedWriteType(for characteristic: CBCharacteristic) -> BoardBleWriteTypeResolution {
        if forceWriteWithResponse, characteristic.properties.contains(.write) {
            return BoardBleWriteTypeResolution(
                writeType: .withResponse,
                source: forceWriteWithResponseSource ?? .watchdogFallback
            )
        }
        let writeType = BoardBleEncoding.preferredWriteType(
            for: characteristic.properties,
            boardName: configuration?.boardName
        )
        let source: BoardBleWriteTypeSource = writeType == .withResponse ? .moonboardCharacteristic : .defaultWithoutResponse
        return BoardBleWriteTypeResolution(writeType: writeType, source: source)
    }

    private func connectionDiagnosticsOnBleQueue(
        peripheral: WritableBlePeripheral,
        characteristic: CBCharacteristic
    ) -> BoardBleConnectionDiagnostics {
        let properties = characteristic.properties
        let writeType = resolvedWriteType(for: characteristic).writeType
        return BoardBleConnectionDiagnostics(
            characteristicProperties: Int(properties.rawValue),
            supportsWriteWithoutResponse: properties.contains(.writeWithoutResponse),
            chosenWriteType: writeType == .withoutResponse ? "withoutResponse" : "withResponse",
            maxWriteWithResponse: peripheral.maximumWriteValueLength(for: .withResponse),
            maxWriteWithoutResponse: peripheral.maximumWriteValueLength(for: .withoutResponse)
        )
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
        connectTimeoutTimer?.cancel()
        connectTimeoutTimer = nil
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
        // Single seed point for the per-write telemetry: `isWriting` just
        // flipped false→true, so exactly one request owns the slot until a
        // settle point finalizes it (#3230).
        currentWriteTelemetry = BoardBleWriteTelemetry(
            origin: request.origin.rawValue,
            initialWriteType: request.initialWriteType == .withoutResponse ? "withoutResponse" : "withResponse",
            finalWriteType: request.initialWriteType == .withoutResponse ? "withoutResponse" : "withResponse",
            writeTypeSource: request.initialWriteTypeSource.rawValue,
            chunkSize: request.chunkSize,
            chunkCount: request.chunks.count,
            negotiatedMaxWriteWithoutResponse: request.negotiatedMaxWriteWithoutResponse,
            startedAt: .now()
        )
        writeChunk(
            requestIndex: 0,
            chunkIndex: 0,
            connectionGeneration: request.connectionGeneration,
            writeGeneration: request.writeGeneration
        )
    }

    /// Close out the in-flight request's telemetry (duration stamp, plus any
    /// still-open park — a watchdog-tripped write settles while parked, and
    /// that fatal park must count) and clear the slot so a later settle point
    /// can't re-deliver stale data. Every path that settles the head request
    /// routes its completion through this.
    private func finalizeCurrentWriteTelemetry() -> BoardBleWriteTelemetry? {
        guard var telemetry = currentWriteTelemetry else { return nil }
        currentWriteTelemetry = nil
        if let parkStartedAt {
            let parkMs = Int((DispatchTime.now().uptimeNanoseconds - parkStartedAt.uptimeNanoseconds) / 1_000_000)
            telemetry.maxParkMs = max(telemetry.maxParkMs, parkMs)
            telemetry.totalParkMs += parkMs
        }
        parkStartedAt = nil
        telemetry.durationMs = Int((DispatchTime.now().uptimeNanoseconds - telemetry.startedAt.uptimeNanoseconds) / 1_000_000)
        return telemetry
    }

    private func rechunkQueuedWriteForForcedWithResponseFallback(
        requestIndex: Int,
        connectionGeneration: UInt64,
        writeGeneration: UInt64
    ) -> Bool {
        guard requestIndex < writeQueue.count else { return false }
        let request = writeQueue[requestIndex]
        guard request.connectionGeneration == connectionGeneration,
              request.writeGeneration == writeGeneration
        else {
            return false
        }
        let payload = request.chunks.reduce(into: Data()) { combinedPayload, chunk in
            combinedPayload.append(chunk)
        }
        let fallbackChunks = stride(from: 0, to: payload.count, by: BoardBleEncoding.classicChunkSize).map { offset in
            payload.subdata(in: offset..<min(offset + BoardBleEncoding.classicChunkSize, payload.count))
        }
        writeQueue[requestIndex] = WriteRequest(
            chunks: fallbackChunks,
            writeType: request.writeType,
            writeTypeSource: request.writeTypeSource,
            initialWriteType: request.initialWriteType,
            initialWriteTypeSource: request.initialWriteTypeSource,
            chunkSize: BoardBleEncoding.classicChunkSize,
            negotiatedMaxWriteWithoutResponse: request.negotiatedMaxWriteWithoutResponse,
            origin: request.origin,
            connectionGeneration: request.connectionGeneration,
            writeGeneration: request.writeGeneration,
            completion: request.completion
        )
        currentWriteTelemetry?.finalWriteType = "withResponse"
        currentWriteTelemetry?.writeTypeSource = BoardBleWriteTypeSource.watchdogFallback.rawValue
        currentWriteTelemetry?.chunkSize = BoardBleEncoding.classicChunkSize
        currentWriteTelemetry?.chunkCount = fallbackChunks.count
        return true
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
            request.completion(BoardBleError.notConnected, finalizeCurrentWriteTelemetry())
            isWriting = false
            processWriteQueue()
            return
        }

        guard chunkIndex < request.chunks.count else {
            _ = writeQueue.removeFirst()
            // A write got through end-to-end: the link is healthy, so refresh the
            // write-stall recovery budget (#3181).
            writeStallRecoveries = 0
            persistPendingWriteWithResponseIdentityIfNeeded()
            request.completion(nil, finalizeCurrentWriteTelemetry())
            isWriting = false
            processWriteQueue()
            return
        }

        // Effective write type: honour the request's own type, but also route to
        // write-with-response when this connection has been latched onto it
        // (`forceWriteWithResponse`) — a parked without-response write that trips
        // the stall watchdog below switches mid-flight without re-queuing.
        let sendWithResponse = request.writeType == .withResponse
            || (forceWriteWithResponse && characteristic.properties.contains(.write))
        if sendWithResponse {
            let actualWriteTypeSource: BoardBleWriteTypeSource
            if request.writeType == .withResponse {
                actualWriteTypeSource = request.writeTypeSource
            } else {
                actualWriteTypeSource = forceWriteWithResponseSource ?? .watchdogFallback
            }
            currentWriteTelemetry?.finalWriteType = "withResponse"
            currentWriteTelemetry?.writeTypeSource = actualWriteTypeSource.rawValue
        } else {
            currentWriteTelemetry?.finalWriteType = "withoutResponse"
            currentWriteTelemetry?.writeTypeSource = request.writeTypeSource.rawValue
        }
        if !sendWithResponse {
            // `bypassCanSendWriteWithoutResponse` short-circuits the gate on a
            // connection we've already proven reports the property stuck false
            // (see the watchdog handler below): keep writing, paced by chunkDelay.
            guard bypassCanSendWriteWithoutResponse || peripheral.canSendWriteWithoutResponse else {
                currentWriteTelemetry?.parkCount += 1
                parkStartedAt = .now()
                pendingWriteResume = { [weak self] in
                    self?.writeChunk(
                        requestIndex: requestIndex,
                        chunkIndex: chunkIndex,
                        connectionGeneration: connectionGeneration,
                        writeGeneration: writeGeneration
                    )
                }
                // Watchdog: last resort when NEITHER resume path fires — the
                // peripheralIsReady delegate stays silent AND the poller below
                // never sees `canSendWriteWithoutResponse` flip true (a
                // genuinely wedged transmit buffer). Unbounded, `isWriting`
                // would stay true forever and the wall would freeze until a
                // manual disconnect. `canSendAtTrip` disambiguates in the
                // field: true would mean the poller missed a flip (logic bug);
                // false proves the wedge that only a link cycle clears; absent
                // means the peripheral was already gone when the watchdog ran.
                pendingWriteResumeWatchdog?.cancel()
                pendingWriteResumeWatchdog = timerScheduler.scheduleOneShot(after: writeResumeTimeout, label: "writeResumeWatchdog") { [weak self] in
                    guard let self, self.pendingWriteResume != nil else { return }
                    // Tri-state on purpose: true = the poller missed a flip
                    // (logic bug), false = wedged buffer on a live link, nil
                    // (omitted from analytics) = the peripheral was already
                    // gone at trip time, so neither claim would be honest.
                    let canSendAtTrip = self.connectedPeripheral?.canSendWriteWithoutResponse
                    self.currentWriteTelemetry?.watchdogTripped = true
                    self.currentWriteTelemetry?.canSendAtTrip = canSendAtTrip
                    // canSendAtTrip == false on a live peripheral is the iOS 26.x
                    // "stuck false" signature: the property never recovered across
                    // the whole watchdog window (the poller re-read it every
                    // writeResumePollInterval and never saw it flip, and
                    // peripheralIsReady never fired). Cycling the link doesn't
                    // clear it — it comes back stuck on the fresh connection too —
                    // so instead latch past the gate for this connection and push
                    // the parked write through. The false reading is a lie on
                    // these OS versions; the radio takes the write. First send eats
                    // one writeResumeTimeout; every later send on this connection
                    // skips the gate. A vanished peripheral (nil) or a genuine
                    // missed-flip (true) still falls through to stall recovery.
                    if canSendAtTrip == false, !self.bypassCanSendWriteWithoutResponse, !self.forceWriteWithResponse {
                        // Split the two iOS failure modes by the characteristic's OWN
                        // advertised properties. A characteristic that advertises only
                        // `.write` (no `.writeWithoutResponse` bit) genuinely cannot take a
                        // no-response write — CoreBluetooth silently drops it — so bypassing
                        // the gate would just fire more writes into the void. That is the
                        // original MoonBoard box's signature, and some Kilter-built controller
                        // boxes advertise the same way. Switch THIS connection to the
                        // ack-paced write-with-response path (and remember the board so a
                        // reconnect skips this stall). Reaching here proves without-response
                        // already failed, so this can never degrade a board it would have
                        // worked on.
                        if let characteristic = self.writeCharacteristic,
                           characteristic.properties.contains(.write),
                           !characteristic.properties.contains(.writeWithoutResponse) {
                            if let peripheral = self.connectedPeripheral {
                                self.writeWithResponsePeripheralIds.insert(peripheral.identifier)
                                self.pendingWriteWithResponsePersistenceIdentity = self.auroraWriteWithResponseIdentity(
                                    peripheral: peripheral,
                                    characteristic: characteristic
                                )
                            }
                            self.forceWriteWithResponse = true
                            self.forceWriteWithResponseSource = .watchdogFallback
                            guard self.rechunkQueuedWriteForForcedWithResponseFallback(
                                requestIndex: requestIndex,
                                connectionGeneration: connectionGeneration,
                                writeGeneration: writeGeneration
                            ) else {
                                self.forceWriteWithResponse = false
                                self.forceWriteWithResponseSource = nil
                                if let peripheral = self.connectedPeripheral {
                                    self.writeWithResponsePeripheralIds.remove(peripheral.identifier)
                                }
                                self.pendingWriteWithResponsePersistenceIdentity = nil
                                self.handleWriteStall()
                                return
                            }
                            self.logger.error("BLE write stalled: RX characteristic advertises only .write; switching this connection to write-with-response")
                            self.resumeParkedWrite(source: "withResponse")
                            return
                        }
                        // The characteristic DOES advertise `.writeWithoutResponse` but the
                        // property is stuck false — the iOS 26.x flow-control bug on an
                        // otherwise-normal board. Latch past the gate and keep
                        // write-without-response; the radio takes the write even though the
                        // flag lies.
                        self.bypassCanSendWriteWithoutResponse = true
                        self.logger.error("BLE write stalled: canSendWriteWithoutResponse stuck false across the watchdog window; bypassing the gate for this connection and resuming the write")
                        self.resumeParkedWrite(source: "bypass")
                        return
                    }
                    self.logger.error("BLE write stalled: peripheral never became ready for write-without-response (canSendAtTrip=\(String(describing: canSendAtTrip), privacy: .public)); attempting recovery")
                    self.handleWriteStall()
                }
                startWriteResumePollerOnBleQueue()
                return
            }

            peripheral.writeValue(request.chunks[chunkIndex], for: characteristic, type: .withoutResponse)
            _ = timerScheduler.scheduleOneShot(after: chunkDelay, label: "chunkDelay") { [weak self] in
                self?.writeChunk(
                    requestIndex: requestIndex,
                    chunkIndex: chunkIndex + 1,
                    connectionGeneration: connectionGeneration,
                    writeGeneration: writeGeneration
                )
            }
            return
        }

        // Write-WITH-response path: the original MoonBoard LED box (whose UART RX
        // characteristic advertises only `.write`), and any Aurora box latched onto
        // it via `forceWriteWithResponse` after without-response stalled on the same
        // `.write`-only signature. CoreBluetooth would silently drop a
        // `.withoutResponse` write to such a characteristic — so pace on the
        // `didWriteValueFor` ack instead of `canSendWriteWithoutResponse` /
        // `peripheralIsReady`. The ack is itself the backpressure signal, so no
        // fixed delay is needed for an Aurora box that fell back to with-response.
        // A bare-name Kilter box is driven like its own app, though: pace 100 ms
        // apart ON TOP of the ack (`connectedBoxIsKilterBuilt`).
        pendingWriteAck = { [weak self] in
            guard let self else { return }
            let advanceToNextChunk = {
                self.writeChunk(
                    requestIndex: requestIndex,
                    chunkIndex: chunkIndex + 1,
                    connectionGeneration: connectionGeneration,
                    writeGeneration: writeGeneration
                )
            }
            if self.connectedBoxIsKilterBuilt {
                _ = self.timerScheduler.scheduleOneShot(after: self.kilterBoxChunkDelay, label: "kilterChunkDelay") {
                    advanceToNextChunk()
                }
            } else {
                advanceToNextChunk()
            }
        }
        // Watchdog mirrors the without-response stall path: if the board never
        // acks within writeResumeTimeout, recover by cycling the link (#3181).
        pendingWriteAckWatchdog?.cancel()
        pendingWriteAckWatchdog = timerScheduler.scheduleOneShot(after: writeResumeTimeout, label: "writeAckWatchdog") { [weak self] in
            guard let self, self.pendingWriteAck != nil else { return }
            self.currentWriteTelemetry?.watchdogTripped = true
            // Reversible-fallback guard for issue #3235. If this connection was
            // FORCED onto write-with-response (a without-response write had stalled
            // on a `.write`-only characteristic) and the with-response write ALSO
            // never acks, the box can complete neither flavour. That is exactly the
            // #3235 marginal-box / stale-GATT-cache case: a box that really wants
            // without-response reads as `.write`-only (a stale cache dropped the
            // `.writeWithoutResponse` bit) and can't deliver the per-write ATT ack.
            // Cycling the link would just disconnect the user, and re-forcing
            // with-response on reconnect would loop. Instead revert THIS connection
            // to the without-response gate bypass (the pre-fix #3563 behaviour) and
            // re-fire the SAME chunk: such a box is then no worse off than before
            // the with-response fix (#3181 still owns any genuine drop), while a
            // real `.write`-only box that DOES ack keeps working. Forget the learned
            // decision so reconnects don't immediately force it again.
            if self.forceWriteWithResponse {
                if let peripheral = self.connectedPeripheral {
                    self.writeWithResponsePeripheralIds.remove(peripheral.identifier)
                    if let characteristic = self.writeCharacteristic,
                       let identity = self.auroraWriteWithResponseIdentity(
                           peripheral: peripheral,
                           characteristic: characteristic
                       ),
                       self.learnedWriteWithResponseEntries.removeValue(forKey: identity) != nil {
                        self.saveLearnedWriteWithResponseEntries()
                    }
                }
                self.forceWriteWithResponse = false
                self.forceWriteWithResponseSource = nil
                self.bypassCanSendWriteWithoutResponse = true
                self.pendingWriteWithResponsePersistenceIdentity = nil
                self.currentWriteTelemetry?.lastResumeSource = "withResponseRevert"
                self.pendingWriteAck = nil
                self.pendingWriteAckWatchdog = nil
                self.logger.error("BLE write stalled: forced write-with-response never acked; reverting this connection to the without-response gate bypass (#3235)")
                self.writeChunk(
                    requestIndex: requestIndex,
                    chunkIndex: chunkIndex,
                    connectionGeneration: connectionGeneration,
                    writeGeneration: writeGeneration
                )
                return
            }
            self.logger.error("BLE write stalled: peripheral never acked write-with-response; attempting recovery")
            self.handleWriteStall()
        }
        peripheral.writeValue(request.chunks[chunkIndex], for: characteristic, type: .withResponse)
    }

    private func failQueuedWrites(_ error: Error) {
        writeGeneration += 1
        let queuedWrites = writeQueue
        writeQueue = []
        let wasWriting = isWriting
        isWriting = false
        pendingWriteResume = nil
        pendingWriteResumeWatchdog?.cancel()
        pendingWriteResumeWatchdog = nil
        writeResumePoller?.cancel()
        writeResumePoller = nil
        pendingWriteAck = nil
        pendingWriteAckWatchdog?.cancel()
        pendingWriteAckWatchdog = nil
        pendingWriteWithResponsePersistenceIdentity = nil
        // Only the in-flight head request has meaningful telemetry; requests
        // that never started get nil. Finalizing folds any still-open park into
        // the totals and clears the slot (and parkStartedAt), so a later
        // defensive call on an empty queue can't re-deliver stale data. When
        // nothing was writing, both should already be nil — clear defensively.
        let headTelemetry: BoardBleWriteTelemetry?
        if wasWriting {
            headTelemetry = finalizeCurrentWriteTelemetry()
        } else {
            headTelemetry = nil
            currentWriteTelemetry = nil
            parkStartedAt = nil
        }
        for (requestIndex, request) in queuedWrites.enumerated() {
            request.completion(error, requestIndex == 0 ? headTelemetry : nil)
        }
        notifyDrainWaitersIfDrainedOnBleQueue()
    }

    private static func loadLearnedWriteWithResponseEntries() -> [String: LearnedWriteWithResponseEntry] {
        guard let data = SharedConstants.sharedDefaults?.data(forKey: SharedConstants.bleWriteWithResponseBoardsKey),
              let entries = try? JSONDecoder().decode([String: LearnedWriteWithResponseEntry].self, from: data)
        else {
            return [:]
        }
        return entries
    }

    private func saveLearnedWriteWithResponseEntries() {
        guard let data = try? JSONEncoder().encode(learnedWriteWithResponseEntries) else { return }
        SharedConstants.sharedDefaults?.set(data, forKey: SharedConstants.bleWriteWithResponseBoardsKey)
    }

    private func learnedWriteWithResponseEntry(
        for identity: String,
        now: Date = Date()
    ) -> LearnedWriteWithResponseEntry? {
        guard let entry = learnedWriteWithResponseEntries[identity] else { return nil }
        if now.timeIntervalSince1970 - entry.learnedAt > learnedWriteWithResponseTtl {
            learnedWriteWithResponseEntries.removeValue(forKey: identity)
            saveLearnedWriteWithResponseEntries()
            return nil
        }
        return entry
    }

    /// Seed `forceWriteWithResponse` / `forceWriteWithResponseSource` /
    /// `connectedBoxIsKilterBuilt` from what this connection knows: a persisted
    /// learned entry, a this-session learning, or a bare Aurora name (Kilter-built
    /// box). Shared by the real connect path and the `setConnection` test seam so
    /// the two can't drift. A bare-name box is a NAME signal, not the GATT property
    /// bit — a healthy serial'd box never matches, so proactively forcing
    /// with-response here can't re-introduce the #3228 stale-property regression.
    private func reseedForceWriteWithResponse(peripheral: WritableBlePeripheral, characteristic: CBCharacteristic) {
        let learnedIdentity = auroraWriteWithResponseIdentity(peripheral: peripheral, characteristic: characteristic)
        let learnedEntry = learnedIdentity.flatMap { learnedWriteWithResponseEntry(for: $0) }
        let learnedThisSession = writeWithResponsePeripheralIds.contains(peripheral.identifier)
        let bareNameBox = BoardBleEncoding.isKilterBuiltBox(
            deviceName: discoveredNames[peripheral.identifier.uuidString] ?? peripheral.name ?? configuration?.deviceName
        )
        connectedBoxIsKilterBuilt = bareNameBox
        forceWriteWithResponse = learnedEntry != nil || learnedThisSession || bareNameBox
        if learnedEntry != nil {
            forceWriteWithResponseSource = .learnedPersistentFallback
        } else if learnedThisSession {
            forceWriteWithResponseSource = .watchdogFallback
        } else if bareNameBox {
            forceWriteWithResponseSource = .bareNameHint
        } else {
            forceWriteWithResponseSource = nil
        }
    }

    private func auroraWriteWithResponseIdentity(
        peripheral: WritableBlePeripheral,
        characteristic: CBCharacteristic
    ) -> String? {
        guard characteristic.uuid != redBearLabWriteCharacteristicUuid,
              configuration?.boardName != "moonboard"
        else {
            return nil
        }
        let deviceId = peripheral.identifier.uuidString
        let deviceName = discoveredNames[deviceId] ?? peripheral.name ?? configuration?.deviceName
        if let serial = BoardBleEncoding.parseSerialNumber(deviceName: deviceName) {
            return "aurora:\(serial)"
        }
        return "peripheral:\(deviceId)"
    }

    private func persistPendingWriteWithResponseIdentityIfNeeded(now: Date = Date()) {
        guard let identity = pendingWriteWithResponsePersistenceIdentity else { return }
        pendingWriteWithResponsePersistenceIdentity = nil
        learnedWriteWithResponseEntries[identity] = LearnedWriteWithResponseEntry(
            learnedAt: now.timeIntervalSince1970
        )
        saveLearnedWriteWithResponseEntries()
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
            onDisconnect?(deviceId, ["context": "write_stall_budget_exhausted"])
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
        writeStallRecoveryWatchdog?.cancel()
        writeStallRecoveryWatchdog = timerScheduler.scheduleOneShot(after: connectTimeout, label: "writeStallRecoveryWatchdog") { [weak self] in
            guard let self, self.writeStallRecoveringPeripheralId == recoveringId else { return }
            self.logger.error("BLE write-stall recovery stalled before reconnect (no didDisconnect); surfacing disconnect for \(recoveringId.uuidString, privacy: .public)")
            self.writeStallRecoveringPeripheralId = nil
            self.writeStallRecoveries = 0
            self.writeCharacteristic = nil
            self.connectedPeripheral = nil
            self.onDisconnect?(recoveringId.uuidString, ["context": "write_stall_recovery_timeout"])
        }
    }

    /// Intentionally drop the current link: bump the generation, mark the
    /// disconnect intentional (so didDisconnectPeripheral suppresses the
    /// onDisconnect-to-JS and invalidates the old link's stale callbacks), cancel,
    /// and null the connection. Shared by the write-stall recovery paths (#3181).
    private func cancelConnectionIntentionallyOnBleQueue(_ peripheral: WritableBlePeripheral) {
        connectionGeneration += 1
        intentionalDisconnectGenerations[peripheral.identifier] = connectionGeneration
        peripheralGenerations[peripheral.identifier] = connectionGeneration
        cancelPeripheralConnection(peripheral)
        writeCharacteristic = nil
        connectedPeripheral = nil
    }

    /// Barrier-gated cancel used by every teardown path except the stale
    /// didConnect branch. A barrier means this UUID already has a manager
    /// cancel awaiting its sole terminal callback; reissuing a cancel for a
    /// still-PENDING connect could manufacture a second callback that no
    /// generation token can classify, so the first cancellation owns teardown
    /// until the barrier settles.
    private func cancelPeripheralConnection(_ peripheral: WritableBlePeripheral) {
        guard registerManagerCancellationBarrierOnBleQueue(peripheralId: peripheral.identifier) else {
            return
        }
        performCancelPeripheralConnection(peripheral)
    }

    /// The single concrete `CBCentralManager.cancelPeripheralConnection` call
    /// site, with no barrier bookkeeping. Every `WritableBlePeripheral` is a
    /// `CBPeripheral` outside tests, so in production this is exactly the old
    /// inline call. The stale didConnect branch calls this directly because its
    /// corrective cancel of a CONNECTED peripheral must go out even when the
    /// UUID's barrier is already registered. The test override lets the native
    /// suites observe cancels without a real CoreBluetooth peripheral.
    private func performCancelPeripheralConnection(_ peripheral: WritableBlePeripheral) {
        #if DEBUG || BOARDSESH_TESTS
        if let overrideForTesting = cancelPeripheralConnectionOverrideForTesting {
            overrideForTesting(peripheral)
            return
        }
        #endif
        guard let concretePeripheral = peripheral as? CBPeripheral else {
            assertionFailure("WritableBlePeripheral is always CBPeripheral outside tests")
            return
        }
        centralManager.cancelPeripheralConnection(concretePeripheral)
    }

    private func registerManagerCancellationBarrierOnBleQueue(peripheralId: UUID) -> Bool {
        guard managerCancellationBarriers[peripheralId] == nil else { return false }
        // A fresh manager cancellation becomes the sole owner of the next
        // terminal callback for this UUID. Retire any displaced-attempt
        // tombstone first so it cannot survive this barrier and swallow a later
        // genuine terminal callback (for example when the retry itself times
        // out before either attempt reports one).
        displacedCancellationPeripheralIds.remove(peripheralId)
        let cancellationBarrier = ManagerCancellationBarrier()
        managerCancellationBarriers[peripheralId] = cancellationBarrier
        cancellationBarrier.watchdog = timerScheduler.scheduleOneShot(
            after: connectTimeout,
            label: "managerCancellationBarrierWatchdog"
        ) { [weak self, weak cancellationBarrier] in
            guard let self, let cancellationBarrier,
                  self.managerCancellationBarriers[peripheralId] === cancellationBarrier
            else { return }
            // Timeout protects promises, not ordering. A disconnected peripheral
            // state is not evidence that CoreBluetooth delivered the terminal
            // callback, so retain the barrier and never force a connect here.
            // The retained barrier stays effective against DEFERRED waiters
            // only until a fresh explicit connect displaces it — an expired
            // barrier must not make the board permanently unconnectable when
            // CoreBluetooth never delivers a callback for a cancelled pending
            // connect (see connectOnBleQueue).
            cancellationBarrier.hasExpired = true
            guard self.deferredConnectRequest?.peripheralId == peripheralId else { return }
            self.failDeferredConnect(BoardBleError.connectTimedOut)
        }
        return true
    }

    private func preparePeripheralForConnection(_ peripheral: WritableBlePeripheral) {
        #if DEBUG || BOARDSESH_TESTS
        if !(peripheral is CBPeripheral) {
            return
        }
        #endif
        guard let concretePeripheral = peripheral as? CBPeripheral else {
            assertionFailure("WritableBlePeripheral is always CBPeripheral outside tests")
            return
        }
        concretePeripheral.delegate = self
    }

    private func connectPeripheral(_ peripheral: WritableBlePeripheral) {
        #if DEBUG || BOARDSESH_TESTS
        if let overrideForTesting = connectPeripheralOverrideForTesting {
            overrideForTesting(peripheral)
            return
        }
        #endif
        guard let concretePeripheral = peripheral as? CBPeripheral else {
            assertionFailure("WritableBlePeripheral is always CBPeripheral outside tests")
            return
        }
        centralManager.connect(concretePeripheral, options: [
            CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
        ])
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

    /// Lowercase hex, matching the JS `uint8ArrayToHex` / ble-plx base64→hex
    /// normalization so the `bleManufacturerData` PostHog field is comparable
    /// across platforms.
    func hexEncodedString() -> String {
        map { String(format: "%02x", $0) }.joined()
    }
}

#if DEBUG || BOARDSESH_TESTS
extension BoardBleManager {
    /// Test-only seam into the write flow-control internals (#3366). Reaches the
    /// manager's `private` state via same-file extension access, so the write
    /// flow-control suite can set up an isolated connection, drive the timers /
    /// delegate callbacks the fakes replace, and read back the resulting state
    /// without touching CoreBluetooth. Never compiled into release builds.
    struct TestHooks {
        fileprivate let manager: BoardBleManager

        /// Run `body` on the BLE serial queue synchronously. Nested manager hops
        /// (`runOnBleQueue`) execute inline under this, so a whole action settles
        /// before the call returns — the suite's determinism relies on it.
        func sync<T>(_ body: () -> T) -> T {
            manager.runOnBleQueueSync(body)
        }

        /// Exercise the intent display request + global drain contract after
        /// readiness has already been established, without creating a real
        /// CBCentralManager in the Swift unit-test target.
        func displayCurrentItemAwaitingDrain(
            items: [SharedQueueItem],
            currentIndex: Int,
            drainTimeout: TimeInterval
        ) async -> Bool {
            await manager.displayCurrentItemAwaitingDrain(
                items: items,
                currentIndex: currentIndex,
                drainTimeout: drainTimeout
            )
        }

        /// Directly seed the connection the write path guards on. No CoreBluetooth
        /// side effects, unlike the real connect flow.
        func setConnection(peripheral: WritableBlePeripheral?, characteristic: CBCharacteristic?) {
            manager.connectedPeripheral = peripheral
            manager.writeCharacteristic = characteristic
            if let peripheral {
                manager.discoveredPeripherals[peripheral.identifier.uuidString] = peripheral
            }
            // Mirror the production reset in didDiscoverCharacteristicsFor so a
            // reconnect in a test starts with the gate re-armed and the
            // with-response latch re-seeded from what the session has learned.
            manager.bypassCanSendWriteWithoutResponse = false
            if let peripheral, let characteristic {
                manager.reseedForceWriteWithResponse(peripheral: peripheral, characteristic: characteristic)
            } else {
                manager.forceWriteWithResponse = false
                manager.forceWriteWithResponseSource = nil
                manager.connectedBoxIsKilterBuilt = false
            }
        }

        /// Set the in-memory board configuration WITHOUT the app-group persistence
        /// `configure()` performs — so a dev machine's stored config can't leak in.
        func setConfiguration(_ configuration: BoardBleConfiguration?) {
            manager.configuration = configuration
        }

        /// Seed the consecutive-stall counter to exercise the recovery-budget
        /// boundary in `handleWriteStall`.
        func setWriteStallRecoveries(_ count: Int) {
            manager.writeStallRecoveries = count
        }

        /// Intercept the single concrete `cancelPeripheralConnection` call so a
        /// fake peripheral never has to be a real `CBPeripheral`.
        func setCancelPeripheralConnectionOverride(_ handler: ((WritableBlePeripheral) -> Void)?) {
            manager.cancelPeripheralConnectionOverrideForTesting = handler
        }

        /// Intercept the concrete CoreBluetooth connect call.
        func setConnectPeripheralOverride(_ handler: ((WritableBlePeripheral) -> Void)?) {
            manager.connectPeripheralOverrideForTesting = handler
        }

        /// Set the central state without instantiating `CBCentralManager`.
        func setCentralState(_ state: CBManagerState?) {
            manager.centralStateOverrideForTesting = state
        }

        /// Make a fake peripheral discoverable by the production connect path.
        func setDiscoveredPeripheral(_ peripheral: WritableBlePeripheral) {
            manager.discoveredPeripherals[peripheral.identifier.uuidString] = peripheral
        }

        /// Intercept the concrete CoreBluetooth scan teardown while preserving
        /// the production `scanRequested = false` transition in
        /// `stopScanOnBleQueue`.
        func setStopScanOverride(_ handler: (() -> Void)?) {
            manager.stopScanOverrideForTesting = handler
        }

        /// Fire the `peripheralIsReady(toSendWriteWithoutResponse:)` delegate body.
        func firePeripheralIsReady() {
            manager.runOnBleQueueSync { manager.handlePeripheralIsReadyOnBleQueue() }
        }

        /// Fire the `didWriteValueFor` delegate body (with-response ack path).
        func fireWriteAck(error: Error?) {
            manager.runOnBleQueueSync { manager.handleDidWriteValueOnBleQueue(error: error) }
        }

        /// Fire the exact `didDisconnectPeripheral` state transition without a
        /// concrete CoreBluetooth central or peripheral.
        func fireDidDisconnect(peripheral: WritableBlePeripheral, error: Error?) {
            manager.runOnBleQueueSync {
                manager.handleDidDisconnectOnBleQueue(peripheral: peripheral, error: error)
            }
        }

        /// Fire the exact `didFailToConnect` state transition.
        func fireDidFailToConnect(peripheral: WritableBlePeripheral, error: Error?) {
            manager.runOnBleQueueSync {
                manager.handleDidFailToConnectOnBleQueue(peripheral: peripheral, error: error)
            }
        }

        /// Fire the exact `didConnect` decision (stale-generation corrective
        /// cancel vs current-generation bookkeeping). Service discovery needs a
        /// concrete `CBPeripheral`, so the current-generation arm's discovery
        /// closure is a no-op here; drive `fireConnectionReady` afterwards to
        /// reach the write-ready success point.
        func fireDidConnect(peripheral: WritableBlePeripheral) {
            manager.runOnBleQueueSync {
                manager.handleDidConnectOnBleQueue(peripheral: peripheral) {}
            }
        }

        /// Fire the unavailable half of `centralManagerDidUpdateState`.
        func fireCentralStateUpdate(_ state: CBManagerState) {
            manager.runOnBleQueueSync {
                let previousStateOverride = manager.centralStateOverrideForTesting
                manager.centralStateOverrideForTesting = state
                defer { manager.centralStateOverrideForTesting = previousStateOverride }
                manager.handleCentralStateUpdateOnBleQueue(state: state)
            }
        }

        /// Fire the production write-ready success point after a test connect.
        func fireConnectionReady(peripheral: WritableBlePeripheral, characteristic: CBCharacteristic) {
            manager.runOnBleQueueSync {
                manager.finishConnectionSetupOnBleQueue(
                    peripheral: peripheral,
                    characteristic: characteristic
                )
            }
        }

        /// Drive the implicit shared-state re-light directly, against an
        /// isolated defaults suite. Deliberately below whatever gate wraps the
        /// connect-path callers, so the #4544 contract (absent state is not a
        /// clear) is pinned independently of how a connect is authorised.
        func displaySharedCurrentItem(defaults: UserDefaults) {
            manager.runOnBleQueueSync {
                manager.displaySharedCurrentItemOnBleQueue(defaults: defaults)
            }
        }

        /// Exercise the pure service-discovery decision (retry-then-fail
        /// fallback) without a real `CBPeripheral` (#3480).
        func serviceDiscoveryDecision(
            discoveredServiceUuids: [CBUUID],
            hasRetriedFullDiscovery: Bool
        ) -> BoardBleManager.ServiceDiscoveryDecision {
            manager.serviceDiscoveryDecision(
                discoveredServiceUuids: discoveredServiceUuids,
                hasRetriedFullDiscovery: hasRetriedFullDiscovery
            )
        }

        /// The Nordic UART and RedBearLab write-service UUIDs, in probe order,
        /// so tests can assert the decision without hardcoding them.
        var writeServiceUuidsForTesting: [CBUUID] { manager.writeServiceUuids() }

        /// Exercise the production service→write-characteristic mapping used by
        /// `didDiscoverCharacteristicsFor`.
        func writeCharacteristicUuidForTesting(serviceUuid: CBUUID) -> CBUUID {
            manager.writeCharacteristicUuid(for: serviceUuid)
        }

        var hasPendingWriteResume: Bool { manager.pendingWriteResume != nil }
        var hasPendingWriteAck: Bool { manager.pendingWriteAck != nil }
        var capturedPendingWriteResume: (() -> Void)? { manager.pendingWriteResume }
        var isWriting: Bool { manager.isWriting }
        var writeQueueDepth: Int { manager.writeQueue.count }
        var writeGeneration: UInt64 { manager.writeGeneration }
        var currentTelemetry: BoardBleWriteTelemetry? { manager.currentWriteTelemetry }
        var writeStallRecoveries: Int { manager.writeStallRecoveries }
        var writeStallRecoveringPeripheralId: UUID? { manager.writeStallRecoveringPeripheralId }
        var bypassCanSendWriteWithoutResponse: Bool { manager.bypassCanSendWriteWithoutResponse }
        var forceWriteWithResponse: Bool { manager.forceWriteWithResponse }
        var forceWriteWithResponseSource: BoardBleWriteTypeSource? { manager.forceWriteWithResponseSource }
        var writeWithResponsePeripheralIds: Set<UUID> { manager.writeWithResponsePeripheralIds }
        var hasPendingConnect: Bool { manager.pendingConnectCompletion != nil }
        var deferredConnectPeripheralId: UUID? { manager.deferredConnectRequest?.peripheralId }
        var managerCancellationBarrierIds: Set<UUID> { Set(manager.managerCancellationBarriers.keys) }
        var displacedCancellationPeripheralIds: Set<UUID> { manager.displacedCancellationPeripheralIds }

        func intentionalDisconnectGeneration(for peripheralId: UUID) -> UInt64? {
            manager.intentionalDisconnectGenerations[peripheralId]
        }

        func peripheralGeneration(for peripheralId: UUID) -> UInt64? {
            manager.peripheralGenerations[peripheralId]
        }

        /// Seed a generation entry directly, so a test can prove a disconnect
        /// path removes (or preserves) it without driving the full connect flow.
        func setPeripheralGeneration(_ generation: UInt64, for peripheralId: UUID) {
            manager.peripheralGenerations[peripheralId] = generation
        }

        func setLearnedWriteWithResponseEntry(
            identity: String,
            learnedAt: TimeInterval
        ) {
            manager.learnedWriteWithResponseEntries[identity] = LearnedWriteWithResponseEntry(
                learnedAt: learnedAt
            )
        }

        func removeLearnedWriteWithResponseEntry(identity: String) {
            manager.learnedWriteWithResponseEntries.removeValue(forKey: identity)
        }

        func hasLearnedWriteWithResponseEntry(identity: String) -> Bool {
            manager.learnedWriteWithResponseEntries[identity] != nil
        }
    }

    var testHooks: TestHooks { TestHooks(manager: self) }
}
#endif
