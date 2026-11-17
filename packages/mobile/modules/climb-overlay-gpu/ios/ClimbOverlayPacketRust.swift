import Foundation
import CryptoKit
import BoardRendererModule

private enum ClimbOverlayRustContract {
  static let validation: Result<Void,Error> = Result {
    guard board_renderer_gpu_packet_api_version() == ClimbOverlayPacketLayout.packetVersion else {
      throw ClimbOverlayPacketFailure.rejected(reason: "gpu-contract-unsupported",scope: "static")
    }
    var output = AuraGpuBytes()
    let status = board_renderer_gpu_packet_contract(&output)
    let owner = ClimbOverlayRustBytes(output)
    try checkClimbOverlayPacketStatus(status,staticConfig: true)
    guard owner.count > 0,owner.count <= 64*1024 else {
      throw ClimbOverlayPacketFailure.rejected(reason: "gpu-contract-unsupported",scope: "static")
    }
    let hash = owner.withBytes { SHA256.hash(data: Data($0)).map { String(format: "%02x",$0) }.joined() }
    guard hash == ClimbOverlayPacketLayout.contractSha256 else {
      throw ClimbOverlayPacketFailure.rejected(reason: "gpu-contract-unsupported",scope: "static")
    }
  }
}

final class ClimbOverlayRustHandle {
  private(set) var id: UInt64
  init(_ id: UInt64) { self.id = id }
  deinit { board_renderer_gpu_handle_close(id) }
  func close() { board_renderer_gpu_handle_close(id);id = 0 }
}

final class ClimbOverlayRustCancellation {
  let handle: ClimbOverlayRustHandle
  init() throws {
    var id: UInt64 = 0
    try checkClimbOverlayPacketStatus(board_renderer_gpu_cancel_create(&id))
    handle = ClimbOverlayRustHandle(id)
  }
  func cancel() { board_renderer_gpu_cancel(handle.id) }
}

final class ClimbOverlayRustBytes {
  let pointer: UnsafeMutablePointer<UInt8>?
  let count: Int
  init(_ bytes: AuraGpuBytes) { pointer = bytes.pointer;count = Int(bytes.length) }
  deinit { board_renderer_free(pointer,UInt32(count)) }
  func withBytes<T>(_ action: (UnsafeRawBufferPointer) throws -> T) rethrows -> T {
    try action(UnsafeRawBufferPointer(start: pointer,count: count))
  }
  func header<T: Decodable>(_ type: T.Type, maximum: Int) throws -> T {
    guard count > 0,count <= maximum,let pointer else { throw ClimbOverlayPacketFailure.rejected(reason: "frame-packet-invalid",scope: "frame") }
    let decoder = JSONDecoder();decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(type,from: Data(bytes: pointer,count: count))
  }
}

/// Owns new metadata IDs independently from JSON decoding/adoption. The typed
/// u64 list remains intact until each successful arena adoption zeros its ID.
final class ClimbOverlayRustChunks {
  let header: ClimbOverlayRustBytes
  let pixels: ClimbOverlayRustBytes
  private let handles: ClimbOverlayRustBytes
  init(_ output: AuraGpuChunks) { header = ClimbOverlayRustBytes(output.header);pixels = ClimbOverlayRustBytes(output.pixels);handles = ClimbOverlayRustBytes(output.handles) }
  deinit {
    handles.withBytes { ids in
      guard ids.count % 8 == 0,ids.count <= 769*8 else { return }
      for offset in stride(from: 0,to: ids.count,by: 8) { board_renderer_gpu_handle_close(ids.loadUnaligned(fromByteOffset: offset,as: UInt64.self).littleEndian) }
    }
  }
  func validateHandles(_ chunks: [ClimbOverlayChunkHeader.Chunk]) throws {
    guard handles.count == chunks.count*8,chunks.count <= 769 else { throw ClimbOverlayArenaFailure.invalid }
    try handles.withBytes { ids in
      var seen = Set<UInt64>()
      for (index,chunk) in chunks.enumerated() {
        let id = ids.loadUnaligned(fromByteOffset: index*8,as: UInt64.self).littleEndian
        guard id > 0,id == chunk.handle,seen.insert(id).inserted else { throw ClimbOverlayArenaFailure.invalid }
      }
    }
  }
  func takeMetadata(_ id: UInt64) throws -> ClimbOverlayRustHandle {
    guard let pointer = handles.pointer,handles.count % 8 == 0 else { throw ClimbOverlayArenaFailure.invalid }
    for offset in stride(from: 0,to: handles.count,by: 8) {
      let address = UnsafeMutableRawPointer(pointer.advanced(by: offset))
      if address.loadUnaligned(as: UInt64.self).littleEndian == id {
        let lease = ClimbOverlayRustHandle(id)
        for byte in 0..<8 { pointer[offset+byte] = 0 }
        return lease
      }
    }
    throw ClimbOverlayArenaFailure.invalid
  }
}

final class ClimbOverlayRustSession {
  let source: String
  let handle: ClimbOverlayRustHandle
  init(source: String, cancel: ClimbOverlayRustCancellation) throws {
    try ClimbOverlayRustContract.validation.get()
    guard source.utf8.count <= 8*1024*1024 else { throw ClimbOverlayPacketFailure.rejected(reason: "gpu-config-unsupported",scope: "static") }
    let bytes = Data(source.utf8)
    var id: UInt64 = 0
    let status = bytes.withUnsafeBytes { board_renderer_gpu_session_create($0.bindMemory(to: UInt8.self).baseAddress,UInt32(bytes.count),cancel.handle.id,&id) }
    try checkClimbOverlayPacketStatus(status,staticConfig: true)
    self.source = source;handle = ClimbOverlayRustHandle(id)
    if let directory = FileManager.default.urls(for: .cachesDirectory,in: .userDomainMask).first?.appendingPathComponent("aura-lazy-v1") {
      let path = Data(directory.path.utf8)
      // Optional acceleration: failure never changes rendering or readiness.
      _ = path.withUnsafeBytes { board_renderer_gpu_session_set_cache_directory(id,$0.bindMemory(to: UInt8.self).baseAddress,UInt32(path.count)) }
    }
  }
  func persistAfterReady() { _ = board_renderer_gpu_session_schedule_persist(handle.id) }
  func plan(_ request: ClimbOverlaySourceRequest,cancel: ClimbOverlayRustCancellation) throws -> (ClimbOverlayRustHandle,ClimbOverlayPlanHeader) {
    let encoder = JSONEncoder();encoder.keyEncodingStrategy = .convertToSnakeCase
    let bytes = try encoder.encode(request)
    var output = AuraGpuPlan()
    let status = bytes.withUnsafeBytes { board_renderer_gpu_plan_create(handle.id,$0.bindMemory(to: UInt8.self).baseAddress,UInt32(bytes.count),cancel.handle.id,&output) }
    let owner = ClimbOverlayRustBytes(output.header)
    let plan = ClimbOverlayRustHandle(output.handle)
    try checkClimbOverlayPacketStatus(status)
    let header = try owner.header(ClimbOverlayPlanHeader.self,maximum: 256*1024)
    try header.validate()
    return (plan,header)
  }
}

func prepareClimbOverlayRustChunks(plan: UInt64,resident: [UInt64],cancel: ClimbOverlayRustCancellation) throws -> ClimbOverlayRustChunks {
  let bytes = try JSONSerialization.data(withJSONObject: ["chunks":resident])
  var output = AuraGpuChunks()
  let status = bytes.withUnsafeBytes { board_renderer_gpu_plan_prepare(plan,$0.bindMemory(to: UInt8.self).baseAddress,UInt32(bytes.count),cancel.handle.id,&output) }
  let owner = ClimbOverlayRustChunks(output)
  try checkClimbOverlayPacketStatus(status)
  return owner
}

struct ClimbOverlayEncodedPacket {
  let handle: ClimbOverlayRustHandle
  let header: ClimbOverlayPacketHeader
  let descriptors: ClimbOverlayRustBytes
  let resources: ClimbOverlayRustBytes
}
func encodeClimbOverlayRustPacket(plan: UInt64,capacity: Int,placements: [ClimbOverlayChunkRecord],cancel: ClimbOverlayRustCancellation) throws -> ClimbOverlayEncodedPacket {
  let bytes = try JSONSerialization.data(withJSONObject: ["arena_bytes":capacity,"chunks":placements.map { ["key":$0.key,"offset":$0.offset,"bytes":$0.bytes] }])
  var output = AuraGpuPacket()
  let status = bytes.withUnsafeBytes { board_renderer_gpu_plan_encode(plan,$0.bindMemory(to: UInt8.self).baseAddress,UInt32(bytes.count),cancel.handle.id,&output) }
  let handle = ClimbOverlayRustHandle(output.handle)
  let header = ClimbOverlayRustBytes(output.header)
  let descriptors = ClimbOverlayRustBytes(output.descriptors)
  let resources = ClimbOverlayRustBytes(output.resources)
  try checkClimbOverlayPacketStatus(status)
  return ClimbOverlayEncodedPacket(handle: handle,header: try header.header(ClimbOverlayPacketHeader.self,maximum: 64*1024),descriptors: descriptors,resources: resources)
}
