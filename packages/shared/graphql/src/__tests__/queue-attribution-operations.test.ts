import { describe, expect, it } from 'vitest';
import { buildASTSchema, buildSchema, parse, validate, visit } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import {
  buildQueueUpdatesSubscription,
  buildSessionQueueStateQuery,
  QUEUE_CAPABILITIES_PROBE,
  QUEUE_STATE_FIELDS_PROBE,
  QUEUE_UPDATES,
  NATIVE_IOS_QUEUE_UPDATES,
} from '../operations/queue-session';

const schemaSource = typeDefs.join('\n\n');
const schema = buildSchema(schemaSource);
const previousSchema = buildASTSchema(
  visit(parse(schemaSource), {
    FieldDefinition(field) {
      return field.name.value === 'currentChangedBy' ? null : undefined;
    },
  }),
);

describe('capability-gated queue attribution documents', () => {
  it.each([false, true])('supports attribution independently of now-slot mode (%s)', (nowSlot) => {
    for (const builder of [buildQueueUpdatesSubscription, buildSessionQueueStateQuery]) {
      const attributed = builder({ nowSlot, attribution: true });
      const legacy = builder({ nowSlot, attribution: false });
      expect(validate(schema, parse(attributed))).toEqual([]);
      expect(validate(schema, parse(legacy))).toEqual([]);
      expect(validate(previousSchema, parse(legacy))).toEqual([]);
      expect(validate(previousSchema, parse(attributed)).length).toBeGreaterThan(0);
      expect(attributed).toContain('currentChangedBy');
      expect(legacy).not.toContain('currentChangedBy');
      expect(attributed.includes('historyCount')).toBe(nowSlot);
      expect(attributed.includes('currentChangedAt')).toBe(nowSlot);
    }
  });

  it('selects the mover in both FullSync.state and CurrentClimbChanged', () => {
    const paths: string[] = [];
    visit(parse(buildQueueUpdatesSubscription({ nowSlot: false, attribution: true })), {
      InlineFragment(fragment) {
        visit(fragment, {
          Field(field) {
            if (field.name.value === 'currentChangedBy') paths.push(fragment.typeCondition?.name.value ?? '');
          },
        });
      },
    });
    expect(paths.sort()).toEqual(['CurrentClimbChanged', 'FullSync']);
  });

  it('probes both schema types without selecting unsupported attribution fields', () => {
    const probe = parse(QUEUE_CAPABILITIES_PROBE);
    expect(validate(previousSchema, probe)).toEqual([]);
    expect(QUEUE_CAPABILITIES_PROBE).toContain('queueState: __type(name: "QueueState")');
    expect(QUEUE_CAPABILITIES_PROBE).toContain('currentClimbChanged: __type(name: "CurrentClimbChanged")');
    expect(QUEUE_STATE_FIELDS_PROBE).not.toContain('currentClimbChanged');
  });

  it('keeps legacy and native documents actor-free', () => {
    expect(QUEUE_UPDATES).not.toContain('currentChangedBy');
    expect(NATIVE_IOS_QUEUE_UPDATES).not.toContain('currentChangedBy');
  });
});
