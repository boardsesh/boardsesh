import ExpoModulesCore
import MetalKit
import UIKit
import BoardRendererModule

let climbOverlayGPUWorkQueue = DispatchQueue(label: "com.boardsesh.climb-overlay-gpu", qos: .userInitiated)

private struct GPUUniforms {
  var size: SIMD4<Float>
  var veil: SIMD4<Float>
  var tuning: SIMD4<Float>
  var tuning2: SIMD4<Float>
  var offsets: SIMD4<UInt32>
  var viewport: SIMD4<Float>
  var motion: SIMD4<Float>
  var other: SIMD4<Float>
  var coverCrop: SIMD4<UInt32>
}

private struct GPUAtlas {
  let manifest: AtlasManifest
  let pixels: MTLBuffer
  let lut: MTLBuffer
  let holds: [UInt32: AtlasHold]
  let supportedStates: Set<UInt32>
  let uploadMs: Double
  let reservation: ClimbOverlayBudget.Reservation
}

private struct GPUScene {
  let atlas: GPUAtlas
  let holds: MTLBuffer
  let count: Int
  let maxReach: Float
  let prepareMs: Double
  let cacheHit: Bool
  let descriptors: [GPUHold]
  let stampLayers: UInt32
  let reservation: ClimbOverlayBudget.Reservation
}

private struct GPUScenes {
  let current: GPUScene
  let previous: GPUScene?
  let next: GPUScene?
}

private enum OverlayFailure: LocalizedError {
  case reason(String)

  var errorDescription: String? {
    switch self { case .reason(let message): return message }
  }
}

/// All compilation, atlas preparation and cache access are on this serial
/// queue. Only the completed immutable scene crosses to the main thread.
private enum OverlayRenderer {
  static let work = climbOverlayGPUWorkQueue
  static let device = MTLCreateSystemDefaultDevice()
  static var pipeline: MTLRenderPipelineState?
  static var commands: MTLCommandQueue?
  static var cache: (source: String, key: Data, assets: [String?], atlas: GPUAtlas)?
  static let budget = ClimbOverlayBudget()
  static let memoryWarningObserver = NotificationCenter.default.addObserver(
    forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
  ) { _ in OverlayRenderer.work.async { OverlayRenderer.cache = nil } }

  static func discardCancelledAtlas(_ atlas: GPUAtlas) {
    // Mounted views and commands keep their own counted reservations. This
    // removes only the optional cache reference from a cancelled preparation.
    if let cached = cache, cached.atlas.pixels === atlas.pixels { cache = nil }
  }

  static func prepare(configJson: String, frames overrideFrames: String? = nil,
                      preparedAtlas: GPUAtlas? = nil, strictRoles: Bool = false,
                      geometryAssetPath: String? = nil, geometryAssetSha256: String? = nil,
                      generatedGeometryDirectory: String? = nil, preparation: ClimbOverlayPreparation? = nil) throws -> GPUScene {
    guard preparation?.isCancelled != true else { throw OverlayFailure.reason("GPU preparation cancelled") }
    guard let device else { throw OverlayFailure.reason("Metal unavailable") }
    let assets = [geometryAssetPath,geometryAssetSha256,generatedGeometryDirectory]
    _ = memoryWarningObserver
    if pipeline == nil {
      let library = try device.makeLibrary(source: ClimbOverlayShader.source, options: nil)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "overlay_vertex")
      descriptor.fragmentFunction = library.makeFunction(name: "overlay_fragment")
      descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
      pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
      commands = device.makeCommandQueue()
    }
    let start = CACurrentMediaTime()
    let frames: String
    let hit: Bool
    let atlas: GPUAtlas
    if let preparedAtlas, let overrideFrames {
      // Warm frame update: no layout JSON parsing, serialization, comparison,
      // field preparation or atlas upload. Only the small active-hold list.
      atlas = preparedAtlas
      frames = overrideFrames
      hit = true
    } else if let overrideFrames, let cached = cache, cached.source == configJson, cached.assets == assets {
      // A carousel can mount a new view for the same static config. Comparing
      // that source avoids rebuilding a canonical JSON key on every swipe.
      atlas = cached.atlas
      frames = overrideFrames
      hit = true
    } else {
      guard configJson.utf8.count <= 8 * 1024 * 1024,
        var config = try JSONSerialization.jsonObject(with: Data(configJson.utf8)) as? [String: Any],
        let configFrames = config["frames"] as? String
      else { throw OverlayFailure.reason("Invalid render config") }
      frames = overrideFrames ?? configFrames
      config["frames"] = ""
      let key = try JSONSerialization.data(withJSONObject: config, options: [.sortedKeys])
      hit = cache?.key == key && cache?.assets == assets
      if hit, let cached = cache {
        atlas = cached.atlas
        cache = (configJson, key, assets, atlas)
      }
      else {
        // One bounded global entry survives carousel view replacement, so
        // moving to a neighbouring climb does not rebuild the same layout.
        cache = nil
        atlas = try makeAtlas(config: key, device: device, geometryAssetPath: geometryAssetPath,
          geometryAssetSha256: geometryAssetSha256,generatedGeometryDirectory: generatedGeometryDirectory)
        guard preparation?.isCancelled != true else { throw OverlayFailure.reason("GPU preparation cancelled") }
        cache = (configJson, key, assets, atlas)
      }
    }
    guard frames.utf8.count <= 32 * 1024 else { throw OverlayFailure.reason("Invalid frames") }
    var active: [GPUHold] = []
    for token in frames.split(separator: ",", omittingEmptySubsequences: false).first?.split(separator: "p") ?? [] {
      let pieces = token.split(separator: "r", omittingEmptySubsequences: false)
      guard pieces.count == 2, let id = UInt32(pieces[0]), let state = UInt32(pieces[1]) else { continue }
      if strictRoles && !atlas.supportedStates.contains(state) {
        throw OverlayFailure.reason("Unsupported hold role in GPU source")
      }
      guard let original = atlas.holds[id] else { continue }
      let hold = atlas.manifest.mirrored ? (original.mirror.flatMap { atlas.holds[$0] } ?? original) : original
      guard let role = hold.roles.first(where: { $0.state == state }) else {
        if strictRoles { throw OverlayFailure.reason("Unsupported hold role in GPU source") }
        continue
      }
      guard active.count < 128 else { throw OverlayFailure.reason("Prototype supports at most 128 active holds") }
      active.append(makeClimbOverlayGPUHold(hold: hold,role: role))
    }
    let count = active.count
    if strictRoles && !frames.isEmpty && count == 0 {
      throw OverlayFailure.reason("GPU source contains no matching holds")
    }
    let maxReach = active.filter { $0.identity.z == 0 }.map { $0.numbers.x }.max() ?? 0
    // Metal requires a nonempty buffer even when the shader loop runs zero times.
    let descriptors = active
    if active.isEmpty {
      active.append(GPUHold(color: .zero, bounds: .zero, crop: .zero, offsets: .zero, numbers: .zero, identity: .zero,fillCrop: .zero,plateCrop: .zero,glyphCrop: .zero,
        extraOffsets: .zero,fillCrop1: .zero,fillCrop2: .zero,fillCrop3: .zero,glyphCrop1: .zero))
    }
    let holdLength = active.count * MemoryLayout<GPUHold>.stride
    let holdEstimate = device.heapBufferSizeAndAlign(length: holdLength,options: .storageModeShared)
    guard let holdAllocation = ClimbOverlayBudget.allocationSize(requested: holdLength,
      heapSize: holdEstimate.size,heapAlignment: holdEstimate.align),
      let reservation = budget.reserve(holdAllocation),
      let holds = device.makeBuffer(bytes: active, length: holdLength,options: .storageModeShared),
      holds.allocatedSize <= holdAllocation else {
      throw OverlayFailure.reason("Active hold allocation failed")
    }
    return GPUScene(atlas: atlas, holds: holds, count: count, maxReach: maxReach,
                    prepareMs: (CACurrentMediaTime()-start)*1000, cacheHit: hit, descriptors: descriptors,
                    stampLayers: descriptors.reduce(0) { $0 | $1.stampLayers },reservation: reservation)
  }

  static func replacingDescriptors(_ scene: GPUScene, with descriptors: [GPUHold]) throws -> GPUScene {
    guard let device else { throw OverlayFailure.reason("Metal unavailable") }
    let buffer = descriptors.isEmpty
      ? [GPUHold(color: .zero,bounds: .zero,crop: .zero,offsets: .zero,numbers: .zero,identity: .zero,fillCrop: .zero,plateCrop: .zero,glyphCrop: .zero,
          extraOffsets: .zero,fillCrop1: .zero,fillCrop2: .zero,fillCrop3: .zero,glyphCrop1: .zero)]
      : descriptors
    let holdLength = buffer.count*MemoryLayout<GPUHold>.stride
    let holdEstimate = device.heapBufferSizeAndAlign(length: holdLength,options: .storageModeShared)
    guard let holdAllocation = ClimbOverlayBudget.allocationSize(requested: holdLength,
      heapSize: holdEstimate.size,heapAlignment: holdEstimate.align),
      let reservation = budget.reserve(holdAllocation),
      let holds = device.makeBuffer(bytes: buffer,length: holdLength,options: .storageModeShared),
      holds.allocatedSize <= holdAllocation else {
      throw OverlayFailure.reason("Motion hold allocation failed")
    }
    return GPUScene(atlas: scene.atlas,holds: holds,count: descriptors.count,maxReach: scene.maxReach,
      prepareMs: scene.prepareMs,cacheHit: scene.cacheHit,descriptors: descriptors,
      stampLayers: descriptors.reduce(0) { $0 | $1.stampLayers },reservation: reservation)
  }

  static func prepareSources(configJson: String, frames: String?, previous: String?, next: String?,
                             preparedAtlas: GPUAtlas?, editBaseline: [UInt32: UInt32]?,
                             geometryAssetPath: String?, geometryAssetSha256: String?,
                             generatedGeometryDirectory: String?, preparation: ClimbOverlayPreparation) throws -> GPUScenes {
    let started = CACurrentMediaTime()
    let current = try prepare(configJson: configJson,frames: frames,preparedAtlas: preparedAtlas,
                              strictRoles: previous != nil || next != nil,
                              geometryAssetPath: geometryAssetPath,geometryAssetSha256: geometryAssetSha256,
                              generatedGeometryDirectory: generatedGeometryDirectory,preparation: preparation)
    let previousScene = try previous.map { try prepare(configJson: configJson,frames: $0,
      preparedAtlas: current.atlas,strictRoles: true,geometryAssetPath: geometryAssetPath,geometryAssetSha256: geometryAssetSha256,
                              generatedGeometryDirectory: generatedGeometryDirectory,preparation: preparation) }
    let nextScene = try next.map { try prepare(configJson: configJson,frames: $0,
      preparedAtlas: current.atlas,strictRoles: true,geometryAssetPath: geometryAssetPath,geometryAssetSha256: geometryAssetSha256,
                              generatedGeometryDirectory: generatedGeometryDirectory,preparation: preparation) }
    func roles(_ scene: GPUScene?) -> [UInt32: UInt32] {
      var roles: [UInt32: UInt32] = [:]
      for hold in scene?.descriptors ?? [] { roles[hold.identity.x] = hold.identity.y }
      return roles
    }
    func annotate(_ scene: GPUScene, lower: [UInt32: UInt32], upper: [UInt32: UInt32],
                  baseline: [UInt32: UInt32]?) throws -> GPUScene {
      let descriptors = scene.descriptors.map { descriptor in
        var hold = descriptor
        hold.numbers.y = baseline.map { $0[hold.identity.x] != hold.identity.y } == true ? 1 : 0
        hold.numbers.z = lower[hold.identity.x].map { $0 == hold.identity.y ? 1 : 2 } ?? 0
        hold.numbers.w = upper[hold.identity.x].map { $0 == hold.identity.y ? 1 : 2 } ?? 0
        return hold
      }
      return try replacingDescriptors(scene,with: descriptors)
    }
    let currentRoles = roles(current)
    let annotatedCurrent = try annotate(current,lower: roles(previousScene),upper: roles(nextScene),baseline: editBaseline)
    let annotatedPrevious = try previousScene.map { try annotate($0,lower: [:],upper: currentRoles,baseline: nil) }
    let annotatedNext = try nextScene.map { try annotate($0,lower: currentRoles,upper: [:],baseline: nil) }
    let timedCurrent = GPUScene(atlas: annotatedCurrent.atlas,holds: annotatedCurrent.holds,
      count: annotatedCurrent.count,maxReach: annotatedCurrent.maxReach,
      prepareMs: (CACurrentMediaTime()-started)*1000,cacheHit: annotatedCurrent.cacheHit,
      descriptors: annotatedCurrent.descriptors,stampLayers: annotatedCurrent.stampLayers,
      reservation: annotatedCurrent.reservation)
    return GPUScenes(current: timedCurrent,previous: annotatedPrevious,next: annotatedNext)
  }

  private static func makeAtlas(config: Data, device: MTLDevice, geometryAssetPath: String?,
                                geometryAssetSha256: String?,generatedGeometryDirectory: String?) throws -> GPUAtlas {
    var manifestPointer: UnsafeMutablePointer<UInt8>?
    var manifestLength: UInt32 = 0
    var pixelsPointer: UnsafeMutablePointer<UInt8>?
    var pixelsLength: UInt32 = 0
    func pathBytes(_ path: String?) throws -> Data {
      guard let path else { return Data() }
      guard path.utf8.count <= 4096 else { throw OverlayFailure.reason("GPU asset path too large") }
      let url = URL(string: path)
      guard url?.scheme == nil || url?.isFileURL == true else { throw OverlayFailure.reason("GPU asset must be local") }
      let bytes = Data((url?.isFileURL == true ? url!.path : path).utf8)
      guard bytes.count <= 4096 else { throw OverlayFailure.reason("GPU asset path too large") }
      return bytes
    }
    let path = try pathBytes(geometryAssetPath)
    let directory = try pathBytes(generatedGeometryDirectory)
    let expected = Data((geometryAssetSha256 ?? "").utf8)
    guard expected.count <= 64 else { throw OverlayFailure.reason("Invalid GPU asset checksum") }
    let status = config.withUnsafeBytes { bytes in
      path.withUnsafeBytes { pathBytes in
        expected.withUnsafeBytes { shaBytes in
          directory.withUnsafeBytes { directoryBytes in
            board_renderer_prepare_gpu_atlas_owned(bytes.bindMemory(to: UInt8.self).baseAddress, UInt32(bytes.count),
              pathBytes.bindMemory(to: UInt8.self).baseAddress,UInt32(pathBytes.count),
              shaBytes.bindMemory(to: UInt8.self).baseAddress,UInt32(shaBytes.count),
              directoryBytes.bindMemory(to: UInt8.self).baseAddress,UInt32(directoryBytes.count),
              &manifestPointer,&manifestLength,&pixelsPointer,&pixelsLength)
          }
        }
      }
    }
    defer {
      board_renderer_free(manifestPointer,manifestLength)
      board_renderer_free(pixelsPointer,pixelsLength)
    }
    guard status == 0, let manifestPointer, let pixelsPointer,
      manifestLength > 0, manifestLength <= 4 * 1024 * 1024 else {
      throw OverlayFailure.reason("Atlas preparation rejected config (\(status))")
    }
    let manifest = try decodeClimbOverlayAtlasManifest(Data(bytes: manifestPointer, count: Int(manifestLength)))
    let payloadLength = Int(pixelsLength)
    guard manifest.version == 2, manifest.lut.count == 257, manifest.veil.count == 4,
      manifest.lut.allSatisfy({ $0.isFinite }),manifest.veil.allSatisfy({ $0.isFinite }),
      manifest.width > 0, manifest.width <= 1536, manifest.height > 0, manifest.height <= 2304,
      payloadLength > 0, payloadLength <= ClimbOverlayBudget.limit,manifest.holds.count <= 1024
    else { throw OverlayFailure.reason("Invalid atlas layout") }
    func validStamp(_ stamp: AtlasStamp?) -> Bool {
      guard let stamp else { return true }
      return stamp.width > 0 && stamp.height > 0 && stamp.offset % 4 == 0
        && UInt64(stamp.x)+UInt64(stamp.width) <= UInt64(manifest.width)
        && UInt64(stamp.y)+UInt64(stamp.height) <= UInt64(manifest.height)
        && UInt64(stamp.offset)+UInt64(stamp.width)*UInt64(stamp.height)*4 <= UInt64(payloadLength)
    }
    guard validStamp(manifest.covers) else { throw OverlayFailure.reason("Invalid atlas cover") }
    var holdIndex: [UInt32: AtlasHold] = [:]
    for hold in manifest.holds {
      let pixels = UInt64(hold.width)*UInt64(hold.height)
      guard hold.width > 0,hold.height > 0,hold.field % 4 == 0,
        UInt64(hold.x)+UInt64(hold.width) <= UInt64(manifest.width),
        UInt64(hold.y)+UInt64(hold.height) <= UInt64(manifest.height),
        hold.bounds.count == 4,hold.bounds.allSatisfy({ $0.isFinite }),holdIndex[hold.id] == nil,
        hold.reach.isFinite,hold.reach >= 0,hold.reach <= 512,
        UInt64(hold.field)+pixels*4 <= UInt64(payloadLength),hold.roles.count <= 32,
        Set(hold.roles.map(\.state)).count == hold.roles.count,
        hold.roles.allSatisfy({ role in
          role.color.count == 3 && role.color.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 255 })
            && role.fillPasses.count <= 4 && role.glyphPasses.count <= 2
            && role.fillPasses.allSatisfy(validStamp) && validStamp(role.plate) && role.glyphPasses.allSatisfy(validStamp)
        }) else { throw OverlayFailure.reason("Invalid atlas hold") }
      holdIndex[hold.id] = hold
    }
    let uploadStart = CACurrentMediaTime()
    let lutLength = manifest.lut.count * MemoryLayout<Float>.size
    let pixelEstimate = device.heapBufferSizeAndAlign(length: payloadLength,options: .storageModeShared)
    let lutEstimate = device.heapBufferSizeAndAlign(length: lutLength,options: .storageModeShared)
    guard let pixelAllocation = ClimbOverlayBudget.allocationSize(requested: payloadLength,
      heapSize: pixelEstimate.size,heapAlignment: pixelEstimate.align),
      let lutAllocation = ClimbOverlayBudget.allocationSize(requested: lutLength,
        heapSize: lutEstimate.size,heapAlignment: lutEstimate.align),
      let reservation = budget.reserve(pixelAllocation+lutAllocation),
      let pixels = device.makeBuffer(bytes: pixelsPointer, length: payloadLength,options: .storageModeShared),
      let lut = device.makeBuffer(bytes: manifest.lut, length: lutLength,options: .storageModeShared),
      pixels.allocatedSize <= pixelAllocation,lut.allocatedSize <= lutAllocation
    else { throw OverlayFailure.reason("GPU atlas allocation exceeds aggregate budget") }
    return GPUAtlas(manifest: manifest, pixels: pixels, lut: lut, holds: holdIndex,
                    supportedStates: Set(manifest.holds.flatMap { $0.roles.map(\.state) }),
                    uploadMs: (CACurrentMediaTime()-uploadStart)*1000,reservation: reservation)
  }
}

/// Diagnostic only: same shader at the reference's exact pixel dimensions.
/// Runs on the preparation queue, writes only its own unique cache artifacts.
func compareClimbOverlayGPU(_ configJson: String) throws -> [String: Any] {
  let scene = try OverlayRenderer.prepare(configJson: configJson)
  guard let device = OverlayRenderer.device, let pipeline = OverlayRenderer.pipeline,
    let command = OverlayRenderer.commands?.makeCommandBuffer() else {
    throw OverlayFailure.reason("GPU comparison unavailable")
  }
  let manifest = scene.atlas.manifest
  let width = Int(manifest.width)
  let height = Int(manifest.height)
  let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm,
    width: width, height: height, mipmapped: false)
  textureDescriptor.usage = [.renderTarget]
  textureDescriptor.storageMode = .shared
  let textureAllocation = max(width*height*4,device.heapTextureSizeAndAlign(descriptor: textureDescriptor).size)
  guard let comparisonReservation = OverlayRenderer.budget.reserve(textureAllocation),
    let texture = device.makeTexture(descriptor: textureDescriptor),texture.allocatedSize <= textureAllocation else {
    throw OverlayFailure.reason("Comparison texture allocation failed")
  }
  defer { withExtendedLifetime(comparisonReservation) {} }
  let pass = MTLRenderPassDescriptor()
  pass.colorAttachments[0].texture = texture
  pass.colorAttachments[0].loadAction = .clear
  pass.colorAttachments[0].storeAction = .store
  pass.colorAttachments[0].clearColor = MTLClearColorMake(0,0,0,0)
  guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else {
    throw OverlayFailure.reason("Comparison encoder failed")
  }
  var uniforms = GPUUniforms(
    size: SIMD4(Float(width),Float(height),Float(scene.count),manifest.glow ? 1 : 0),
    veil: SIMD4(manifest.veil[0]/255,manifest.veil[1]/255,manifest.veil[2]/255,manifest.veil[3]/255),
    tuning: SIMD4(manifest.merge,manifest.seam,manifest.seamMix,manifest.seamSharpness),
    tuning2: SIMD4(manifest.fringe,manifest.coreShare,scene.maxReach,0),
    offsets: SIMD4(manifest.covers?.offset ?? .max,scene.stampLayers,0,0),viewport: SIMD4(Float(width),Float(height),0,0),
    motion: SIMD4(0,1,1,1),other: .zero,coverCrop: manifest.covers?.crop ?? .zero)
  encoder.setRenderPipelineState(pipeline)
  encoder.setFragmentBuffer(scene.atlas.pixels, offset: 0, index: 0)
  encoder.setFragmentBuffer(scene.holds, offset: 0, index: 1)
  encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GPUUniforms>.stride, index: 2)
  encoder.setFragmentBuffer(scene.atlas.lut, offset: 0, index: 3)
  encoder.setFragmentBuffer(scene.holds, offset: 0, index: 4)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.endEncoding()
  var submitted = false
  DispatchQueue.main.sync {
    guard UIApplication.shared.applicationState == .active else { return }
    command.commit()
    submitted = true
  }
  guard submitted else { throw OverlayFailure.reason("Comparison paused while app inactive") }
  command.waitUntilCompleted()
  guard command.status == .completed else { throw OverlayFailure.reason("Comparison GPU command failed") }
  var gpu = [UInt8](repeating: 0, count: width*height*4)
  gpu.withUnsafeMutableBytes { bytes in
    texture.getBytes(bytes.baseAddress!, bytesPerRow: width*4, from: MTLRegionMake2D(0,0,width,height), mipmapLevel: 0)
  }
  for pixel in stride(from: 0, to: gpu.count, by: 4) { gpu.swapAt(pixel, pixel+2) }
  var referencePointer: UnsafeMutablePointer<UInt8>?
  var referenceLength: UInt32 = 0
  var referenceWidth: UInt32 = 0
  var referenceHeight: UInt32 = 0
  let configBytes = Array(configJson.utf8)
  let cpuStart = CACurrentMediaTime()
  let status = configBytes.withUnsafeBufferPointer { bytes in
    board_renderer_render(bytes.baseAddress, UInt32(bytes.count), &referencePointer,
                          &referenceLength, &referenceWidth, &referenceHeight)
  }
  let cpuRenderMs = (CACurrentMediaTime()-cpuStart)*1000
  guard status == 0, let referencePointer else { throw OverlayFailure.reason("Reference Rust render failed") }
  defer { board_renderer_free(referencePointer, referenceLength) }
  guard referenceWidth == manifest.width, referenceHeight == manifest.height,
    Int(referenceLength) == gpu.count else { throw OverlayFailure.reason("Reference size mismatch") }
  let reference = UnsafeBufferPointer(start: referencePointer, count: Int(referenceLength))
  var maximum = 0
  var squared = 0.0
  var differentPixels = 0
  for pixel in stride(from: 0, to: gpu.count, by: 4) {
    var differs = false
    for channel in 0..<4 {
      let difference = abs(Int(gpu[pixel+channel])-Int(reference[pixel+channel]))
      maximum = max(maximum,difference)
      squared += Double(difference*difference)
      differs = differs || difference > 1
    }
    if differs { differentPixels += 1 }
  }
  let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("gpu-overlay-parity", isDirectory: true)
    .appendingPathComponent(UUID().uuidString, isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  func save(_ bytes: Data, name: String) throws -> String {
    guard let provider = CGDataProvider(data: bytes as CFData),
      let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: width*4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent),
      let png = UIImage(cgImage: image).pngData() else { throw OverlayFailure.reason("Comparison PNG failed") }
    let destination = directory.appendingPathComponent(name)
    try png.write(to: destination, options: .atomic)
    return destination.absoluteString
  }
  return ["width":width,"height":height,"maxChannelError":maximum,
    "rmse":sqrt(squared/Double(gpu.count)),"pixelsOverOne":differentPixels,
    "cpuRenderMs":cpuRenderMs,"gpuMs":max(0,command.gpuEndTime-command.gpuStartTime)*1000,
    "prepareMs":scene.prepareMs,"uploadMs":scene.cacheHit ? 0 : scene.atlas.uploadMs,
    "atlasBytes":scene.atlas.pixels.length,"atlasCacheHit":scene.cacheHit,
    "gpuUri":try save(Data(gpu),name:"gpu.png"),
    "referenceUri":try save(Data(bytes: referencePointer, count: Int(referenceLength)),name:"rust.png")]
}

final class ClimbOverlayGPUView: ExpoView, MTKViewDelegate {
  let onRenderReady = EventDispatcher()
  let onRenderError = EventDispatcher()
  var configJson = "" {
    didSet { if configJson != oldValue { configRevision &+= 1; preparation?.cancel() } }
  }
  var geometryAssetPath: String? {
    didSet { if geometryAssetPath != oldValue { configRevision &+= 1; preparation?.cancel() } }
  }
  var geometryAssetSha256: String? {
    didSet { if geometryAssetSha256 != oldValue { configRevision &+= 1; preparation?.cancel() } }
  }
  var generatedGeometryDirectory: String? {
    didSet { if generatedGeometryDirectory != oldValue { configRevision &+= 1; preparation?.cancel() } }
  }
  var frames: String?
  var previousFrames: String?
  var nextFrames: String?
  var centerPage: Double = 0 {
    didSet { if !centerPage.isFinite { centerPage = oldValue } }
  }
  var animateEdits = false
  var reduceMotion = false
  var displayMirrored = false
  private var pagePosition: Double?
  var requestId = ""
  var active = false
  private let metal: MTKView
  private var revision: UInt64 = 0
  private var reportedRevision: UInt64?
  private var scene: GPUScene?
  private var previousScene: GPUScene?
  private var nextScene: GPUScene?
  private var configRevision: UInt64 = 0
  private var submittedConfigRevision: UInt64?
  private var submittedFrames: String?
  private var submittedPreviousFrames: String?
  private var submittedNextFrames: String?
  private var submittedCenterPage: Double = 0
  private var preparedConfigRevision: UInt64?
  private var preparedAtlas: GPUAtlas?
  private var submittedRequest = ""
  private var background = UIApplication.shared.applicationState != .active
  private var needsFrame = false
  private var preparing = false
  private var preparation: ClimbOverlayPreparation?
  private var editorBaseline: [UInt32: UInt32]?
  private var editorBaselineRevision: UInt64?
  private var editorPulse = ClimbOverlayMotion.EditorPulse()
  private var editorDisplayLink: CADisplayLink?
  private var editChangedHoldCount = 0
  private var scheduledEditDurationMs: Double = 0
  private var suppressMotion: Bool { reduceMotion || UIAccessibility.isReduceMotionEnabled }

  deinit { preparation?.cancel() }

  required init(appContext: AppContext? = nil) {
    metal = MTKView(frame: .zero, device: OverlayRenderer.device)
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    metal.isUserInteractionEnabled = false
    metal.isOpaque = false
    metal.colorPixelFormat = .bgra8Unorm
    metal.clearColor = MTLClearColorMake(0, 0, 0, 0)
    metal.isPaused = true
    metal.autoResizeDrawable = false
    metal.enableSetNeedsDisplay = true
    metal.delegate = self
    addSubview(metal)
    NotificationCenter.default.addObserver(self, selector: #selector(suspend), name: UIApplication.willResignActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(resume), name: UIApplication.didBecomeActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(motionPolicyChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(motionPolicyChanged), name: .NSProcessInfoPowerStateDidChange, object: nil)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    metal.frame = bounds
    let scale = traitCollection.displayScale
    metal.contentScaleFactor = scale > 0 ? scale : 1
    requestDraw()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      preparation?.cancel()
      stopEditorMotion()
      scene = nil
      previousScene = nil
      nextScene = nil
      editorBaseline = nil
      editorBaselineRevision = nil
      preparedAtlas = nil
      preparedConfigRevision = nil
      submittedConfigRevision = nil
      submittedFrames = nil
      submittedRequest = ""
      return
    }
    applyProps()
    requestDraw()
  }

  @objc private func suspend() { background = true; stopEditorMotion() }
  @objc private func resume() { background = false; applyProps(); requestDraw() }

  func setPagePosition(_ position: Double) {
    guard position.isFinite, position != pagePosition else { return }
    pagePosition = position
    requestDraw()
  }

  @objc private func motionPolicyChanged() {
    if suppressMotion || ProcessInfo.processInfo.isLowPowerModeEnabled { stopEditorMotion() }
    requestDraw()
  }

  private func stopEditorMotion() {
    editorDisplayLink?.invalidate()
    editorDisplayLink = nil
    editorPulse.cancel()
  }

  private func startEditorMotion() -> Bool {
    stopEditorMotion()
    guard animateEdits, !suppressMotion, !ProcessInfo.processInfo.isLowPowerModeEnabled,
      active, !background, window != nil else { return false }
    editorPulse.schedule()
    return true
  }

  private func beginPresentedEditorMotion() {
    guard animateEdits, !suppressMotion, !ProcessInfo.processInfo.isLowPowerModeEnabled,
      active, !background, window != nil else { stopEditorMotion(); return }
    guard editorPulse.present(at: CACurrentMediaTime()) else { return }
    let link = CADisplayLink(target: self,selector: #selector(editorTick))
    link.preferredFramesPerSecond = 60
    link.add(to: .main,forMode: .common)
    editorDisplayLink = link
    requestDraw()
  }

  @objc private func editorTick() {
    guard let started = editorPulse.started, active, !background, window != nil,
      !suppressMotion, !ProcessInfo.processInfo.isLowPowerModeEnabled else {
      stopEditorMotion()
      requestDraw()
      return
    }
    if CACurrentMediaTime()-started >= ClimbOverlayMotion.editDuration { stopEditorMotion() }
    requestDraw()
  }

  func applyProps() {
    if !active {
      preparation?.cancel()
      stopEditorMotion()
      scene = nil
      previousScene = nil
      nextScene = nil
      editorBaseline = nil
      editorBaselineRevision = nil
      preparedAtlas = nil
      preparedConfigRevision = nil
      submittedConfigRevision = nil
      submittedFrames = nil
      submittedRequest = ""
      return
    }
    if suppressMotion || !animateEdits || ProcessInfo.processInfo.isLowPowerModeEnabled { stopEditorMotion() }
    guard active, window != nil, !background, !configJson.isEmpty else { return }
    // An observed empty editor is a real semantic baseline even when its
    // atlas is still preparing. Preserve it before the coalescing guard so a
    // quick first tap lights the changed hold instead of looking like mount.
    if animateEdits, frames?.isEmpty == true {
      editorBaseline = [:]
      editorBaselineRevision = configRevision
    }
    if submittedConfigRevision == configRevision && submittedFrames == frames && submittedRequest == requestId
      && submittedPreviousFrames == previousFrames && submittedNextFrames == nextFrames && submittedCenterPage == centerPage {
      requestDraw()
      return
    }
    // Coalesce updates while atlas preparation is running. There is at most
    // one worker request for this view; completion picks up the latest props.
    guard !preparing else { return }
    preparing = true
    stopEditorMotion()
    editChangedHoldCount = 0
    scheduledEditDurationMs = 0
    scene = nil
    previousScene = nil
    nextScene = nil
    revision &+= 1
    let generation = revision
    let config = configJson
    let assetPath = geometryAssetPath
    let assetSha = geometryAssetSha256
    let generatedDirectory = generatedGeometryDirectory
    let preparation = ClimbOverlayPreparation()
    self.preparation = preparation
    let layoutRevision = configRevision
    let frame = frames
    let previous = previousFrames
    let next = nextFrames
    let page = centerPage.isFinite ? centerPage : 0
    let baseline = animateEdits && editorBaselineRevision == layoutRevision ? editorBaseline : nil
    let request = requestId
    if preparedConfigRevision != layoutRevision {
      preparedAtlas = nil
      preparedConfigRevision = nil
    }
    let reusableAtlas = preparedConfigRevision == layoutRevision ? preparedAtlas : nil
    submittedConfigRevision = layoutRevision
    submittedFrames = frame
    submittedPreviousFrames = previous
    submittedNextFrames = next
    submittedCenterPage = page
    submittedRequest = request
    OverlayRenderer.work.async { [weak self] in
      let result = Result { try OverlayRenderer.prepareSources(configJson: config,frames: frame,
        previous: previous,next: next,preparedAtlas: reusableAtlas,editBaseline: baseline,
        geometryAssetPath: assetPath,geometryAssetSha256: assetSha,
        generatedGeometryDirectory: generatedDirectory,preparation: preparation) }
      DispatchQueue.main.async { [weak self] in
        if preparation.isCancelled, case .success(let scenes) = result {
          OverlayRenderer.work.async { OverlayRenderer.discardCancelledAtlas(scenes.current.atlas) }
        }
        guard let self else { return }
        self.preparing = false
        self.preparation = nil
        // A rapid swipe can invalidate the active frame while its layout is
        // still useful. Keep that atlas, then prepare only the latest frame.
        if self.configRevision == layoutRevision, self.window != nil, self.active,
          case .success(let scenes) = result {
          self.preparedAtlas = scenes.current.atlas
          self.preparedConfigRevision = layoutRevision
        }
        guard self.revision == generation, self.configRevision == layoutRevision,
          self.frames == frame, self.previousFrames == previous, self.nextFrames == next,
          self.centerPage == page, self.requestId == request else {
          self.applyProps()
          return
        }
        guard self.window != nil, self.active else {
          self.submittedConfigRevision = nil
          self.submittedFrames = nil
          self.submittedRequest = ""
          return
        }
        self.submittedConfigRevision = layoutRevision
        self.submittedFrames = frame
        self.submittedPreviousFrames = previous
        self.submittedNextFrames = next
        self.submittedCenterPage = page
        self.submittedRequest = request
        switch result {
        case .success(let scenes):
          let scene = scenes.current
          self.scene = scene
          self.previousScene = scenes.previous
          self.nextScene = scenes.next
          var baseline: [UInt32: UInt32] = [:]
          for hold in scene.descriptors { baseline[hold.identity.x] = hold.identity.y }
          self.editorBaseline = baseline
          self.editorBaselineRevision = layoutRevision
          self.editChangedHoldCount = scene.descriptors.filter { $0.numbers.y > 0 }.count
          self.scheduledEditDurationMs = self.editChangedHoldCount > 0 && self.startEditorMotion()
            ? ClimbOverlayMotion.editDuration * 1000 : 0
          self.metal.drawableSize = CGSize(width: Int(scene.atlas.manifest.width), height: Int(scene.atlas.manifest.height))
          self.requestDraw()
        case .failure(let error):
          self.scene = nil
          self.onRenderError(["requestId": request, "reason": String(describing: error)])
        }
      }
    }
  }

  private func requestDraw() {
    needsFrame = true
    if active && !background && window != nil { metal.setNeedsDisplay() }
  }

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { requestDraw() }

  func draw(in view: MTKView) {
    guard needsFrame, !preparing, active, !background, window != nil,
      configRevision == submittedConfigRevision, frames == submittedFrames, requestId == submittedRequest,
      previousFrames == submittedPreviousFrames, nextFrames == submittedNextFrames, centerPage == submittedCenterPage,
      let scene, let pipeline = OverlayRenderer.pipeline,
      let drawable = view.currentDrawable, let descriptor = view.currentRenderPassDescriptor
    else { return }
    guard let command = OverlayRenderer.commands?.makeCommandBuffer(),
      let encoder = command.makeRenderCommandEncoder(descriptor: descriptor) else {
      needsFrame = false
      onRenderError(["requestId":requestId,"reason":"GPU command encoding unavailable"])
      return
    }
    needsFrame = false
    let manifest = scene.atlas.manifest
    var lower = scene
    var upper = scene
    var progress: Float = 0
    let selection = ClimbOverlayMotion.select(pagePosition: pagePosition ?? submittedCenterPage,
      centerPage: submittedCenterPage,hasPrevious: previousScene != nil,hasNext: nextScene != nil,
      reduceMotion: suppressMotion)
    if selection.lowerOffset == -1, let previousScene { lower = previousScene }
    if selection.upperOffset == 1, let nextScene { upper = nextScene }
    progress = selection.progress
    let reachScale = editorPulse.reachScale(at: CACurrentMediaTime())
    var uniforms = GPUUniforms(
      size: SIMD4(Float(manifest.width),Float(manifest.height),Float(lower.count),manifest.glow ? 1 : 0),
      veil: SIMD4(manifest.veil[0]/255,manifest.veil[1]/255,manifest.veil[2]/255,manifest.veil[3]/255),
      tuning: SIMD4(manifest.merge,manifest.seam,manifest.seamMix,manifest.seamSharpness),
      tuning2: SIMD4(manifest.fringe,manifest.coreShare,lower.maxReach,0),
      offsets: SIMD4(manifest.covers?.offset ?? .max,
        ClimbOverlayMotion.selectStampLayers(lower: lower.stampLayers,upper: upper.stampLayers,progress: progress),0,0),
      viewport: SIMD4(Float(view.drawableSize.width),Float(view.drawableSize.height),0,0),
      motion: SIMD4(progress,ClimbOverlayMotion.revealBand,0,reachScale),
      other: SIMD4(Float(upper.count),upper.maxReach,
        previousFrames != nil || nextFrames != nil || animateEdits ? 1 : 0,displayMirrored ? 1 : 0),
      coverCrop: manifest.covers?.crop ?? .zero)
    encoder.setRenderPipelineState(pipeline)
    encoder.setFragmentBuffer(scene.atlas.pixels, offset: 0, index: 0)
    encoder.setFragmentBuffer(lower.holds, offset: 0, index: 1)
    encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GPUUniforms>.stride, index: 2)
    encoder.setFragmentBuffer(scene.atlas.lut, offset: 0, index: 3)
    encoder.setFragmentBuffer(upper.holds, offset: 0, index: 4)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    let generation = revision
    let request = requestId
    let editCount = editChangedHoldCount
    let editDurationMs = scheduledEditDurationMs
    let lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
    #if targetEnvironment(simulator)
    // Simulator exposes only the legacy diagnostic capability. Its command
    // completion says pixels were rendered, not that a drawable was displayed.
    let requiresPresentation = false
    #else
    let requiresPresentation = frames != nil
    #endif
    // These are accessed only on main. A drawable callback and a command
    // completion can arrive in either order; v2 readiness needs both.
    var finishedGPUMs: Double?
    var presented = false
    let reportReady: () -> Void = { [weak self] in
      guard let self, let gpuMs = finishedGPUMs,
        !requiresPresentation || presented,
        self.revision == generation, self.requestId == request,
        self.configRevision == self.submittedConfigRevision, self.frames == self.submittedFrames,
        self.previousFrames == self.submittedPreviousFrames, self.nextFrames == self.submittedNextFrames,
        self.centerPage == self.submittedCenterPage,
        self.active, !self.background, self.window != nil,
        self.reportedRevision != generation else { return }
      self.reportedRevision = generation
      self.beginPresentedEditorMotion()
      self.onRenderReady(["requestId":request,"prepareMs":scene.prepareMs,
        "uploadMs":scene.cacheHit ? 0 : scene.atlas.uploadMs,"gpuMs":gpuMs,
        "atlasBytes":scene.atlas.pixels.length,"atlasCacheHit":scene.cacheHit,
        "editChangedHoldCount":editCount,"editDurationMs":editDurationMs,"lowPowerMode":lowPowerMode])
    }
    #if !targetEnvironment(simulator)
    if requiresPresentation {
      drawable.addPresentedHandler { _ in
        DispatchQueue.main.async { presented = true; reportReady() }
      }
    }
    #endif
    command.addCompletedHandler { [weak self, lower, upper] completed in
      // Metal retains MTLBuffer objects itself. Keep their budget reservations
      // alive until completion, including upper/previous buffers and atlases.
      defer { withExtendedLifetime((lower,upper)) {} }
      let gpuMs = max(0, completed.gpuEndTime-completed.gpuStartTime)*1000
      DispatchQueue.main.async { [weak self] in
        guard let self, self.revision == generation, self.requestId == request,
          self.configRevision == self.submittedConfigRevision, self.frames == self.submittedFrames,
          self.previousFrames == self.submittedPreviousFrames, self.nextFrames == self.submittedNextFrames,
          self.centerPage == self.submittedCenterPage,
          self.active, !self.background, self.window != nil else { return }
        if completed.status == .error {
          self.onRenderError(["requestId":request,"reason":completed.error?.localizedDescription ?? "GPU command failed"])
        } else {
          finishedGPUMs = gpuMs
          reportReady()
        }
      }
    }
    command.present(drawable)
    command.commit()
  }
}
