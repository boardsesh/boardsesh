import { isRecord, WledBleProtocolError } from './index';

function integer(candidate: unknown, minimum: number, maximum: number): boolean {
  return (
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= minimum && candidate <= maximum
  );
}
function fail(): never {
  throw new WledBleProtocolError('disallowed-state');
}
function keysAllowed(candidate: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(candidate).some((key) => !keys.includes(key))) fail();
}

/** Validate every field before any native WLED state function can run. */
export function validateLightingState(state: unknown, ledCount: number): asserts state is Record<string, unknown> {
  if (!integer(ledCount, 1, 65535) || !isRecord(state) || !Object.keys(state).length) fail();
  keysAllowed(state, ['on', 'bri', 'transition', 'tt', 'live', 'lor', 'nl', 'udpn', 'seg']);
  for (const [key, field] of Object.entries(state)) {
    switch (key) {
      case 'on':
        if (typeof field !== 'boolean') fail();
        break;
      case 'bri':
        if (!integer(field, 0, 255)) fail();
        break;
      case 'transition':
      case 'tt':
        if (!integer(field, 0, 65535)) fail();
        break;
      case 'live':
        if (field !== false) fail();
        break;
      case 'lor':
        if (field !== 1) fail();
        break;
      case 'nl':
        if (!isRecord(field) || typeof field.on !== 'boolean') fail();
        keysAllowed(field, ['on']);
        break;
      case 'udpn':
        if (!isRecord(field) || field.nn !== true) fail();
        keysAllowed(field, ['nn']);
        break;
      case 'seg':
        if (!Array.isArray(field) || !field.length || field.length > 256) fail();
        for (const segment of field) validateSegment(segment, ledCount);
        break;
    }
  }
}

function validateSegment(segment: unknown, ledCount: number): void {
  if (!isRecord(segment) || !integer(segment.id, 0, 255)) fail();
  keysAllowed(segment, [
    'id',
    'start',
    'stop',
    'on',
    'bri',
    'fx',
    'pal',
    'grp',
    'spc',
    'of',
    'rev',
    'mi',
    'frz',
    'col',
    'i',
  ]);
  for (const [key, field] of Object.entries(segment)) {
    switch (key) {
      case 'id':
        break;
      case 'start':
        if (!integer(field, 0, ledCount - 1)) fail();
        break;
      case 'stop':
        if (!integer(field, 1, ledCount)) fail();
        break;
      case 'bri':
      case 'fx':
      case 'pal':
        if (!integer(field, 0, 255)) fail();
        break;
      case 'grp':
        if (!integer(field, 1, 65535)) fail();
        break;
      case 'spc':
      case 'of':
        if (!integer(field, 0, 65535)) fail();
        break;
      case 'on':
      case 'rev':
      case 'mi':
      case 'frz':
        if (typeof field !== 'boolean') fail();
        break;
      case 'col':
        if (
          !Array.isArray(field) ||
          !field.length ||
          field.length > 3 ||
          field.some(
            (color) =>
              !Array.isArray(color) ||
              (color.length !== 3 && color.length !== 4) ||
              color.some((channel) => !integer(channel, 0, 255)),
          )
        )
          fail();
        break;
      case 'i':
        validateIndividualColors(field, ledCount);
        break;
    }
  }
  if (typeof segment.start === 'number' && typeof segment.stop === 'number' && segment.start >= segment.stop) fail();
}

function validateIndividualColors(individual: unknown, ledCount: number): void {
  if (!Array.isArray(individual) || !individual.length) fail();
  for (let offset = 0; offset < individual.length;) {
    const start: unknown = individual[offset++];
    if (!integer(start, 0, ledCount - 1)) fail();
    if (typeof individual[offset] === 'number') {
      const stop: unknown = individual[offset++];
      if (!integer(stop, 1, ledCount) || (stop as number) <= (start as number)) fail();
    }
    const color: unknown = individual[offset++];
    if (typeof color !== 'string' || !/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) fail();
  }
}
