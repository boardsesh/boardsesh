import CoreBluetooth
import Foundation

struct BoardBleConfiguration: Codable, Equatable {
    let boardName: String
    let layoutId: Int
    let sizeId: Int
    let apiLevel: Int?
    let deviceName: String?
    let colorOverrides: [String: String]
    // MoonBoard grid rows (18 standard, 12 Mini). Optional so configs
    // persisted by builds that predate it still decode (#3392).
    let numRows: Int?
    // MoonBoard "V2" additional-LED feature (light each hold's neighbour LED,
    // firmware-defined — see BoardBleEncoding.makeMoonboardPacket). Optional,
    // like `numRows` above: Swift's synthesized Decodable only skips a missing
    // key for an Optional-typed property (`decodeIfPresent`) — a non-optional
    // stored property's default-value expression is NOT consulted by Codable
    // synthesis, so `Bool = false` here would still throw `keyNotFound` and
    // fail the whole decode for configs persisted before this field existed
    // (readConfiguration() swallows that via `try?`, silently dropping the
    // saved config). `Bool?` decodes those as nil; callers read
    // `lightAdjacentHolds ?? false`.
    let lightAdjacentHolds: Bool?

    init(
        boardName: String,
        layoutId: Int,
        sizeId: Int,
        apiLevel: Int?,
        deviceName: String?,
        colorOverrides: [String: String],
        numRows: Int?,
        lightAdjacentHolds: Bool? = nil
    ) {
        self.boardName = boardName
        self.layoutId = layoutId
        self.sizeId = sizeId
        self.apiLevel = apiLevel
        self.deviceName = deviceName
        self.colorOverrides = colorOverrides
        self.numRows = numRows
        self.lightAdjacentHolds = lightAdjacentHolds
    }
}

struct BoardBlePacketResult: Equatable {
    let packet: Data
    let skippedPositionCount: Int
    let skippedRoleCount: Int
    let totalPlacements: Int
}

enum BoardBleEncoding {
    /// Picks the CoreBluetooth write type for a Nordic UART RX characteristic,
    /// gated on the board family.
    ///
    /// Aurora (Kilter/Tension) controllers drove the wall with write-WITHOUT-
    /// response for the entire Capacitor era and the first RN port, and that path
    /// is proven on the hardware — so Aurora (and an unknown / `nil` board) ALWAYS
    /// take it, even when iOS reports the characteristic without the
    /// `.writeWithoutResponse` property bit (observed on iOS 26.x). Routing Aurora
    /// to write-with-response made boards whose ATT ack never arrives stall on
    /// every write — the status LED lights but the climb never displays.
    ///
    /// Only the original MoonBoard LED box needs write-with-response UP FRONT: its
    /// UART RX characteristic advertises only `.write`, and CoreBluetooth SILENTLY
    /// DROPS a `.withoutResponse` write to a characteristic that lacks the property
    /// (which left the MoonBoard wall dark on iOS while Android — whose GATT stack
    /// sends no-response writes regardless — worked). So for MoonBoard, and only
    /// MoonBoard, fall back to `.withResponse` whenever `.writeWithoutResponse` is
    /// absent.
    ///
    /// Aurora boxes that ALSO advertise only `.write` (some Kilter-built
    /// controllers) are handled the other way round — behaviourally, not here:
    /// `BoardBleManager` still starts them on without-response, and only switches
    /// this connection to with-response once a write demonstrably stalls on that
    /// `.write`-only characteristic (see `forceWriteWithResponse`). Deciding it
    /// up-front from the property bit is exactly what regressed the fleet in #3228
    /// (a stale GATT cache can drop the bit on a healthy board), so this function
    /// deliberately keeps Aurora on without-response regardless of the bit.
    static func preferredWriteType(
        for properties: CBCharacteristicProperties,
        boardName: String?
    ) -> CBCharacteristicWriteType {
        guard boardName == "moonboard" else { return .withoutResponse }
        return properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
    }

    /// The classic 20-byte BLE payload (ATT 23 − 3): the floor every controller
    /// generation is proven on, and the fixed size for both MoonBoard paths.
    static let classicChunkSize = 20
    /// Ceiling for MTU-sized Aurora chunks: ATT 247 − 3 header bytes. iOS-26.5
    /// telemetry (#3230) shows the failing "oversized" cohort clusters at the
    /// full ATT 512 (`maximumWriteValueLength` 509), while ATT ≤255 is clean in
    /// the field — so never pass the negotiated maximum straight through.
    /// Lockstep with `MAX_ATT_CHUNK_SIZE` in
    /// packages/shared/ble-protocol/src/transport.ts (Android mirror).
    static let maxAttChunkSize = 244

    /// Transport chunk size for one GATT write. Chunking is a transport detail —
    /// framing (SOH·LEN·CHK·STX·payload·ETX) is byte-identical at any size; the
    /// official Kilter app negotiates MTU the same way (#3230).
    ///
    /// Aurora on write-without-response sizes chunks from the connection's
    /// negotiated `maximumWriteValueLength`, clamped to [20, 244]. MoonBoard —
    /// both the Nordic-UART and RedBearLab boxes — and any with-response path
    /// stay at the proven 20 bytes.
    static func effectiveChunkSize(
        negotiatedMaxWriteLength: Int,
        writeType: CBCharacteristicWriteType,
        boardName: String?
    ) -> Int {
        guard writeType == .withoutResponse, boardName != "moonboard" else { return classicChunkSize }
        return min(max(negotiatedMaxWriteLength, classicChunkSize), maxAttChunkSize)
    }

    private struct HoldRoleInfo {
        let state: String
        let color: String
    }

    private struct LedEntry {
        let position: Int
        let color: String
    }

    private struct CommandBytes {
        let middle: UInt8
        let first: UInt8
        let last: UInt8
        let only: UInt8
    }

    private static let messageBodyMaxLength = 255
    private static let v2MaxBoardPower = 18.0
    private static let v2PowerScales = [1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05]
    private static let v3Commands = CommandBytes(middle: 81, first: 82, last: 83, only: 84)
    private static let v2Commands = CommandBytes(middle: 77, first: 78, last: 79, only: 80)

    private static let holdStateMap: [String: [Int: HoldRoleInfo]] = [
        "kilter": [
            12: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            13: HoldRoleInfo(state: "HAND", color: "#00FFFF"),
            14: HoldRoleInfo(state: "FINISH", color: "#FF00FF"),
            15: HoldRoleInfo(state: "FOOT", color: "#FFAA00"),
            20: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            21: HoldRoleInfo(state: "HAND", color: "#00FFFF"),
            22: HoldRoleInfo(state: "FINISH", color: "#FF00FF"),
            23: HoldRoleInfo(state: "FOOT", color: "#FFA500"),
            24: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            25: HoldRoleInfo(state: "HAND", color: "#00FFFF"),
            26: HoldRoleInfo(state: "FINISH", color: "#FF00FF"),
            27: HoldRoleInfo(state: "FOOT", color: "#FFA500"),
            28: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            29: HoldRoleInfo(state: "HAND", color: "#00FFFF"),
            30: HoldRoleInfo(state: "FINISH", color: "#FF00FF"),
            31: HoldRoleInfo(state: "FOOT", color: "#FFA500"),
            32: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            33: HoldRoleInfo(state: "HAND", color: "#00FFFF"),
            34: HoldRoleInfo(state: "FINISH", color: "#FF00FF"),
            35: HoldRoleInfo(state: "FOOT", color: "#FFA500"),
            36: HoldRoleInfo(state: "HAND", color: "#00FFFF"),
            37: HoldRoleInfo(state: "HAND", color: "#FF00FF"),
            38: HoldRoleInfo(state: "HAND", color: "#FFFF00"),
            39: HoldRoleInfo(state: "HAND", color: "#00FF00"),
            40: HoldRoleInfo(state: "HAND", color: "#FF0000"),
            41: HoldRoleInfo(state: "HAND", color: "#0000FF"),
            42: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            43: HoldRoleInfo(state: "HAND", color: "#00FFFF"),
            44: HoldRoleInfo(state: "FINISH", color: "#FF00FF"),
            45: HoldRoleInfo(state: "FOOT", color: "#FFAA00"),
        ],
        "tension": [
            1: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            2: HoldRoleInfo(state: "HAND", color: "#0000FF"),
            3: HoldRoleInfo(state: "FINISH", color: "#FF0000"),
            4: HoldRoleInfo(state: "FOOT", color: "#FF00FF"),
            5: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            6: HoldRoleInfo(state: "HAND", color: "#0000FF"),
            7: HoldRoleInfo(state: "FINISH", color: "#FF0000"),
            8: HoldRoleInfo(state: "FOOT", color: "#FF00FF"),
        ],
        "decoy": commonAuroraRoleMap(),
        "touchstone": commonAuroraRoleMap(),
        "grasshopper": commonAuroraRoleMap(),
        "soill": commonAuroraRoleMap(),
    ]

    /// Builds the JS-bound reason dict from a CoreBluetooth disconnect error.
    /// Returns nil for a clean disconnect (no error) so the JS side reads a
    /// missing reason as "iOS reported none" rather than a fabricated one. The
    /// NSError `code` is the CBError.Code (e.g. 6 connectionTimeout, 7
    /// peripheralDisconnected) that distinguishes a range/idle drop from a
    /// peer-terminated link (another central taking the last-connection-wins board).
    /// Keys must stay in sync with `NativeBleDisconnectEvent` in
    /// `modules/live-activity/src/index.ts`.
    static func disconnectReasonBody(from error: Error?) -> [String: Any]? {
        guard let error = error as NSError? else { return nil }
        return [
            "errorCode": error.code,
            "errorDomain": error.domain,
            "errorDescription": error.localizedDescription,
        ]
    }

    static func parseApiLevel(deviceName: String?) -> Int {
        guard let deviceName else { return 2 }
        // Mirror the TS regex /@(\d+)/: the FIRST '@' immediately followed by one
        // or more ASCII digits. (Using `.backwards`/last-'@' diverges from TS on
        // pathological multi-'@' names.) Defaults to 2 when absent.
        var searchStart = deviceName.startIndex
        while let atRange = deviceName.range(of: "@", range: searchStart..<deviceName.endIndex) {
            let digits = deviceName[atRange.upperBound...].prefix { ("0"..."9").contains($0) }
            if let value = Int(digits) {
                return value
            }
            searchStart = atRange.upperBound
        }
        return 2
    }

    static func parseSerialNumber(deviceName: String?) -> String? {
        guard let deviceName,
              let hashRange = deviceName.range(of: "#")
        else {
            return nil
        }
        let serial = deviceName[hashRange.upperBound...].prefix { $0 != "@" }
        return serial.isEmpty ? nil : String(serial)
    }

    // Mirror of the TS `AURORA_BOARDS` in ble-protocol/aurora.ts. Keep in sync.
    static let auroraBoardNames = ["kilter", "tension", "decoy", "touchstone", "grasshopper", "soill"]

    /// Mirror of the TS `parseBoardTypeFromDeviceName`: lowercase, strip whitespace
    /// and hyphens, then prefix-match against the Aurora board list.
    static func parseBoardTypeFromDeviceName(deviceName: String?) -> String? {
        guard let deviceName else { return nil }
        let normalized = deviceName.lowercased().filter { !$0.isWhitespace && $0 != "-" }
        return auroraBoardNames.first { normalized.hasPrefix($0) }
    }

    /// Mirror of the TS `isKilterBuiltBox`: an Aurora-family board advertising a
    /// bare name with NO `#serial` suffix — a mid-2025+ "Kilter-built" box whose
    /// RX characteristic is write-with-response only. See the TS helper for the
    /// #3228-safety rationale (this is a name signal, not the GATT property bit).
    static func isKilterBuiltBox(deviceName: String?) -> Bool {
        parseBoardTypeFromDeviceName(deviceName: deviceName) != nil
            && parseSerialNumber(deviceName: deviceName) == nil
    }

    static func checksum(_ payload: [UInt8]) -> UInt8 {
        let sum = payload.reduce(0) { partial, byte in
            (partial + Int(byte)) & 255
        }
        return UInt8(sum ^ 255)
    }

    static func wrapBytes(_ payload: [UInt8]) -> [UInt8] {
        guard payload.count <= messageBodyMaxLength else { return [] }
        return [1, UInt8(payload.count), checksum(payload), 2] + payload + [3]
    }

    static func encodePositionV3(_ position: Int) -> [UInt8] {
        [UInt8(position & 255), UInt8((position >> 8) & 255)]
    }

    static func encodeColorV3(_ color: String) -> UInt8 {
        let normalized = normalizeColor(color)
        let red = (hexByte(normalized, offset: 0) / 32) << 5
        let green = (hexByte(normalized, offset: 2) / 32) << 2
        let blue = hexByte(normalized, offset: 4) / 64
        return UInt8(red | green | blue)
    }

    static func encodePositionAndColorV3(position: Int, color: String) -> [UInt8] {
        encodePositionV3(position) + [encodeColorV3(color)]
    }

    static func scaledColorV2(_ value: Int, scale: Double) -> Int {
        Int(floor(Double(value) * scale)) >> 6
    }

    static func encodePositionAndColorV2(position: Int, color: String, scale: Double) -> [UInt8] {
        guard position <= 1023 else { return [] }

        let normalized = normalizeColor(color)
        let positionLow = position & 255
        let positionHigh = (position >> 8) & 3
        let red = scaledColorV2(hexByte(normalized, offset: 0), scale: scale)
        let green = scaledColorV2(hexByte(normalized, offset: 2), scale: scale)
        let blue = scaledColorV2(hexByte(normalized, offset: 4), scale: scale)
        let colorByte = (red << 6) | (green << 4) | (blue << 2) | positionHigh

        return [UInt8(positionLow), UInt8(colorByte)]
    }

    static func makeAuroraPacket(
        frames: String,
        placementPositions: [Int: Int],
        boardName: String,
        apiLevel: Int = 3,
        colorOverrides: [String: String] = [:]
    ) -> BoardBlePacketResult {
        let isV2 = apiLevel < 3
        let commands = isV2 ? v2Commands : v3Commands

        if frames.isEmpty {
            return BoardBlePacketResult(
                packet: Data(wrapBytes([commands.only])),
                skippedPositionCount: 0,
                skippedRoleCount: 0,
                totalPlacements: 0
            )
        }

        var ledEntries: [LedEntry] = []
        var skippedPositionCount = 0
        var skippedRoleCount = 0

        for frame in parseFrames(frames) {
            guard let ledPosition = placementPositions[frame.placementId] else {
                skippedPositionCount += 1
                continue
            }
            guard let roleInfo = holdStateMap[boardName]?[frame.roleCode] else {
                skippedRoleCount += 1
                continue
            }

            let color = sanitizedOverride(colorOverrides[roleInfo.state]) ?? roleInfo.color
            ledEntries.append(LedEntry(position: ledPosition, color: color))
        }

        let totalPlacements = ledEntries.count + skippedPositionCount + skippedRoleCount
        guard !ledEntries.isEmpty else {
            return BoardBlePacketResult(
                packet: Data(),
                skippedPositionCount: skippedPositionCount,
                skippedRoleCount: skippedRoleCount,
                totalPlacements: totalPlacements
            )
        }

        let scale = isV2 ? computeV2Scale(ledEntries: ledEntries, ledsPerHold: ledsPerHold(boardName: boardName)) : 1
        var resultParts: [[UInt8]] = []
        var currentPart = [commands.middle]
        var ledsWritten = 0
        var skippedAfterEncoding = 0

        for entry in ledEntries {
            let encoded = isV2
                ? encodePositionAndColorV2(position: entry.position, color: entry.color, scale: scale)
                : encodePositionAndColorV3(position: entry.position, color: entry.color)

            if encoded.isEmpty {
                skippedAfterEncoding += 1
                continue
            }

            if currentPart.count + encoded.count > messageBodyMaxLength {
                resultParts.append(currentPart)
                currentPart = [commands.middle]
            }
            currentPart.append(contentsOf: encoded)
            ledsWritten += 1
        }

        guard ledsWritten > 0 else {
            return BoardBlePacketResult(
                packet: Data(),
                skippedPositionCount: skippedPositionCount + skippedAfterEncoding,
                skippedRoleCount: skippedRoleCount,
                totalPlacements: totalPlacements
            )
        }

        resultParts.append(currentPart)
        if resultParts.count == 1 {
            resultParts[0][0] = commands.only
        } else {
            resultParts[0][0] = commands.first
            resultParts[resultParts.count - 1][0] = commands.last
        }

        let wrapped = resultParts.flatMap { wrapBytes($0) }
        return BoardBlePacketResult(
            packet: Data(wrapped),
            skippedPositionCount: skippedPositionCount + skippedAfterEncoding,
            skippedRoleCount: skippedRoleCount,
            totalPlacements: totalPlacements
        )
    }

    // MARK: - MoonBoard

    // MoonBoard speaks a different protocol from the Aurora boards: an ASCII
    // frame `l#{holds}#` where each hold is a role letter plus a serial LED
    // position derived straight from its grid coordinate — no per-board LED
    // placement map and no binary packet wrapper. Ported from
    // packages/shared/ble-protocol/src/moonboard.ts; keep the two in lockstep
    // (parity asserted in LiveActivityWidgetTests).
    //
    // All layouts are 11 columns wide, but the row count varies: the standard
    // wall is 18 rows while the Mini's LED strip is 12 (#3392). The row count
    // comes from the JS-side board config (getMoonBoardGeometryByLayoutId) via
    // configureBoard; 18 is the fallback for configs persisted before numRows
    // existed.
    private static let moonboardGridColumns = 11
    private static let moonboardDefaultGridRows = 18
    private static let moonboardRoleMap: [Int: String] = [42: "S", 43: "P", 44: "E"]
    private static let moonboardFramePrefix = "l#"
    private static let moonboardFrameSuffix = "#"
    // MoonBoard "V2" config prefix — mirrors MOONBOARD_V2_ADDITIONAL_LED_PREFIX
    // in packages/shared/ble-protocol/src/moonboard.ts. Keep in lockstep.
    private static let moonboardV2AdditionalLedPrefix = "~D"

    static func moonboardSerialPosition(holdId: Int, numRows: Int? = nil) -> Int? {
        let gridRows = numRows ?? moonboardDefaultGridRows
        let maxHoldId = moonboardGridColumns * gridRows
        guard holdId >= 1, holdId <= maxHoldId else { return nil }

        let zeroBasedHoldId = holdId - 1
        let colIndex = zeroBasedHoldId % moonboardGridColumns
        let rowIndex = zeroBasedHoldId / moonboardGridColumns

        // Odd columns are wired bottom-to-top, so their row order is reversed.
        if colIndex % 2 == 0 {
            return colIndex * gridRows + rowIndex
        }
        return colIndex * gridRows + (gridRows - 1 - rowIndex)
    }

    static func makeMoonboardPacket(frames: String, numRows: Int? = nil, lightAdjacentHolds: Bool = false) -> BoardBlePacketResult {
        // `l##` (empty frame) is MoonBoard's clear-all: community firmware
        // (ArduinoMoonBoardLED) clears every LED on each incoming frame; unverified
        // on official Moon controllers (at worst a no-op). Gate on the RAW string —
        // only the deliberate-clear input (`frames == ""`) may produce `l##`. A
        // non-empty frames string that parses to nothing (corrupt/truncated data)
        // must fall through to the zero-encodable refusal below, matching the JS
        // builder's `isClear` contract.
        if frames.isEmpty {
            return BoardBlePacketResult(
                packet: Data((moonboardFramePrefix + moonboardFrameSuffix).utf8),
                skippedPositionCount: 0,
                skippedRoleCount: 0,
                totalPlacements: 0
            )
        }

        let parsedFrames = parseFrames(frames)
        var encodedHolds: [String] = []
        var skippedRoleCount = 0
        var skippedPositionCount = 0

        for frame in parsedFrames {
            guard let roleLetter = moonboardRoleMap[frame.roleCode] else {
                skippedRoleCount += 1
                continue
            }
            guard let position = moonboardSerialPosition(holdId: frame.placementId, numRows: numRows) else {
                skippedPositionCount += 1
                continue
            }
            encodedHolds.append("\(roleLetter)\(position)")
        }

        // Zero encodable holds on a non-empty climb → refuse: whether every
        // placement was skipped (unrecognised roles, out-of-range ids) or the
        // frames string parsed to nothing at all, falling through to `l##` would
        // silently dark the wall, so return an empty packet and let the caller
        // refuse to write — matching dispatchMoonboardPacket on the JS side.
        guard !encodedHolds.isEmpty else {
            return BoardBlePacketResult(
                packet: Data(),
                skippedPositionCount: skippedPositionCount,
                skippedRoleCount: skippedRoleCount,
                totalPlacements: parsedFrames.count
            )
        }

        let framePayload = moonboardFramePrefix + encodedHolds.joined(separator: ",") + moonboardFrameSuffix
        let payload = lightAdjacentHolds ? moonboardV2AdditionalLedPrefix + framePayload : framePayload
        return BoardBlePacketResult(
            packet: Data(payload.utf8),
            skippedPositionCount: skippedPositionCount,
            skippedRoleCount: skippedRoleCount,
            totalPlacements: parsedFrames.count
        )
    }

    static func mirroredFrames(frames: String, boardName: String, layoutId: Int) -> String? {
        var mirroredFrames = ""
        for frame in parseFrames(frames) {
            guard let mirroredId = BoardPlacementData.mirroredPlacementId(
                boardName: boardName,
                layoutId: layoutId,
                placementId: frame.placementId
            ) else {
                return nil
            }
            mirroredFrames += "p\(mirroredId)r\(frame.roleCode)"
        }
        return mirroredFrames
    }

    private static func parseFrames(_ frames: String) -> [(placementId: Int, roleCode: Int)] {
        frames
            .split(separator: "p")
            .compactMap { frame in
                let parts = frame.split(separator: "r")
                guard parts.count == 2,
                      let placementId = Int(parts[0]),
                      let roleCode = Int(parts[1])
                else {
                    return nil
                }
                return (placementId: placementId, roleCode: roleCode)
            }
    }

    private static func computeV2Scale(ledEntries: [LedEntry], ledsPerHold: Int) -> Double {
        for scale in v2PowerScales {
            var totalPower = 0.0
            for entry in ledEntries {
                let normalized = normalizeColor(entry.color)
                let red = scaledColorV2(hexByte(normalized, offset: 0), scale: scale)
                let green = scaledColorV2(hexByte(normalized, offset: 2), scale: scale)
                let blue = scaledColorV2(hexByte(normalized, offset: 4), scale: scale)
                totalPower += Double(red + green + blue) / 30
            }
            if Double(ledsPerHold) * totalPower <= v2MaxBoardPower {
                return scale
            }
        }
        return 0
    }

    private static func ledsPerHold(boardName: String) -> Int {
        boardName == "kilter" ? 2 : 1
    }

    /// Mirrors the TS `SIX_DIGIT_HEX_PATTERN` guard: only honour a colour
    /// override that is exactly six hex digits (after an optional leading '#').
    /// Anything else (shorthand "#fff", a named colour, an 8-digit RGBA) falls
    /// back to the canonical role colour instead of rendering black or a
    /// silently truncated colour to the wall.
    private static func sanitizedOverride(_ override: String?) -> String? {
        guard let override else { return nil }
        let stripped = override.hasPrefix("#") ? String(override.dropFirst()) : override
        guard stripped.count == 6, stripped.allSatisfy(\.isHexDigit) else { return nil }
        return override
    }

    private static func normalizeColor(_ color: String) -> String {
        let stripped = color.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        guard stripped.count >= 6 else { return "000000" }
        return String(stripped.prefix(6)).uppercased()
    }

    private static func hexByte(_ color: String, offset: Int) -> Int {
        let start = color.index(color.startIndex, offsetBy: offset)
        let end = color.index(start, offsetBy: 2)
        return Int(color[start..<end], radix: 16) ?? 0
    }

    private static func commonAuroraRoleMap() -> [Int: HoldRoleInfo] {
        [
            1: HoldRoleInfo(state: "STARTING", color: "#00FF00"),
            2: HoldRoleInfo(state: "HAND", color: "#0000FF"),
            3: HoldRoleInfo(state: "FINISH", color: "#FF0000"),
            4: HoldRoleInfo(state: "FOOT", color: "#FF00FF"),
        ]
    }
}
