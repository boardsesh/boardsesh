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
///   export <prepared work dir> <fresh output dir> <track or sheet id>...
///   compare <prepared work dir> <export dir> <GLES render dir> <fresh output dir>
///
/// `export` and `compare` are the Android half (gles.mjs): the frames' uniforms
/// and Swift look words for the GLES renderer, then Metal against GLES.
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
  /// `transitioning` keeps the progress strictly between 0 and 1, as Rust does when shared
  /// holds dip, so a pair at W = (1, 0) or (0, 1) still takes the shader's swap path.
  func uniforms(lower: Int, upper: Int, swap: [Float], transitioning: Bool = false) throws -> Data {
    let same = lower == upper
    var bytes = try rustUniforms(same ? "still-\(lower)" : (lower == 0 ? "base-0-2" : "base-1-0"))
    let (weightLower, weightUpper, shared) = (swap[0], swap[1], swap[2])
    let lowerCount = scenes[lower].count, upperCount = scenes[upper].count
    var progress: Float
    if same { progress = 0 }
    else if lowerCount > 0 && upperCount == 0 { progress = 1 - weightLower }
    else if lowerCount == 0 && upperCount > 0 { progress = weightUpper }
    else if shared < 1 || transitioning {
      progress = min(max((1 - weightLower + weightUpper) * 0.5, Float.ulpOfOne), 1 - Float.ulpOfOne)
    }
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
    let usage = arguments.count == 4 && ["render", "parity", "endpoints"].contains(arguments[1])
      || arguments.count >= 5 && arguments[1] == "export" || arguments.count == 6 && arguments[1] == "compare"
    guard usage else {
      throw PreviewError(description: "Usage: render|parity|endpoints <work dir> <fresh output dir>, export <work dir> <fresh output dir> <id>..., compare <work dir> <export dir> <GLES dir> <fresh output dir>")
    }
    let work = URL(fileURLWithPath: arguments[2], isDirectory: true)
    let output = URL(fileURLWithPath: arguments[arguments[1] == "compare" ? 5 : 3], isDirectory: true)
    guard !FileManager.default.fileExists(atPath: output.path) else {
      throw PreviewError(description: "Output exists: \(output.path)")
    }
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    switch arguments[1] {
    case "render": try render(work: work, output: output)
    case "parity": try parity(work: work, output: output)
    case "endpoints": try endpoints(work: work, output: output)
    case "export": try export(work: work, output: output, ids: Array(arguments[4...]))
    default:
      try compare(work: work, exported: URL(fileURLWithPath: arguments[3], isDirectory: true),
        gles: arguments[4] == "-" ? nil : URL(fileURLWithPath: arguments[4], isDirectory: true), output: output)
    }
  }

  /// The frames of the named tracks and sheets, named `<id>-<index>`, each with the look it draws.
  static func selection(_ plan: Plan, ids: [String]) throws -> [(name: String, frame: PlanFrame, look: [Double]?)] {
    try ids.flatMap { id -> [(name: String, frame: PlanFrame, look: [Double]?)] in
      if let track = plan.motion.first(where: { $0.id == id }) {
        return track.frames.enumerated().map { ("\(id)-\($0.offset)", $0.element, track.look) }
      }
      if let sheet = plan.sheets.first(where: { $0.id == id }) {
        return sheet.frames.enumerated().map { ("\(id)-\($0.offset)", $0.element, $0.element.look) }
      }
      throw PreviewError(description: "No track or sheet \(id)")
    }
  }

  static func littleEndian(_ words: [UInt16]) -> Data {
    var data = Data(capacity: words.count * 2)
    for word in words { withUnsafeBytes(of: word.littleEndian) { data.append(contentsOf: $0) } }
    return data
  }

  /// For the GLES renderer and the Kotlin look: each frame's uniforms (exactly the bytes
  /// `render` draws with), its Swift look words, the packets it needs and a manifest.
  static func export(work: URL, output: URL, ids: [String]) throws {
    let plan = try JSONDecoder().decode(Plan.self, from: read(work.appendingPathComponent("plan.json")))
    let renderer = try Renderer()
    let frames = output.appendingPathComponent("frames")
    try FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)
    var loaded: [String: LoadedPacket] = [:]
    var rows: [[String: Any]] = []
    var table = ""
    for (name, frame, look) in try selection(plan, ids: ids) {
      guard let description = plan.packets[frame.packet], let board = plan.boards[description.board] else {
        throw PreviewError(description: "No packet \(frame.packet)")
      }
      let packet = try loaded[frame.packet] ?? LoadedPacket(description, board: board, work: work, renderer: renderer)
      loaded[frame.packet] = packet
      try packet.uniforms(lower: frame.lower, upper: frame.upper, swap: frame.swap)
        .write(to: frames.appendingPathComponent("\(name).uniforms"))
      try littleEndian(packet.look(frame, values: look)).write(to: frames.appendingPathComponent("\(name).swift-look"))
      let lower = description.scenes[frame.lower], upper = description.scenes[frame.upper]
      let directory = "packets/" + frame.packet.replacingOccurrences(of: "/", with: "-")
      table += "\(name) \(directory) \(packet.width) \(packet.height) \(lower.offset) \(lower.bytes) \(upper.offset) \(upper.bytes)\n"
      var row: [String: Any] = ["name": name, "packet": frame.packet, "directory": directory, "lower": frame.lower,
        "upper": frame.upper, "swap": frame.swap, "sharedFloor": frame.sharedFloor, "codes": frame.codes]
      if let look { row["look"] = look }
      rows.append(row)
    }
    let packets = Dictionary(uniqueKeysWithValues: loaded.keys.map { key -> (String, Any) in
      let description = plan.packets[key]!, board = plan.boards[description.board]!
      return (key, ["source": work.appendingPathComponent(description.dir).path, "width": board.width, "height": board.height,
        "scenes": description.scenes.map { ["offset": $0.offset, "bytes": $0.bytes, "count": $0.count] }])
    })
    try table.write(to: output.appendingPathComponent("frames.tsv"), atomically: true, encoding: .utf8)
    try JSONSerialization.data(withJSONObject: ["packets": packets, "frames": rows], options: [.prettyPrinted, .sortedKeys])
      .write(to: output.appendingPathComponent("frames.json"))
    print("{\"status\":\"EXPORTED\",\"frames\":\(rows.count),\"packets\":\(loaded.count)}")
  }

  /// Metal (Swift look words) against GLES (Kotlin look words), frame by frame: the
  /// largest channel error, pixels off by more than one byte and pixels changed at all,
  /// and whether the two platforms' look words are the same words. `lookPixels` is how
  /// many pixels the look itself changes on Metal (against no look), so a match means
  /// something. Saves the worst frames as Metal / GLES / 32× difference composites.
  /// Without a GLES directory it compares the look words only.
  static func compare(work: URL, exported: URL, gles: URL?, output: URL) throws {
    let plan = try JSONDecoder().decode(Plan.self, from: read(work.appendingPathComponent("plan.json")))
    let manifest = try JSONSerialization.jsonObject(with: read(exported.appendingPathComponent("frames.json"))) as! [String: Any]
    let names = (manifest["frames"] as! [[String: Any]]).map { $0["name"] as! String }
    let ids = Array(Set(names.map { String($0[..<$0.lastIndex(of: "-")!]) }))
    let frames = Dictionary(uniqueKeysWithValues: try selection(plan, ids: ids).map { ($0.name, ($0.frame, $0.look)) })
    let renderer = try Renderer()
    let pipeline = try renderer.pipeline(ClimbOverlayShader.source)
    var packets: [String: LoadedPacket] = [:]
    var photos: [String: CGImage] = [:]
    var rows: [[String: Any]] = []
    var worst: [(error: Int, name: String, metal: Data, android: Data, packet: LoadedPacket, board: String)] = []
    var wordFrames = 0, wordsDiffering = 0, largestWordDifference = 0
    for name in names {
      guard let entry = frames[name], let description = plan.packets[entry.0.packet],
        let board = plan.boards[description.board] else { throw PreviewError(description: "No frame \(name)") }
      let (frame, look) = entry
      let packet = try packets[frame.packet] ?? LoadedPacket(description, board: board, work: work, renderer: renderer)
      packets[frame.packet] = packet
      if photos[description.board] == nil { photos[description.board] = try Images.load(work.appendingPathComponent(board.photo)) }
      let swiftWords = try packet.look(frame, values: look)
      let kotlin = try read(exported.appendingPathComponent("frames/\(name).kotlin-look"))
      let kotlinWords = stride(from: 0, to: kotlin.count, by: 2).map { UInt16(kotlin[$0]) | UInt16(kotlin[$0 + 1]) << 8 }
      var differing = kotlinWords.count == swiftWords.count ? 0 : max(kotlinWords.count, swiftWords.count)
      if differing == 0 {
        for (left, right) in zip(swiftWords, kotlinWords) where left != right {
          differing += 1
          largestWordDifference = max(largestWordDifference, abs(Int(left) - Int(right)))
        }
      }
      if swiftWords.first == 1 { wordFrames += 1 }
      wordsDiffering += differing
      guard let gles else {
        rows.append(["name": name, "lookOn": swiftWords.first == 1, "holds": swiftWords.count / 4 - 1,
          "lookWordsDiffering": differing])
        continue
      }
      let metal = try renderer.draw(pipeline, width: packet.width, height: packet.height, pixels: packet.pixels,
        descriptors: packet.descriptors, lowerOffset: packet.scenes[frame.lower].offset,
        upperOffset: packet.scenes[frame.upper].offset,
        uniforms: packet.uniforms(lower: frame.lower, upper: frame.upper, swap: frame.swap), resources: packet.resources,
        look: swiftWords)
      let android = try read(gles.appendingPathComponent("\(name).rgba"))
      guard android.count == metal.count else { throw PreviewError(description: "GLES frame \(name) has the wrong size") }
      var largest = 0, overOne = 0, changed = 0
      metal.withUnsafeBytes { a in android.withUnsafeBytes { b in
        let left = a.bindMemory(to: UInt8.self), right = b.bindMemory(to: UInt8.self)
        var index = 0
        while index < left.count {
          var error = 0
          for channel in 0..<4 { error = max(error, abs(Int(left[index + channel]) - Int(right[index + channel]))) }
          largest = max(largest, error)
          if error > 1 { overOne += 1 }
          if error > 0 { changed += 1 }
          index += 4
        }
      } }
      let lookPixels = swiftWords.first == 1 ? changedPixels(metal, try renderer.draw(pipeline, width: packet.width,
        height: packet.height, pixels: packet.pixels, descriptors: packet.descriptors,
        lowerOffset: packet.scenes[frame.lower].offset, upperOffset: packet.scenes[frame.upper].offset,
        uniforms: packet.uniforms(lower: frame.lower, upper: frame.upper, swap: frame.swap), resources: packet.resources,
        look: ClimbOverlaySwapLook.off)).any : 0
      rows.append(["name": name, "lookOn": swiftWords.first == 1, "holds": swiftWords.count / 4 - 1,
        "lookWordsDiffering": differing, "maxChannelError": largest, "pixelsOverOne": overOne, "changedPixels": changed,
        "lookPixels": lookPixels])
      worst.append((largest * 10_000_000 + overOne, name, metal, android, packet, description.board))
      worst.sort { $0.error > $1.error }
      if worst.count > 3 { worst.removeLast() }
    }
    let images = output.appendingPathComponent("worst")
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    for entry in worst {
      var difference = Data(count: entry.metal.count)
      difference.withUnsafeMutableBytes { target in entry.metal.withUnsafeBytes { a in entry.android.withUnsafeBytes { b in
        let out = target.bindMemory(to: UInt8.self), left = a.bindMemory(to: UInt8.self), right = b.bindMemory(to: UInt8.self)
        for index in stride(from: 0, to: out.count, by: 4) {
          for channel in 0..<3 { out[index + channel] = UInt8(min(255, 32 * abs(Int(left[index + channel]) - Int(right[index + channel])))) }
          out[index + 3] = 255
        }
      } } }
      for (suffix, rgba) in [("metal", entry.metal), ("gles", entry.android)] {
        try Images.savePNG(try Images.composite(board: photos[entry.board]!,
          overlay: try Images.image(rgba, width: entry.packet.width, height: entry.packet.height)),
          to: images.appendingPathComponent("\(entry.name)-\(suffix).png"))
      }
      try Images.savePNG(try Images.image(difference, width: entry.packet.width, height: entry.packet.height),
        to: images.appendingPathComponent("\(entry.name)-difference-32x.png"))
    }
    func summary(_ subset: [[String: Any]]) -> [String: Any] {
      guard gles != nil else { return ["frames": subset.count] }
      return ["frames": subset.count, "maxChannelError": subset.map { $0["maxChannelError"] as! Int }.max() ?? 0,
       "meanLookPixels": subset.isEmpty ? 0 : subset.map { $0["lookPixels"] as! Int }.reduce(0, +) / subset.count,
       "framesWithPixelsOverOne": subset.filter { ($0["pixelsOverOne"] as! Int) > 0 }.count,
       "maxPixelsOverOne": subset.map { $0["pixelsOverOne"] as! Int }.max() ?? 0,
       "maxChangedPixels": subset.map { $0["changedPixels"] as! Int }.max() ?? 0,
       "meanChangedPixels": subset.isEmpty ? 0 : subset.map { $0["changedPixels"] as! Int }.reduce(0, +) / subset.count]
    }
    let report: [String: Any] = ["device": renderer.device.name, "lookOn": summary(rows.filter { $0["lookOn"] as! Bool }),
      "lookOff": summary(rows.filter { !($0["lookOn"] as! Bool) }),
      "lookWords": ["framesWithLook": wordFrames, "wordsDiffering": wordsDiffering, "largestDifference": largestWordDifference],
      "worst": worst.map(\.name), "rows": rows]
    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      .write(to: output.appendingPathComponent("compare.json"))
    let brief = report.filter { $0.key != "rows" }
    print(String(data: try JSONSerialization.data(withJSONObject: brief, options: [.sortedKeys]), encoding: .utf8)!)
  }

  /// The swap's two ends against the still compositor, pixel for pixel: a look frame at
  /// W = (1, 0) must draw exactly the lower climb at rest, and at W = (0, 1) exactly the
  /// upper one, or a pixel would change on the first drag frame and again on the swap's
  /// last frame. Every pair I's sheets draw, with each sheet's own look (Subtle and Bold,
  /// recorded Kilter climbs, shared-hold and role-change sets, MoonBoard).
  static func endpoints(work: URL, output: URL) throws {
    let plan = try JSONDecoder().decode(Plan.self, from: read(work.appendingPathComponent("plan.json")))
    let renderer = try Renderer()
    let pipeline = try renderer.pipeline(ClimbOverlayShader.source)
    var packets: [String: LoadedPacket] = [:]
    var rows: [[String: Any]] = []
    var seen = Set<String>()
    var differing = 0
    for sheet in plan.sheets where sheet.id.hasPrefix("I-") {
      for frame in sheet.frames where frame.lower != frame.upper {
        guard let values = frame.look, let look = ClimbOverlaySwapLook.Look(values) else {
          throw PreviewError(description: "\(sheet.id) has no look")
        }
        let key = "\(values)|\(frame.packet)|\(frame.lower)|\(frame.upper)"
        guard seen.insert(key).inserted else { continue }
        guard let description = plan.packets[frame.packet], let board = plan.boards[description.board] else {
          throw PreviewError(description: "No packet \(frame.packet)")
        }
        let loaded = try packets[frame.packet] ?? LoadedPacket(description, board: board, work: work, renderer: renderer)
        packets[frame.packet] = loaded
        let lowerScene = loaded.lookScene(frame.lower, upper: false)
        let upperScene = loaded.lookScene(frame.upper, upper: true)
        for (name, whole) in [("W=(1,0)", frame.lower), ("W=(0,1)", frame.upper)] {
          let lowerWhole = whole == frame.lower
          let swap: [Float] = lowerWhole ? [1, 0, 1] : [0, 1, 1]
          // The whole climb is the one being left (the first drag frame); the dark one arrives
          // from its slot's edge. A hold at W = 1 or 0 draws the same either way round.
          let words = ClimbOverlaySwapLook.encode(lower: lowerScene, upper: upperScene,
            lowerSide: ClimbOverlaySwapLook.Side(weight: swap[0], code: lowerWhole ? 0 : 2),
            upperSide: ClimbOverlaySwapLook.Side(weight: swap[1], code: lowerWhole ? 1 : 0),
            sharedFloor: 1, look: look, mirrored: false, allowReach: true)
          let shaped = try renderer.draw(pipeline, width: loaded.width, height: loaded.height, pixels: loaded.pixels,
            descriptors: loaded.descriptors, lowerOffset: loaded.scenes[frame.lower].offset,
            upperOffset: loaded.scenes[frame.upper].offset,
            uniforms: loaded.uniforms(lower: frame.lower, upper: frame.upper, swap: swap, transitioning: true),
            resources: loaded.resources, look: words)
          let still = try renderer.draw(pipeline, width: loaded.width, height: loaded.height, pixels: loaded.pixels,
            descriptors: loaded.descriptors, lowerOffset: loaded.scenes[whole].offset,
            upperOffset: loaded.scenes[whole].offset,
            uniforms: loaded.uniforms(lower: whole, upper: whole, swap: [1, 0, 1]), resources: loaded.resources,
            look: ClimbOverlaySwapLook.off)
          let changed = changedPixels(shaped, still)
          var largest = 0
          shaped.withUnsafeBytes { first in still.withUnsafeBytes { second in
            for index in 0..<first.count { largest = max(largest, abs(Int(first[index]) - Int(second[index]))) }
          } }
          if changed.any > 0 {
            differing += 1
            // Where they differ, eight times brighter, on black.
            var difference = Data(count: shaped.count)
            difference.withUnsafeMutableBytes { target in shaped.withUnsafeBytes { first in still.withUnsafeBytes { second in
              for index in stride(from: 0, to: first.count, by: 4) {
                for channel in 0..<3 {
                  target[index + channel] = UInt8(min(255, abs(Int(first[index + channel]) - Int(second[index + channel])) * 8))
                }
                target[index + 3] = 255
              }
            } } }
            let stem = "\(sheet.id)-\(frame.lower)-\(frame.upper)-\(lowerWhole ? "start" : "end")"
            try Images.savePNG(Images.image(difference, width: loaded.width, height: loaded.height),
              to: output.appendingPathComponent("\(stem)-difference.png"))
          }
          rows.append(["sheet": sheet.id, "packet": frame.packet, "lower": frame.lower, "upper": frame.upper,
            "weights": name, "changedPixels": changed.any, "visiblyChangedPixels": changed.visible,
            "maxChannelDifference": largest])
        }
      }
    }
    guard !rows.isEmpty else { throw PreviewError(description: "No pairs on I's sheets") }
    let status = differing == 0 ? "PASS_ENDPOINTS_MATCH_STILL" : "FAIL_ENDPOINTS_DIFFER"
    try JSONSerialization.data(withJSONObject: ["status": status, "device": renderer.device.name, "checks": rows.count,
      "differing": differing, "rows": rows], options: [.prettyPrinted, .sortedKeys])
      .write(to: output.appendingPathComponent("endpoints.json"))
    print("{\"status\":\"\(status)\",\"checks\":\(rows.count),\"differing\":\(differing)}")
    if differing > 0 { throw PreviewError(description: "A look frame at W = (1, 0) or (0, 1) differs from the still frame") }
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
