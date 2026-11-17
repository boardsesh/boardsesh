import Foundation
@main enum ClimbOverlayPacketJobTests {
  static func main() {
    var ended = 0
    let timer = ClimbOverlayPacketJob { ended += 1 }
    timer.cancel();timer.cancel();precondition(!timer.start());timer.finish();precondition(ended == 1)
    let running = ClimbOverlayPacketJob { ended += 1 }
    precondition(running.start());running.cancel();precondition(ended == 1)
    running.finish();running.finish();precondition(ended == 2)
    print("Swift packet jobs: cancelled timers and actual running-work drain passed")
  }
}
