import ExpoModulesCore
import MetalKit
import UIKit
import BoardRendererModule
import os

let climbOverlayGPUWorkQueue = DispatchQueue(label: "com.boardsesh.climb-overlay-gpu", qos: .userInitiated)

private enum OverlayFailure: LocalizedError {
  case reason(String)
  var errorDescription: String? { if case .reason(let reason) = self { return reason };return nil }
}

/// Diagnostic only: same shader at the reference's exact pixel dimensions.
/// Runs on the preparation queue, writes only its own unique cache artifacts.
func compareClimbOverlayGPU(_ configJson: String) throws -> [String: Any] {
  let cancel = try ClimbOverlayRustCancellation()
  let preparation = ClimbOverlayPreparation(cancelAction: cancel.cancel)
  ClimbOverlayPacketMetrics.begin()
  defer { ClimbOverlayPacketMetrics.end() }
  let session = try ClimbOverlayMetalPackets.session(source: configJson,cancel: cancel)
  guard let packet = try ClimbOverlayMetalPackets.prepare(session: session,
    request: ClimbOverlaySourceRequest(current: nil,previous: nil,next: nil,editBaseline: nil),
    cancel: cancel,preparation: preparation),let device = ClimbOverlayMetalPackets.device,
    let pipeline = ClimbOverlayMetalPackets.pipeline,
    let command = ClimbOverlayMetalPackets.commands?.makeCommandBuffer() else {
    throw ClimbOverlayArenaFailure.pressure
  }
  let width = packet.header.width
  let height = packet.header.height
  let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm,
    width: width, height: height, mipmapped: false)
  textureDescriptor.usage = [.renderTarget]
  textureDescriptor.storageMode = .shared
  let textureEstimate = device.heapTextureSizeAndAlign(descriptor: textureDescriptor)
  guard let textureAllocation = ClimbOverlayBudget.allocationSize(requested: width*height*4,
    heapSize: textureEstimate.size,heapAlignment: textureEstimate.align) else { throw ClimbOverlayArenaFailure.pressure }
  guard let comparisonReservation = climbOverlayAggregateBudget.reserve(textureAllocation),
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
  guard let uniformSlot = packet.acquireUniforms() else { throw ClimbOverlayArenaFailure.pressure }
  defer { packet.releaseUniforms(uniformSlot) }
  try packet.uniforms(slot: uniformSlot,lower: 0,upper: 0,progress: 0,pulse: 1,viewport: SIMD2(Float(width),Float(height)),
    productionEmpty: false,mirrored: false)
  encoder.setRenderPipelineState(pipeline)
  encodeClimbOverlayPacket(packet,encoder: encoder,lower: 0,upper: 0,uniformSlot: uniformSlot)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  encoder.endEncoding()
  var submitted = false
  DispatchQueue.main.sync {
    guard UIApplication.shared.applicationState == .active else { return }
    ClimbOverlayPacketMetrics.gpuBegin()
    command.commit()
    submitted = true
  }
  guard submitted else { throw OverlayFailure.reason("Comparison paused while app inactive") }
  command.waitUntilCompleted()
  ClimbOverlayPacketMetrics.gpuEnd()
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
  guard Int(referenceWidth) == width, Int(referenceHeight) == height,
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
    "prepareMs":packet.prepareMs,"uploadMs":packet.uploadMs,
    "atlasBytes":packet.selectedBytes,"atlasCacheHit":packet.cacheHit,
    "gpuUri":try save(Data(gpu),name:"gpu.png"),
    "referenceUri":try save(Data(bytes: referencePointer, count: Int(referenceLength)),name:"rust.png")]
}

private let swapLookLog = Logger(subsystem: "com.boardsesh.climb-overlay-gpu",category: "swap-look")

final class ClimbOverlayGPUView: ExpoView, MTKViewDelegate {
  let onRenderReady = EventDispatcher()
  let onRenderError = EventDispatcher()
  /// Whether the swap look is drawing, sent when that changes, and only while
  /// `swapLookStateEvents` is on (the board motion lab's readout; the player leaves it off).
  let onSwapLookState = EventDispatcher()
  /// The app listens for `onSwapLookState`. On, it gets the state at once and on every change.
  var swapLookStateEvents = false {
    didSet {
      guard swapLookStateEvents != oldValue else { return }
      swapLookLastReport = [:]
      reportSwapLook()
    }
  }
  var configJson = "" {
    didSet { if configJson != oldValue { configRevision &+= 1; preparation?.cancel();cancelPrefetch();cpuSession = nil;carryOver = nil } }
  }
  var geometryAssetPath: String? {
    didSet { if geometryAssetPath != oldValue { configRevision &+= 1; preparation?.cancel();cancelPrefetch() } }
  }
  var geometryAssetSha256: String? {
    didSet { if geometryAssetSha256 != oldValue { configRevision &+= 1; preparation?.cancel();cancelPrefetch() } }
  }
  var generatedGeometryDirectory: String? {
    didSet { if generatedGeometryDirectory != oldValue { configRevision &+= 1; preparation?.cancel();cancelPrefetch() } }
  }
  var prefetchFrames: [String] = []
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
  private var revealMode = ClimbOverlayMotion.revealModeWipe
  private var outgoingWeight: Float = 1
  private var incomingWeight: Float = 0
  private var sharedWeight: Float = 1
  /// The swap look (the player's or the lab's) and which climbs arrive this frame.
  /// Nil draws API 7's swap.
  private var swapLook: ClimbOverlaySwapLook.Look?
  private var arrivals = ClimbOverlayMotion.SwapArrivals()
  /// A seven-number frame's shared floor, for the look; nil for the shipped four-number frames.
  private var sharedFloor: Float?
  private var swapLookRejected = false
  /// Holds in the last look drawn since the look last changed; nil until one is drawn.
  private var swapLookAppliedHolds: Int?
  private var swapLookLastReport: [String: AnyHashable] = [:]
  private var swapLookLogged = false
  /// The newest swap frame this view has applied, by the app's sequence.
  private var swapSequence = ClimbOverlayMotion.SwapFrameSequenceGate()
  /// The packet on screen when a new trio started preparing, kept drawing the
  /// running swap until the replacement is ready. Same layout revision only.
  private struct CarryOver {
    let packet: ClimbOverlayMetalPacket
    let centerPage: Double
    let configRevision: UInt64?
    let productionEmpty: Bool
  }
  private var carryOver: CarryOver?
  var requestId = ""
  var active = false
  private let metal: MTKView
  private var revision: UInt64 = 0
  private var reportedRevision: UInt64?
  private var packet: ClimbOverlayMetalPacket?
  private var cpuSession: ClimbOverlayRustSession?
  private var prefetch: ClimbOverlayPreparation?
  private var scheduledPrefetch: DispatchWorkItem?
  private var prefetchJob: ClimbOverlayPacketJob?
  private var submittedPrefetch: [String] = []
  private var configRevision: UInt64 = 0
  private var submittedConfigRevision: UInt64?
  private var submittedFrames: String?
  private var submittedPreviousFrames: String?
  private var submittedNextFrames: String?
  private var submittedCenterPage: Double = 0
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

  deinit { preparation?.cancel(releasingGPU: false);prefetch?.cancel();scheduledPrefetch?.cancel();prefetchJob?.cancel() }

  required init(appContext: AppContext? = nil) {
    metal = MTKView(frame: .zero, device: ClimbOverlayMetalPackets.device)
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
    NotificationCenter.default.addObserver(self, selector: #selector(motionPolicyChanged), name: UIAccessibility.differentiateWithoutColorDidChangeNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(motionPolicyChanged), name: .NSProcessInfoPowerStateDidChange, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(motionPolicyChanged), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
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
      preparation?.cancel(releasingGPU: false)
      clearPresentation()
      return
    }
    applyProps()
    requestDraw()
  }

  @objc private func suspend() {
    background = true
    preparation?.cancel()
    clearPresentation()
    climbOverlayGPUWorkQueue.async { ClimbOverlayMetalPackets.releaseGPU() }
  }
  @objc private func resume() { background = false; applyProps(); requestDraw() }

  private func clearSubmittedRequest() {
    submittedConfigRevision = nil
    submittedFrames = nil
    submittedPreviousFrames = nil
    submittedNextFrames = nil
    submittedRequest = ""
  }

  private func clearPresentation() {
    revision &+= 1
    stopEditorMotion()
    packet = nil
    carryOver = nil
    cancelPrefetch()
    editorBaseline = nil
    editorBaselineRevision = nil
    reportedRevision = nil
    needsFrame = false
    clearSubmittedRequest()
  }

  func setPagePosition(_ position: Double) {
    guard position.isFinite, position != pagePosition else { return }
    pagePosition = position
    cancelPrefetch()
    requestDraw()
  }

  /// "swap" or "wipe" from the app; anything else is the wipe.
  func setRevealMode(_ name: String?) {
    let mode = ClimbOverlayMotion.revealMode(named: name)
    guard mode != revealMode else { return }
    revealMode = mode
    if mode != ClimbOverlayMotion.revealModeSwap { carryOver = nil }
    reportSwapLook()
    requestDraw()
  }

  /// The swap's frame: its pair and weights, applied together. It arrives as
  /// the `swapFrame` command and again as the animated prop; a frame older
  /// than one already applied is dropped. The timing lives in the app.
  func setSwapFrame(_ values: [Double]) {
    guard let sequenced = ClimbOverlayMotion.sequencedSwapFrame(values),
      swapSequence.admit(sequenced.sequence)
    else { return }
    let frame = sequenced.frame
    guard frame.pagePosition != pagePosition || frame.outgoing != outgoingWeight || frame.incoming != incomingWeight
      || frame.shared != sharedWeight || sequenced.arrivals != arrivals || frame.sharedFloor != sharedFloor
    else { return }
    if frame.pagePosition != pagePosition { cancelPrefetch() }
    pagePosition = frame.pagePosition
    outgoingWeight = frame.outgoing
    incomingWeight = frame.incoming
    sharedWeight = frame.shared
    sharedFloor = frame.sharedFloor
    arrivals = sequenced.arrivals
    requestDraw()
  }

  /// The swap look's numbers (`ClimbOverlaySwapLook.Look`): the player's once, the
  /// lab's again whenever a slider is released. Nil or malformed turns the look off.
  func setSwapLook(_ values: [Double]?) {
    let look = values.flatMap { ClimbOverlaySwapLook.Look($0) }
    swapLookRejected = values != nil && look == nil
    if look != swapLook {
      swapLook = look
      swapLookAppliedHolds = nil
      requestDraw()
    }
    reportSwapLook()
  }

  /// Why the look is not drawing, or nil when it can.
  private var swapLookOffReason: String? {
    if swapLook == nil { return swapLookRejected ? "look rejected" : "no look prop" }
    if revealMode != ClimbOverlayMotion.revealModeSwap { return "not swap mode" }
    if suppressMotion { return "Reduce Motion" }
    // A ghost shows a hold's role colour without its role shape (HIG Color).
    if UIAccessibility.shouldDifferentiateWithoutColor { return "Differentiate Without Color" }
    return nil
  }

  /// Why glow reach is pinned at 1 while the look draws, or nil.
  private var swapLookReachOffReason: String? {
    if ProcessInfo.processInfo.isLowPowerModeEnabled { return "Low Power" }
    return ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue ? "hot phone" : nil
  }

  /// Tells the lab whether the look is off (with why), ready, or drawn (with its
  /// hold count), only when that changes, and only while it listens.
  private func reportSwapLook() {
    guard swapLookStateEvents else { return }
    var report: [String: AnyHashable]
    if let reason = swapLookOffReason {
      swapLookAppliedHolds = nil
      report = ["state": "off", "reason": reason]
    } else {
      report = swapLookAppliedHolds.map { ["state": "on", "holds": $0] } ?? ["state": "ready"]
      if let reachOff = swapLookReachOffReason { report["reachOff"] = reachOff }
    }
    guard report != swapLookLastReport else { return }
    swapLookLastReport = report
    onSwapLookState(report)
  }

  /// A draw used the look: report it the first time (and when its hold count changes), and log once.
  private func swapLookDrawn(_ words: [UInt16]) {
    guard words.first == 1 else { return }
    let holds = words.count/4-1
    if !swapLookLogged {
      swapLookLogged = true
      swapLookLog.info("swap look applied: \(holds) holds, reach \(self.swapLookReachOffReason ?? "on", privacy: .public)")
    }
    guard swapLookAppliedHolds != holds else { return }
    swapLookAppliedHolds = holds
    reportSwapLook()
  }

  /// Glow reach stays at 1 in Low Power Mode and on a hot phone, as the editor pulse stops there.
  private var swapLookReachAllowed: Bool { swapLookReachOffReason == nil }

  /// This frame's swap-look buffer, or its zero header (API 7's swap): no look,
  /// the wipe, a single climb on show, or Reduce Motion or Differentiate Without
  /// Color, which turn the look off here whatever the app sends.
  private func swapLookWords(_ packet: ClimbOverlayMetalPacket,selection: ClimbOverlayMotion.Selection,
                             weights: ClimbOverlayMotion.SwapWeights) -> [UInt16] {
    guard swapLookOffReason == nil, let look = swapLook,
      selection.lowerOffset != selection.upperOffset else { return ClimbOverlaySwapLook.off }
    let lowerSlot = ClimbOverlayMotion.slot(selection.lowerOffset)
    let upperSlot = ClimbOverlayMotion.slot(selection.upperOffset)
    let lower = packet.swapLookScene(slot: lowerSlot,upper: false)
    let upper = packet.swapLookScene(slot: upperSlot,upper: true)
    // The shader reads one entry for every hold the packet draws: a scene that
    // could not be read whole draws API 7's swap rather than read past the look.
    guard lower.holds.count == packet.header.scenes[lowerSlot].count,
      upper.holds.count == packet.header.scenes[upperSlot].count else { return ClimbOverlaySwapLook.off }
    let codes = ClimbOverlaySwapLook.sides(progress: selection.progress,
      outgoing: arrivals.outgoing,incoming: arrivals.incoming)
    return ClimbOverlaySwapLook.encode(
      lower: lower,
      upper: upper,
      lowerSide: ClimbOverlaySwapLook.Side(weight: weights.lower,code: codes.lower),
      upperSide: ClimbOverlaySwapLook.Side(weight: weights.upper,code: codes.upper),
      sharedFloor: sharedFloor ?? weights.shared,look: look,mirrored: displayMirrored,allowReach: swapLookReachAllowed)
  }

  /// Fabric view commands. Reanimated's `dispatchCommand` reaches here through
  /// RCTMountingManager, inline on the main thread when it dispatches from the
  /// UI runtime, without waiting for a React commit to mount (#7737). Swift sees
  /// ExpoFabricViewObjC as a plain UIView, so this names the selector that
  /// RCTViewComponentView implements; anything but `swapFrame` goes to that.
  @objc(handleCommand:args:)
  func handleViewCommand(_ commandName: NSString, args: NSArray) {
    guard commandName as String == ClimbOverlayMotion.swapFrameCommand else {
      forwardViewCommand(commandName, args: args)
      return
    }
    guard let values = ClimbOverlayMotion.commandValues(args) else { return }
    setSwapFrame(values)
  }

  private func forwardViewCommand(_ commandName: NSString, args: NSArray) {
    typealias CommandHandler = @convention(c) (AnyObject, Selector, NSString, NSArray) -> Void
    let selector = #selector(handleViewCommand(_:args:))
    guard let parent = ClimbOverlayGPUView.superclass(),
      let method = class_getInstanceMethod(parent, selector)
    else { return }
    unsafeBitCast(method_getImplementation(method), to: CommandHandler.self)(self, selector, commandName, args)
  }

  /// Reduce Motion, Differentiate Without Color, Low Power Mode or the thermal state changed.
  @objc private func motionPolicyChanged() {
    // Power and thermal notifications can arrive off the main thread.
    guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.motionPolicyChanged() };return }
    if suppressMotion || ProcessInfo.processInfo.isLowPowerModeEnabled { stopEditorMotion() }
    reportSwapLook()
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
    // The Reduce Motion prop may have changed with this batch.
    reportSwapLook()
    if !active {
      preparation?.cancel(releasingGPU: false)
      clearPresentation()
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
      schedulePrefetch()
      requestDraw()
      return
    }
    cancelPrefetch()
    // Coalesce updates while atlas preparation is running. There is at most
    // one worker request for this view; completion picks up the latest props.
    guard !preparing else { preparation?.cancel(releasingGPU: false);return }
    preparing = true
    stopEditorMotion()
    editChangedHoldCount = 0
    scheduledEditDurationMs = 0
    // The swap may be mid-fade: keep its pair moving from the packet on screen
    // until the replacement is ready (see drawCarryOver).
    if revealMode == ClimbOverlayMotion.revealModeSwap, let packet, !animateEdits {
      carryOver = CarryOver(packet: packet,centerPage: submittedCenterPage,configRevision: submittedConfigRevision,
        productionEmpty: submittedPreviousFrames != nil || submittedNextFrames != nil)
    } else if revealMode != ClimbOverlayMotion.revealModeSwap {
      carryOver = nil
    }
    packet = nil
    cancelPrefetch()
    revision &+= 1
    let generation = revision
    let config = configJson
    let cancel: ClimbOverlayRustCancellation
    do { cancel = try ClimbOverlayRustCancellation() }
    catch { preparing = false;reportFailure(error,request: requestId);return }
    let preparation = ClimbOverlayPreparation(cancelAction: cancel.cancel)
    self.preparation = preparation
    let layoutRevision = configRevision
    let frame = frames
    let previous = previousFrames
    let next = nextFrames
    let page = centerPage.isFinite ? centerPage : 0
    let baseline = animateEdits && editorBaselineRevision == layoutRevision ? editorBaseline : nil
    let request = requestId
    cancelPrefetch()
    let reusableSession = cpuSession?.source == config ? cpuSession : nil
    submittedConfigRevision = layoutRevision
    submittedFrames = frame
    submittedPreviousFrames = previous
    submittedNextFrames = next
    submittedCenterPage = page
    submittedRequest = request
    ClimbOverlayPacketMetrics.begin()
    climbOverlayGPUWorkQueue.async { [weak self] in
      let result = Result { () throws -> ClimbOverlayMetalPacket in
        guard !preparation.isCancelled else { throw ClimbOverlayPacketFailure.cancelled }
        let session = try reusableSession ?? ClimbOverlayMetalPackets.session(source: config,cancel: cancel)
        let request = ClimbOverlaySourceRequest(current: frame,previous: previous,next: next,
          editBaseline: baseline?.sorted(by: { $0.key < $1.key }).map { [$0.key,$0.value] })
        guard let packet = try ClimbOverlayMetalPackets.prepare(session: session,request: request,cancel: cancel,
          preparation: preparation) else { throw ClimbOverlayArenaFailure.invalid }
        return packet
      }
      ClimbOverlayPacketMetrics.end()
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.preparing = false
        self.preparation = nil
        if self.configRevision == layoutRevision,case .success(let packet) = result { self.cpuSession = packet.session }
        let current = self.revision == generation && self.configRevision == layoutRevision &&
          self.frames == frame && self.previousFrames == previous && self.nextFrames == next &&
          self.centerPage == page && self.requestId == request
        switch preparation.completion(current: current,visible: self.window != nil && self.active && !self.background) {
        case .cancelled, .superseded:
          self.clearSubmittedRequest();self.applyProps();return
        case .hidden: self.carryOver = nil;self.clearSubmittedRequest();return
        case .accept: break
        }
        switch result {
        case .success(let packet):
          // The hand-over: this frame's pair and weights, now from the new trio.
          self.carryOver = nil
          self.packet = packet
          self.editorBaseline = packet.header.currentRoles.reduce(into: [:]) { $0[$1[0]] = $1[1] }
          self.editorBaselineRevision = layoutRevision
          self.editChangedHoldCount = packet.header.changedCount
          self.scheduledEditDurationMs = self.editChangedHoldCount > 0 && self.startEditorMotion()
            ? ClimbOverlayMotion.editDuration*1000 : 0
          self.metal.drawableSize = CGSize(width: packet.header.width,height: packet.header.height)
          self.requestDraw()
        case .failure(let error): self.packet = nil;self.carryOver = nil;self.reportFailure(error,request: request)
        }
      }
    }
  }

  private func reportFailure(_ error: Error,request: String) {
    if let failure = error as? ClimbOverlayPacketFailure {
      guard let event = failure.event else { return }
      onRenderError(["requestId":request,"reason":event.0,"failureScope":event.1])
    } else if error is ClimbOverlayArenaFailure {
      onRenderError(["requestId":request,"reason":"gpu-resource-limit","failureScope":"context"])
    } else {
      // Unknown errors fall back for this mount only. Deterministic causes (device,
      // pipeline, contract, config) already throw with an explicit "static" scope.
      onRenderError(["requestId":request,"reason":"gpu-preparation-failed","failureScope":"context"])
    }
  }

  private func cancelPrefetch() {
    scheduledPrefetch?.cancel();scheduledPrefetch = nil
    prefetchJob?.cancel();prefetchJob = nil
    prefetch?.cancel();prefetch = nil
    submittedPrefetch = []
  }

  private func schedulePrefetch() {
    guard let packet,active,!background,window != nil,!preparing,
      abs((pagePosition ?? centerPage)-centerPage) < 0.0001 else { return }
    let frames = Array(prefetchFrames.filter { $0.utf8.count <= 32768 }.prefix(2))
    guard frames != submittedPrefetch else { return }
    cancelPrefetch();submittedPrefetch = frames
    guard !frames.isEmpty else { return }
    let revision = self.revision
    ClimbOverlayPacketMetrics.begin()
    let job = ClimbOverlayPacketJob(onEnd: ClimbOverlayPacketMetrics.end)
    prefetchJob = job
    let item = DispatchWorkItem { [weak self,packet,job] in
      guard job.start() else { return }
      guard let self,self.revision == revision,self.active,!self.background,self.window != nil else { job.finish();return }
      let cancel: ClimbOverlayRustCancellation
      do { cancel = try ClimbOverlayRustCancellation() } catch { job.finish();return }
      let work = ClimbOverlayPreparation(cancelAction: cancel.cancel)
      self.prefetch = work
      climbOverlayGPUWorkQueue.async {
        defer { job.finish() }
        for frame in frames {
          if work.isCancelled { break }
          _ = try? ClimbOverlayMetalPackets.prepare(session: packet.session,
            request: ClimbOverlaySourceRequest(current: frame,previous: nil,next: nil,editBaseline: nil),
            cancel: cancel,preparation: work,cacheOnly: true)
        }
      }
    }
    scheduledPrefetch = item
    DispatchQueue.main.asyncAfter(deadline: .now()+0.15,execute: item)
  }

  private func requestDraw() {
    needsFrame = true
    if active && !background && window != nil { metal.setNeedsDisplay() }
  }

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { requestDraw() }

  /// A frame of the running swap from the packet on screen while the next trio
  /// prepares. It reports nothing: readiness belongs to the new request.
  private func drawCarryOver(in view: MTKView) {
    guard let carry = carryOver, revealMode == ClimbOverlayMotion.revealModeSwap,
      carry.configRevision == configRevision, let position = pagePosition,
      let carried = ClimbOverlayMotion.carryOverSwap(pagePosition: position,
        centerPage: carry.centerPage,hasPrevious: carry.packet.header.present[1],
        hasNext: carry.packet.header.present[2],outgoing: outgoingWeight,incoming: incomingWeight,
        shared: sharedWeight),
      let pipeline = ClimbOverlayMetalPackets.pipeline else { return }
    let (selection, weights) = carried
    let packet = carry.packet
    guard let uniformSlot = packet.acquireUniforms() else { return }
    guard let drawable = view.currentDrawable, let descriptor = view.currentRenderPassDescriptor,
      let command = ClimbOverlayMetalPackets.commands?.makeCommandBuffer(),
      let encoder = command.makeRenderCommandEncoder(descriptor: descriptor) else {
      packet.releaseUniforms(uniformSlot)
      return
    }
    needsFrame = false
    let lower = ClimbOverlayMotion.slot(selection.lowerOffset)
    let upper = ClimbOverlayMotion.slot(selection.upperOffset)
    let look = swapLookWords(packet,selection: selection,weights: weights)
    do {
      try packet.uniforms(slot: uniformSlot,lower: lower,upper: upper,revealMode: revealMode,
        progress: selection.progress,swap: weights,pulse: 1,
        viewport: SIMD2(Float(view.drawableSize.width),Float(view.drawableSize.height)),
        productionEmpty: carry.productionEmpty,mirrored: displayMirrored)
    } catch { packet.releaseUniforms(uniformSlot);encoder.endEncoding();carryOver = nil;return }
    encoder.setRenderPipelineState(pipeline)
    encodeClimbOverlayPacket(packet,encoder: encoder,lower: lower,upper: upper,uniformSlot: uniformSlot,look: look)
    swapLookDrawn(look)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    command.addCompletedHandler { [packet] _ in
      packet.releaseUniforms(uniformSlot);ClimbOverlayPacketMetrics.gpuEnd();withExtendedLifetime(packet) {}
    }
    command.present(drawable)
    ClimbOverlayPacketMetrics.gpuBegin()
    command.commit()
  }

  func draw(in view: MTKView) {
    guard needsFrame, active, !background, window != nil else { return }
    guard !preparing,
      configRevision == submittedConfigRevision, frames == submittedFrames, requestId == submittedRequest,
      previousFrames == submittedPreviousFrames, nextFrames == submittedNextFrames, centerPage == submittedCenterPage,
      let packet, let pipeline = ClimbOverlayMetalPackets.pipeline,
      let drawable = view.currentDrawable, let descriptor = view.currentRenderPassDescriptor
    else { drawCarryOver(in: view);return }
    guard let uniformSlot = packet.acquireUniforms() else { needsFrame = true;return }
    guard let command = ClimbOverlayMetalPackets.commands?.makeCommandBuffer(),
      let encoder = command.makeRenderCommandEncoder(descriptor: descriptor) else {
      packet.releaseUniforms(uniformSlot)
      needsFrame = false
      onRenderError(["requestId":requestId,"reason":"gpu-command-unavailable","failureScope":"context"])
      return
    }
    needsFrame = false
    // The swap honours Reduce Motion in the app, as a shorter dissolve; only
    // the position-driven wipe is switched off here.
    let swap = revealMode == ClimbOverlayMotion.revealModeSwap
    let (selection, weights) = swap
      ? ClimbOverlayMotion.selectSwap(pagePosition: pagePosition ?? submittedCenterPage,
        centerPage: submittedCenterPage,hasPrevious: packet.header.present[1],hasNext: packet.header.present[2],
        outgoing: outgoingWeight,incoming: incomingWeight,shared: sharedWeight)
      : (ClimbOverlayMotion.select(pagePosition: pagePosition ?? submittedCenterPage,
        centerPage: submittedCenterPage,hasPrevious: packet.header.present[1],hasNext: packet.header.present[2],
        reduceMotion: suppressMotion), ClimbOverlayMotion.SwapWeights(lower: 1,upper: 0))
    let lower = ClimbOverlayMotion.slot(selection.lowerOffset)
    let upper = ClimbOverlayMotion.slot(selection.upperOffset)
    let look = swap ? swapLookWords(packet,selection: selection,weights: weights) : ClimbOverlaySwapLook.off
    do {
      try packet.uniforms(slot: uniformSlot,lower: lower,upper: upper,revealMode: revealMode,
        progress: selection.progress,swap: weights,
        pulse: editorPulse.reachScale(at: CACurrentMediaTime()),
        viewport: SIMD2(Float(view.drawableSize.width),Float(view.drawableSize.height)),
        productionEmpty: previousFrames != nil || nextFrames != nil || animateEdits,
        mirrored: displayMirrored)
    } catch { packet.releaseUniforms(uniformSlot);encoder.endEncoding();reportFailure(error,request: requestId);return }
    encoder.setRenderPipelineState(pipeline)
    encodeClimbOverlayPacket(packet,encoder: encoder,lower: lower,upper: upper,uniformSlot: uniformSlot,look: look)
    swapLookDrawn(look)
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
      self.schedulePrefetch()
      climbOverlayGPUWorkQueue.async { packet.session.persistAfterReady() }
      self.onRenderReady(["requestId":request,"prepareMs":packet.prepareMs,
        "uploadMs":packet.uploadMs,"gpuMs":gpuMs,
        "atlasBytes":packet.selectedBytes,"atlasCacheHit":packet.cacheHit,"uploadBytes":packet.uploadBytes,
        "litHoldCount":packet.header.scenes[0].count,
        "editChangedHoldCount":editCount,"editDurationMs":editDurationMs,"lowPowerMode":lowPowerMode])
    }
    #if !targetEnvironment(simulator)
    if requiresPresentation {
      drawable.addPresentedHandler { _ in
        DispatchQueue.main.async { presented = true; reportReady() }
      }
    }
    #endif
    command.addCompletedHandler { [weak self, packet] completed in
      // Metal retains MTLBuffer objects itself. Keep their budget reservations
      // alive until completion, including upper/previous buffers and atlases.
      defer { packet.releaseUniforms(uniformSlot);ClimbOverlayPacketMetrics.gpuEnd();withExtendedLifetime(packet) {} }
      let gpuMs = max(0, completed.gpuEndTime-completed.gpuStartTime)*1000
      DispatchQueue.main.async { [weak self] in
        guard let self, self.revision == generation, self.requestId == request,
          self.configRevision == self.submittedConfigRevision, self.frames == self.submittedFrames,
          self.previousFrames == self.submittedPreviousFrames, self.nextFrames == self.submittedNextFrames,
          self.centerPage == self.submittedCenterPage,
          self.active, !self.background, self.window != nil else { return }
        if completed.status == .error {
          self.onRenderError(["requestId":request,"reason":"gpu-command-failed","failureScope":"context"])
        } else {
          finishedGPUMs = gpuMs
          reportReady()
          if self.needsFrame { self.requestDraw() }
        }
      }
    }
    command.present(drawable)
    ClimbOverlayPacketMetrics.gpuBegin()
    command.commit()
  }
}
