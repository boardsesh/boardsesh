import Foundation
import BoardRendererModule

/// Includes cache-only/cancelled work. Independent of Ready-event delivery.
enum ClimbOverlayPacketMetrics {
  private static let lock = NSLock()
  private static var epoch: UInt64 = 0
  private static var pending = 0
  private static var pendingGPU = 0
  private static var uploads: UInt64 = 0
  private static var copies: UInt64 = 0
  private static var prefetch: UInt64 = 0
  private static var growths: UInt64 = 0
  private static var contextResets: UInt64 = 0
  static func begin() { lock.lock();pending += 1;epoch &+= 1;lock.unlock() }
  static func end() { lock.lock();pending -= 1;epoch &+= 1;lock.unlock() }
  static func gpuBegin() { lock.lock();pendingGPU += 1;epoch &+= 1;lock.unlock() }
  static func gpuEnd() { lock.lock();pendingGPU -= 1;precondition(pendingGPU >= 0);epoch &+= 1;lock.unlock() }
  static func uploaded(_ bytes: Int,prefetch only: Bool) {
    lock.lock();uploads &+= UInt64(bytes);if only { prefetch &+= UInt64(bytes) };epoch &+= 1;lock.unlock()
  }
  static func copied(_ bytes: Int,prefetch only: Bool) {
    lock.lock();copies &+= UInt64(bytes);if only { prefetch &+= UInt64(bytes) };epoch &+= 1;lock.unlock()
  }
  static func replaced() { lock.lock();growths &+= 1;epoch &+= 1;lock.unlock() }
  static func resetContext() { lock.lock();contextResets &+= 1;epoch &+= 1;lock.unlock() }
  static func snapshot() -> [String: Any] {
    lock.lock();defer { lock.unlock() }
    return ["available":true,"nativeActivityEpoch":epoch,"pendingNativeJobs":pending,"pendingGpuCommands":pendingGPU,
      "cpuToGpuPixelUploadBytes":uploads,"gpuArenaCopyBytes":copies,"gpuPixelUploadBytes":uploads+copies,
      "prefetchPixelUploadBytes":prefetch,"arenaReplacements":growths,"contextResets":contextResets]
  }
}


func climbOverlayPacketResourceStats() throws -> [String: Any] {
  let before = ClimbOverlayPacketMetrics.snapshot()
  var output = AuraGpuBytes()
  let status = board_renderer_gpu_packet_stats(&output)
  let owner = ClimbOverlayRustBytes(output)
  try checkClimbOverlayPacketStatus(status)
  let rust = try owner.withBytes { bytes -> [String: Any] in
    guard bytes.count > 0,bytes.count <= 16384,
      let result = try JSONSerialization.jsonObject(with: Data(bytes)) as? [String: Any],
      result["version"] as? Int == 1,result["available"] as? Bool == true else { throw ClimbOverlayArenaFailure.invalid }
    return result
  }
  var result = ClimbOverlayPacketMetrics.snapshot()
  result["statsVersion"] = 1
  result["rust"] = rust
  result["gpuReservedBytes"] = climbOverlayAggregateBudget.bytes
  result["drained"] = climbOverlayPacketDrained(before: before["nativeActivityEpoch"] as! UInt64,
    after: result["nativeActivityEpoch"] as! UInt64,nativeJobs: result["pendingNativeJobs"] as! Int,
    gpuCommands: result["pendingGpuCommands"] as! Int,rustDrained: rust["drained"] as? Bool == true)
  return result
}
