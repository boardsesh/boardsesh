import ExpoModulesCore
import UIKit

public class BoardRendererModule: Module {
  // Cap the on-disk PNG cache so heavy users don't accumulate hundreds of
  // MB of stale renders. The cache lives in Library/Caches, which iOS may
  // also reclaim on its own under storage pressure — this is just our
  // explicit upper bound.
  private static let cacheCapBytes: Int = 200 * 1024 * 1024

  private lazy var cacheDir: URL = {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("board-thumbnails", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      NSLog("[BoardRenderer] Failed to create cache dir at \(dir.path): \(error)")
    }
    return dir
  }()

  // Lazy-initialized once per module lifetime (i.e. once per app launch).
  // Accessing it from renderHoldsOverlay triggers the prune on first call.
  private lazy var pruneOnce: Void = {
    pruneCacheIfNeeded(maxBytes: BoardRendererModule.cacheCapBytes)
  }()

  private func pruneCacheIfNeeded(maxBytes: Int) {
    // Sort by modificationDate (not contentAccessDate) because that's what
    // we can reliably bump on a cache hit via setAttributes(.modificationDate:).
    // contentAccessDate is read-only via URLResourceKey on most volumes, so
    // mixing the two would let hot files appear stale after a relaunch.
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    guard let entries = try? FileManager.default.contentsOfDirectory(
      at: cacheDir,
      includingPropertiesForKeys: keys,
      options: [.skipsHiddenFiles]
    ) else { return }

    var infos: [(url: URL, size: Int, modified: Date)] = []
    var totalBytes = 0
    for url in entries {
      guard let values = try? url.resourceValues(forKeys: Set(keys)) else { continue }
      let size = values.fileSize ?? 0
      let modified = values.contentModificationDate ?? Date(timeIntervalSince1970: 0)
      infos.append((url, size, modified))
      totalBytes += size
    }

    if totalBytes <= maxBytes { return }

    infos.sort { $0.modified < $1.modified }
    var removed = 0
    for info in infos {
      if totalBytes <= maxBytes { break }
      do {
        try FileManager.default.removeItem(at: info.url)
        totalBytes -= info.size
        removed += 1
      } catch {
        NSLog("[BoardRenderer] Failed to evict \(info.url.lastPathComponent): \(error)")
      }
    }
    if removed > 0 {
      NSLog("[BoardRenderer] Pruned \(removed) cached PNGs; new total \(totalBytes) bytes")
    }
  }

  private func renderOverlay(configJson: String, cacheKey: String) throws -> String {
    _ = self.pruneOnce
    let outputUrl = self.cacheDir.appendingPathComponent("\(cacheKey).png")

    if FileManager.default.fileExists(atPath: outputUrl.path) {
      // Touch mtime so LRU treats hot files as recently used.
      try? FileManager.default.setAttributes(
        [.modificationDate: Date()], ofItemAtPath: outputUrl.path
      )
      return outputUrl.absoluteString
    }

    let jsonData = Array(configJson.utf8)
    var outData: UnsafeMutablePointer<UInt8>? = nil
    var outLen: UInt32 = 0
    var outWidth: UInt32 = 0
    var outHeight: UInt32 = 0

    let result = jsonData.withUnsafeBufferPointer { buffer in
      guard let baseAddress = buffer.baseAddress else { return Int32(-1) }
      return board_renderer_render(
        baseAddress,
        UInt32(buffer.count),
        &outData,
        &outLen,
        &outWidth,
        &outHeight
      )
    }

    guard result == 0, let pixelData = outData else {
      throw NSError(
        domain: "BoardRenderer", code: Int(result),
        userInfo: [
          NSLocalizedDescriptionKey: "Rust render failed with code \(result)"
        ])
    }

    defer { board_renderer_free(pixelData, outLen) }

    let width = Int(outWidth)
    let height = Int(outHeight)

    // Wrap the RGBA buffer Rust returned in a CGImage and PNG-encode it
    // directly — no compositing step, no background draws. tiny-skia's
    // Pixmap::data() returns premultiplied RGBA (verified in
    // tiny_skia::Pixmap docs: "A container that owns premultiplied RGBA
    // pixels"); CGImageAlphaInfo.premultipliedLast is the matching
    // CoreGraphics format. Using straight alpha here would produce
    // washed-out hold colors.
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
    guard let overlayContext = CGContext(
      data: UnsafeMutableRawPointer(pixelData),
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: colorSpace,
      bitmapInfo: bitmapInfo.rawValue
    ), let overlayImage = overlayContext.makeImage() else {
      throw NSError(
        domain: "BoardRenderer", code: -3,
        userInfo: [NSLocalizedDescriptionKey: "Failed to wrap RGBA buffer as CGImage"])
    }

    let uiImage = UIImage(cgImage: overlayImage)
    guard let pngData = uiImage.pngData() else {
      throw NSError(
        domain: "BoardRenderer", code: -4,
        userInfo: [NSLocalizedDescriptionKey: "PNG encoding failed"])
    }

    try pngData.write(to: outputUrl)
    return outputUrl.absoluteString
  }

  public func definition() -> ModuleDefinition {
    Name("BoardRenderer")

    // Renders just the climb's hold overlay — a transparent-background PNG
    // containing only the hold markers. The RN component stacks bundled
    // board background images underneath this overlay, mirroring the web
    // SVG-on-background model. Backgrounds aren't passed in here anymore;
    // keeping them in JS means the placeholder (backgrounds alone) is
    // visible while this async render is in flight.
    AsyncFunction("renderHoldsOverlay") {
      (configJson: String, cacheKey: String) throws -> String in
      try self.renderOverlay(configJson: configJson, cacheKey: cacheKey)
    }

    // Same renderer as renderHoldsOverlay, but the method's presence is a
    // native capability signal for marker shape, brush, and size overrides.
    AsyncFunction("renderHoldsOverlayWithMarkers") {
      (configJson: String, cacheKey: String) throws -> String in
      try self.renderOverlay(configJson: configJson, cacheKey: cacheKey)
    }
  }
}
