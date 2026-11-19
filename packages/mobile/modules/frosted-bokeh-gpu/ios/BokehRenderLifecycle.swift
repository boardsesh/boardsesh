import Foundation

/// Accessed on main only. Compiling a resource never holds up a caller that
/// checks its result; concurrent views share the same background preparation.
final class BokehAsyncResource<Resource> {
  private(set) var result: Result<Resource, Error>?
  private var started = false
  private var listeners: [() -> Void] = []
  private let prepare: () throws -> Resource
  private let work = DispatchQueue(label: "com.boardsesh.frosted-bokeh-prepare", qos: .userInitiated)

  init(prepare: @escaping () throws -> Resource) { self.prepare = prepare }

  func load(onReady: @escaping () -> Void) {
    precondition(Thread.isMainThread)
    if result != nil { onReady(); return }
    listeners.append(onReady)
    guard !started else { return }
    started = true
    work.async { [self] in
      let completed = Result { try prepare() }
      DispatchQueue.main.async { [self] in
        result = completed
        let ready = listeners
        listeners.removeAll()
        ready.forEach { $0() }
      }
    }
  }
}

/// A late completion from a detached/backgrounded surface cannot fail its
/// replacement. One accepted failure stops submissions until JS unmounts it.
struct BokehRenderLifecycle {
  private(set) var generation: UInt64 = 0
  private(set) var active = false
  private(set) var failed = false

  mutating func setActive(_ next: Bool) {
    guard active != next else { return }
    generation &+= 1
    active = next
  }

  mutating func fail(generation submitted: UInt64) -> Bool {
    guard active, !failed, submitted == generation else { return false }
    failed = true
    return true
  }
}
