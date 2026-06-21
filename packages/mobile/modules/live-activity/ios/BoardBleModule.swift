import ExpoModulesCore
import Foundation
import os.log

/// Expo Module bridge to `BoardBleManager`. Direct port of the Capacitor
/// `BoardBlePlugin` API surface (`isAvailable`, `startScan`, `stopScan`,
/// `connect`, `disconnect`, `write`, `cancelWrites`, `configureBoard`) plus
/// the two listener events (`scanResult`, `disconnected`).
///
/// The underlying `BoardBleManager` singleton is unchanged from the Capacitor
/// app, so the same Swift code that backs Dynamic Island intent writes via
/// `LiveActivityBleBridge` also backs JS-initiated scans/writes.
public class BoardBleModule: Module {
    private let logger = Logger(subsystem: "com.boardsesh.app", category: "BoardBleModule")

    /// Pending listener events queued while no JS listener is attached, mirroring
    /// Capacitor's `notifyListeners(..., retainUntilConsumed: true)` semantics.
    /// Drained on `OnStartObserving`.
    private struct PendingEvent {
        let name: String
        let body: [String: Any]
    }
    private let bufferQueue = DispatchQueue(label: "com.boardsesh.app.BoardBleModule.buffer")
    private var pendingEvents: [PendingEvent] = []
    private var hasListener = false
    private var isDraining = false

    public func definition() -> ModuleDefinition {
        Name("BoardBle")

        Events("scanResult", "disconnected", "connected")

        OnCreate {
            BoardBleManager.shared.setEventHandlers(
                onScanResult: { [weak self] result in
                    self?.emitOrBuffer(name: "scanResult", body: [
                        "device": [
                            "deviceId": result.deviceId,
                            "name": result.name ?? ""
                        ],
                        "localName": result.name ?? "",
                        "rssi": result.rssi,
                        "serviceUuids": result.serviceUuids
                    ])
                },
                onDisconnect: { [weak self] deviceId in
                    self?.emitOrBuffer(name: "disconnected", body: ["deviceId": deviceId])
                },
                onConnected: { [weak self] deviceId, deviceName in
                    self?.emitOrBuffer(name: "connected", body: [
                        "deviceId": deviceId,
                        "deviceName": deviceName ?? ""
                    ])
                }
            )
        }

        OnDestroy {
            BoardBleManager.shared.setEventHandlers(onScanResult: nil, onDisconnect: nil, onConnected: nil)
        }

        OnStartObserving {
            self.bufferQueue.sync {
                self.hasListener = true
            }
            self.drainPendingEvents()
        }

        OnStopObserving {
            self.bufferQueue.sync {
                self.hasListener = false
            }
        }

        AsyncFunction("isAvailable") { () -> [String: Any] in
            return ["available": BoardBleManager.shared.isAvailable]
        }

        AsyncFunction("startScan") { (services: [String]?, promise: Promise) in
            BoardBleManager.shared.startScan(serviceUuids: services ?? []) { result in
                switch result {
                case .success:
                    promise.resolve(nil)
                case .failure(let error):
                    self.logger.error("BLE scan failed: \(error.localizedDescription, privacy: .public)")
                    promise.reject("BLE_SCAN_FAILED", error.localizedDescription)
                }
            }
        }

        AsyncFunction("stopScan") { () -> Void in
            BoardBleManager.shared.stopScan()
        }

        AsyncFunction("connect") { (deviceId: String, promise: Promise) in
            guard !deviceId.isEmpty else {
                promise.reject("BLE_BAD_ARG", "Missing required parameter: deviceId")
                return
            }
            BoardBleManager.shared.connect(deviceId: deviceId) { result in
                switch result {
                case .success:
                    promise.resolve(nil)
                case .failure(let error):
                    self.logger.error("BLE connect failed: \(error.localizedDescription, privacy: .public)")
                    promise.reject("BLE_CONNECT_FAILED", error.localizedDescription)
                }
            }
        }

        AsyncFunction("disconnect") { (promise: Promise) in
            BoardBleManager.shared.disconnect {
                promise.resolve(nil)
            }
        }

        AsyncFunction("write") { (value: String, promise: Promise) in
            guard !value.isEmpty else {
                promise.reject("BLE_BAD_ARG", "Missing required parameter: value")
                return
            }
            BoardBleManager.shared.write(hex: value) { result in
                switch result {
                case .success:
                    promise.resolve(nil)
                case .failure(let error):
                    self.logger.error("BLE write failed: \(error.localizedDescription, privacy: .public)")
                    promise.reject("BLE_WRITE_FAILED", error.localizedDescription)
                }
            }
        }

        AsyncFunction("cancelWrites") { () -> Void in
            BoardBleManager.shared.cancelWrites()
        }

        // Presence of this function doubles as the JS feature gate for the
        // newer native surface (unfiltered scanning, the `connected` event,
        // connection adoption) — see BoardBleNativeModule in src/index.ts.
        AsyncFunction("getConnectedDevice") { () -> [String: Any]? in
            guard let device = BoardBleManager.shared.connectedDeviceInfo else { return nil }
            return [
                "deviceId": device.deviceId,
                "name": device.name ?? ""
            ]
        }

        AsyncFunction("configureBoard") { (options: ConfigureBoardOptions) -> Void in
            BoardBleManager.shared.configure(
                BoardBleConfiguration(
                    boardName: options.boardName,
                    layoutId: options.layoutId,
                    sizeId: options.sizeId,
                    apiLevel: options.apiLevel,
                    deviceName: options.deviceName,
                    colorOverrides: options.colorOverrides ?? [:]
                )
            )
        }
    }

    private func emitOrBuffer(name: String, body: [String: Any]) {
        bufferQueue.sync {
            pendingEvents.append(PendingEvent(name: name, body: body))
            // Cap buffer growth in case the JS layer never attaches.
            // Scan results are the only high-volume event and they're
            // safely discarded if old.
            if pendingEvents.count > 200 {
                pendingEvents.removeFirst(pendingEvents.count - 200)
            }
        }
        drainPendingEvents()
    }

    /// Sends buffered events FIFO while a listener is attached. `sendEvent`
    /// runs OUTSIDE `bufferQueue` so a synchronously re-entrant emission can
    /// never deadlock the serial queue; `isDraining` keeps the drain
    /// single-flight so concurrent callers can't interleave events out of
    /// order.
    private func drainPendingEvents() {
        while true {
            let next: PendingEvent? = bufferQueue.sync {
                guard hasListener, !isDraining, !pendingEvents.isEmpty else { return nil }
                isDraining = true
                return pendingEvents.removeFirst()
            }
            guard let next else { return }
            sendEvent(next.name, next.body)
            let hasMore: Bool = bufferQueue.sync {
                isDraining = false
                return hasListener && !pendingEvents.isEmpty
            }
            if !hasMore { return }
        }
    }
}

/// Argument record for `configureBoard`. Keys mirror the Capacitor
/// `BoardBlePlugin.configureBoard` shape one-for-one.
struct ConfigureBoardOptions: Record {
    @Field var boardName: String = ""
    @Field var layoutId: Int = 0
    @Field var sizeId: Int = 0
    @Field var apiLevel: Int?
    @Field var deviceName: String?
    @Field var colorOverrides: [String: String]?
}
