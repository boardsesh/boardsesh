import CoreGraphics
import Foundation
import ImageIO
import Metal
import UniformTypeIdentifiers

/// Board motion lab previews, step 2, on this Mac's GPU: the real
/// `ClimbOverlayShader.source`, real Rust packets and uniforms, and the swap look
/// buffer from the real `ClimbOverlaySwapLook.swift`. Compiled and run by
/// render.mjs; see README.md.
///
///   preview <prepared work dir> <fresh output dir>
///   parity  <aura-transition-golden work dir> <fresh output dir>
struct PreviewError: Error, CustomStringConvertible { let description: String }

struct PreviewScene: Decodable { let offset: Int; let bytes: Int; let count: Int }
struct PreviewSample: Decodable {
  let name: String
  let variant: String
  let letter: String
  let label: String
  let lower: Int
  let upper: Int
  let swap: [Float]
  let arrivals: [Bool]
  let look: [Double]?
}
struct PreviewTimeline: Decodable {
  let width: Int
  let height: Int
  let scenes: [PreviewScene]
  let samples: [PreviewSample]
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

final class Renderer {
  let device: MTLDevice
  let queue: MTLCommandQueue
  let width: Int
  let height: Int
  let texture: MTLTexture

  init(width: Int, height: Int) throws {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
      throw PreviewError(description: "Metal unavailable")
    }
    self.device = device
    self.queue = queue
    self.width = width
    self.height = height
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height,
      mipmapped: false)
    descriptor.usage = [.renderTarget]
    descriptor.storageMode = .shared
    guard let texture = device.makeTexture(descriptor: descriptor) else { throw PreviewError(description: "No texture") }
    self.texture = texture
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

  /// One draw, exactly as encodeClimbOverlayPacket binds it, read back as premultiplied RGBA.
  func draw(_ pipeline: MTLRenderPipelineState, pixels: MTLBuffer, descriptors: MTLBuffer, lowerOffset: Int,
            upperOffset: Int, uniforms: Data, resources: MTLBuffer, look: [UInt16]) throws -> Data {
    guard uniforms.count == ClimbOverlayPacketLayout.uniformBytes, let command = queue.makeCommandBuffer() else {
      throw PreviewError(description: "Bad uniforms or no command buffer")
    }
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
      texture.getBytes($0.baseAddress!, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height),
        mipmapLevel: 0)
    }
    return output
  }
}

enum Images {
  static func image(_ rgba: Data, width: Int, height: Int) throws -> CGImage {
    guard let provider = CGDataProvider(data: rgba as CFData),
      let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider,
        decode: nil, shouldInterpolate: false, intent: .defaultIntent)
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

  /// The overlay drawn source-over on the board photo, as the app stacks them.
  static func composite(board: CGImage, overlay: CGImage) throws -> CGImage {
    guard let context = CGContext(data: nil, width: overlay.width, height: overlay.height, bitsPerComponent: 8,
      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw PreviewError(description: "No context") }
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
}

@main enum BoardMotionPreview {
  static func read(_ url: URL) throws -> Data { try Data(contentsOf: url) }

  static func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 4, ["preview", "parity"].contains(arguments[1]) else {
      throw PreviewError(description: "Usage: preview|parity <work dir> <fresh output dir>")
    }
    let work = URL(fileURLWithPath: arguments[2], isDirectory: true)
    let output = URL(fileURLWithPath: arguments[3], isDirectory: true)
    guard !FileManager.default.fileExists(atPath: output.path) else {
      throw PreviewError(description: "Output exists: \(output.path)")
    }
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    if arguments[1] == "preview" { try preview(work: work, output: output) } else { try parity(work: work, output: output) }
  }

  /// Every timeline frame, composited on the board photo, one PNG each.
  static func preview(work: URL, output: URL) throws {
    let timeline = try JSONDecoder().decode(PreviewTimeline.self, from: read(work.appendingPathComponent("timeline.json")))
    let packet = work.appendingPathComponent("packet")
    let renderer = try Renderer(width: timeline.width, height: timeline.height)
    let pipeline = try renderer.pipeline(ClimbOverlayShader.source)
    let descriptorBytes = try read(packet.appendingPathComponent("descriptors.bin"))
    let pixels = try renderer.buffer(read(packet.appendingPathComponent("pixels.bin")))
    let resources = try renderer.buffer(read(packet.appendingPathComponent("resources.bin")))
    let descriptors = try renderer.buffer(descriptorBytes)
    let board = try Images.load(work.appendingPathComponent("board.png"))
    /// A scene's holds as the look reads them, as the lower or upper side.
    func scene(_ slot: Int, upper: Bool) -> ClimbOverlaySwapLook.Scene {
      let scene = timeline.scenes[slot]
      let holds = descriptorBytes.withUnsafeBytes { bytes in
        ClimbOverlaySwapLook.holds(descriptors: UnsafeRawBufferPointer(rebasing: bytes[scene.offset..<(scene.offset + scene.bytes)]),
          count: scene.count, upper: upper, width: Float(timeline.width), height: Float(timeline.height))
      }
      return ClimbOverlaySwapLook.Scene(holds)
    }
    var report: [[String: Any]] = []
    for sample in timeline.samples {
      let uniforms = try read(packet.appendingPathComponent("uniforms-\(sample.name).bin"))
      var look = ClimbOverlaySwapLook.off
      if let values = sample.look, sample.lower != sample.upper {
        guard let parsed = ClimbOverlaySwapLook.Look(values) else { throw PreviewError(description: "Bad look") }
        look = ClimbOverlaySwapLook.encode(lower: scene(sample.lower, upper: false), upper: scene(sample.upper, upper: true),
          lowerSide: ClimbOverlaySwapLook.Side(weight: sample.swap[0], arriving: sample.arrivals[0]),
          upperSide: ClimbOverlaySwapLook.Side(weight: sample.swap[1], arriving: sample.arrivals[1]),
          sharedFloor: sample.swap[2], look: parsed, mirrored: false, allowReach: true)
      }
      let rgba = try renderer.draw(pipeline, pixels: pixels, descriptors: descriptors,
        lowerOffset: timeline.scenes[sample.lower].offset, upperOffset: timeline.scenes[sample.upper].offset,
        uniforms: uniforms, resources: resources, look: look)
      let overlay = try Images.image(rgba, width: timeline.width, height: timeline.height)
      try Images.savePNG(overlay, to: output.appendingPathComponent("\(sample.name)-overlay.png"))
      try Images.savePNG(try Images.composite(board: board, overlay: overlay),
        to: output.appendingPathComponent("\(sample.name).png"))
      report.append(["name": sample.name, "variant": sample.variant, "label": sample.label,
        "lookOn": look[0] == 1, "holds": max(0, look.count / 4 - 1)])
    }
    try JSONSerialization.data(withJSONObject: ["device": renderer.device.name, "frames": report],
      options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("render.json"))
    print("{\"status\":\"RENDERED\",\"frames\":\(report.count),\"device\":\"\(renderer.device.name)\"}")
  }

  /// The golden's 42 samples through the shader as it was (`BaselineShader`) and as
  /// it is with no look bound: every byte must match.
  static func parity(work: URL, output: URL) throws {
    let inputsURL = work.appendingPathComponent("inputs/inputs.json")
    let inputs = try JSONDecoder().decode(GoldenInputs.self, from: read(inputsURL))
    let directory = inputsURL.deletingLastPathComponent()
    let renderer = try Renderer(width: inputs.width, height: inputs.height)
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
    var changedPixelsTotal = 0
    for sample in inputs.samples {
      let uniforms = try read(directory.appendingPathComponent("new-uniforms-\(sample.name).bin"))
      let buffer = descriptors[sample.editorAllChanged ? "editor" : "transition"]!
      let lowerOffset = inputs.scenes[sample.lower].offset
      let upperOffset = inputs.scenes[sample.upper].offset
      let before = try renderer.draw(baseline, pixels: pixels, descriptors: buffer, lowerOffset: lowerOffset,
        upperOffset: upperOffset, uniforms: uniforms, resources: resources, look: ClimbOverlaySwapLook.off)
      let after = try renderer.draw(current, pixels: pixels, descriptors: buffer, lowerOffset: lowerOffset,
        upperOffset: upperOffset, uniforms: uniforms, resources: resources, look: ClimbOverlaySwapLook.off)
      var changed = 0
      var maximum = 0
      before.withUnsafeBytes { first in after.withUnsafeBytes { second in
        for pixel in 0..<(inputs.width * inputs.height) {
          var error = 0
          for channel in 0..<4 { error = max(error, abs(Int(first[pixel * 4 + channel]) - Int(second[pixel * 4 + channel]))) }
          if error > 0 { changed += 1 }
          maximum = max(maximum, error)
        }
      } }
      if before == after { identical += 1 }
      changedPixelsTotal += changed
      rows.append(["name": sample.name, "identicalBytes": before == after, "changedPixels": changed,
        "maxChannelError": maximum])
    }
    let passed = identical == inputs.samples.count
    try JSONSerialization.data(withJSONObject: ["status": passed ? "PASS_LOOK_OFF_IDENTICAL" : "FAIL_LOOK_OFF_DIFFERS",
      "device": renderer.device.name, "samples": inputs.samples.count, "identicalSamples": identical,
      "changedPixels": changedPixelsTotal, "rows": rows], options: [.prettyPrinted, .sortedKeys])
      .write(to: output.appendingPathComponent("parity.json"))
    print("{\"status\":\"\(passed ? "PASS_LOOK_OFF_IDENTICAL" : "FAIL_LOOK_OFF_DIFFERS")\",\"identical\":\(identical),\"samples\":\(inputs.samples.count),\"changedPixels\":\(changedPixelsTotal)}")
    if !passed { throw PreviewError(description: "Look-off output differs from the baseline shader") }
  }
}
