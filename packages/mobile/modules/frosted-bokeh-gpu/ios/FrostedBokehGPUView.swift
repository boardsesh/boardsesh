import ExpoModulesCore
import MetalKit
import UIKit

/// One blob as the shader reads it. Layout matches `Blob` in the shader:
/// float2 (8) + float + float, then float4 on a 16-byte boundary = 32 bytes.
struct GPUBlob {
  var pos: SIMD2<Float>
  var r: Float
  var peak: Float
  var color: SIMD4<Float>
}

/// Layout matches `Uniforms` in the shader: 64 bytes, scalars only after the
/// float4 so Swift and Metal agree on every offset.
struct GPUUniforms {
  var size: SIMD2<Float>
  var time: Float
  var blend: Float
  var base: SIMD4<Float>
  var count: Int32
  var drift: Float
  var scale: Float
  var motion: Float
  var swell: Float
  var pad0: Float = 0
  var pad1: Float = 0
  var pad2: Float = 0
}

/// Draws the blobs and moves them. It redraws only while something moves:
/// 15 fps for the breathing (a light's fastest drift is about 2 pt/s, a tenth
/// of a point a frame), 60 fps while gliding to the next climb, and nothing at
/// all when the view is off screen, the app is in the background, Reduce Motion
/// is on (no breathing, no glide) or Low Power Mode is on (no breathing).
final class FrostedBokehGPUView: ExpoView, MTKViewDelegate {
  let onRenderError = EventDispatcher()

  // Props land here; applyProps() takes them together once per update.
  var pendingBlobs: [GPUBlobRecord] = []
  var pendingBase = "#0E0D12"
  var pendingBlend = "screen"
  var pendingKey = ""
  var pendingReduceMotion = false
  var pendingDrift = 0.0
  var pendingSwell = 0.0
  var pendingGlideMs = 0.0

  private static let breathingFramesPerSecond = 15
  private static let glidingFramesPerSecond = 60

  private let mtkView: MTKView
  private let startTime = CACurrentMediaTime()

  private var blend: Float = 0
  private var base = SIMD4<Float>(0, 0, 0, 1)
  private var key: String?
  private var reduceMotion = false
  private var drift: Float = 0
  private var swell: Float = 0
  private var glideDuration: CFTimeInterval = 0
  private var target: [GPUBlob] = []
  /// What a glide starts from, until it finishes.
  private var source: [GPUBlob]?
  private var glideStart: CFTimeInterval = 0
  private var inBackground = UIApplication.shared.applicationState == .background
  private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
  private var reportedError = false

  required init(appContext: AppContext? = nil) {
    BokehRenderer.warmUp()
    mtkView = MTKView(frame: .zero, device: BokehRenderer.device)
    super.init(appContext: appContext)
    clipsToBounds = true
    isUserInteractionEnabled = false
    mtkView.colorPixelFormat = .bgra8Unorm
    mtkView.framebufferOnly = true
    // Transparent until the first frame lands, so the React Native base colour
    // behind shows instead of black.
    mtkView.isOpaque = false
    mtkView.clearColor = MTLClearColorMake(0, 0, 0, 0)
    mtkView.delegate = self
    mtkView.isPaused = true
    mtkView.enableSetNeedsDisplay = true
    mtkView.isUserInteractionEnabled = false
    addSubview(mtkView)

    // Selector-based observers are dropped with the view; no deinit needed.
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    center.addObserver(self, selector: #selector(powerStateDidChange), name: .NSProcessInfoPowerStateDidChange, object: nil)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    mtkView.frame = bounds
    updateScale()
    mtkView.setNeedsDisplay()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // The trait collection's scale can read 0 before the view joins a window.
    updateScale()
    updateLoop(now: CACurrentMediaTime())
    mtkView.setNeedsDisplay()
  }

  private func updateScale() {
    let scale = traitCollection.displayScale
    mtkView.contentScaleFactor = scale > 0 ? scale : (window?.screen.scale ?? UIScreen.main.scale)
  }

  func applyProps() {
    if BokehRenderer.pipeline == nil {
      reportRenderError("pipeline")
      return
    }
    let now = CACurrentMediaTime()
    blend = pendingBlend == "screen" ? 0 : (pendingBlend == "multiply" ? 1 : 2)
    base = Self.rgba(pendingBase)
    reduceMotion = pendingReduceMotion
    drift = Float(max(0, pendingDrift))
    swell = Float(max(0, pendingSwell))
    glideDuration = max(0, pendingGlideMs) / 1000
    let next = pendingBlobs.prefix(BokehRenderer.maxBlobs).map {
      GPUBlob(
        pos: SIMD2(Float($0.x), Float($0.y)),
        r: Float($0.r),
        peak: Float($0.peak),
        color: Self.rgba($0.color)
      )
    }
    if let key, key != pendingKey, !reduceMotion, glideDuration > 0 {
      // Glide from what is on screen right now, a glide in progress included.
      source = blobs(at: now)
      glideStart = now
    } else if key != pendingKey || reduceMotion {
      source = nil
    }
    key = pendingKey
    target = Array(next)
    updateLoop(now: now)
    if !inBackground {
      mtkView.setNeedsDisplay()
    }
  }

  // MARK: - Motion

  private var breathing: Bool {
    !reduceMotion && !lowPower && drift + swell > 0
  }

  /// 0...1 through the current glide, or nil when there is none.
  private func glideProgress(at now: CFTimeInterval) -> Double? {
    guard source != nil, glideDuration > 0 else { return nil }
    let progress = (now - glideStart) / glideDuration
    return progress >= 1 ? nil : max(0, progress)
  }

  private func updateLoop(now: CFTimeInterval) {
    let gliding = glideProgress(at: now) != nil
    let running = window != nil && !inBackground && (breathing || gliding)
    mtkView.preferredFramesPerSecond = gliding ? Self.glidingFramesPerSecond : Self.breathingFramesPerSecond
    mtkView.enableSetNeedsDisplay = !running
    mtkView.isPaused = !running
  }

  /// The blobs for one frame: the target, or the glide's in-between. Lights
  /// pair by index (the shared geometry orders them along the board); a light
  /// with no partner fades out where it was, or in where it lands.
  private func blobs(at now: CFTimeInterval) -> [GPUBlob] {
    guard let source, let progress = glideProgress(at: now) else { return target }
    let eased = Float(progress * progress * (3 - 2 * progress))
    var out: [GPUBlob] = []
    out.reserveCapacity(max(source.count, target.count))
    for index in 0..<max(source.count, target.count) {
      let from = index < source.count ? source[index] : nil
      let to = index < target.count ? target[index] : nil
      if let from, let to {
        out.append(GPUBlob(
          pos: from.pos + (to.pos - from.pos) * eased,
          r: from.r + (to.r - from.r) * eased,
          peak: from.peak + (to.peak - from.peak) * eased,
          color: from.color + (to.color - from.color) * eased
        ))
      } else if let from {
        out.append(GPUBlob(pos: from.pos, r: from.r, peak: from.peak * (1 - eased), color: from.color))
      } else if let to {
        out.append(GPUBlob(pos: to.pos, r: to.r, peak: to.peak * eased, color: to.color))
      }
    }
    return out
  }

  @objc private func didEnterBackground() {
    inBackground = true
    updateLoop(now: CACurrentMediaTime())
  }

  @objc private func willEnterForeground() {
    inBackground = false
    updateLoop(now: CACurrentMediaTime())
    mtkView.setNeedsDisplay()
  }

  @objc private func powerStateDidChange() {
    // Posted on an arbitrary queue.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
      self.updateLoop(now: CACurrentMediaTime())
      self.mtkView.setNeedsDisplay()
    }
  }

  private func reportRenderError(_ reason: String) {
    guard !reportedError else { return }
    reportedError = true
    onRenderError(["reason": reason])
  }

  // MARK: - MTKViewDelegate

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
    view.setNeedsDisplay()
  }

  func draw(in view: MTKView) {
    // Metal refuses GPU work from a backgrounded app, and asking for a drawable
    // there can block the main thread. willEnterForeground redraws.
    guard !inBackground else { return }
    let now = CACurrentMediaTime()
    if source != nil, glideProgress(at: now) == nil {
      source = nil
    }
    var frame = blobs(at: now)
    let count = Int32(frame.count)
    if frame.isEmpty {
      // setFragmentBytes needs a non-empty buffer; count 0 draws only the base.
      frame = [GPUBlob(pos: .zero, r: 0, peak: 0, color: .zero)]
    }
    var uniforms = GPUUniforms(
      size: SIMD2(Float(bounds.width), Float(bounds.height)),
      // Wrapped so Float keeps sub-millisecond precision in a long session; the
      // orbit's phase jump at the wrap is a few points once every ~3 hours.
      time: Float((now - startTime).truncatingRemainder(dividingBy: 10_000)),
      blend: blend,
      base: base,
      count: count,
      drift: drift,
      scale: Float(view.contentScaleFactor),
      motion: breathing ? 1 : 0,
      swell: swell
    )
    if !BokehRenderer.draw(in: view, uniforms: &uniforms, blobs: frame) {
      reportRenderError("draw")
    }
    updateLoop(now: now)
  }

  // MARK: - Parsing

  private static func rgba(_ hex: String) -> SIMD4<Float> {
    var clean = hex.trimmingCharacters(in: .whitespaces)
    if clean.hasPrefix("#") { clean.removeFirst() }
    if clean.count == 3 { clean = clean.map { "\($0)\($0)" }.joined() }
    let value = UInt32(clean.prefix(6), radix: 16) ?? 0
    return SIMD4(
      Float((value >> 16) & 0xFF) / 255,
      Float((value >> 8) & 0xFF) / 255,
      Float(value & 0xFF) / 255,
      1
    )
  }
}

/// The shared device, queue and pipeline. The shader compiles from source once
/// per launch (a few milliseconds), so no metallib has to survive CocoaPods
/// packaging.
enum BokehRenderer {
  /// `MAX_BOKEH_BLOBS` in `@boardsesh/frosted-bokeh`, doubled for headroom.
  static let maxBlobs = 30

  static let device = MTLCreateSystemDefaultDevice()
  private static let queue = device?.makeCommandQueue()

  private static let warmUpOnce: Void = {
    DispatchQueue.global(qos: .userInitiated).async { _ = pipeline }
  }()

  /// Compiles the shader on a background queue, so the first frame on the
  /// main thread finds it ready instead of compiling it there.
  static func warmUp() {
    _ = warmUpOnce
  }

  static let pipeline: MTLRenderPipelineState? = {
    guard let device else { return nil }
    do {
      let library = try device.makeLibrary(source: bokehShaderSource, options: nil)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "bokehVertex")
      descriptor.fragmentFunction = library.makeFunction(name: "bokehFragment")
      descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
      return try device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      NSLog("[FrostedBokehGPU] shader compile failed: \(error)")
      return nil
    }
  }()

  /// False when the frame could not be encoded at all. A missing drawable is
  /// not an error: the next frame tries again.
  static func draw(in view: MTKView, uniforms: inout GPUUniforms, blobs: [GPUBlob]) -> Bool {
    guard let pipeline, let queue else { return false }
    guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable else { return true }
    guard
      let commands = queue.makeCommandBuffer(),
      let encoder = commands.makeRenderCommandEncoder(descriptor: pass)
    else { return false }
    encoder.setRenderPipelineState(pipeline)
    encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GPUUniforms>.stride, index: 0)
    blobs.withUnsafeBytes { bytes in
      if let address = bytes.baseAddress {
        encoder.setFragmentBytes(address, length: bytes.count, index: 1)
      }
    }
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    commands.present(drawable)
    commands.commit()
    return true
  }
}
