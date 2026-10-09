import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation
import UIKit

public class MobileCpuProfileModule: Module {
  private func digest(_ url: URL) throws -> String {
    SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
  }

  public func definition() -> ModuleDefinition {
    Name("MobileCpuProfile")
    AsyncFunction("snapshot") { () throws -> [String: Double] in
      var usage = rusage()
      guard getrusage(RUSAGE_SELF, &usage) == 0 else {
        throw NSError(domain: "MobileCpuProfile", code: 1, userInfo: [NSLocalizedDescriptionKey: "getrusage failed"])
      }
      let cpuMs = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000
        + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
      return ["cpuMs": cpuMs, "monotonicMs": ProcessInfo.processInfo.systemUptime * 1000, "pid": Double(getpid())]
    }
    AsyncFunction("identity") { () throws -> [String: Any] in
      let bundle = Bundle.main
      guard let mainBundle = bundle.url(forResource: "main", withExtension: "jsbundle"), let executable = bundle.executableURL,
        let expoPlist = bundle.url(forResource: "Expo", withExtension: "plist"),
        let updates = NSDictionary(contentsOf: expoPlist), let otaEnabled = updates["EXUpdatesEnabled"] as? Bool else {
        throw NSError(domain: "MobileCpuProfile", code: 2, userInfo: [NSLocalizedDescriptionKey: "Embedded bundle or explicit OTA setting missing"])
      }
      #if DEBUG
      let configuration = "Debug"
      #else
      let configuration = "Release"
      #endif
      #if targetEnvironment(simulator)
      let physical = false
      #else
      let physical = true
      #endif
      var machine = utsname()
      uname(&machine)
      let machineCapacity = MemoryLayout.size(ofValue: machine.machine)
      let model = withUnsafePointer(to: &machine.machine) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: machineCapacity) { String(cString: $0) }
      }
      return ["appId": bundle.bundleIdentifier ?? "", "configuration": configuration, "platform": "ios", "physical": physical,
        "pid": Int(getpid()), "model": model, "osVersion": UIDevice.current.systemVersion, "otaEnabled": otaEnabled,
        "embeddedBundleSha256": try self.digest(mainBundle), "artifactSha256": try self.digest(executable),
        "cpuClock": "getrusage-self-user-plus-system-ms"]
    }
  }
}
