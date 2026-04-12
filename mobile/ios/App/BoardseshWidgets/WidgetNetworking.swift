import Foundation

enum WidgetNetworking {
    static func sendNavigation(action: String, currentIndex: Int) async {
        guard let defaults = SharedConstants.sharedDefaults,
              let serverUrl = defaults.string(forKey: SharedConstants.serverUrlKey),
              let sessionId = defaults.string(forKey: SharedConstants.sessionIdKey)
        else { return }

        guard let url = URL(string: "\(serverUrl)/api/widget/navigate") else { return }

        let body: [String: Any] = [
            "sessionId": sessionId,
            "action": action,
            "currentIndex": currentIndex
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        request.httpBody = jsonData

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode != 200 {
                print("[Widget] Navigation request failed with status \(httpResponse.statusCode)")
            }
        } catch {
            print("[Widget] Navigation request failed: \(error.localizedDescription)")
        }
    }
}
