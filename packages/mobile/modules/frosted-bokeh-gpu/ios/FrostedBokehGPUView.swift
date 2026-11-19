import ExpoModulesCore
import MetalKit
import UIKit

/// One blob as the shader reads it. Layout matches `Blob` in the shader:
/// float2 (8) + float + float, then float4 on a 16-byte boundary = 32 bytes.
/// The colour's alpha carries the light's breathing seed.
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
/// of a point a frame), 60 fps while the board's swap frames arrive or a
/// release runs (`BokehMotion`), and nothing at all when the view is off
/// screen or the app is in the background. Reduce Motion and Low Power Mode
/// stop the breathing. (The app draws a still frost under Reduce Motion.)
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
  var pendingSwapClimbs: GPUSwapClimbsRecord?
  var pendingSwapLook: [Double]?
  var pendingReleaseMs = 220.0
  var pendingReleaseOutMs = 150.0

  private static let breathingFramesPerSecond = 15
  private static let movingFramesPerSecond = 60
  /// Swap frames arrive only while the board moves; this long after the last one the loop slows down.
  private static let frameQuiet: CFTimeInterval = 0.1

  private let mtkView: MTKView
  private let startTime = CACurrentMediaTime()
  private let motion = BokehMotion()

  private var blend: Float = 0
  private var base = SIMD4<Float>(0, 0, 0, 1)
  private var reduceMotion = false
  private var drift: Float = 0
  private var swell: Float = 0
  private var lastFrameAt: CFTimeInterval = -1
  private var inBackground = UIApplication.shared.applicationState == .background
  private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
  private var lifecycle = BokehRenderLifecycle()
  private var propsApplied = false

  required init(appContext: AppContext? = nil) {
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
    BokehRenderer.resources.load { [weak self] in
      guard let self, self.propsApplied else { return }
      self.applyProps()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    mtkView.frame = bounds
    motion.width = Float(bounds.width)
    updateScale()
    mtkView.setNeedsDisplay()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // The trait collection's scale can read 0 before the view joins a window.
    updateScale()
    if propsApplied { applyProps() }
    updateLoop(now: CACurrentMediaTime())
    mtkView.setNeedsDisplay()
  }

  private func updateScale() {
    let scale = traitCollection.displayScale
    mtkView.contentScaleFactor = scale > 0 ? scale : (window?.screen.scale ?? UIScreen.main.scale)
  }

  func applyProps() {
    propsApplied = true
    updateLoop(now: CACurrentMediaTime())
    guard !lifecycle.failed else { return }
    // The base colour behind this transparent surface remains visible while
    // compilation runs. Never read a lazy pipeline initializer on the UI thread.
    guard let prepared = BokehRenderer.resources.result else { return }
    guard case .success = prepared else {
      reportRenderError("pipeline")
      return
    }
    let now = CACurrentMediaTime()
    blend = pendingBlend == "screen" ? 0 : (pendingBlend == "multiply" ? 1 : 2)
    base = Self.rgba(pendingBase)
    reduceMotion = pendingReduceMotion
    drift = Float(max(0, pendingDrift))
    swell = Float(max(0, pendingSwell))
    motion.look = BokehSwapLook(pendingSwapLook)
    motion.releaseSeconds = max(0.001, pendingReleaseMs / 1000)
    motion.fadeSeconds = max(0.001, pendingReleaseOutMs / 1000)
    let current = BokehClimb(key: pendingKey, lights: Self.lights(pendingBlobs))
    var pages: [Int: BokehClimb] = [:]
    if let climbs = pendingSwapClimbs {
      let center = BokehMotion.page(climbs.centerPage)
      pages[center] = current
      if let previous = climbs.previous { pages[center - 1] = BokehClimb(key: previous.key, lights: Self.lights(previous.blobs)) }
      if let next = climbs.next { pages[center + 1] = BokehClimb(key: next.key, lights: Self.lights(next.blobs)) }
    }
    motion.setClimbs(current: current, pages: pages, now: now)
    updateLoop(now: now)
    if !inBackground {
      mtkView.setNeedsDisplay()
    }
  }

  /// The board's swap frame, from the `swapFrame` command or prop.
  func setSwapFrame(_ values: [Double]) {
    let now = CACurrentMediaTime()
    guard motion.applyFrame(values, now: now) else { return }
    lastFrameAt = now
    updateLoop(now: now)
    if !inBackground {
      mtkView.setNeedsDisplay()
    }
  }

  /// Fabric view commands. Reanimated's `dispatchCommand` reaches here through
  /// RCTMountingManager, inline on the main thread when it dispatches from the
  /// UI runtime, without waiting for a React commit (as `ClimbOverlayGPUView`).
  /// Swift sees ExpoFabricViewObjC as a plain UIView, so this names the
  /// selector that RCTViewComponentView implements; anything but `swapFrame`
  /// goes to that.
  @objc(handleCommand:args:)
  func handleViewCommand(_ commandName: NSString, args: NSArray) {
    guard commandName as String == "swapFrame" else {
      forwardViewCommand(commandName, args: args)
      return
    }
    var values: [Double] = []
    for arg in args {
      guard let number = arg as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return }
      values.append(number.doubleValue)
    }
    setSwapFrame(values)
  }

  private func forwardViewCommand(_ commandName: NSString, args: NSArray) {
    typealias CommandHandler = @convention(c) (AnyObject, Selector, NSString, NSArray) -> Void
    let selector = #selector(handleViewCommand(_:args:))
    guard let parent = FrostedBokehGPUView.superclass(),
      let method = class_getInstanceMethod(parent, selector)
    else { return }
    unsafeBitCast(method_getImplementation(method), to: CommandHandler.self)(self, selector, commandName, args)
  }

  private static func lights(_ records: [GPUBlobRecord]) -> [BokehLight] {
    records.prefix(BokehMotion.maxLights).map { record in
      let color = rgba(record.color)
      let x = Float(record.x)
      let y = Float(record.y)
      return BokehLight(
        // Hold ids are small; anything past 2^53 is not one, and Int64() would trap past 2^63.
        id: record.id >= 0 && record.id < 9_007_199_254_740_992 ? Int64(record.id) : -1,
        seed: record.seed >= 0 && record.seed.isFinite ? Float(record.seed) : BokehLight.positionSeed(x: x, y: y),
        x: x, y: y, r: Float(record.r), peak: Float(record.peak),
        red: color.x, green: color.y, blue: color.z)
    }
  }

  // MARK: - Motion

  private var breathing: Bool {
    !reduceMotion && !lowPower && drift + swell > 0
  }

  private func moving(at now: CFTimeInterval) -> Bool {
    motion.transitioning(now) || (lastFrameAt >= 0 && now - lastFrameAt < Self.frameQuiet)
  }

  private func updateLoop(now: CFTimeInterval) {
    lifecycle.setActive(window != nil && !inBackground)
    let moving = moving(at: now)
    let running = propsApplied && lifecycle.active && !lifecycle.failed && BokehRenderer.ready && (breathing || moving)
    mtkView.preferredFramesPerSecond = moving ? Self.movingFramesPerSecond : Self.breathingFramesPerSecond
    mtkView.enableSetNeedsDisplay = !running
    mtkView.isPaused = !running
  }

  @objc private func didEnterBackground() {
    inBackground = true
    updateLoop(now: CACurrentMediaTime())
  }

  @objc private func willEnterForeground() {
    inBackground = false
    if propsApplied { applyProps() }
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

  private func reportRenderError(_ reason: String, generation: UInt64? = nil) {
    guard lifecycle.fail(generation: generation ?? lifecycle.generation) else { return }
    updateLoop(now: CACurrentMediaTime())
    onRenderError(["reason": reason])
  }

  // MARK: - MTKViewDelegate

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
    view.setNeedsDisplay()
  }

  func draw(in view: MTKView) {
    // Metal refuses GPU work from a backgrounded app, and asking for a drawable
    // there can block the main thread. willEnterForeground redraws.
    guard propsApplied, lifecycle.active, !lifecycle.failed, BokehRenderer.ready else { return }
    let now = CACurrentMediaTime()
    var frame = motion.lights(now).map {
      GPUBlob(pos: SIMD2($0.x, $0.y), r: $0.r, peak: $0.peak, color: SIMD4($0.red, $0.green, $0.blue, $0.seed))
    }
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
    let generation = lifecycle.generation
    if !BokehRenderer.draw(in: view, uniforms: &uniforms, blobs: frame, onFailure: { [weak self] in
      self?.reportRenderError("gpu-command", generation: generation)
    }) {
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

/// Shared resources compile once on the preparation queue. Main-thread callers
/// only read a published result, including while the compiler is still busy.
enum BokehRenderer {
  /// `MAX_GPU_BOKEH_LIGHTS` in `@boardsesh/frosted-bokeh`: two climbs of `MAX_BOKEH_BLOBS`.
  static let maxBlobs = BokehMotion.maxLights

  static let device = MTLCreateSystemDefaultDevice()
  struct Resources {
    let pipeline: MTLRenderPipelineState
    let queue: MTLCommandQueue
  }
  private enum PreparationFailure: Error { case unavailable }

  static let resources = BokehAsyncResource<Resources> {
    guard let device, let queue = device.makeCommandQueue() else { throw PreparationFailure.unavailable }
    let library = try device.makeLibrary(source: bokehShaderSource, options: nil)
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: "bokehVertex")
    descriptor.fragmentFunction = library.makeFunction(name: "bokehFragment")
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    return Resources(pipeline: try device.makeRenderPipelineState(descriptor: descriptor), queue: queue)
  }

  static var ready: Bool {
    if case .success? = resources.result { return true }
    return false
  }

  /// False when the frame could not be encoded at all. A missing drawable is
  /// not an error: the next frame tries again.
  static func draw(in view: MTKView, uniforms: inout GPUUniforms, blobs: [GPUBlob], onFailure: @escaping () -> Void) -> Bool {
    guard case .success(let prepared)? = resources.result else { return false }
    guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable else { return true }
    guard
      let commands = prepared.queue.makeCommandBuffer(),
      let encoder = commands.makeRenderCommandEncoder(descriptor: pass)
    else { return false }
    encoder.setRenderPipelineState(prepared.pipeline)
    encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GPUUniforms>.stride, index: 0)
    blobs.withUnsafeBytes { bytes in
      if let address = bytes.baseAddress {
        encoder.setFragmentBytes(address, length: bytes.count, index: 1)
      }
    }
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    commands.addCompletedHandler { completed in
      guard completed.status == .error else { return }
      DispatchQueue.main.async(execute: onFailure)
    }
    commands.present(drawable)
    commands.commit()
    return true
  }
}
