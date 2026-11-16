import Foundation

/// A scheduled idle timer counts as pending work. Cancellation retires an
/// unstarted timer immediately; running work drains only at its actual end.
final class ClimbOverlayPacketJob {
  private let lock = NSLock()
  private var started = false
  private var ended = false
  private var cancelled = false
  private let onEnd: () -> Void
  init(onEnd: @escaping () -> Void) { self.onEnd = onEnd }
  func start() -> Bool {
    lock.lock();defer { lock.unlock() }
    guard !ended,!cancelled else { return false }
    started = true;return true
  }
  func cancel() {
    lock.lock();cancelled = true
    let finish = !started && !ended
    if finish { ended = true }
    lock.unlock();if finish { onEnd() }
  }
  func finish() {
    lock.lock();let finish = !ended;ended = true;lock.unlock()
    if finish { onEnd() }
  }
}
