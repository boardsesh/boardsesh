import AdServices
import ExpoModulesCore

public class AppleAdsAttributionModule: Module {
    public func definition() -> ModuleDefinition {
        Name("AppleAdsAttribution")

        // Expo runs this synchronous closure on its background AsyncFunction
        // queue. Never expose NSError descriptions: only the token or a fixed
        // outcome crosses into JS, and neither is logged here.
        AsyncFunction("getAttributionToken") { () -> [String: String] in
            guard #available(iOS 14.3, *) else {
                return ["status": "unavailable"]
            }
            do {
                return ["status": "available", "token": try AAAttribution.attributionToken()]
            } catch {
                if let attributionError = error as? AAAttributionError,
                   attributionError.code == .platformNotSupported {
                    return ["status": "unavailable"]
                }
                return ["status": "retryable"]
            }
        }
    }
}
