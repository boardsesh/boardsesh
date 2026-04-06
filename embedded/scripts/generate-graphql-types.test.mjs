#!/usr/bin/env node
/**
 * Unit tests for GraphQL to C++ Type Generator
 *
 * Run with: node --test embedded/scripts/generate-graphql-types.test.mjs
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import functions directly from the source module
import {
  parseGraphQLSchema,
  graphqlTypeToCpp,
  generateCppStruct,
  generateHeader,
  TYPE_MAP,
  FIELD_TYPE_OVERRIDES,
  CONTROLLER_TYPES,
  ROLE_NOT_SET,
  ANGLE_NOT_SET,
} from './generate-graphql-types.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Tests
// ============================================

describe('GraphQL Schema Parser', () => {
  it('should parse a simple type definition', () => {
    const schema = `
      type LedCommand {
        position: Int!
        r: Int!
        g: Int!
        b: Int!
      }
    `;

    const types = parseGraphQLSchema(schema);
    assert.strictEqual(types.size, 1);
    assert.ok(types.has('LedCommand'));

    const ledCommand = types.get('LedCommand');
    assert.strictEqual(ledCommand.kind, 'type');
    assert.strictEqual(ledCommand.fields.length, 4);
    assert.strictEqual(ledCommand.fields[0].name, 'position');
    assert.strictEqual(ledCommand.fields[0].type, 'Int');
    assert.strictEqual(ledCommand.fields[0].isNullable, false);
  });

  it('should parse input type definitions', () => {
    const schema = `
      input LedCommandInput {
        position: Int!
        r: Int!
        g: Int!
        b: Int!
        role: Int
      }
    `;

    const types = parseGraphQLSchema(schema);
    const input = types.get('LedCommandInput');

    assert.strictEqual(input.kind, 'input');
    assert.strictEqual(input.fields.length, 5);

    const roleField = input.fields.find(f => f.name === 'role');
    assert.strictEqual(roleField.isNullable, true);
  });

  it('should parse array fields', () => {
    const schema = `
      type LedUpdate {
        commands: [LedCommand!]!
        climbUuid: String
        climbName: String
        angle: Int!
      }
    `;

    const types = parseGraphQLSchema(schema);
    const update = types.get('LedUpdate');

    const commandsField = update.fields.find(f => f.name === 'commands');
    assert.strictEqual(commandsField.isArray, true);
    assert.strictEqual(commandsField.type, 'LedCommand');
  });

  it('should parse union types', () => {
    const schema = `
      type LedUpdate {
        commands: [LedCommand!]!
      }

      type ControllerPing {
        timestamp: String!
      }

      union ControllerEvent = LedUpdate | ControllerPing
    `;

    const types = parseGraphQLSchema(schema);
    const union = types.get('ControllerEvent');

    assert.strictEqual(union.kind, 'union');
    assert.deepStrictEqual(union.unionTypes, ['LedUpdate', 'ControllerPing']);
  });

  it('should skip non-controller types', () => {
    const schema = `
      type User {
        id: ID!
        name: String!
      }

      type LedCommand {
        position: Int!
      }
    `;

    const types = parseGraphQLSchema(schema);
    assert.strictEqual(types.size, 1);
    assert.ok(types.has('LedCommand'));
    assert.ok(!types.has('User'));
  });

  it('should handle doc comments', () => {
    const schema = `
      """
      This is a doc comment that should be ignored
      """
      type LedCommand {
        """Position of the LED"""
        position: Int!
      }
    `;

    const types = parseGraphQLSchema(schema);
    assert.ok(types.has('LedCommand'));
    assert.strictEqual(types.get('LedCommand').fields.length, 1);
  });
});

describe('GraphQL to C++ Type Mapping', () => {
  it('should map Int to int32_t', () => {
    assert.strictEqual(graphqlTypeToCpp('Int', false, false), 'int32_t');
    assert.strictEqual(graphqlTypeToCpp('Int', true, false), 'int32_t');
  });

  it('should map String to const char*', () => {
    assert.strictEqual(graphqlTypeToCpp('String', false, false), 'const char*');
  });

  it('should map Boolean to bool', () => {
    assert.strictEqual(graphqlTypeToCpp('Boolean', false, false), 'bool');
  });

  it('should map Float to float', () => {
    assert.strictEqual(graphqlTypeToCpp('Float', false, false), 'float');
  });

  it('should map ID to const char*', () => {
    assert.strictEqual(graphqlTypeToCpp('ID', false, false), 'const char*');
  });

  it('should pass through custom types', () => {
    assert.strictEqual(graphqlTypeToCpp('LedCommand', false, false), 'LedCommand');
    assert.strictEqual(graphqlTypeToCpp('CustomType', false, false), 'CustomType');
  });
});

describe('C++ Struct Generation', () => {
  it('should generate a simple struct', () => {
    const type = {
      name: 'ControllerPing',
      kind: 'type',
      fields: [
        { name: 'timestamp', type: 'String', isNullable: false, isArray: false }
      ]
    };

    const output = generateCppStruct(type);
    assert.ok(output.includes('struct ControllerPing {'));
    assert.ok(output.includes('const char* timestamp;'));
    assert.ok(output.includes('};'));
  });

  it('should apply field type overrides for RGB values', () => {
    const type = {
      name: 'LedCommand',
      kind: 'type',
      fields: [
        { name: 'position', type: 'Int', isNullable: false, isArray: false },
        { name: 'r', type: 'Int', isNullable: false, isArray: false },
        { name: 'g', type: 'Int', isNullable: false, isArray: false },
        { name: 'b', type: 'Int', isNullable: false, isArray: false },
      ]
    };

    const output = generateCppStruct(type);
    assert.ok(output.includes('int32_t position;'));
    assert.ok(output.includes('uint8_t r;'));
    assert.ok(output.includes('uint8_t g;'));
    assert.ok(output.includes('uint8_t b;'));
  });

  it('should generate array fields with count', () => {
    const type = {
      name: 'LedUpdate',
      kind: 'type',
      fields: [
        { name: 'commands', type: 'LedCommand', isNullable: false, isArray: true },
      ]
    };

    const output = generateCppStruct(type);
    assert.ok(output.includes('LedCommand* commands;'));
    assert.ok(output.includes('size_t commandsCount;'));
  });

  it('should generate union type comment', () => {
    const type = {
      name: 'ControllerEvent',
      kind: 'union',
      fields: [],
      unionTypes: ['LedUpdate', 'ControllerPing']
    };

    const output = generateCppStruct(type);
    assert.ok(output.includes('Union type: ControllerEvent'));
    assert.ok(output.includes('LedUpdate | ControllerPing'));
    assert.ok(output.includes('__typename'));
  });
});

describe('Integration: Parse and Generate', () => {
  it('should parse real schema and generate valid C++ for LedCommand', () => {
    // The schema is modular - read all .ts files from the schema directory
    const schemaDir = path.join(__dirname, '../../packages/shared-schema/src/schema');
    const schemaSinglePath = path.join(__dirname, '../../packages/shared-schema/src/schema.ts');

    let schemaContent;
    if (fs.existsSync(schemaDir) && fs.statSync(schemaDir).isDirectory()) {
      const files = fs.readdirSync(schemaDir).filter(f => f.endsWith('.ts')).sort();
      schemaContent = files.map(f => fs.readFileSync(path.join(schemaDir, f), 'utf-8')).join('\n');
    } else if (fs.existsSync(schemaSinglePath)) {
      schemaContent = fs.readFileSync(schemaSinglePath, 'utf-8');
    } else {
      console.log('Skipping integration test: schema file not found');
      return;
    }

    const types = parseGraphQLSchema(schemaContent);

    // Verify we found the expected types
    assert.ok(types.has('LedCommand'), 'Should have LedCommand');
    assert.ok(types.has('LedUpdate'), 'Should have LedUpdate');
    assert.ok(types.has('ControllerPing'), 'Should have ControllerPing');
    assert.ok(types.has('ControllerEvent'), 'Should have ControllerEvent');

    // Verify LedCommand structure
    const ledCommand = types.get('LedCommand');
    assert.strictEqual(ledCommand.fields.length, 4);

    const posField = ledCommand.fields.find(f => f.name === 'position');
    assert.ok(posField, 'Should have position field');

    // Generate C++ and verify it's syntactically reasonable
    const cppOutput = generateCppStruct(ledCommand);
    assert.ok(cppOutput.includes('struct LedCommand'), 'Should have struct definition');
    assert.ok(cppOutput.includes('uint8_t r;'), 'Should use uint8_t for r');
    assert.ok(cppOutput.includes('};'), 'Should close struct');
  });

  it('should generate valid output file', () => {
    const outputPath = path.join(__dirname, '../libs/graphql-types/src/graphql_types.h');

    if (!fs.existsSync(outputPath)) {
      console.log('Skipping output file test: generated file not found');
      return;
    }

    const content = fs.readFileSync(outputPath, 'utf-8');

    // Verify header guards
    assert.ok(content.includes('#ifndef GRAPHQL_TYPES_H'), 'Should have include guard');
    assert.ok(content.includes('#define GRAPHQL_TYPES_H'), 'Should have define guard');
    assert.ok(content.includes('#endif'), 'Should close include guard');

    // Verify required includes
    assert.ok(content.includes('#include <Arduino.h>'), 'Should include Arduino.h');
    assert.ok(content.includes('#include <ArduinoJson.h>'), 'Should include ArduinoJson.h');

    // Verify structs are generated
    assert.ok(content.includes('struct LedCommand'), 'Should have LedCommand struct');
    assert.ok(content.includes('struct LedUpdate'), 'Should have LedUpdate struct');
    assert.ok(content.includes('struct ControllerPing'), 'Should have ControllerPing struct');

    // Verify operations namespace
    assert.ok(content.includes('namespace GraphQLOps'), 'Should have GraphQLOps namespace');
    assert.ok(content.includes('CONTROLLER_EVENTS_SUBSCRIPTION'), 'Should have subscription');

    // Verify helper functions
    assert.ok(content.includes('inline bool parseLedCommand'), 'Should have parse helper');
    assert.ok(content.includes('inline bool parseLedUpdate'), 'Should have parse helper');

    // Verify uint8_t is used for RGB
    assert.ok(content.includes('uint8_t r;'), 'Should use uint8_t for red');
    assert.ok(content.includes('uint8_t g;'), 'Should use uint8_t for green');
    assert.ok(content.includes('uint8_t b;'), 'Should use uint8_t for blue');

    // Verify freeLedUpdate helper is generated
    assert.ok(content.includes('inline void freeLedUpdate'), 'Should have freeLedUpdate helper');
    assert.ok(content.includes('delete[] update.commands'), 'freeLedUpdate should delete commands array');

    // Verify ROLE_NOT_SET sentinel constant
    assert.ok(content.includes('ROLE_NOT_SET'), 'Should have ROLE_NOT_SET constant');
    assert.ok(content.includes('cmd.role != ROLE_NOT_SET'), 'Should use ROLE_NOT_SET for comparison');

    // Verify pointer lifetime documentation
    assert.ok(content.includes('String pointer lifetime'), 'Should document pointer lifetime');
    assert.ok(content.includes('JsonDocument'), 'Should mention JsonDocument lifetime');

    // Verify no timestamp (to avoid noisy diffs)
    assert.ok(!content.includes('Generated:'), 'Should not have timestamp in header');

    // Verify LedCommand has include guard for native test compatibility
    assert.ok(content.includes('#ifndef LEDCOMMAND_DEFINED'), 'LedCommand should have include guard');
    assert.ok(content.includes('#define LEDCOMMAND_DEFINED'), 'LedCommand should define guard');
    assert.ok(content.includes('#endif // LEDCOMMAND_DEFINED'), 'LedCommand should close guard');

    // Verify memory allocation failure handling
    assert.ok(content.includes('std::nothrow'), 'Should use std::nothrow for allocation');
    assert.ok(content.includes('#include <new>'), 'Should include <new> header');
    assert.ok(content.includes('return false;  // Allocation failed'), 'Should return false on allocation failure');

    // Verify angle nullable documentation
    assert.ok(content.includes('ANGLE_NOT_SET'), 'Should document angle nullable behavior with sentinel value');
  });
});

describe('Edge Cases', () => {
  it('should handle empty schema', () => {
    const types = parseGraphQLSchema('');
    assert.strictEqual(types.size, 0);
  });

  it('should handle schema with only non-controller types', () => {
    const schema = `
      type User {
        id: ID!
      }
      type Session {
        id: ID!
      }
    `;
    const types = parseGraphQLSchema(schema);
    assert.strictEqual(types.size, 0);
  });

  it('should handle nullable fields correctly', () => {
    const schema = `
      type ClimbMatchResult {
        matched: Boolean!
        climbUuid: String
        climbName: String
      }
    `;

    const types = parseGraphQLSchema(schema);
    const result = types.get('ClimbMatchResult');

    const matched = result.fields.find(f => f.name === 'matched');
    const climbUuid = result.fields.find(f => f.name === 'climbUuid');

    assert.strictEqual(matched.isNullable, false);
    assert.strictEqual(climbUuid.isNullable, true);
  });
});

describe('Generated Code Verification', () => {
  it('should generate parse failure cleanup code', () => {
    const outputPath = path.join(__dirname, '../libs/graphql-types/src/graphql_types.h');

    if (!fs.existsSync(outputPath)) {
      console.log('Skipping parse cleanup test: generated file not found');
      return;
    }

    const content = fs.readFileSync(outputPath, 'utf-8');

    // Verify parseLedUpdate checks parseLedCommand return value
    assert.ok(
      content.includes('if (!parseLedCommand(cmd, update.commands[i]))'),
      'Should check parseLedCommand return value'
    );

    // Verify cleanup happens on parse failure
    assert.ok(
      content.includes('// Parsing failed - free memory and return false'),
      'Should have cleanup comment for parse failure'
    );

    // Verify memory is freed on parse failure (delete before nullptr assignment)
    const parseFailureSection = content.substring(
      content.indexOf('if (!parseLedCommand(cmd, update.commands[i]))'),
      content.indexOf('if (!parseLedCommand(cmd, update.commands[i]))') + 300
    );
    assert.ok(
      parseFailureSection.includes('delete[] update.commands'),
      'Should delete commands array on parse failure'
    );
    assert.ok(
      parseFailureSection.includes('update.commands = nullptr'),
      'Should set commands to nullptr after delete'
    );
    assert.ok(
      parseFailureSection.includes('update.commandsCount = 0'),
      'Should reset commandsCount to 0 on failure'
    );
  });

  it('should verify constants match between JS and generated code', () => {
    const outputPath = path.join(__dirname, '../libs/graphql-types/src/graphql_types.h');

    if (!fs.existsSync(outputPath)) {
      console.log('Skipping constants test: generated file not found');
      return;
    }

    const content = fs.readFileSync(outputPath, 'utf-8');

    // Verify ROLE_NOT_SET value matches
    assert.ok(
      content.includes(`constexpr int32_t ROLE_NOT_SET = ${ROLE_NOT_SET}`),
      `Generated ROLE_NOT_SET should match JS value (${ROLE_NOT_SET})`
    );

    // Verify ANGLE_NOT_SET value matches
    assert.ok(
      content.includes(`constexpr int32_t ANGLE_NOT_SET = ${ANGLE_NOT_SET}`),
      `Generated ANGLE_NOT_SET should match JS value (${ANGLE_NOT_SET})`
    );
  });
});
