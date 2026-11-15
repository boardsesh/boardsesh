import ExpoModulesCore
import MetalKit
import UIKit
import BoardRendererModule

let climbOverlayGPUWorkQueue = DispatchQueue(label: "com.boardsesh.climb-overlay-gpu", qos: .userInitiated)

private struct AtlasRole: Decodable {
  let state: UInt32
  let color: [Float]
  let fill: UInt32
  let plate: UInt32
  let glyph: UInt32
}

private struct AtlasHold: Decodable {
  let id: UInt32
  let mirror: UInt32?
  let x: UInt32
  let y: UInt32
  let width: UInt32
  let height: UInt32
  let bounds: [Float]
  let field: UInt32
  let reach: Float
  let roles: [AtlasRole]
}

private struct AtlasManifest: Decodable {
  let version: Int
  let width: UInt32
  let height: UInt32
  let covers: UInt32
  let veil: [Float]
  let mirrored: Bool
  let glow: Bool
  let merge: Float
  let seam: Float
  let seamMix: Float
  let seamSharpness: Float
  let fringe: Float
  let coreShare: Float
  let lut: [Float]
  let holds: [AtlasHold]
}

// Six 16-byte vectors, matching Metal's Hold exactly.
private struct GPUHold {
  var color: SIMD4<Float>
  var bounds: SIMD4<Float>
  var crop: SIMD4<UInt32>
  var offsets: SIMD4<UInt32>
  var numbers: SIMD4<Float>
  var identity: SIMD4<UInt32>
}

private struct GPUUniforms {
  var size: SIMD4<Float>
  var veil: SIMD4<Float>
  var tuning: SIMD4<Float>
  var tuning2: SIMD4<Float>
  var offsets: SIMD4<UInt32>
  var viewport: SIMD4<Float>
  var motion: SIMD4<Float>
  var other: SIMD4<Float>
}

private struct GPUAtlas {
  let manifest: AtlasManifest
  let pixels: MTLBuffer
  let lut: MTLBuffer
  let holds: [UInt32: AtlasHold]
  let supportedStates: Set<UInt32>
  let uploadMs: Double
}

private struct GPUScene {
  let atlas: GPUAtlas
  let holds: MTLBuffer
  let count: Int
  let maxReach: Float
  let prepareMs: Double
  let cacheHit: Bool
  let descriptors: [GPUHold]
}

private struct GPUScenes {
  let current: GPUScene
  let previous: GPUScene?
  let next: GPUScene?
}

private enum OverlayFailure: Error {
  case reason(String)
}

/// All compilation, atlas preparation and cache access are on this serial
/// queue. Only the completed immutable scene crosses to the main thread.
private enum OverlayRenderer {
  static let work = climbOverlayGPUWorkQueue
  static let device = MTLCreateSystemDefaultDevice()
  static var pipeline: MTLRenderPipelineState?
  static var commands: MTLCommandQueue?
  static var cache: (source: String, key: Data, atlas: GPUAtlas)?
  static let memoryWarningObserver = NotificationCenter.default.addObserver(
    forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
  ) { _ in OverlayRenderer.work.async { OverlayRenderer.cache = nil } }

  static func prepare(configJson: String, frames overrideFrames: String? = nil,
                      preparedAtlas: GPUAtlas? = nil, strictRoles: Bool = false) throws -> GPUScene {
    guard let device else { throw OverlayFailure.reason("Metal unavailable") }
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
    } else if let overrideFrames, let cached = cache, cached.source == configJson {
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
      hit = cache?.key == key
      if hit, let cached = cache {
        atlas = cached.atlas
        cache = (configJson, key, atlas)
      }
      else {
        // One bounded global entry survives carousel view replacement, so
        // moving to a neighbouring climb does not rebuild the same layout.
        cache = nil
        atlas = try makeAtlas(config: key, device: device)
        cache = (configJson, key, atlas)
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
      active.append(GPUHold(
        color: SIMD4(role.color[0]/255, role.color[1]/255, role.color[2]/255, 1),
        bounds: SIMD4(hold.bounds[0],hold.bounds[1],hold.bounds[2],hold.bounds[3]),
        crop: SIMD4(hold.x,hold.y,hold.width,hold.height),
        offsets: SIMD4(hold.field,role.fill,role.plate,role.glyph),
        numbers: SIMD4(hold.reach,0,0,0),identity: SIMD4(hold.id,state,0,0)))
    }
    let count = active.count
    if strictRoles && !frames.isEmpty && count == 0 {
      throw OverlayFailure.reason("GPU source contains no matching holds")
    }
    let maxReach = active.map { $0.numbers.x }.max() ?? 0
    // Metal requires a nonempty buffer even when the shader loop runs zero times.
    let descriptors = active
    if active.isEmpty {
      active.append(GPUHold(color: .zero, bounds: .zero, crop: .zero, offsets: .zero, numbers: .zero, identity: .zero))
    }
    guard let holds = device.makeBuffer(bytes: active, length: active.count * MemoryLayout<GPUHold>.stride) else {
      throw OverlayFailure.reason("Active hold allocation failed")
    }
    return GPUScene(atlas: atlas, holds: holds, count: count, maxReach: maxReach,
                    prepareMs: (CACurrentMediaTime()-start)*1000, cacheHit: hit, descriptors: descriptors)
  }

  static func replacingDescriptors(_ scene: GPUScene, with descriptors: [GPUHold]) throws -> GPUScene {
    guard let device else { throw OverlayFailure.reason("Metal unavailable") }
    let buffer = descriptors.isEmpty
      ? [GPUHold(color: .zero,bounds: .zero,crop: .zero,offsets: .zero,numbers: .zero,identity: .zero)]
      : descriptors
    guard let holds = device.makeBuffer(bytes: buffer,length: buffer.count*MemoryLayout<GPUHold>.stride) else {
      throw OverlayFailure.reason("Motion hold allocation failed")
    }
    return GPUScene(atlas: scene.atlas,holds: holds,count: descriptors.count,maxReach: scene.maxReach,
      prepareMs: scene.prepareMs,cacheHit: scene.cacheHit,descriptors: descriptors)
  }

  static func prepareSources(configJson: String, frames: String?, previous: String?, next: String?,
                             preparedAtlas: GPUAtlas?, editBaseline: [UInt32: UInt32]?) throws -> GPUScenes {
    let started = CACurrentMediaTime()
    let current = try prepare(configJson: configJson,frames: frames,preparedAtlas: preparedAtlas,
                              strictRoles: previous != nil || next != nil)
    let previousScene = try previous.map { try prepare(configJson: configJson,frames: $0,
      preparedAtlas: current.atlas,strictRoles: true) }
    let nextScene = try next.map { try prepare(configJson: configJson,frames: $0,
      preparedAtlas: current.atlas,strictRoles: true) }
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
      descriptors: annotatedCurrent.descriptors)
    return GPUScenes(current: timedCurrent,previous: annotatedPrevious,next: annotatedNext)
  }

  private static func makeAtlas(config: Data, device: MTLDevice) throws -> GPUAtlas {
    var pointer: UnsafeMutablePointer<UInt8>?
    var length: UInt32 = 0
    let status = config.withUnsafeBytes { bytes in
      board_renderer_prepare_gpu_atlas(bytes.bindMemory(to: UInt8.self).baseAddress, UInt32(bytes.count), &pointer, &length)
    }
    guard status == 0, let pointer else { throw OverlayFailure.reason("Atlas preparation rejected config (\(status))") }
    defer { board_renderer_free(pointer, length) }
    guard length >= 4 else { throw OverlayFailure.reason("Invalid atlas header") }
    let headerLength = Int(UInt32(pointer[0]) | UInt32(pointer[1]) << 8 | UInt32(pointer[2]) << 16 | UInt32(pointer[3]) << 24)
    guard headerLength > 0, headerLength <= 2 * 1024 * 1024, headerLength + 4 < Int(length) else {
      throw OverlayFailure.reason("Invalid atlas manifest size")
    }
    let manifest = try JSONDecoder().decode(AtlasManifest.self, from: Data(bytes: pointer+4, count: headerLength))
    let payloadLength = Int(length)-headerLength-4
    guard manifest.version == 1, manifest.lut.count == 257, manifest.veil.count == 4,
      manifest.width > 0, manifest.width <= 1536, manifest.height > 0, manifest.height <= 2048,
      payloadLength <= 128 * 1024 * 1024,
      Int(manifest.covers) + Int(manifest.width)*Int(manifest.height)*4 <= payloadLength
    else { throw OverlayFailure.reason("Invalid atlas layout") }
    var holdIndex: [UInt32: AtlasHold] = [:]
    for hold in manifest.holds {
      let pixels = Int(hold.width)*Int(hold.height)
      guard hold.bounds.count == 4, Int(hold.field)+pixels*8 <= payloadLength,
        hold.roles.allSatisfy({ role in
          role.color.count == 3 && [role.fill,role.plate,role.glyph].allSatisfy { offset in
            offset == UInt32.max || Int(offset)+pixels*4 <= payloadLength
          }
        }) else { throw OverlayFailure.reason("Invalid atlas hold") }
      holdIndex[hold.id] = hold
    }
    let uploadStart = CACurrentMediaTime()
    guard let pixels = device.makeBuffer(bytes: pointer+4+headerLength, length: payloadLength),
      let lut = device.makeBuffer(bytes: manifest.lut, length: manifest.lut.count * MemoryLayout<Float>.size)
    else { throw OverlayFailure.reason("GPU atlas allocation failed") }
    return GPUAtlas(manifest: manifest, pixels: pixels, lut: lut, holds: holdIndex,
                    supportedStates: Set(manifest.holds.flatMap { $0.roles.map(\.state) }),
                    uploadMs: (CACurrentMediaTime()-uploadStart)*1000)
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
  guard let texture = device.makeTexture(descriptor: textureDescriptor) else {
    throw OverlayFailure.reason("Comparison texture allocation failed")
  }
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
    offsets: SIMD4(manifest.covers,0,0,0),viewport: SIMD4(Float(width),Float(height),0,0),
    motion: SIMD4(0,1,1,1),other: .zero)
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
    didSet { if configJson != oldValue { configRevision &+= 1 } }
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
  private var editorBaseline: [UInt32: UInt32]?
  private var editorBaselineRevision: UInt64?
  private var editorStart: CFTimeInterval?
  private var editorDisplayLink: CADisplayLink?
  private var editChangedHoldCount = 0
  private var scheduledEditDurationMs: Double = 0
  private var suppressMotion: Bool { reduceMotion || UIAccessibility.isReduceMotionEnabled }

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
    editorStart = nil
  }

  private func startEditorMotion() -> Bool {
    stopEditorMotion()
    guard animateEdits, !suppressMotion, !ProcessInfo.processInfo.isLowPowerModeEnabled,
      active, !background, window != nil else { return false }
    editorStart = CACurrentMediaTime()
    let link = CADisplayLink(target: self,selector: #selector(editorTick))
    link.preferredFramesPerSecond = 60
    link.add(to: .main,forMode: .common)
    editorDisplayLink = link
    return true
  }

  @objc private func editorTick() {
    guard let started = editorStart, active, !background, window != nil,
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
    let layoutRevision = configRevision
    let frame = frames
    let previous = previousFrames
    let next = nextFrames
    let page = centerPage.isFinite ? centerPage : 0
    let baseline = animateEdits && editorBaselineRevision == layoutRevision ? editorBaseline : nil
    let request = requestId
    let reusableAtlas = preparedConfigRevision == layoutRevision ? preparedAtlas : nil
    submittedConfigRevision = layoutRevision
    submittedFrames = frame
    submittedPreviousFrames = previous
    submittedNextFrames = next
    submittedCenterPage = page
    submittedRequest = request
    OverlayRenderer.work.async { [weak self] in
      let result = Result { try OverlayRenderer.prepareSources(configJson: config,frames: frame,
        previous: previous,next: next,preparedAtlas: reusableAtlas,editBaseline: baseline) }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.preparing = false
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
    let illumination = editorStart.map {
      ClimbOverlayMotion.editIllumination(elapsed: CACurrentMediaTime()-$0)
    } ?? 1
    var uniforms = GPUUniforms(
      size: SIMD4(Float(manifest.width),Float(manifest.height),Float(lower.count),manifest.glow ? 1 : 0),
      veil: SIMD4(manifest.veil[0]/255,manifest.veil[1]/255,manifest.veil[2]/255,manifest.veil[3]/255),
      tuning: SIMD4(manifest.merge,manifest.seam,manifest.seamMix,manifest.seamSharpness),
      tuning2: SIMD4(manifest.fringe,manifest.coreShare,lower.maxReach,0),
      offsets: SIMD4(manifest.covers,0,0,0),
      viewport: SIMD4(Float(view.drawableSize.width),Float(view.drawableSize.height),0,0),
      motion: SIMD4(progress,ClimbOverlayMotion.revealBand,0,illumination),
      other: SIMD4(Float(upper.count),upper.maxReach,
        previousFrames != nil || nextFrames != nil || animateEdits ? 1 : 0,displayMirrored ? 1 : 0))
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
    command.addCompletedHandler { [weak self] completed in
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
