import Foundation

/// Value-only, bounded observations. Never owns peripherals or performs BLE work.
struct BoardBleEvidenceDevice {
    let deviceId: String
    var localName: String?
    var cachedName: String?
    var serviceUuids: [String] = []
    var manufacturerData: String?
    var serviceData: [String: String] = [:]
    var observedAt = Date.distantPast
    var manufacturerDataOriginalBytes: Int?
    var serviceDataOriginalBytes: [String: Int] = [:]
    var truncated = false

    var eligible: Bool {
        let name = (localName ?? cachedName ?? "").lowercased()
        // Match the shared Aurora parser's whitespace/hyphen normalization
        // for the multi-word So iLL brand. This remains a name hint only.
        let normalizedName = name.filter { !$0.isWhitespace && $0 != "-" }
        let isSoillName = normalizedName.hasPrefix("soill")
        let brands = ["moonboard", "kilter", "tension", "woods", "grasshopper", "touchstone", "decoy", "soill"]
        let specificServices = ["4488b571-7806-4df6-bcff-a2897e4953ff", "2c9285bc-dfd0-4fd8-a13d-393660f8a060", "7a112233-4455-6677-8899-aabbccddee01"]
        return isSoillName || brands.contains(where: { brand in
            guard name.hasPrefix(brand) else { return false }
            guard let boundary = name.dropFirst(brand.count).first else { return true }
            return boundary.isWhitespace || "#@-".contains(boundary)
        }) || serviceUuids.contains(where: specificServices.contains)
    }

    var dictionary: [String: Any] {
        var result: [String: Any] = ["deviceId": deviceId, "serviceUuids": serviceUuids,
                                    "observedAt": ISO8601DateFormatter().string(from: observedAt), "advertisementStatus": "observed", "truncated": truncated]
        if let localName { result["localName"] = localName }
        if let cachedName { result["cachedName"] = cachedName }
        if let manufacturerData { result["manufacturerData"] = manufacturerData }
        if let manufacturerDataOriginalBytes { result["manufacturerDataOriginalBytes"] = manufacturerDataOriginalBytes }
        if !serviceDataOriginalBytes.isEmpty { result["serviceDataOriginalBytes"] = serviceDataOriginalBytes }
        if !serviceData.isEmpty { result["serviceData"] = serviceData }
        return result
    }
}

struct BoardBleEvidenceScan {
    let scanId: String
    private(set) var complete = false
    private(set) var devices: [String: BoardBleEvidenceDevice] = [:]
    private var order: [String] = []
    private(set) var droppedCount = 0

    init(scanId: String) { self.scanId = scanId }

    mutating func finish() { complete = true }

    mutating func observe(deviceId: String, localName: String?, cachedName: String?, serviceUuids: [String],
                          manufacturerData: String?, serviceData: [String: String]?, now: Date = Date()) {
        guard !complete else { return }
        if devices[deviceId] == nil, devices.count >= 158 {
            // Recognized records survive unrelated traffic; only 128 pending
            // observations and 30 recognized boards can occupy the buffer.
            guard let victim = order.first(where: { devices[$0]?.eligible == false }) else {
                droppedCount += 1
                return
            }
            devices.removeValue(forKey: victim)
            order.removeAll { $0 == victim }
            droppedCount += 1
        }
        var device = devices[deviceId] ?? BoardBleEvidenceDevice(deviceId: deviceId)
        if let localName { device.localName = String(localName.prefix(256)); device.truncated = device.truncated || localName.count > 256 }
        if let cachedName { device.cachedName = String(cachedName.prefix(256)); device.truncated = device.truncated || cachedName.count > 256 }
        let uuids = Set(device.serviceUuids + serviceUuids.map { $0.lowercased() }).sorted()
        device.serviceUuids = Array(uuids.prefix(32))
        device.truncated = device.truncated || uuids.count > 32
        if let manufacturerData {
            device.manufacturerData = String(manufacturerData.prefix(1024))
            device.manufacturerDataOriginalBytes = manufacturerData.count / 2
            device.truncated = device.truncated || manufacturerData.count > 1024
        }
        for (uuid, bytes) in (serviceData ?? [:]).sorted(by: { $0.key < $1.key }) {
            let key = uuid.lowercased()
            guard device.serviceData[key] != nil || device.serviceData.count < 16 else { device.truncated = true; continue }
            device.serviceData[key] = String(bytes.prefix(1024))
            device.serviceDataOriginalBytes[key] = bytes.count / 2
            device.truncated = device.truncated || bytes.count > 1024
        }
        device.observedAt = now
        // Enforce independent pending/eligible budgets after a packet promotes
        // an anonymous peripheral into a board candidate.
        let eligibleCount = devices.values.filter(\.eligible).count - (devices[deviceId]?.eligible == true ? 1 : 0)
        if device.eligible, eligibleCount >= 30 { droppedCount += 1; return }
        if !device.eligible, devices[deviceId] == nil,
           devices.values.filter({ !$0.eligible }).count >= 128,
           let victim = order.first(where: { devices[$0]?.eligible == false }) {
            devices.removeValue(forKey: victim)
            order.removeAll { $0 == victim }
            droppedCount += 1
        }
        devices[deviceId] = device
        order.removeAll { $0 == deviceId }
        order.append(deviceId)
    }

    func dictionary(selectedDeviceId: String) -> [String: Any] {
        var candidates = devices.values.filter { $0.eligible && $0.deviceId != selectedDeviceId }.sorted { $0.deviceId < $1.deviceId }
        candidates = Array(candidates.prefix(30))
        if let selected = devices[selectedDeviceId] { candidates.insert(selected, at: 0) }
        return ["version": 1, "scanId": scanId, "complete": complete,
                "devices": candidates.map(\.dictionary), "droppedCount": droppedCount]
    }
}
