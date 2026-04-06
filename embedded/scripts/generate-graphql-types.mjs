#!/usr/bin/env node
/**
 * GraphQL to C++ Type Generator for ESP32 Firmware
 *
 * This script reads the GraphQL schema from packages/shared-schema and generates
 * C++ header files with ArduinoJson-compatible structs for the ESP32 firmware.
 *
 * Usage:
 *   node embedded/scripts/generate-graphql-types.mjs
 *
 * Or via npm script:
 *   bun run controller:codegen
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path configuration
// The schema is modular - read all .ts files from the schema directory
const SCHEMA_DIR = path.join(__dirname, '../../packages/shared-schema/src/schema');
const SCHEMA_PATH = SCHEMA_DIR; // kept for backwards compat in error messages
const OUTPUT_DIR = path.join(__dirname, '../libs/graphql-types/src');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'graphql_types.h');

/**
 * Read all GraphQL schema content from the modular schema directory.
 * Falls back to reading a single schema.ts file if the directory doesn't exist.
 */
function readSchemaContent() {
  if (fs.existsSync(SCHEMA_DIR) && fs.statSync(SCHEMA_DIR).isDirectory()) {
    const files = fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.ts')).sort();
    return files.map(f => fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf-8')).join('\n');
  }
  // Fallback: try single schema.ts file
  const singlePath = path.join(__dirname, '../../packages/shared-schema/src/schema.ts');
  if (fs.existsSync(singlePath)) {
    return fs.readFileSync(singlePath, 'utf-8');
  }
  return null;
}

// Types that the firmware needs (controller-relevant subset)
const CONTROLLER_TYPES = [
  'LedCommand',
  'LedCommandInput',
  'LedUpdate',
  'ControllerPing',
  'ControllerEvent',
  'ClimbMatchResult',
  'DeviceLogEntry',
  'SendDeviceLogsInput',
  'SendDeviceLogsResponse',
];

// GraphQL to C++ type mapping
const TYPE_MAP = {
  'Int': 'int32_t',
  'Int!': 'int32_t',
  'Float': 'float',
  'Float!': 'float',
  'String': 'const char*',
  'String!': 'const char*',
  'Boolean': 'bool',
  'Boolean!': 'bool',
  'ID': 'const char*',
  'ID!': 'const char*',
};

// Field-specific type overrides for embedded optimization
// These override the default mappings for specific fields
const FIELD_TYPE_OVERRIDES = {
  'LedCommand.r': 'uint8_t',
  'LedCommand.g': 'uint8_t',
  'LedCommand.b': 'uint8_t',
  'LedCommandInput.r': 'uint8_t',
  'LedCommandInput.g': 'uint8_t',
  'LedCommandInput.b': 'uint8_t',
};

// Sentinel values for optional fields (use specific values to indicate "not set")
const ROLE_NOT_SET = -1;
const ANGLE_NOT_SET = -32768;  // INT16_MIN - unlikely valid angle value

/**
 * ESP32 Memory Optimization: Field Exclusions
 *
 * These fields are intentionally excluded from the generated GraphQL operation
 * strings to reduce memory usage on the ESP32 microcontroller (~320KB RAM).
 * The firmware only needs a subset of fields for LED control and basic display.
 *
 * New fields added to these types in the schema will be automatically included
 * in operations unless explicitly excluded here. When adding an exclusion,
 * document the reason.
 */
const ESP32_FIELD_EXCLUSIONS = {
  LedUpdate: new Set([
    'queueItemUuid',  // Not needed for LED display on ESP32
    'climbGrade',     // Grade info not displayed on ESP32 hardware
    'gradeColor',     // Color info not displayed on ESP32 hardware
    'boardPath',      // Board path not used by ESP32 controller
    'navigation',     // Complex nested type (QueueNavigationContext), exceeds ESP32 memory budget
    'clientId',       // BLE disconnect logic uses different mechanism on ESP32
  ]),
};

/**
 * Parse GraphQL schema and extract types
 * @param {string} schemaContent
 * @returns {Map<string, object>}
 */
function parseGraphQLSchema(schemaContent) {
  const types = new Map();

  // Remove doc comments for easier parsing
  const cleanSchema = schemaContent
    .replace(/"""[\s\S]*?"""/g, '')
    // Simplify single-line string literals to prevent mismatched braces inside strings
    // from confusing the brace-counting parser (e.g., "Use {foo}" would be simplified to "")
    .replace(/"[^"]*"/g, '""');

  // Parse type/input definitions using brace-counting to handle nested braces correctly.
  // This handles cases like @deprecated(reason: "...") or directives with object arguments
  // such as @directive(config: { key: "value" }) that a simple [^}]+ regex would break on.
  const typeStartRegex = /(type|input)\s+(\w+)\s*\{/g;
  let match;

  while ((match = typeStartRegex.exec(cleanSchema)) !== null) {
    const kind = match[1];
    const name = match[2];
    const bodyStart = match.index + match[0].length;

    // Count braces to find the matching closing brace
    let depth = 1;
    let i = bodyStart;
    while (i < cleanSchema.length && depth > 0) {
      if (cleanSchema[i] === '{') depth++;
      else if (cleanSchema[i] === '}') depth--;
      i++;
    }

    // Advance regex past the type block to avoid re-matching body content
    typeStartRegex.lastIndex = i;

    if (depth !== 0) continue; // Unmatched braces, skip

    const body = cleanSchema.substring(bodyStart, i - 1);

    if (!CONTROLLER_TYPES.includes(name)) continue;

    const fields = [];
    const fieldRegex = /(\w+)\s*:\s*(\[?\w+!?\]?!?)/g;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      const fieldName = fieldMatch[1];
      let fieldType = fieldMatch[2];

      const isArray = fieldType.startsWith('[');
      const isNullable = !fieldType.endsWith('!');

      // Clean up type
      fieldType = fieldType.replace(/[\[\]!]/g, '');

      fields.push({
        name: fieldName,
        type: fieldType,
        isNullable,
        isArray,
      });
    }

    types.set(name, { name, kind, fields });
  }

  // Parse union types
  const unionRegex = /union\s+(\w+)\s*=\s*([^#\n]+)/g;
  while ((match = unionRegex.exec(cleanSchema)) !== null) {
    const name = match[1];
    const unionBody = match[2].trim();

    if (!CONTROLLER_TYPES.includes(name)) continue;

    const unionTypes = unionBody.split('|').map(t => t.trim());
    types.set(name, {
      name,
      kind: 'union',
      fields: [],
      unionTypes,
    });
  }

  return types;
}

/**
 * Convert GraphQL type to C++ type
 * @param {string} graphqlType
 * @param {boolean} isNullable
 * @param {boolean} isArray
 * @returns {string}
 */
function graphqlTypeToCpp(graphqlType, isNullable, isArray) {
  // Check if it's a known scalar type
  const key = isNullable ? graphqlType : `${graphqlType}!`;
  if (TYPE_MAP[key]) {
    return TYPE_MAP[key];
  }
  if (TYPE_MAP[graphqlType]) {
    return TYPE_MAP[graphqlType];
  }

  // For custom types, return struct name
  return graphqlType;
}

// Types that need include guards (defined elsewhere for native test compatibility)
const GUARDED_TYPES = ['LedCommand'];

/**
 * Generate C++ struct for a GraphQL type
 * @param {object} type
 * @returns {string}
 */
function generateCppStruct(type) {
  if (type.kind === 'union') {
    return `// Union type: ${type.name} = ${type.unionTypes?.join(' | ')}
// Use __typename field to determine actual type`;
  }

  const lines = [];
  const needsGuard = GUARDED_TYPES.includes(type.name);
  const guardName = `${type.name.toUpperCase()}_DEFINED`;

  if (needsGuard) {
    lines.push(`// Include guard: ${type.name} may also be defined in led_controller.h for native tests`);
    lines.push(`#ifndef ${guardName}`);
    lines.push(`#define ${guardName}`);
  }

  lines.push(`/**`);
  lines.push(` * ${type.kind === 'input' ? 'Input' : 'Output'} type: ${type.name}`);
  lines.push(` * Generated from GraphQL schema`);
  lines.push(` */`);
  lines.push(`struct ${type.name} {`);

  for (const field of type.fields) {
    // Check for field-specific type override
    const overrideKey = `${type.name}.${field.name}`;
    let cppType = FIELD_TYPE_OVERRIDES[overrideKey];

    if (!cppType) {
      cppType = graphqlTypeToCpp(field.type, field.isNullable, field.isArray);
    }

    if (field.isArray) {
      // For arrays, we need a pointer and count
      lines.push(`    ${cppType}* ${field.name};`);
      lines.push(`    size_t ${field.name}Count;`);
    } else {
      lines.push(`    ${cppType} ${field.name};`);
    }
  }

  lines.push(`};`);

  if (needsGuard) {
    lines.push(`#endif // ${guardName}`);
  }

  return lines.join('\n');
}

/**
 * Generate GraphQL field selection string from a parsed type.
 * Recurses into sub-types to build nested selections (e.g., "commands { position r g b }").
 * Uses ESP32_FIELD_EXCLUSIONS to omit fields not needed on the microcontroller.
 *
 * @param {string} typeName - Name of the GraphQL type
 * @param {Map<string, object>} types - Parsed type map from parseGraphQLSchema
 * @param {number} depth - Recursion depth (max 3 to prevent infinite loops)
 * @returns {string} Field selection string for use in GraphQL operations
 */
function generateFieldSelection(typeName, types, depth = 0) {
  if (depth > 3) return '';

  const type = types.get(typeName);
  if (!type || type.kind === 'union') return '';

  const exclusions = ESP32_FIELD_EXCLUSIONS[typeName] || new Set();

  return type.fields
    .filter(f => !exclusions.has(f.name))
    .map(f => {
      const subType = types.get(f.type);
      if (subType && subType.kind !== 'union' && subType.fields.length > 0) {
        const subSelection = generateFieldSelection(f.type, types, depth + 1);
        return subSelection ? `${f.name} { ${subSelection} }` : f.name;
      }
      return f.name;
    })
    .join(' ');
}

/**
 * Generate GraphQL operation strings from parsed schema types.
 * Field selections are generated from the schema to stay in sync automatically.
 * See ESP32_FIELD_EXCLUSIONS for intentionally omitted fields.
 *
 * @param {Map<string, object>} types - Parsed types from parseGraphQLSchema
 * @returns {string}
 */
function generateOperations(types) {
  const ledUpdateFields = generateFieldSelection('LedUpdate', types);
  const controllerPingFields = generateFieldSelection('ControllerPing', types);
  const climbMatchResultFields = generateFieldSelection('ClimbMatchResult', types);
  const sendDeviceLogsResponseFields = generateFieldSelection('SendDeviceLogsResponse', types);

  return `
// ============================================
// GraphQL Operations for ESP32 Controller
// ============================================
// Field selections are auto-generated from the schema.
// See ESP32_FIELD_EXCLUSIONS for intentionally omitted fields.

namespace GraphQLOps {

/**
 * Subscription: Controller Events
 * Receives LED updates and ping events from the backend
 *
 * Note: ControllerQueueSync union member is not included here -
 * ESP32 firmware does not yet handle queue display synchronization.
 */
constexpr const char* CONTROLLER_EVENTS_SUBSCRIPTION =
    "subscription ControllerEvents($sessionId: ID!) { "
    "controllerEvents(sessionId: $sessionId) { "
    "... on LedUpdate { __typename ${ledUpdateFields} } "
    "... on ControllerPing { __typename ${controllerPingFields} } "
    "} }";

/**
 * Mutation: Set Climb From LED Positions
 * Sends LED positions from Bluetooth to match a climb
 */
constexpr const char* SET_CLIMB_FROM_LED_POSITIONS =
    "mutation SetClimbFromLeds($sessionId: ID!, $positions: [LedCommandInput!]!) { "
    "setClimbFromLedPositions(sessionId: $sessionId, positions: $positions) { "
    "${climbMatchResultFields} } }";

/**
 * Mutation: Controller Heartbeat
 * Keep-alive ping to update lastSeenAt
 */
constexpr const char* CONTROLLER_HEARTBEAT =
    "mutation ControllerHeartbeat($sessionId: ID!) { "
    "controllerHeartbeat(sessionId: $sessionId) }";

/**
 * Mutation: Send Device Logs
 * Forward device logs to backend for Axiom ingestion
 */
constexpr const char* SEND_DEVICE_LOGS =
    "mutation SendDeviceLogs($input: SendDeviceLogsInput!) { "
    "sendDeviceLogs(input: $input) { ${sendDeviceLogsResponseFields} } }";

} // namespace GraphQLOps
`;
}

/**
 * Generate the complete C++ header file
 * @param {Map<string, object>} types
 * @returns {string}
 */
function generateHeader(types) {
  let content = `/**
 * Auto-generated GraphQL Types for ESP32 Firmware
 *
 * Source: packages/shared-schema/src/schema.ts
 *
 * DO NOT EDIT MANUALLY - This file is generated by:
 *   bun run controller:codegen
 *
 * These types are compatible with ArduinoJson for JSON serialization.
 */

#ifndef GRAPHQL_TYPES_H
#define GRAPHQL_TYPES_H

#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>

// ============================================
// GraphQL Type Constants
// ============================================

namespace GraphQLTypename {
    constexpr const char* LED_UPDATE = "LedUpdate";
    constexpr const char* CONTROLLER_PING = "ControllerPing";
}

// ============================================
// GraphQL Types for Controller
// ============================================

`;

  // Generate structs in dependency order
  const orderedTypes = [
    'LedCommand',
    'LedCommandInput',
    'LedUpdate',
    'ControllerPing',
    'ClimbMatchResult',
    'DeviceLogEntry',
    'SendDeviceLogsInput',
    'SendDeviceLogsResponse',
  ];

  for (const typeName of orderedTypes) {
    const type = types.get(typeName);
    if (type) {
      content += generateCppStruct(type) + '\n\n';
    }
  }

  // Add union comment
  const controllerEvent = types.get('ControllerEvent');
  if (controllerEvent) {
    content += `// ${generateCppStruct(controllerEvent)}\n\n`;
  }

  // Add operations (field selections generated from parsed schema types)
  content += generateOperations(types);

  // Add helper functions for JSON parsing
  content += `
// ============================================
// Constants
// ============================================

/** Sentinel value indicating role field is not set */
constexpr int32_t ROLE_NOT_SET = ${ROLE_NOT_SET};

/** Sentinel value indicating angle field is not set (null in GraphQL) */
constexpr int32_t ANGLE_NOT_SET = ${ANGLE_NOT_SET};

// ============================================
// JSON Parsing Helpers (ArduinoJson)
// ============================================
//
// IMPORTANT: String pointer lifetime
// ----------------------------------
// The climbUuid, climbName, and other const char* fields returned by parse
// functions point directly into the JsonDocument's memory. These pointers
// become invalid when the JsonDocument is destroyed or modified.
//
// If you need to keep string values beyond the JsonDocument's lifetime,
// copy them to your own buffers before the document goes out of scope.

#include <ArduinoJson.h>
#include <new>  // for std::nothrow

/**
 * Parse a LedCommand from a JsonObject
 */
inline bool parseLedCommand(JsonObject& obj, LedCommand& cmd) {
    if (!obj.containsKey("position")) return false;
    cmd.position = obj["position"];
    cmd.r = obj["r"] | 0;
    cmd.g = obj["g"] | 0;
    cmd.b = obj["b"] | 0;
    return true;
}

/**
 * Parse a LedUpdate from a JsonObject
 *
 * IMPORTANT: This allocates memory for the commands array.
 * You MUST call freeLedUpdate() when done to avoid memory leaks.
 *
 * String pointers (climbUuid, climbName) point into the JsonDocument
 * and become invalid when the document is destroyed.
 *
 * NOTE: angle is set to ANGLE_NOT_SET (-32768) if not present in JSON.
 * Check update.angle != ANGLE_NOT_SET to determine if angle was provided.
 *
 * @return false if memory allocation fails or command parsing fails, true otherwise
 */
inline bool parseLedUpdate(JsonObject& obj, LedUpdate& update) {
    JsonArray commands = obj["commands"];
    if (commands.isNull()) {
        update.commands = nullptr;
        update.commandsCount = 0;
    } else {
        update.commandsCount = commands.size();
        update.commands = new (std::nothrow) LedCommand[update.commandsCount];
        if (update.commands == nullptr) {
            update.commandsCount = 0;
            return false;  // Allocation failed
        }
        size_t i = 0;
        for (JsonObject cmd : commands) {
            if (!parseLedCommand(cmd, update.commands[i])) {
                // Parsing failed - free memory and return false
                delete[] update.commands;
                update.commands = nullptr;
                update.commandsCount = 0;
                return false;
            }
            i++;
        }
    }
    update.climbUuid = obj["climbUuid"] | nullptr;
    update.climbName = obj["climbName"] | nullptr;
    update.angle = obj.containsKey("angle") ? (int32_t)obj["angle"] : ANGLE_NOT_SET;
    return true;
}

/**
 * Free memory allocated by parseLedUpdate()
 * Safe to call even if commands is nullptr
 */
inline void freeLedUpdate(LedUpdate& update) {
    if (update.commands != nullptr) {
        delete[] update.commands;
        update.commands = nullptr;
        update.commandsCount = 0;
    }
}

/**
 * Parse a ClimbMatchResult from a JsonObject
 *
 * String pointers (climbUuid, climbName) point into the JsonDocument
 * and become invalid when the document is destroyed.
 */
inline bool parseClimbMatchResult(JsonObject& obj, ClimbMatchResult& result) {
    result.matched = obj["matched"] | false;
    result.climbUuid = obj["climbUuid"] | nullptr;
    result.climbName = obj["climbName"] | nullptr;
    return true;
}

/**
 * Serialize a LedCommandInput to a JsonObject
 * Set cmd.role to ROLE_NOT_SET (-1) to omit the role field
 */
inline void serializeLedCommandInput(JsonObject& obj, const LedCommandInput& cmd) {
    obj["position"] = cmd.position;
    obj["r"] = cmd.r;
    obj["g"] = cmd.g;
    obj["b"] = cmd.b;
    if (cmd.role != ROLE_NOT_SET) {
        obj["role"] = cmd.role;
    }
}

/**
 * Serialize a DeviceLogEntry to a JsonObject
 */
inline void serializeDeviceLogEntry(JsonObject& obj, const DeviceLogEntry& entry) {
    obj["ts"] = entry.ts;
    obj["level"] = entry.level;
    obj["component"] = entry.component;
    obj["message"] = entry.message;
    if (entry.metadata) {
        obj["metadata"] = entry.metadata;
    }
}

#endif // GRAPHQL_TYPES_H
`;

  return content;
}

async function main() {
  console.log('GraphQL to C++ Type Generator');
  console.log('==============================\n');

  // Read schema
  console.log(`Reading schema from: ${SCHEMA_PATH}`);
  const schemaContent = readSchemaContent();
  if (!schemaContent) {
    console.error(`Error: Schema not found at ${SCHEMA_PATH}`);
    process.exit(1);
  }

  // Parse schema
  console.log('Parsing GraphQL schema...');
  const types = parseGraphQLSchema(schemaContent);
  console.log(`Found ${types.size} controller-relevant types`);

  for (const [name, type] of types) {
    console.log(`  - ${name} (${type.kind}, ${type.fields.length} fields)`);
  }

  // Generate header
  console.log('\nGenerating C++ header...');
  const header = generateHeader(types);

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, header);
  console.log(`Written to: ${OUTPUT_FILE}`);

  // Show stats
  const lineCount = header.split('\n').length;
  console.log(`\nGenerated ${lineCount} lines of C++ code`);
  console.log('\nDone!');
}

// Run main only when script is executed directly (not when imported for testing)
const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch(console.error);
}

// Export functions for testing
export {
  parseGraphQLSchema,
  graphqlTypeToCpp,
  generateCppStruct,
  generateHeader,
  generateFieldSelection,
  generateOperations,
  TYPE_MAP,
  FIELD_TYPE_OVERRIDES,
  CONTROLLER_TYPES,
  ESP32_FIELD_EXCLUSIONS,
  ROLE_NOT_SET,
  ANGLE_NOT_SET,
};
