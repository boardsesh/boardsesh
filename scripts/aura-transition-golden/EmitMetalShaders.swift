import Foundation
import CryptoKit
@main enum EmitGoldenMetalSources {
  static func main() throws {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "AuraGolden", code: 1) }
    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    guard !FileManager.default.fileExists(atPath: root.path) else { throw NSError(domain: "AuraGolden", code: 2) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    let before = Data(ReferenceShader.source.utf8), after = Data(ClimbOverlayShader.source.utf8)
    try before.write(to: root.appendingPathComponent("before.metal"))
    try after.write(to: root.appendingPathComponent("after.metal"))
    let result = ["compiledContractSha256": ClimbOverlayPacketLayout.contractSha256, "beforeRuntimeShaderSha256": hash(before), "afterRuntimeShaderSha256": hash(after)]
    try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("receipt.json"))
  }
}
