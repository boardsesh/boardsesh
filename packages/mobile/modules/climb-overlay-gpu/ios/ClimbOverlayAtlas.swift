import Foundation
import CoreFoundation

struct AtlasStamp: Decodable {
  let offset: UInt32
  let x: UInt32
  let y: UInt32
  let width: UInt32
  let height: UInt32
  var crop: SIMD4<UInt32> { SIMD4(x,y,width,height) }
}

struct AtlasRole: Decodable {
  let state: UInt32
  let identity: UInt32
  let color: [Float]
  let fillPasses: [AtlasStamp?]
  let plate: AtlasStamp?
  let glyphPasses: [AtlasStamp?]
  let annotation: Bool?
  var fill: AtlasStamp? { fillPasses.first ?? nil }
  var glyph: AtlasStamp? { glyphPasses.first ?? nil }
  func fillPass(_ index: Int) -> AtlasStamp? { fillPasses.indices.contains(index) ? fillPasses[index] : nil }
  func glyphPass(_ index: Int) -> AtlasStamp? { glyphPasses.indices.contains(index) ? glyphPasses[index] : nil }
}

struct AtlasHold: Decodable {
  let id: UInt32
  let mirror: UInt32?
  let x: UInt32
  let y: UInt32
  let width: UInt32
  let height: UInt32
  let bounds: [Float]
  let field: UInt32
  let reach: Float
  let roles: [AtlasRole]

  private enum CodingKeys: String, CodingKey {
    case id, mirror, x, y, width, height, bounds, field, reach, roles
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(UInt32.self, forKey: .id)
    mirror = try container.decodeIfPresent(UInt32.self, forKey: .mirror)
    x = try container.decode(UInt32.self, forKey: .x)
    y = try container.decode(UInt32.self, forKey: .y)
    width = try container.decode(UInt32.self, forKey: .width)
    height = try container.decode(UInt32.self, forKey: .height)
    bounds = try container.decode([Float].self, forKey: .bounds)
    field = try container.decode(UInt32.self, forKey: .field)
    reach = try container.decode(Float.self, forKey: .reach)
    let rows = try container.decode([AtlasRoleRecord].self, forKey: .roles)
    roles = try ClimbOverlayRoleAliases.resolve(rows.map(\.entry)) { role, state in
      role.withState(state)
    }
  }
}

struct AtlasManifest: Decodable {
  let version: Int
  let width: UInt32
  let height: UInt32
  let covers: AtlasStamp?
  let veil: [Float]
  let mirrored: Bool
  let glow: Bool
  let merge: Float
  let seam: Float
  let seamMix: Float
  let seamSharpness: Float
  let fringe: Float
  let coreShare: Float
  let lut: [Float]
  let holds: [AtlasHold]
}

// Fourteen 16-byte vectors, matching Metal's Hold exactly.
struct GPUHold {
  var color: SIMD4<Float>
  var bounds: SIMD4<Float>
  var crop: SIMD4<UInt32>
  var offsets: SIMD4<UInt32>
  var numbers: SIMD4<Float>
  var identity: SIMD4<UInt32>
  var fillCrop: SIMD4<UInt32>
  var plateCrop: SIMD4<UInt32>
  var glyphCrop: SIMD4<UInt32>
  var extraOffsets: SIMD4<UInt32>
  var fillCrop1: SIMD4<UInt32>
  var fillCrop2: SIMD4<UInt32>
  var fillCrop3: SIMD4<UInt32>
  var glyphCrop1: SIMD4<UInt32>

  var stampLayers: UInt32 {
    ClimbOverlayMotion.stampLayers(offsets: offsets,extraOffsets: extraOffsets,annotation: identity.z > 0)
  }
}


func makeClimbOverlayGPUHold(hold: AtlasHold, role: AtlasRole) -> GPUHold {
  GPUHold(
        color: SIMD4(role.color[0]/255, role.color[1]/255, role.color[2]/255, 1),
        bounds: SIMD4(hold.bounds[0],hold.bounds[1],hold.bounds[2],hold.bounds[3]),
        crop: SIMD4(hold.x,hold.y,hold.width,hold.height),
        offsets: SIMD4(hold.field,role.fill?.offset ?? .max,role.plate?.offset ?? .max,role.glyph?.offset ?? .max),
        numbers: SIMD4(hold.reach,0,0,0),identity: SIMD4(hold.id,role.identity,role.annotation == true ? 1 : 0,0),
        fillCrop: role.fill?.crop ?? .zero,plateCrop: role.plate?.crop ?? .zero,glyphCrop: role.glyph?.crop ?? .zero,
        extraOffsets: SIMD4(role.fillPass(1)?.offset ?? .max,role.fillPass(2)?.offset ?? .max,
          role.fillPass(3)?.offset ?? .max,role.glyphPass(1)?.offset ?? .max),
        fillCrop1: role.fillPass(1)?.crop ?? .zero,fillCrop2: role.fillPass(2)?.crop ?? .zero,
        fillCrop3: role.fillPass(3)?.crop ?? .zero,glyphCrop1: role.glyphPass(1)?.crop ?? .zero)
}

private extension AtlasRole {
  func withState(_ state: UInt32) -> AtlasRole {
    AtlasRole(state: state,identity: identity,color: color,fillPasses: fillPasses,
      plate: plate,glyphPasses: glyphPasses,annotation: annotation)
  }
}

enum AtlasRoleEntry<Payload> {
  case full(state: UInt32,identity: UInt32,payload: Payload)
  case alias(state: UInt32,target: UInt32)
}

private enum AtlasRoleAliasFailure: LocalizedError {
  case invalid(String)
  var errorDescription: String? { switch self { case .invalid(let reason): return reason } }
}

/// Metadata-only aliases never change pixels, descriptor layout or visual identity.
/// Each invocation owns one hold's earlier-full canonical table.
enum ClimbOverlayRoleAliases {
  static func resolve<Payload>(_ rows: [AtlasRoleEntry<Payload>],
                              withState: (Payload, UInt32) -> Payload) throws -> [Payload] {
    guard rows.count <= 32 else { throw AtlasRoleAliasFailure.invalid("Too many atlas roles") }
    var seen = Set<UInt32>()
    var canonical: [UInt32: Payload] = [:]
    var result: [Payload] = []
    for row in rows {
      switch row {
      case .full(let state,let identity,let payload):
        guard seen.insert(state).inserted else { throw AtlasRoleAliasFailure.invalid("Duplicate atlas role state") }
        result.append(payload)
        if state == identity { canonical[state] = payload }
      case .alias(let state,let target):
        guard seen.insert(state).inserted,state != target,let source = canonical[target] else {
          throw AtlasRoleAliasFailure.invalid("Atlas alias needs a unique state and an earlier full canonical role")
        }
        result.append(withState(source,state))
      }
    }
    return result
  }

  private static func uint32(_ value: Any?) throws -> UInt32 {
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID(),
      ["c","C","s","S","i","I","l","L","q","Q"].contains(String(cString: number.objCType)),
      number.int64Value >= 0,number.uint64Value <= UInt64(UInt32.max) else {
      throw AtlasRoleAliasFailure.invalid("Atlas role requires an integer UInt32")
    }
    return UInt32(number.uint64Value)
  }

  /// JSONDecoder permits mathematically integral doubles. Inspect raw NSNumber
  /// types first so both native readers reject floats, strings and Boolean roles.
  static func validateManifestRoleJSON(_ bytes: Data) throws {
    guard let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      let holds = root["holds"] as? [[String: Any]],holds.count <= 1024 else {
      throw AtlasRoleAliasFailure.invalid("Invalid atlas holds")
    }
    for hold in holds {
      guard let roles = hold["roles"] as? [[String: Any]],roles.count <= 32 else {
        throw AtlasRoleAliasFailure.invalid("Invalid atlas role rows")
      }
      let rows: [AtlasRoleEntry<Void>] = try roles.map { role in
        let state = try uint32(role["state"])
        if role.keys.contains("alias") {
          guard Set(role.keys) == Set(["state","alias"]) else {
            throw AtlasRoleAliasFailure.invalid("Atlas alias may contain only state and alias")
          }
          return .alias(state: state,target: try uint32(role["alias"]))
        }
        return .full(state: state,identity: try uint32(role["identity"]),payload: ())
      }
      _ = try resolve(rows) { _,_ in () }
    }
  }
}

private struct AtlasRoleKey: CodingKey {
  let stringValue: String
  var intValue: Int? { nil }
  init(_ string: String) { stringValue = string }
  init?(stringValue: String) { self.init(stringValue) }
  init?(intValue: Int) { return nil }
}

private struct AtlasRoleRecord: Decodable {
  let entry: AtlasRoleEntry<AtlasRole>
  init(from decoder: Decoder) throws {
    // Dynamic keys are essential: enum CodingKeys would hide unknown overrides.
    let container = try decoder.container(keyedBy: AtlasRoleKey.self)
    let keys = Set(container.allKeys.map(\.stringValue))
    if keys.contains("alias") {
      guard keys == Set(["state","alias"]) else {
        throw AtlasRoleAliasFailure.invalid("Atlas alias has unexpected fields")
      }
      entry = .alias(state: try container.decode(UInt32.self,forKey: AtlasRoleKey("state")),
        target: try container.decode(UInt32.self,forKey: AtlasRoleKey("alias")))
    } else {
      let role = try AtlasRole(from: decoder)
      entry = .full(state: role.state,identity: role.identity,payload: role)
    }
  }
}

func decodeClimbOverlayAtlasManifest(_ bytes: Data) throws -> AtlasManifest {
  try ClimbOverlayRoleAliases.validateManifestRoleJSON(bytes)
  return try JSONDecoder().decode(AtlasManifest.self,from: bytes)
}
