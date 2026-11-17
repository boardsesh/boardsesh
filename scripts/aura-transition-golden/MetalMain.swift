import Foundation
@main enum AuraGoldenHost {
  static func main() throws {
    guard CommandLine.arguments.count == 3 else { throw AuraGoldenError(message: "Expected inputs.json fresh-output-directory") }
    try MetalGolden.run(inputURL: URL(fileURLWithPath: CommandLine.arguments[1]), outputURL: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
  }
}
