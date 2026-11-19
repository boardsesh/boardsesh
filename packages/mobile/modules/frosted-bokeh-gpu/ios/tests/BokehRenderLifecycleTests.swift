import Foundation

@main enum BokehRenderLifecycleTests {
  static func pump(until finished: () -> Bool) {
    let deadline = Date().addingTimeInterval(5)
    while !finished() && Date() < deadline {
      _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    precondition(finished(), "main-queue completion did not arrive")
  }

  static func main() {
    // A deliberately blocked compiler cannot block load() or result reads.
    let compilerStarted = DispatchSemaphore(value: 0)
    let finishCompilation = DispatchSemaphore(value: 0)
    var preparations = 0
    let resource = BokehAsyncResource<Int> {
      precondition(!Thread.isMainThread)
      preparations += 1
      compilerStarted.signal()
      precondition(finishCompilation.wait(timeout: .now() + 5) == .success)
      return 42
    }
    var callbacks = 0
    var newestProps = "old climb"
    var appliedProps: [String] = []
    func ready() {
      precondition(Thread.isMainThread)
      precondition(try! resource.result!.get() == 42)
      callbacks += 1
      appliedProps.append(newestProps)
    }
    resource.load(onReady: ready)
    precondition(compilerStarted.wait(timeout: .now() + 5) == .success)
    resource.load(onReady: ready)
    precondition(resource.result == nil && callbacks == 0)
    newestProps = "latest climb"
    finishCompilation.signal()
    pump { callbacks == 2 }
    precondition(preparations == 1 && appliedProps == ["latest climb", "latest climb"])
    resource.load(onReady: ready)
    precondition(callbacks == 3 && preparations == 1)

    // A rejected compile is cached too: each view can fall back without retry storms.
    enum Rejected: Error { case compiler }
    let rejected = BokehAsyncResource<Int> { throw Rejected.compiler }
    var rejectionCallbacks = 0
    rejected.load { rejectionCallbacks += 1 }
    pump { rejectionCallbacks == 1 }
    guard case .failure(let failure)? = rejected.result, failure is Rejected else {
      preconditionFailure("compile rejection was not published")
    }
    rejected.load { rejectionCallbacks += 1 }
    precondition(rejectionCallbacks == 2)

    // Commands may complete after background/detach and after a new surface attaches.
    var lifecycle = BokehRenderLifecycle()
    lifecycle.setActive(true)
    let oldCommand = lifecycle.generation
    lifecycle.setActive(false)
    precondition(!lifecycle.fail(generation: oldCommand) && !lifecycle.failed)
    lifecycle.setActive(true)
    precondition(!lifecycle.fail(generation: oldCommand) && !lifecycle.failed)
    let currentCommand = lifecycle.generation
    lifecycle.setActive(true)
    precondition(lifecycle.generation == currentCommand)
    precondition(lifecycle.fail(generation: currentCommand) && lifecycle.failed)
    precondition(!lifecycle.fail(generation: currentCommand))
    lifecycle.setActive(false)
    lifecycle.setActive(true)
    precondition(lifecycle.failed && !lifecycle.fail(generation: lifecycle.generation))

    // Views waiting on shared compilation are not retained by their callback.
    final class WaitingView {}
    var waitingView: WaitingView? = WaitingView()
    let releaseWorker = DispatchSemaphore(value: 0)
    let abandoned = BokehAsyncResource<Int> {
      precondition(releaseWorker.wait(timeout: .now() + 5) == .success)
      return 1
    }
    var abandonedReady = false
    abandoned.load { [weak waitingView] in
      precondition(waitingView == nil)
      abandonedReady = true
    }
    waitingView = nil
    releaseWorker.signal()
    pump { abandonedReady }
    print("PASS bokeh async compilation and command lifecycle")
  }
}
