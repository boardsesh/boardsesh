import Foundation
import Metal
import CryptoKit

struct AuraGoldenError: Error { let message: String }
struct AuraGoldenScene: Decodable { let offset: Int; let bytes: Int; let count: Int }
struct AuraGoldenSample: Decodable {
  let name: String
  let lower: Int
  let upper: Int
  let progress: Float
  let pulse: Float
  let mirrored: Bool
  let editorAllChanged: Bool
}
struct AuraGoldenInputs: Decodable {
  let version: Int
  let width: Int
  let height: Int
  let contractSha256: String
  let scenes: [AuraGoldenScene]
  let samples: [AuraGoldenSample]
  let pixelFiles: [String: String]
  let resourceFiles: [String: String]
  let descriptorFiles: [String: [String: String]]
}

/// Shared by the macOS preflight and the separately signed diagnostic UIKit app.
/// No account, preferences, network, telemetry, gesture or production-view calls.
enum MetalGolden {
  static func run(inputURL: URL, outputURL: URL) throws {
    func require(_ condition: Bool, _ message: String) throws {
      if !condition { throw AuraGoldenError(message: message) }
    }
    func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    func read(_ name: String, limit: Int = 128 * 1024 * 1024) throws -> Data {
      try require(!name.isEmpty && name != "." && name != ".." && name.range(of: "^[a-zA-Z0-9.-]+$", options: .regularExpression) != nil, "Unsafe bundled input filename")
      let path = inputURL.deletingLastPathComponent().appendingPathComponent(name)
      let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
      let length = (attributes[.size] as? NSNumber)?.intValue ?? -1
      try require(length >= 0 && length <= limit, "Input length outside bound")
      return try Data(contentsOf: path)
    }
    let inputs = try JSONDecoder().decode(AuraGoldenInputs.self, from: Data(contentsOf: inputURL))
    try require(inputs.version == 1 && inputs.width == 1080 && inputs.height == 1504, "Fixture dimensions/version changed")
    try require(inputs.scenes.map { $0.count } == [6, 7, 7] && inputs.samples.count == 42, "Fixture scenes/controls changed")
    try require(inputs.contractSha256 == ClimbOverlayPacketLayout.contractSha256, "Compiled contract differs from input")
    try require(!FileManager.default.fileExists(atPath: outputURL.path), "Preserve existing output folder")
    try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { throw AuraGoldenError(message: "Metal unavailable") }
    func pipeline(_ source: String) throws -> MTLRenderPipelineState {
      let library = try device.makeLibrary(source: source, options: nil)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "overlay_vertex")
      descriptor.fragmentFunction = library.makeFunction(name: "overlay_fragment")
      descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
      return try device.makeRenderPipelineState(descriptor: descriptor)
    }
    let pipelines = ["old": try pipeline(ReferenceShader.source), "new": try pipeline(ClimbOverlayShader.source)]
    var allocations = 0
    func buffer(_ contents: Data) throws -> MTLBuffer {
      let conservative = ((contents.count + 16383) / 16384) * 16384
      try require(contents.count > 0 && allocations + conservative <= 128 * 1024 * 1024, "Owned buffer admission failed")
      guard let buffer = contents.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: contents.count, options: .storageModeShared) }) else { throw AuraGoldenError(message: "Buffer allocation failed") }
      allocations += buffer.allocatedSize
      try require(allocations <= 128 * 1024 * 1024, "Actual owned buffer budget exceeded")
      return buffer
    }
    var pixelBuffers: [String: MTLBuffer] = [:], resourceBuffers: [String: MTLBuffer] = [:]
    var descriptorBuffers: [String: [String: MTLBuffer]] = [:]
    for mode in ["old", "new"] {
      guard let pixels = inputs.pixelFiles[mode], let resources = inputs.resourceFiles[mode] else { throw AuraGoldenError(message: "Missing input buffers") }
      pixelBuffers[mode] = try buffer(read(pixels))
      resourceBuffers[mode] = try buffer(read(resources, limit: 8 * 1024 * 1024))
      var variants: [String: MTLBuffer] = [:]
      for variant in ["transition", "editor"] {
        guard let path = inputs.descriptorFiles[variant]?[mode] else { throw AuraGoldenError(message: "Missing descriptor variant") }
        let bytes = try read(path, limit: 384 * 224)
        try require(bytes.count == 4480, "Descriptor stride/count changed")
        variants[variant] = try buffer(bytes)
      }
      descriptorBuffers[mode] = variants
    }
    let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: inputs.width, height: inputs.height, mipmapped: false)
    textureDescriptor.usage = [.renderTarget]; textureDescriptor.storageMode = .shared
    let textureEstimate = device.heapTextureSizeAndAlign(descriptor: textureDescriptor).size
    try require(allocations + textureEstimate <= 128 * 1024 * 1024, "Owned texture admission failed")
    guard let texture = device.makeTexture(descriptor: textureDescriptor) else { throw AuraGoldenError(message: "Texture allocation failed") }
    allocations += texture.allocatedSize
    try require(allocations <= 128 * 1024 * 1024, "Actual owned texture budget exceeded")
    var rows: [[String: Any]] = [], names = Set<String>(), hashes: [String: String] = [:]
    var commands = 0, maximumError = 0, pixelsOverOne = 0
    for sample in inputs.samples {
      try require(sample.name.range(of: "^[a-z0-9-]{1,64}$", options: .regularExpression) != nil && names.insert(sample.name).inserted, "Unsafe/duplicate sample name")
      try require((0..<3).contains(sample.lower) && (0..<3).contains(sample.upper), "Invalid source slot")
      let variant = sample.editorAllChanged ? "editor" : "transition"
      var outputs: [String: Data] = [:]
      for mode in ["old", "new"] {
        guard let pixels = pixelBuffers[mode], let resources = resourceBuffers[mode], let descriptors = descriptorBuffers[mode]?[variant], let pipeline = pipelines[mode], let command = queue.makeCommandBuffer() else { throw AuraGoldenError(message: "Missing render resources") }
        let uniforms = try read("\(mode)-uniforms-\(sample.name).bin", limit: 144)
        try require(uniforms.count == 144, "Uniform stride changed")
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture; pass.colorAttachments[0].loadAction = .clear; pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
        guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { throw AuraGoldenError(message: "Encoder unavailable") }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBuffer(pixels, offset: 0, index: 0)
        encoder.setFragmentBuffer(descriptors, offset: inputs.scenes[sample.lower].offset, index: 1)
        uniforms.withUnsafeBytes { encoder.setFragmentBytes($0.baseAddress!, length: 144, index: 2) }
        encoder.setFragmentBuffer(resources, offset: 0, index: 3)
        encoder.setFragmentBuffer(descriptors, offset: inputs.scenes[sample.upper].offset, index: 4)
        // The swap look's header (binding 5), zero: no look, API 7's swap. The reference ignores it.
        let lookOff: [UInt16] = [0, 0, 0, 0]
        lookOff.withUnsafeBytes { encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: 5) }
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding(); command.commit(); command.waitUntilCompleted(); commands += 1
        try require(command.status == .completed && command.error == nil, "Metal command failed: \(String(describing: command.error))")
        var output = Data(repeating: 0, count: inputs.width * inputs.height * 4)
        output.withUnsafeMutableBytes { texture.getBytes($0.baseAddress!, bytesPerRow: inputs.width * 4, from: MTLRegionMake2D(0, 0, inputs.width, inputs.height), mipmapLevel: 0) }
        try output.write(to: outputURL.appendingPathComponent("\(sample.name)-\(mode).rgba"), options: .atomic)
        outputs[mode] = output; hashes["\(sample.name)-\(mode)"] = hash(output)
      }
      let reference = outputs["old"]!, actual = outputs["new"]!
      var localMaximum = 0, localOverOne = 0, changedPixels = 0
      reference.withUnsafeBytes { firstBytes in actual.withUnsafeBytes { secondBytes in
        let first = firstBytes.bindMemory(to: UInt8.self), second = secondBytes.bindMemory(to: UInt8.self)
        for pixel in 0..<(inputs.width * inputs.height) {
          var error = 0
          for channel in 0..<4 { error = max(error, abs(Int(first[pixel * 4 + channel]) - Int(second[pixel * 4 + channel]))) }
          localMaximum = max(localMaximum, error)
          if error > 1 { localOverOne += 1 }; if error > 0 { changedPixels += 1 }
        }
      } }
      maximumError = max(maximumError, localMaximum); pixelsOverOne += localOverOne
      rows.append(["name": sample.name, "maxChannelError": localMaximum, "pixelsOverOne": localOverOne, "changedPixels": changedPixels, "oldRgbaSha256": hash(reference), "newRgbaSha256": hash(actual)])
    }
    let progressChanges = hashes["forward-0-m0-new"] != hashes["forward-4-m0-new"]
    let pulseChanges = hashes["editor-0-m0-new"] != hashes["editor-2-m0-new"]
    let mirrorChanges = hashes["forward-2-m0-new"] != hashes["forward-2-m1-new"]
    var reversalStable = true
    for mirror in 0..<2 { for index in 0..<5 { for mode in ["old", "new"] {
      reversalStable = reversalStable && hashes["forward-\(index)-m\(mirror)-\(mode)"] == hashes["reverse-\(4-index)-m\(mirror)-\(mode)"]
    } } }
    var swapStable = true
    for mode in ["old", "new"] {
      swapStable = swapStable && hashes["swap-0-m0-\(mode)"] == hashes["forward-0-m0-\(mode)"]
        && hashes["swap-4-m0-\(mode)"] == hashes["forward-4-m0-\(mode)"]
        && hashes["swap-2-m0-\(mode)"] == hashes["swap-2-m1-\(mode)"]
        && hashes["swap-1-m0-\(mode)"] != hashes["swap-0-m0-\(mode)"]
        && hashes["swap-2-m0-\(mode)"] != hashes["swap-3-m0-\(mode)"]
        && hashes["swap-shared-1-m0-\(mode)"] != hashes["swap-2-m0-\(mode)"]
        && hashes["swap-shared-3-m0-\(mode)"] != hashes["swap-0-m0-\(mode)"]
    }
    let passed = maximumError <= 1 && pixelsOverOne == 0 && commands == 84 && progressChanges && pulseChanges && mirrorChanges && reversalStable && swapStable
    let executableHash = try Bundle.main.executableURL.map { hash(try Data(contentsOf: $0)) } ?? "unavailable"
    let report: [String: Any] = ["status": passed ? "PASS_ACTUAL_METAL_RICH_42" : "FAIL_ACTUAL_METAL_RICH_42", "device": device.name, "processId": ProcessInfo.processInfo.processIdentifier, "bundleId": Bundle.main.bundleIdentifier ?? "host-helper", "executableSha256": executableHash, "compiledContractSha256": ClimbOverlayPacketLayout.contractSha256, "beforeRuntimeShaderSha256": hash(Data(ReferenceShader.source.utf8)), "afterRuntimeShaderSha256": hash(Data(ClimbOverlayShader.source.utf8)), "width": inputs.width, "height": inputs.height, "commandsCompleted": commands, "maximumChannelError": maximumError, "pixelsOverOne": pixelsOverOne, "progressChangesPixels": progressChanges, "editingPulseChangesPixels": pulseChanges, "displayMirrorChangesPixels": mirrorChanges, "reversalStable": reversalStable, "swapStable": swapStable, "trackedOwnedAllocationBytes": allocations, "samples": rows, "qualification": "Offscreen actual Metal shader images. Host and physical iPhone runs are separately identified; no gesture cadence, scanout, frame performance or driver-private allocation claim. Rust endpoint/pulse comparisons are independently checked by the host collector."]
    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: outputURL.appendingPathComponent("result.json"), options: .atomic)
    try require(passed, "Metal comparison failed; all raw outputs retained")
  }
}
