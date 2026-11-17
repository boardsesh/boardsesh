import Foundation

enum ClimbOverlayPacketFailure: Error {
  case cancelled
  case rejected(reason: String, scope: String)
  var event: (String,String)? {
    switch self { case .cancelled: return nil; case .rejected(let reason,let scope): return (reason,scope) }
  }
}

func checkClimbOverlayPacketStatus(_ status: Int32, staticConfig: Bool = false) throws {
  switch Int(status) {
  case ClimbOverlayPacketLayout.statusesSuccess: return
  case ClimbOverlayPacketLayout.statusesCancelled,ClimbOverlayPacketLayout.statusesClosed:
    throw ClimbOverlayPacketFailure.cancelled
  case ClimbOverlayPacketLayout.statusesResourcePressure:
    throw ClimbOverlayPacketFailure.rejected(reason: "gpu-resource-limit",scope: "context")
  case ClimbOverlayPacketLayout.statusesInternalPanic:
    throw ClimbOverlayPacketFailure.rejected(reason: "gpu-internal-failure",scope: "context")
  default:
    throw ClimbOverlayPacketFailure.rejected(reason: staticConfig ? "gpu-config-unsupported" : "frame-packet-invalid",
      scope: staticConfig ? "static" : "frame")
  }
}

struct ClimbOverlayPlanHeader: Decodable {
  let version: Int
  let contractSha256: String
  let sessionKey: String
  let counts: [Int]
  let present: [Bool]
  let chunks: [String]
  func validate() throws {
    guard version == ClimbOverlayPacketLayout.packetVersion,contractSha256 == ClimbOverlayPacketLayout.contractSha256,
      counts.count == 3,present.count == 3,present[0],counts.allSatisfy({ $0 >= 0 && $0 <= ClimbOverlayPacketLayout.maxActivePerSource }),
      chunks.count <= 769,Set(chunks).count == chunks.count,
      chunks.allSatisfy({ $0.utf8.count == 64 && $0.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) }) else {
      throw ClimbOverlayPacketFailure.rejected(reason: "frame-packet-invalid",scope: "frame")
    }
  }
}
struct ClimbOverlayChunkHeader: Decodable {
  struct Chunk: Decodable { let handle: UInt64;let key: String;let bytes: Int;let sourceOffset: Int }
  let version: Int
  let pixelBytes: Int
  let chunks: [Chunk]
}
struct ClimbOverlayPacketHeader: Decodable {
  struct Scene: Decodable { let offset: Int;let bytes: Int;let count: Int;let maxReach: Float;let stampLayers: UInt32;let tileDirectory: UInt32 }
  let version: Int
  let contractSha256: String
  let width: Int
  let height: Int
  let scenes: [Scene]
  let present: [Bool]
  let currentRoles: [[UInt32]]
  let changedCount: Int
  let columns: Int
  let tileEdge: Int
  let descriptorBytes: Int
  let uniformBytes: Int
}

struct ClimbOverlaySourceRequest: Encodable {
  let current: String?
  let previous: String?
  let next: String?
  let editBaseline: [[UInt32]]?
  let strict = true
}

extension ClimbOverlayPacketHeader {
  func validate(descriptorPayloadBytes: Int,resourcePayloadBytes: Int) throws {
    let header = self
    guard header.width > 0,header.width <= 1536,header.height > 0,header.height <= 2304 else {
      throw ClimbOverlayPacketFailure.rejected(reason: "frame-packet-invalid",scope: "frame")
    }
    let columns = (header.width+ClimbOverlayPacketLayout.tileEdge-1)/ClimbOverlayPacketLayout.tileEdge
    let rows = (header.height+ClimbOverlayPacketLayout.tileEdge-1)/ClimbOverlayPacketLayout.tileEdge
    guard header.version == ClimbOverlayPacketLayout.packetVersion,header.contractSha256 == ClimbOverlayPacketLayout.contractSha256,
      header.width > 0,header.width <= 1536,header.height > 0,header.height <= 2304,
      header.tileEdge == ClimbOverlayPacketLayout.tileEdge,header.columns == columns,
      header.descriptorBytes == ClimbOverlayPacketLayout.descriptorBytes,header.uniformBytes == ClimbOverlayPacketLayout.uniformBytes,
      header.scenes.count == 3,header.present.count == 3,header.present[0],
      descriptorPayloadBytes <= 3*(ClimbOverlayPacketLayout.maxActivePerSource+1)*ClimbOverlayPacketLayout.descriptorBytes,
      resourcePayloadBytes >= ClimbOverlayPacketLayout.lutWords*4,resourcePayloadBytes <= 8*1024*1024,resourcePayloadBytes % 4 == 0,
      header.changedCount >= 0,header.changedCount <= header.scenes[0].count,
      header.currentRoles.count <= header.scenes[0].count,header.currentRoles.allSatisfy({ $0.count == 2 }) else {
      throw ClimbOverlayPacketFailure.rejected(reason: "frame-packet-invalid",scope: "frame")
    }
    for scene in header.scenes {
      guard scene.count >= 0,scene.count <= ClimbOverlayPacketLayout.maxActivePerSource,
        scene.bytes == max(1,scene.count)*ClimbOverlayPacketLayout.descriptorBytes,scene.offset >= 0,scene.offset % 16 == 0,
        scene.offset <= descriptorPayloadBytes,scene.bytes <= descriptorPayloadBytes-scene.offset,
        scene.maxReach.isFinite,scene.maxReach >= 0,scene.maxReach <= 512,scene.stampLayers <= 15,
        scene.tileDirectory >= ClimbOverlayPacketLayout.lutWords,
        UInt64(scene.tileDirectory)+UInt64(columns*rows*2) <= UInt64(resourcePayloadBytes/4) else {
        throw ClimbOverlayPacketFailure.rejected(reason: "frame-packet-invalid",scope: "frame")
      }
    }
  }

}

func climbOverlayPacketDrained(before: UInt64,after: UInt64,nativeJobs: Int,gpuCommands: Int,rustDrained: Bool) -> Bool {
  before == after && nativeJobs == 0 && gpuCommands == 0 && rustDrained
}
