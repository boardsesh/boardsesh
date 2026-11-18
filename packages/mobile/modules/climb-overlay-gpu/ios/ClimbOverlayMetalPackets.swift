import Foundation
import Metal
import QuartzCore
import UIKit
import BoardRendererModule

final class ClimbOverlayMetalArena {
  let pixels: MTLBuffer
  let reservation: ClimbOverlayBudget.Reservation
  init(pixels: MTLBuffer,reservation: ClimbOverlayBudget.Reservation) { self.pixels = pixels;self.reservation = reservation }
}

final class ClimbOverlayMetalPins {
  let arena: ClimbOverlayMetalArena
  private let keys: [String]
  private let epoch: UInt64
  init(arena: ClimbOverlayMetalArena,keys: [String],epoch: UInt64) { self.arena = arena;self.keys = keys;self.epoch = epoch }
  deinit {
    let keys = keys,epoch = epoch
    climbOverlayGPUWorkQueue.async { try? ClimbOverlayMetalPackets.index.release(keys,epoch: epoch) }
  }
}

final class ClimbOverlayMetalPacket {
  let rust: ClimbOverlayRustHandle
  let session: ClimbOverlayRustSession
  let header: ClimbOverlayPacketHeader
  let descriptors: [MTLBuffer]
  let resources: MTLBuffer
  let uniformBuffers: [MTLBuffer]
  private let uniformLock = NSLock()
  private var uniformInUse = [Bool](repeating: false,count: 3)
  let reservation: ClimbOverlayBudget.Reservation
  let pins: ClimbOverlayMetalPins
  let prepareMs: Double
  let uploadMs: Double
  let uploadBytes: Int
  let copiedBytes: Int
  let selectedBytes: Int
  var cacheHit: Bool { uploadBytes == 0 && copiedBytes == 0 }
  init(rust: ClimbOverlayRustHandle,session: ClimbOverlayRustSession,header: ClimbOverlayPacketHeader,
       descriptors: [MTLBuffer],resources: MTLBuffer,uniformBuffers: [MTLBuffer],reservation: ClimbOverlayBudget.Reservation,
       pins: ClimbOverlayMetalPins,prepareMs: Double,uploadMs: Double,uploadBytes: Int,copiedBytes: Int,selectedBytes: Int) {
    self.rust = rust;self.session = session;self.header = header;self.descriptors = descriptors;self.resources = resources
    self.uniformBuffers = uniformBuffers;self.reservation = reservation;self.pins = pins;self.prepareMs = prepareMs;self.uploadMs = uploadMs
    self.uploadBytes = uploadBytes;self.copiedBytes = copiedBytes;self.selectedBytes = selectedBytes
  }
  func acquireUniforms() -> Int? {
    uniformLock.lock();defer { uniformLock.unlock() }
    guard let slot = uniformInUse.firstIndex(of: false) else { return nil }
    uniformInUse[slot] = true;return slot
  }
  func releaseUniforms(_ slot: Int) { uniformLock.lock();uniformInUse[slot] = false;uniformLock.unlock() }
  /// Swap look only: a scene's holds as the look reads them, as the lower or
  /// the upper side of a pair (each side has its own membership number).
  /// Decoded on first use; read and written on the main thread only.
  private var swapLookScenes: [Int: ClimbOverlaySwapLook.Scene] = [:]
  func swapLookScene(slot: Int,upper: Bool) -> ClimbOverlaySwapLook.Scene {
    let cacheKey = slot*2+(upper ? 1 : 0)
    if let scene = swapLookScenes[cacheKey] { return scene }
    let count = header.scenes[slot].count
    let buffer = descriptors[slot]
    let holds = ClimbOverlaySwapLook.holds(
      descriptors: UnsafeRawBufferPointer(start: buffer.contents(),count: min(buffer.length,count*ClimbOverlayPacketLayout.descriptorBytes)),
      count: count,upper: upper,width: Float(header.width),height: Float(header.height))
    let scene = ClimbOverlaySwapLook.Scene(holds)
    swapLookScenes[cacheKey] = scene
    return scene
  }
  func uniforms(slot: Int,lower: Int,upper: Int,revealMode: Int = ClimbOverlayMotion.revealModeWipe,progress: Float,
                swap: ClimbOverlayMotion.SwapWeights = .init(lower: 1,upper: 0),pulse: Float,viewport: SIMD2<Float>,
                productionEmpty: Bool,mirrored: Bool) throws {
    let status = board_renderer_gpu_packet_shared_reveal_uniforms(rust.id,UInt32(lower),UInt32(upper),UInt32(revealMode),
      progress,swap.lower,swap.upper,swap.shared,pulse,viewport.x,viewport.y,productionEmpty ? 1 : 0,mirrored ? 1 : 0,
      uniformBuffers[slot].contents().assumingMemoryBound(to: UInt8.self),UInt32(ClimbOverlayPacketLayout.uniformBytes))
    try checkClimbOverlayPacketStatus(status)
  }
}

/// Geometry preparation, metadata ownership, placement and GPU copies are all
/// serialized here. Draws only read immutable packet/buffer generations.
enum ClimbOverlayMetalPackets {
  static let device = MTLCreateSystemDefaultDevice()
  static var pipeline: MTLRenderPipelineState?
  static var commands: MTLCommandQueue?
  static let index = ClimbOverlayArenaIndex()
  static var arena: ClimbOverlayMetalArena?
  private static var metadata: [String: ClimbOverlayRustHandle] = [:]
  private static var sessions: [String: (used: UInt64,session: ClimbOverlayRustSession)] = [:]
  private static var sessionClock: UInt64 = 0
  private static let budget = climbOverlayAggregateBudget
  private static let memoryObserver = NotificationCenter.default.addObserver(
    forName: UIApplication.didReceiveMemoryWarningNotification,object: nil,queue: nil
  ) { _ in climbOverlayGPUWorkQueue.async { releaseGPU() } }

  static func initialize() throws -> MTLDevice {
    _ = memoryObserver
    guard let device else { throw ClimbOverlayPacketFailure.rejected(reason: "gpu-device-unsupported",scope: "static") }
    guard ClimbOverlayBudget.limit == ClimbOverlayPacketLayout.maxGpuBytes else {
      throw ClimbOverlayPacketFailure.rejected(reason: "gpu-contract-unsupported",scope: "static")
    }
    if pipeline == nil {
      do {
        let library = try device.makeLibrary(source: ClimbOverlayShader.source,options: nil)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "overlay_vertex")
        descriptor.fragmentFunction = library.makeFunction(name: "overlay_fragment")
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
      } catch { throw ClimbOverlayPacketFailure.rejected(reason: "gpu-pipeline-unsupported",scope: "static") }
    }
    if commands == nil { commands = device.makeCommandQueue() }
    guard commands != nil else { throw ClimbOverlayPacketFailure.rejected(reason: "gpu-resource-limit",scope: "context") }
    return device
  }

  static func session(source: String,cancel: ClimbOverlayRustCancellation) throws -> ClimbOverlayRustSession {
    sessionClock &+= 1
    if let existing = sessions[source] { sessions[source] = (sessionClock,existing.session);return existing.session }
    if sessions.count >= 4,let oldest = sessions.min(by: { $0.value.used < $1.value.used }) { sessions.removeValue(forKey: oldest.key) }
    let session = try ClimbOverlayRustSession(source: source,cancel: cancel)
    sessions[source] = (sessionClock,session)
    return session
  }

  static func releaseGPU() {
    _ = index.reset()
    metadata.removeAll()
    arena = nil
    // CPU sessions/chunks survive. In-flight packets retain their real buffers
    // and budget reservations until their command completion handlers end.
  }

  private static func allocation(_ requested: Int,device: MTLDevice) throws -> Int {
    let estimate = device.heapBufferSizeAndAlign(length: requested,options: .storageModeShared)
    guard let bytes = ClimbOverlayBudget.allocationSize(requested: requested,heapSize: estimate.size,heapAlignment: estimate.align) else {
      throw ClimbOverlayPacketFailure.rejected(reason: "gpu-resource-limit",scope: "context")
    }
    return bytes
  }

  private static func newArena(_ capacity: Int,device: MTLDevice) throws -> ClimbOverlayMetalArena {
    let allocated = try allocation(capacity,device: device)
    guard let reservation = budget.reserve(allocated),let pixels = device.makeBuffer(length: capacity,options: .storageModeShared),
      pixels.allocatedSize <= allocated else { throw ClimbOverlayPacketFailure.rejected(reason: "gpu-resource-limit",scope: "context") }
    ClimbOverlayPacketMetrics.replaced()
    return ClimbOverlayMetalArena(pixels: pixels,reservation: reservation)
  }

  static func prepare(session: ClimbOverlayRustSession,request: ClimbOverlaySourceRequest,cancel: ClimbOverlayRustCancellation,
                      preparation: ClimbOverlayPreparation,cacheOnly: Bool = false) throws -> ClimbOverlayMetalPacket? {
    let started = CACurrentMediaTime()
    let device = try initialize()
    guard !preparation.isCancelled else { throw ClimbOverlayPacketFailure.cancelled }
    let (plan,description) = try session.plan(request,cancel: cancel)
    let resident = description.chunks.compactMap { metadata[$0]?.id }
    let owner = try prepareClimbOverlayRustChunks(plan: plan.id,resident: resident,cancel: cancel)
    let missing = try owner.header.header(ClimbOverlayChunkHeader.self,maximum: 256*1024)
    try owner.validateHandles(missing.chunks)
    guard missing.version == ClimbOverlayPacketLayout.packetVersion,missing.pixelBytes == owner.pixels.count,
      owner.pixels.count <= ClimbOverlayPacketLayout.maxGpuBytes else { throw ClimbOverlayArenaFailure.invalid }
    var acquired: [String: ClimbOverlayRustHandle] = [:]
    var newRecords: [ClimbOverlayChunkRecord] = []
    for chunk in missing.chunks {
      guard chunk.bytes >= 0,chunk.bytes % 4 == 0,chunk.sourceOffset >= 0,chunk.sourceOffset % 4 == 0,
        chunk.sourceOffset <= owner.pixels.count,chunk.bytes <= owner.pixels.count-chunk.sourceOffset,
        acquired[chunk.key] == nil,description.chunks.contains(chunk.key),metadata[chunk.key] == nil else { throw ClimbOverlayArenaFailure.invalid }
      acquired[chunk.key] = try owner.takeMetadata(chunk.handle)
      newRecords.append(ClimbOverlayChunkRecord(key: chunk.key,handle: chunk.handle,offset: 0,bytes: chunk.bytes))
    }
    let placement = try index.prepare(required: description.chunks,missing: newRecords)
    if cacheOnly && !missing.chunks.isEmpty && placement.capacity > ClimbOverlayArenaIndex.retainedTarget { throw ClimbOverlayPacketFailure.cancelled }
    let encoded = try encodeClimbOverlayRustPacket(plan: plan.id,capacity: placement.capacity,
      placements: description.chunks.map { placement.records[$0]! },cancel: cancel)
    try encoded.header.validate(descriptorPayloadBytes: encoded.descriptors.count,resourcePayloadBytes: encoded.resources.count)
    guard !preparation.isCancelled else { throw ClimbOverlayPacketFailure.cancelled }
    let target = try placement.replacement ? newArena(placement.capacity,device: device) : arena.unwrap()
    var descriptors: [MTLBuffer] = []
    var resources: MTLBuffer?
    var uniformBuffers: [MTLBuffer] = []
    var packetReservation: ClimbOverlayBudget.Reservation?
    if !cacheOnly {
      let amounts = try encoded.header.scenes.map { try allocation($0.bytes,device: device) } + [try allocation(encoded.resources.count,device: device)]
      let uniformAmount = try allocation(ClimbOverlayPacketLayout.uniformBytes,device: device)
      guard let reservation = budget.reserve(amounts.reduce(0,+)+3*uniformAmount) else { throw ClimbOverlayArenaFailure.pressure }
      packetReservation = reservation
      try encoded.descriptors.withBytes { bytes in
        for (slot,scene) in encoded.header.scenes.enumerated() {
          guard let pointer = bytes.baseAddress,let buffer = device.makeBuffer(bytes: pointer.advanced(by: scene.offset),length: scene.bytes,options: .storageModeShared),
            buffer.allocatedSize <= amounts[slot] else { throw ClimbOverlayArenaFailure.pressure }
          descriptors.append(buffer)
        }
      }
      resources = try encoded.resources.withBytes { bytes in
        guard let pointer = bytes.baseAddress,let buffer = device.makeBuffer(bytes: pointer,length: bytes.count,options: .storageModeShared),
          buffer.allocatedSize <= amounts[3] else { throw ClimbOverlayArenaFailure.pressure }
        return buffer
      }
    }
    if !cacheOnly {
      let uniformAmount = try allocation(ClimbOverlayPacketLayout.uniformBytes,device: device)
      for _ in 0..<3 {
        guard let buffer = device.makeBuffer(length: ClimbOverlayPacketLayout.uniformBytes,options: .storageModeShared),
          buffer.allocatedSize <= uniformAmount else { throw ClimbOverlayArenaFailure.pressure }
        uniformBuffers.append(buffer)
      }
    }
    var copied = 0
    let uploadStarted = CACurrentMediaTime()
    if placement.replacement,let previous = arena,!placement.copies.isEmpty {
      guard let command = commands?.makeCommandBuffer(),let blit = command.makeBlitCommandEncoder() else { throw ClimbOverlayArenaFailure.pressure }
      for copy in placement.copies {
        blit.copy(from: previous.pixels,sourceOffset: copy.source,to: target.pixels,destinationOffset: copy.destination,size: copy.bytes)
        copied += copy.bytes
      }
      blit.endEncoding();ClimbOverlayPacketMetrics.gpuBegin();command.commit();command.waitUntilCompleted();ClimbOverlayPacketMetrics.gpuEnd()
      ClimbOverlayPacketMetrics.copied(copied,prefetch: cacheOnly)
      guard command.status == .completed else { throw ClimbOverlayPacketFailure.rejected(reason: "gpu-command-failed",scope: "context") }
    }
    var patchedExisting = false
    do {
      try owner.pixels.withBytes { bytes in
        for chunk in missing.chunks where chunk.bytes > 0 {
          guard !preparation.isCancelled,let pointer = bytes.baseAddress else { throw ClimbOverlayPacketFailure.cancelled }
          patchedExisting = !placement.replacement
          let destination = placement.records[chunk.key]!.offset
          target.pixels.contents().advanced(by: destination).copyMemory(from: pointer.advanced(by: chunk.sourceOffset),byteCount: chunk.bytes)
          ClimbOverlayPacketMetrics.uploaded(chunk.bytes,prefetch: cacheOnly)
        }
      }
      guard !preparation.isCancelled else { throw ClimbOverlayPacketFailure.cancelled }
      try index.commit(placement)
    } catch {
      if patchedExisting { for record in try index.discardTouchedOptional(placement) { metadata.removeValue(forKey: record.key) } }
      throw error
    }
    arena = target
    for removed in placement.removed { metadata.removeValue(forKey: removed.key) }
    for (key,handle) in acquired { metadata[key] = handle }
    let epoch = try index.retain(description.chunks)
    if cacheOnly { try index.release(description.chunks,epoch: epoch);return nil }
    guard let resources,let packetReservation else { throw ClimbOverlayArenaFailure.invalid }
    return ClimbOverlayMetalPacket(rust: encoded.handle,session: session,header: encoded.header,descriptors: descriptors,
      resources: resources,uniformBuffers: uniformBuffers,reservation: packetReservation,pins: ClimbOverlayMetalPins(arena: target,keys: description.chunks,epoch: epoch),
      prepareMs: (CACurrentMediaTime()-started)*1000,uploadMs: missing.pixelBytes == 0 && copied == 0 ? 0 : (CACurrentMediaTime()-uploadStarted)*1000,
      uploadBytes: missing.pixelBytes,copiedBytes: copied,selectedBytes: description.chunks.reduce(0) { $0+placement.records[$1]!.bytes })
  }
}

private extension Optional where Wrapped == ClimbOverlayMetalArena {
  func unwrap() throws -> Wrapped { guard let self else { throw ClimbOverlayArenaFailure.invalid };return self }
}

/// `look` is the swap look's buffer (`ClimbOverlaySwapLook.encode`), or its
/// zero header: the shader always reads the header, so it is always bound.
func encodeClimbOverlayPacket(_ packet: ClimbOverlayMetalPacket,encoder: MTLRenderCommandEncoder,
                             lower: Int,upper: Int,uniformSlot: Int,look: [UInt16] = ClimbOverlaySwapLook.off) {
  encoder.setFragmentBuffer(packet.pins.arena.pixels,offset: 0,index: ClimbOverlayPacketLayout.metalBindingsPixels)
  encoder.setFragmentBuffer(packet.descriptors[lower],offset: 0,index: ClimbOverlayPacketLayout.metalBindingsLower)
  encoder.setFragmentBuffer(packet.uniformBuffers[uniformSlot],offset: 0,index: ClimbOverlayPacketLayout.metalBindingsUniforms)
  encoder.setFragmentBuffer(packet.resources,offset: 0,index: ClimbOverlayPacketLayout.metalBindingsResources)
  encoder.setFragmentBuffer(packet.descriptors[upper],offset: 0,index: ClimbOverlayPacketLayout.metalBindingsUpper)
  look.withUnsafeBytes { bytes in
    encoder.setFragmentBytes(bytes.baseAddress!,length: bytes.count,index: ClimbOverlaySwapLook.metalBinding)
  }
}
