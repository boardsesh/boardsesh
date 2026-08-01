import CoreBluetooth
import Foundation

/// The slice of `CBPeripheral` the write flow-control path uses (#3366).
/// `CBPeripheral` conforms via an empty extension — zero behavior change; the
/// seam exists only so tests can inject a fake peripheral without standing up a
/// real CoreBluetooth stack.
protocol WritableBlePeripheral: AnyObject {
    var identifier: UUID { get }
    var name: String? { get }
    var canSendWriteWithoutResponse: Bool { get }
    func maximumWriteValueLength(for type: CBCharacteristicWriteType) -> Int
    func writeValue(_ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType)
}

extension CBPeripheral: WritableBlePeripheral {}

/// One-shot cancellable timer. Production wraps a `DispatchWorkItem` scheduled
/// via `queue.asyncAfter`; `cancel()` forwards to the work item's `cancel()`.
protocol BleOneShotTimer: AnyObject {
    func cancel()
}

/// Repeating timer mirroring `DispatchSourceTimer`'s lifecycle
/// (`setEventHandler` → `schedule` → `activate`; `cancel`). `AnyObject` so the
/// `===` identity guard behind the write-resume poller keeps working.
protocol BleRepeatingTimer: AnyObject {
    func setEventHandler(_ handler: @escaping () -> Void)
    func schedule(interval: TimeInterval, leeway: DispatchTimeInterval)
    func activate()
    func cancel()
}

/// Factory for the write flow-control timers. Production hands back GCD-backed
/// timers scheduled on the BLE queue; tests hand back fakes they fire inline.
protocol BleTimerScheduling: AnyObject {
    /// `label` names the call site (including "connectTimeout",
    /// "managerCancellationBarrierWatchdog", "writeResumeWatchdog",
    /// "chunkDelay", "writeAckWatchdog", and
    /// "writeStallRecoveryWatchdog"); tests key on it.
    func scheduleOneShot(after delay: TimeInterval, label: String, _ handler: @escaping () -> Void) -> BleOneShotTimer
    func makeRepeatingTimer() -> BleRepeatingTimer
}

/// Production scheduler: wraps GCD exactly as the pre-#3366 inline code did, so
/// swapping the manager's timer construction onto this seam is byte-for-byte
/// behavior-preserving.
///
/// - one-shot: `DispatchWorkItem(block: handler)` scheduled with
///   `queue.asyncAfter(deadline: .now() + delay, execute:)`; `cancel()` →
///   `workItem.cancel()`.
/// - repeating: a `DispatchSource.makeTimerSource(queue:)` whose
///   `setEventHandler` / `activate` / `cancel` are forwarded 1:1, and whose
///   `schedule(interval:leeway:)` maps to
///   `timer.schedule(deadline: .now() + interval, repeating: interval, leeway:)`.
final class DispatchBleTimerScheduler: BleTimerScheduling {
    private let queue: DispatchQueue

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func scheduleOneShot(after delay: TimeInterval, label _: String, _ handler: @escaping () -> Void) -> BleOneShotTimer {
        let workItem = DispatchWorkItem(block: handler)
        queue.asyncAfter(deadline: .now() + delay, execute: workItem)
        return DispatchBleOneShotTimer(workItem: workItem)
    }

    func makeRepeatingTimer() -> BleRepeatingTimer {
        DispatchBleRepeatingTimer(timer: DispatchSource.makeTimerSource(queue: queue))
    }
}

private final class DispatchBleOneShotTimer: BleOneShotTimer {
    private let workItem: DispatchWorkItem

    init(workItem: DispatchWorkItem) {
        self.workItem = workItem
    }

    func cancel() {
        workItem.cancel()
    }
}

private final class DispatchBleRepeatingTimer: BleRepeatingTimer {
    private let timer: DispatchSourceTimer

    init(timer: DispatchSourceTimer) {
        self.timer = timer
    }

    func setEventHandler(_ handler: @escaping () -> Void) {
        timer.setEventHandler(handler: handler)
    }

    func schedule(interval: TimeInterval, leeway: DispatchTimeInterval) {
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: leeway)
    }

    func activate() {
        timer.activate()
    }

    func cancel() {
        timer.cancel()
    }
}
