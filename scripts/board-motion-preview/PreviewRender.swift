import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Metal
import UniformTypeIdentifiers

/// Board motion lab previews, step 2, on this Mac's GPU: the real
/// `ClimbOverlayShader.source`, real Rust packets, and the swap look buffer from
/// the real `ClimbOverlaySwapLook.swift`. Compiled and run by render.mjs; see
/// README.md.
///
///   render <prepared work dir> <fresh output dir>
///   parity <aura-transition-golden work dir> <fresh output dir>
struct PreviewError: Error, CustomStringConvertible { let description: String }

struct PlanScene: Decodable { let offset: Int; let bytes: Int; let count: Int; let stampLayers: UInt32 }
struct PlanPacket: Decodable { let board: String; let dir: String; let scenes: [PlanScene] }
struct PlanBoard: Decodable { let width: Int; let height: Int; let photo: String }
struct PlanCheck: Decodable { let packet: String; let name: String; let lower: Int; let upper: Int; let swap: [Float] }
struct PlanFrame: Decodable {
  let packet: String
  let lower: Int
  let upper: Int
  let swap: [Float]
  let sharedFloor: Float
  let codes: [Int]
  let label: String?
  let look: [Double]?
  let atMs: Double?
  let phase: String?
}
struct PlanSheet: Decodable { let id: String; let board: String; let title: String; let frames: [PlanFrame] }
struct PlanTrack: Decodable {
  let id: String
  let variant: String
  let letter: String
  let name: String
  let preset: String
  let speed: String
  let look: [Double]?
  let board: String
  let commitsMs: [Double]
  let frames: [PlanFrame]
}
struct Plan: Decodable {
  let boards: [String: PlanBoard]
  let packets: [String: PlanPacket]
  let validations: [PlanCheck]
  let sheets: [PlanSheet]
  let motion: [PlanTrack]
}

struct GoldenScene: Decodable { let offset: Int; let count: Int }
struct GoldenSample: Decodable { let name: String; let lower: Int; let upper: Int; let editorAllChanged: Bool }
struct GoldenInputs: Decodable {
  let width: Int
  let height: Int
  let scenes: [GoldenScene]
  let samples: [GoldenSample]
  let pixelFiles: [String: String]
  let resourceFiles: [String: String]
  let descriptorFiles: [String: [String: String]]
}

func read(_ url: URL) throws -> Data { try Data(contentsOf: url) }

final class Renderer {
  let device: MTLDevice
  let queue: MTLCommandQueue
  private var textures: [String: MTLTexture] = [:]

  init() throws {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
      throw PreviewError(description: "Metal unavailable")
    }
    self.device = device
    self.queue = queue
  }

  func pipeline(_ source: String) throws -> MTLRenderPipelineState {
    let library = try device.makeLibrary(source: source, options: nil)
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: "overlay_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: "overlay_fragment")
    descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
    return try device.makeRenderPipelineState(descriptor: descriptor)
  }

  func buffer(_ data: Data) throws -> MTLBuffer {
    guard let buffer = data.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: data.count,
      options: .storageModeShared) }) else { throw PreviewError(description: "Buffer allocation failed") }
    return buffer
  }

  private func texture(width: Int, height: Int) throws -> MTLTexture {
    let key = "\(width)x\(height)"
    if let texture = textures[key] { return texture }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height,
      mipmapped: false)
    descriptor.usage = [.renderTarget]
    descriptor.storageMode = .shared
    guard let texture = device.makeTexture(descriptor: descriptor) else { throw PreviewError(description: "No texture") }
    textures[key] = texture
    return texture
  }

  /// One draw, exactly as encodeClimbOverlayPacket binds it, read back as premultiplied RGBA.
  func draw(_ pipeline: MTLRenderPipelineState, width: Int, height: Int, pixels: MTLBuffer, descriptors: MTLBuffer,
            lowerOffset: Int, upperOffset: Int, uniforms: Data, resources: MTLBuffer, look: [UInt16]) throws -> Data {
    guard uniforms.count == ClimbOverlayPacketLayout.uniformBytes, let command = queue.makeCommandBuffer() else {
      throw PreviewError(description: "Bad uniforms or no command buffer")
    }
    let texture = try texture(width: width, height: height)
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
    guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else {
      throw PreviewError(description: "No encoder")
    }
    encoder.setRenderPipelineState(pipeline)
    encoder.setFragmentBuffer(pixels, offset: 0, index: ClimbOverlayPacketLayout.metalBindingsPixels)
    encoder.setFragmentBuffer(descriptors, offset: lowerOffset, index: ClimbOverlayPacketLayout.metalBindingsLower)
    uniforms.withUnsafeBytes {
      encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: ClimbOverlayPacketLayout.metalBindingsUniforms)
    }
    encoder.setFragmentBuffer(resources, offset: 0, index: ClimbOverlayPacketLayout.metalBindingsResources)
    encoder.setFragmentBuffer(descriptors, offset: upperOffset, index: ClimbOverlayPacketLayout.metalBindingsUpper)
    look.withUnsafeBytes {
      encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: ClimbOverlaySwapLook.metalBinding)
    }
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    command.commit()
    command.waitUntilCompleted()
    guard command.status == .completed else {
      throw PreviewError(description: "GPU command failed: \(String(describing: command.error))")
    }
    var output = Data(count: width * height * 4)
    output.withUnsafeMutableBytes {
      texture.getBytes($0.baseAddress!, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
    }
    return output
  }
}

/// A prepared packet: its buffers, the Rust base uniforms the frames are patched from, and its holds for the look.
final class LoadedPacket {
  let width: Int
  let height: Int
  let scenes: [PlanScene]
  let pixels: MTLBuffer
  let descriptors: MTLBuffer
  let resources: MTLBuffer
  private let descriptorBytes: Data
  private let directory: URL
  private var bases: [String: Data] = [:]
  private var lookScenes: [String: ClimbOverlaySwapLook.Scene] = [:]

  init(_ plan: PlanPacket, board: PlanBoard, work: URL, renderer: Renderer) throws {
    width = board.width
    height = board.height
    scenes = plan.scenes
    directory = work.appendingPathComponent(plan.dir)
    descriptorBytes = try read(directory.appendingPathComponent("descriptors.bin"))
    pixels = try renderer.buffer(read(directory.appendingPathComponent("pixels.bin")))
    descriptors = try renderer.buffer(descriptorBytes)
    resources = try renderer.buffer(read(directory.appendingPathComponent("resources.bin")))
  }

  func rustUniforms(_ name: String) throws -> Data {
    if let base = bases[name] { return base }
    let data = try read(directory.appendingPathComponent("uniforms-\(name).bin"))
    bases[name] = data
    return data
  }

  /// The uniforms Rust's `encode_uniforms` writes for this pair and swap: its base for the
  /// pair with the weights, progress, shared-weight word and stamp layers patched in.
  func uniforms(lower: Int, upper: Int, swap: [Float]) throws -> Data {
    let same = lower == upper
    var bytes = try rustUniforms(same ? "still-\(lower)" : (lower == 0 ? "base-0-2" : "base-1-0"))
    let (weightLower, weightUpper, shared) = (swap[0], swap[1], swap[2])
    let lowerCount = scenes[lower].count, upperCount = scenes[upper].count
    var progress: Float
    if same { progress = 0 }
    else if lowerCount > 0 && upperCount == 0 { progress = 1 - weightLower }
    else if lowerCount == 0 && upperCount > 0 { progress = weightUpper }
    else if shared < 1 { progress = min(max((1 - weightLower + weightUpper) * 0.5, Float.ulpOfOne), 1 - Float.ulpOfOne) }
    else { progress = (1 - weightLower + weightUpper) * 0.5 }
    func put(_ word: Int, _ value: UInt32) {
      withUnsafeBytes(of: value.littleEndian) { bytes.replaceSubrange((word * 4)..<(word * 4 + 4), with: $0) }
    }
    put(15, progress > 0 && progress < 1 ? shared.bitPattern : 0)
    let layers = scenes.map(\.stampLayers)
    put(17, progress <= 0 ? layers[lower] : (progress >= 1 ? layers[upper] : layers[lower] | layers[upper]))
    put(22, weightLower.bitPattern)
    put(23, weightUpper.bitPattern)
    put(24, progress.bitPattern)
    return bytes
  }

  func lookScene(_ slot: Int, upper: Bool) -> ClimbOverlaySwapLook.Scene {
    let key = "\(slot)-\(upper)"
    if let scene = lookScenes[key] { return scene }
    let scene = scenes[slot]
    let holds = descriptorBytes.withUnsafeBytes { bytes in
      ClimbOverlaySwapLook.holds(descriptors: UnsafeRawBufferPointer(rebasing: bytes[scene.offset..<(scene.offset + scene.bytes)]),
        count: scene.count, upper: upper, width: Float(width), height: Float(height))
    }
    let built = ClimbOverlaySwapLook.Scene(holds)
    lookScenes[key] = built
    return built
  }

  /// The look buffer the native view would bind for this frame: `values` is the
  /// variant's look (a sheet frame carries its own, a motion track one for all).
  func look(_ frame: PlanFrame, values: [Double]?) throws -> [UInt16] {
    guard let values, frame.lower != frame.upper else { return ClimbOverlaySwapLook.off }
    guard let look = ClimbOverlaySwapLook.Look(values) else { throw PreviewError(description: "Bad look") }
    return ClimbOverlaySwapLook.encode(lower: lookScene(frame.lower, upper: false), upper: lookScene(frame.upper, upper: true),
      lowerSide: ClimbOverlaySwapLook.Side(weight: frame.swap[0], code: frame.codes[0]),
      upperSide: ClimbOverlaySwapLook.Side(weight: frame.swap[1], code: frame.codes[1]),
      sharedFloor: frame.sharedFloor, look: look, mirrored: false, allowReach: true)
  }
}

enum Images {
  static func image(_ rgba: Data, width: Int, height: Int) throws -> CGImage {
    guard let provider = CGDataProvider(data: rgba as CFData),
      let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider,
        decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    else { throw PreviewError(description: "CGImage failed") }
    return image
  }

  static func load(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      throw PreviewError(description: "Cannot read \(url.path)")
    }
    return image
  }

  static func context(width: Int, height: Int) throws -> CGContext {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
      throw PreviewError(description: "No context")
    }
    context.interpolationQuality = .high
    return context
  }

  /// The overlay drawn source-over on the board photo, as the app stacks them, at full size.
  static func composite(board: CGImage, overlay: CGImage) throws -> CGImage {
    let context = try context(width: overlay.width, height: overlay.height)
    let frame = CGRect(x: 0, y: 0, width: overlay.width, height: overlay.height)
    context.draw(board, in: frame)
    context.draw(overlay, in: frame)
    guard let image = context.makeImage() else { throw PreviewError(description: "Composite failed") }
    return image
  }

  static func savePNG(_ image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw PreviewError(description: "Cannot write \(url.path)") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw PreviewError(description: "PNG write failed") }
  }

  static func text(_ string: String, in context: CGContext, x: CGFloat, y: CGFloat, size: CGFloat, gray: CGFloat,
                   rightEdge: CGFloat? = nil) {
    let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: gray, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: attributes))
    let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    context.textPosition = CGPoint(x: rightEdge.map { $0 - width } ?? x, y: y)
    CTLineDraw(line, context)
  }
}

/// Pixels whose any channel differs, and those that differ by more than 16 of 255.
func changedPixels(_ first: Data, _ second: Data) -> (any: Int, visible: Int) {
  var any = 0, visible = 0
  first.withUnsafeBytes { a in second.withUnsafeBytes { b in
    let left = a.bindMemory(to: UInt8.self), right = b.bindMemory(to: UInt8.self)
    var index = 0
    while index < left.count {
      var largest = 0
      for channel in 0..<4 { largest = max(largest, abs(Int(left[index + channel]) - Int(right[index + channel]))) }
      if largest > 0 { any += 1 }
      if largest > 16 { visible += 1 }
      index += 4
    }
  } }
  return (any, visible)
}

/// One video: frames written to ffmpeg as raw RGBA, encoded H.264 / yuv420p at 60 fps.
final class VideoWriter {
  let process = Process()
  let input = Pipe()
  init(path: String, width: Int, height: Int) throws {
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s",
      "\(width)x\(height)", "-r", "60", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]
    process.standardInput = input
    try process.run()
  }
  func write(_ data: Data) { input.fileHandleForWriting.write(data) }
  func finish() throws {
    try input.fileHandleForWriting.close()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw PreviewError(description: "ffmpeg failed") }
  }
}

@main enum BoardMotionPreview {
  static func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 4, ["render", "parity"].contains(arguments[1]) else {
      throw PreviewError(description: "Usage: render|parity <work dir> <fresh output dir>")
    }
    let work = URL(fileURLWithPath: arguments[2], isDirectory: true)
    let output = URL(fileURLWithPath: arguments[3], isDirectory: true)
    guard !FileManager.default.fileExists(atPath: output.path) else {
      throw PreviewError(description: "Output exists: \(output.path)")
    }
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    if arguments[1] == "render" { try render(work: work, output: output) } else { try parity(work: work, output: output) }
  }

  static func render(work: URL, output: URL) throws {
    let plan = try JSONDecoder().decode(Plan.self, from: read(work.appendingPathComponent("plan.json")))
    let renderer = try Renderer()
    let pipeline = try renderer.pipeline(ClimbOverlayShader.source)
    var packets: [String: LoadedPacket] = [:]
    func packet(_ key: String) throws -> LoadedPacket {
      if let loaded = packets[key] { return loaded }
      guard let description = plan.packets[key], let board = plan.boards[description.board] else {
        throw PreviewError(description: "No packet \(key)")
      }
      let loaded = try LoadedPacket(description, board: board, work: work, renderer: renderer)
      packets[key] = loaded
      return loaded
    }
    var photos: [String: CGImage] = [:]
    for (key, board) in plan.boards { photos[key] = try Images.load(work.appendingPathComponent(board.photo)) }
    func overlay(_ frame: PlanFrame, look values: [Double]?, with state: MTLRenderPipelineState) throws -> (Data, LoadedPacket) {
      let loaded = try packet(frame.packet)
      let rgba = try renderer.draw(state, width: loaded.width, height: loaded.height, pixels: loaded.pixels,
        descriptors: loaded.descriptors, lowerOffset: loaded.scenes[frame.lower].offset,
        upperOffset: loaded.scenes[frame.upper].offset,
        uniforms: loaded.uniforms(lower: frame.lower, upper: frame.upper, swap: frame.swap), resources: loaded.resources,
        look: loaded.look(frame, values: values))
      return (rgba, loaded)
    }

    // 1. The patched uniforms are the bytes Rust writes.
    var mismatches: [String] = []
    for check in plan.validations {
      let loaded = try packet(check.packet)
      if try loaded.uniforms(lower: check.lower, upper: check.upper, swap: check.swap) != loaded.rustUniforms(check.name) {
        mismatches.append("\(check.packet)/\(check.name)")
      }
    }
    guard mismatches.isEmpty else { throw PreviewError(description: "Patched uniforms differ from Rust: \(mismatches)") }

    // 2. Contact-sheet frames, composited on the photo at full size.
    let sheets = output.appendingPathComponent("sheets")
    for sheet in plan.sheets {
      let directory = sheets.appendingPathComponent(sheet.id)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      for (index, frame) in sheet.frames.enumerated() {
        let (rgba, loaded) = try overlay(frame, look: frame.look, with: pipeline)
        let image = try Images.image(rgba, width: loaded.width, height: loaded.height)
        try Images.savePNG(try Images.composite(board: photos[sheet.board]!, overlay: image),
          to: directory.appendingPathComponent("\(index).png"))
      }
    }

    // 3. The ghost-halo cut (round 2, E at drag 60 pt): the shader before the ownership fix against now.
    var cutCheck: [String: Any] = [:]
    if let sheet = plan.sheets.first(where: { $0.id == "E-ghost-peek" }) {
      let directory = output.appendingPathComponent("cut-check")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let before = try renderer.pipeline(BeforeFixShader.source)
      let frame = sheet.frames[2]
      let (old, loaded) = try overlay(frame, look: frame.look, with: before)
      let (new, _) = try overlay(frame, look: frame.look, with: pipeline)
      let changed = changedPixels(old, new)
      for (name, rgba) in [("before", old), ("after", new)] {
        let composite = try Images.composite(board: photos[sheet.board]!,
          overlay: try Images.image(rgba, width: loaded.width, height: loaded.height))
        try Images.savePNG(composite, to: directory.appendingPathComponent("e-2-\(name).png"))
        // Around x 580, y 300-380, where the cut was, three times larger.
        if let crop = composite.cropping(to: CGRect(x: 430, y: 240, width: 300, height: 200)) {
          let context = try Images.context(width: 900, height: 600)
          context.interpolationQuality = .none
          context.draw(crop, in: CGRect(x: 0, y: 0, width: 900, height: 600))
          if let scaled = context.makeImage() { try Images.savePNG(scaled, to: directory.appendingPathComponent("e-2-\(name)-crop.png")) }
        }
      }
      cutCheck = ["frame": "E · drag 60 pt", "changedPixels": changed.any, "visiblyChangedPixels": changed.visible]
    }

    // 4. Motion: per group of speed and preset, A first; videos, pixel differences from A, glow per commit.
    let motion = output.appendingPathComponent("motion")
    try FileManager.default.createDirectory(at: motion, withIntermediateDirectories: true)
    var stats: [[String: Any]] = []
    let groups = Dictionary(grouping: plan.motion, by: { "\($0.preset)-\($0.speed)" })
    for (_, tracks) in groups.sorted(by: { $0.key < $1.key }) {
      guard let baseline = tracks.first(where: { $0.variant == "shipped-wall-swap" }) else { continue }
      let others = tracks.filter { $0.variant != "shipped-wall-swap" }
      let board = plan.boards[baseline.board]!
      let paneHeight = 1024, strip = 56
      let paneWidth = (Int((Double(paneHeight) * Double(board.width) / Double(board.height)).rounded()) + 1) / 2 * 2
      let height = paneHeight + strip
      /// Composite → video canvas: a strip of labels above the board, never on it.
      func canvas(_ track: PlanTrack, _ frame: PlanFrame, _ overlay: CGImage) throws -> (Data, Double) {
        let context = try Images.context(width: paneWidth, height: height)
        context.setFillColor(CGColor(red: 0.055, green: 0.043, blue: 0.086, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: paneWidth, height: height))
        let pane = CGRect(x: 0, y: 0, width: paneWidth, height: paneHeight)
        context.draw(photos[track.board]!, in: pane)
        context.draw(overlay, in: pane)
        let preset = track.preset == "bold" ? "Bold" : "Subtle"
        let title = track.variant == "shipped-wall-swap" ? "\(track.letter) · \(track.name)" : "\(track.letter) · \(track.name) · \(preset)"
        Images.text(title, in: context, x: 14, y: CGFloat(paneHeight + 30), size: 22, gray: 0.95)
        let time = String(format: "%.2f s", (frame.atMs ?? 0) / 1000)
        Images.text("\(track.speed == "1x" ? "1×" : "0.25×") · \(time) · \(frame.phase ?? "")", in: context, x: 14,
          y: CGFloat(paneHeight + 8), size: 17, gray: 0.7)
        guard let bytes = context.data else { throw PreviewError(description: "No canvas bytes") }
        let rowBytes = context.bytesPerRow
        let data = Data(bytes: bytes, count: rowBytes * height)
        // Mean glow chroma (max - min of RGB) over the board: the grey photo adds little, lit holds a lot.
        var chroma = 0
        data.withUnsafeBytes { raw in
          let pixels = raw.bindMemory(to: UInt8.self)
          for row in strip..<height {
            var index = row * rowBytes
            for _ in 0..<paneWidth {
              let red = Int(pixels[index]), green = Int(pixels[index + 1]), blue = Int(pixels[index + 2])
              chroma += max(red, green, blue) - min(red, green, blue)
              index += 4
            }
          }
        }
        return (data, Double(chroma) / Double(paneWidth * paneHeight))
      }
      let writeBaseline = baseline.preset == "subtle"
      let baselineWriter = writeBaseline
        ? try VideoWriter(path: motion.appendingPathComponent("\(baseline.letter)-\(baseline.variant)-\(baseline.speed).mp4").path,
          width: paneWidth, height: height) : nil
      let writers = try others.map {
        try VideoWriter(path: motion.appendingPathComponent("\($0.id).mp4").path, width: paneWidth, height: height)
      }
      var differences = [[(Int, Int)]](repeating: [], count: others.count)
      var chromas = [[Double]](repeating: [], count: others.count)
      var baselineChroma: [Double] = []
      for index in baseline.frames.indices {
        let (baseRGBA, loaded) = try overlay(baseline.frames[index], look: baseline.look, with: pipeline)
        let (baseCanvas, baseGlow) = try canvas(baseline, baseline.frames[index],
          try Images.image(baseRGBA, width: loaded.width, height: loaded.height))
        baselineWriter?.write(baseCanvas)
        baselineChroma.append(baseGlow)
        for (trackIndex, track) in others.enumerated() {
          let frame = track.frames[index]
          let (rgba, packet) = try overlay(frame, look: track.look, with: pipeline)
          differences[trackIndex].append(changedPixels(baseRGBA, rgba))
          let (data, glow) = try canvas(track, frame, try Images.image(rgba, width: packet.width, height: packet.height))
          writers[trackIndex].write(data)
          chromas[trackIndex].append(glow)
        }
      }
      try baselineWriter?.finish()
      for writer in writers { try writer.finish() }
      // The darkest moment after each commit (500 ms), against A's.
      func windows(_ glow: [Double], _ track: PlanTrack) -> [Double] {
        track.commitsMs.map { commit in
          zip(track.frames, glow).filter { ($0.0.atMs ?? 0) >= commit && ($0.0.atMs ?? 0) < commit + 500 }.map(\.1).min() ?? 0
        }
      }
      let baselineDarkest = windows(baselineChroma, baseline)
      for (trackIndex, track) in others.enumerated() {
        let anyChanged = differences[trackIndex].map(\.0), visible = differences[trackIndex].map(\.1)
        let darkest = windows(chromas[trackIndex], track)
        stats.append(["track": track.id, "frames": track.frames.count,
          "meanChangedPixels": anyChanged.reduce(0, +) / max(anyChanged.count, 1), "maxChangedPixels": anyChanged.max() ?? 0,
          "meanVisiblyChangedPixels": visible.reduce(0, +) / max(visible.count, 1), "maxVisiblyChangedPixels": visible.max() ?? 0,
          "darkestGlowPerCommit": darkest.map { ($0 * 10).rounded() / 10 },
          "shippedDarkestGlowPerCommit": baselineDarkest.map { ($0 * 10).rounded() / 10 },
          "neverDarkerThanShipped": zip(darkest, baselineDarkest).allSatisfy { $0 >= $1 - 0.05 }])
      }
    }
    let report: [String: Any] = ["device": renderer.device.name, "uniformChecks": plan.validations.count,
      "sheets": plan.sheets.map(\.id), "cutCheck": cutCheck, "motion": stats]
    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      .write(to: output.appendingPathComponent("stats.json"))
    print("{\"status\":\"RENDERED\",\"uniformChecks\":\(plan.validations.count),\"sheets\":\(plan.sheets.count),\"tracks\":\(plan.motion.count)}")
  }

  /// The golden's 42 samples through the shader as it was (`BaselineShader`) and as
  /// it is with no look bound: every byte must match.
  static func parity(work: URL, output: URL) throws {
    let inputsURL = work.appendingPathComponent("inputs/inputs.json")
    let inputs = try JSONDecoder().decode(GoldenInputs.self, from: read(inputsURL))
    let directory = inputsURL.deletingLastPathComponent()
    let renderer = try Renderer()
    let baseline = try renderer.pipeline(BaselineShader.source)
    let current = try renderer.pipeline(ClimbOverlayShader.source)
    guard let pixelName = inputs.pixelFiles["new"], let resourceName = inputs.resourceFiles["new"] else {
      throw PreviewError(description: "Golden inputs lack the new packet")
    }
    let pixels = try renderer.buffer(read(directory.appendingPathComponent(pixelName)))
    let resources = try renderer.buffer(read(directory.appendingPathComponent(resourceName)))
    var descriptors: [String: MTLBuffer] = [:]
    for variant in ["transition", "editor"] {
      guard let name = inputs.descriptorFiles[variant]?["new"] else { throw PreviewError(description: "No descriptors") }
      descriptors[variant] = try renderer.buffer(read(directory.appendingPathComponent(name)))
    }
    var rows: [[String: Any]] = []
    var identical = 0
    var changedTotal = 0
    for sample in inputs.samples {
      let uniforms = try read(directory.appendingPathComponent("new-uniforms-\(sample.name).bin"))
      let buffer = descriptors[sample.editorAllChanged ? "editor" : "transition"]!
      let lowerOffset = inputs.scenes[sample.lower].offset
      let upperOffset = inputs.scenes[sample.upper].offset
      let before = try renderer.draw(baseline, width: inputs.width, height: inputs.height, pixels: pixels,
        descriptors: buffer, lowerOffset: lowerOffset, upperOffset: upperOffset, uniforms: uniforms,
        resources: resources, look: ClimbOverlaySwapLook.off)
      let after = try renderer.draw(current, width: inputs.width, height: inputs.height, pixels: pixels,
        descriptors: buffer, lowerOffset: lowerOffset, upperOffset: upperOffset, uniforms: uniforms,
        resources: resources, look: ClimbOverlaySwapLook.off)
      let changed = changedPixels(before, after).any
      if before == after { identical += 1 }
      changedTotal += changed
      rows.append(["name": sample.name, "identicalBytes": before == after, "changedPixels": changed])
    }
    let passed = identical == inputs.samples.count
    let status = passed ? "PASS_LOOK_OFF_IDENTICAL" : "FAIL_LOOK_OFF_DIFFERS"
    try JSONSerialization.data(withJSONObject: ["status": status, "device": renderer.device.name,
      "samples": inputs.samples.count, "identicalSamples": identical, "changedPixels": changedTotal, "rows": rows],
      options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("parity.json"))
    print("{\"status\":\"\(status)\",\"identical\":\(identical),\"samples\":\(inputs.samples.count),\"changedPixels\":\(changedTotal)}")
    if !passed { throw PreviewError(description: "Look-off output differs from the baseline shader") }
  }
}
