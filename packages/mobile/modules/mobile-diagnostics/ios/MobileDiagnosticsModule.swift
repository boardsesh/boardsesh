import ExpoModulesCore
import Sentry

@_silgen_name("boardsesh_diagnostics_abort")
private func boardseshDiagnosticsAbort()

public class MobileDiagnosticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MobileDiagnostics")
    Constants([
      "nativeInitVersion": 1,
      "nativeAbortVersion": 2,
      "nativeStartupId": UserDefaults.standard.string(forKey: "boardsesh.diagnostics.startupId") ?? "",
      "previousNativeStartupId": UserDefaults.standard.bool(forKey: "boardsesh.diagnostics.startupMarkerDurable") ? UserDefaults.standard.string(forKey: "boardsesh.diagnostics.previousStartupId") ?? "" : ""
    ])
    Function("crashNativeAbort") { (testRunId: String, snapshotJson: String) -> Bool in
      #if DEBUG
      return false
      #else
      guard SentrySDK.isEnabled, !testRunId.isEmpty, testRunId.count <= 200,
        let bytes = snapshotJson.data(using: .utf8), bytes.count <= 32768,
        let snapshot = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
      else { return false }
      let launchId = (snapshot["launch"] as? [String: Any])?["launchId"] as? String
      guard launchId == nil || launchId!.count <= 200 else { return false }
      // Cocoa 9.29's crash scope observer writes tags/context synchronously into
      // SentryCrash. Keep this scope update and libc abort in the same native call.
      SentrySDK.configureScope { scope in
        scope.setTag(value: "sentry-test", key: "source")
        scope.setTag(value: "native-abort", key: "sentry_test_kind")
        scope.setTag(value: testRunId, key: "test_run_id")
        if let launchId = launchId {
          scope.setTag(value: launchId, key: "launch_id")
        }
        scope.setContext(value: snapshot, key: "mobile_diagnostics_native_abort")
      }
      boardseshDiagnosticsAbort()
      return true // Unreachable with the real libc abort.
      #endif
    }
  }
}
