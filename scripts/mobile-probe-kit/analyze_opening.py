#!/usr/bin/env python3
"""Compare observed full-art/geometry readiness with the cached-opening target.

Usage: analyze_opening.py RUN_DIR [--gestures-verified] [--ready-budget-ms 100] [--output FILE]
       analyze_opening.py --self-test

Reads probe-events.json, events.json and build-manifest.json (or manifest.json).
Manifest fields: commit, mode='Release', deviceId, probeVariant='baseline' or
'candidate', thermalBefore, thermalAfter. journalComplete=true is an explicit
coverage attestation when chunks are absent; it cannot override corrupt chunks.
Otherwise pulled chunks must merge exactly to the aggregate in stable atMs
order, from chunk-00000 without gaps, through the events.json run-end wall time.
run-end must follow all claimed tap/readiness endpoints.

The full gate requires cached warm, scroll20, scroll40, scroll60 and recycled
cohorts. Each scroll-start/end pair carries that phase and contains downward,
non-fast scroll-progress counts 5,10,15,20, cumulatively 60 before scroll60 taps.
fast-start/end then contains fast up counts 5,10 followed by down counts 5,10,
before recycled opens. open-start/open-end marks identify each opening's phase.
Thirty unmarked or warm-only openings remain a pilot, never a passing full test.
Physical
swipe/pinch/dismiss verification requires the explicit CLI flag or a
gestures-verified.json file containing {"verified": true}. No probe proves it.

Writes opening-summary.json by default. Exit 0 means every acceptance gate
passed; exit 1 means insufficient evidence or a failed target; exit 2 is bad input.
All timings are milliseconds. Full-art wallMs is conservative JS receipt time;
gesture geometry uses uiWallMs and remains a recognizer-readiness proxy.
"""
import argparse
from collections import Counter, defaultdict
import json
import math
from pathlib import Path
import re
import statistics
import sys
import tempfile
import unittest


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def positive_generation(value):
    return number(value) and value > 0 and int(value) == value


def identity(event):
    """Exact immutable render entry; URI equality alone cannot survive a rewrite."""
    if not event.get('key') or not event.get('uri') or not positive_generation(event.get('generation')):
        return None
    return (event['key'], event['uri'], event['generation'])


def describe(values):
    ordered = sorted(values)
    if not ordered:
        return {'count': 0, 'p50Ms': None, 'p95Ms': None, 'maxMs': None}
    # Nearest rank: a small run must not interpolate away its slowest tail.
    return {'count': len(ordered), 'p50Ms': statistics.median(ordered),
            'p95Ms': ordered[math.ceil(0.95 * len(ordered)) - 1], 'maxMs': ordered[-1]}


def phase_at(moment, marks):
    current = 'unmarked'
    for mark in sorted(marks, key=lambda item: item.get('wall', item.get('wallMs', 0))):
        instant = mark.get('wall', mark.get('wallMs'))
        if not number(instant) or instant > moment:
            continue
        label = mark.get('event', mark.get('name', ''))
        if label.endswith('-end'):
            current = 'unmarked'
        elif isinstance(mark.get('phase'), str) and mark['phase']:
            current = mark['phase']
        elif label.endswith('-start'):
            current = label[:-6]
    return current


def normalize_events(events):
    normalized = []
    for position, event in enumerate(events):
        if not isinstance(event, dict) or not isinstance(event.get('data', {}), dict):
            raise ValueError(f'probe event {position} must be an object with object data')
        flattened = {**event.get('data', {}), **event}
        flattened['_position'] = position
        if not isinstance(flattened.get('name'), str) or not number(flattened.get('wallMs')):
            raise ValueError(f'probe event {position} needs name and finite wallMs')
        normalized.append(flattened)
    # Preserve file order when Date.now() assigns the same millisecond: a
    # post-tap index write in that millisecond must never become a pre-tap hit.
    return sorted(normalized, key=lambda event: (event['wallMs'], event['_position']))


def metadata_validation(manifest, observed_variant):
    problems = []
    commit = manifest.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-fA-F]{7,40}', commit):
        problems.append('missing/invalid build commit')
    if str(manifest.get('mode', '')).lower() != 'release':
        problems.append('Release build mode not established')
    if not isinstance(manifest.get('deviceId'), str) or not manifest['deviceId'].strip():
        problems.append('missing deviceId')
    if manifest.get('probeVariant') not in ('baseline', 'candidate'):
        problems.append('missing/invalid probeVariant')
    elif manifest['probeVariant'] != observed_variant:
        problems.append('probeVariant does not match observed full-display events')
    before, after = manifest.get('thermalBefore'), manifest.get('thermalAfter')
    def thermal_acceptable(state):
        return isinstance(state, str) and state in ('nominal', 'fair') or type(state) is int and state in (0, 1)
    if not thermal_acceptable(before) or not thermal_acceptable(after):
        problems.append('missing or unsuitable thermal observations')
    elif before != after:
        problems.append('thermal state changed during run')
    return problems


def mark_wall(mark):
    return mark.get('wall', mark.get('wallMs'))


def terminal_validation(events, marks):
    ends = [mark_wall(mark) for mark in marks if mark.get('event', mark.get('name')) == 'run-end']
    if len(ends) != 1 or not number(ends[0]):
        return ['one finite run-end marker is required'], None
    ended = ends[0]
    endpoint_names = ('climb-press', 'play-full-art-displayed', 'play-full-art-displayed-native',
                      'play-gesture-geometry-committed-ui')
    if any((max(event['wallMs'], event.get('uiWallMs', event['wallMs'])) if event['name'] == endpoint_names[-1] else event['wallMs']) > ended
           for event in events if event['name'] in endpoint_names):
        return ['run-end precedes a claimed tap/readiness endpoint'], ended
    if not events or max(event['wallMs'] for event in events) < ended:
        return ['aggregate stream does not cover run-end'], ended
    return [], ended


def verify_chunks(run, probes, run_end):
    """Verify the actual transport, not merely plausible chunk filenames."""
    paths = list((run / 'probe').rglob('chunk-*.json'))
    evidence = {'present': bool(paths), 'verified': False, 'problems': []}
    if not paths:
        evidence['problems'].append('pulled chunks unavailable')
        return evidence
    indexed = []
    for path in paths:
        matched = re.fullmatch(r'chunk-(\d+)\.json', path.name)
        if not matched:
            evidence['problems'].append('invalid chunk filename')
            return evidence
        indexed.append((int(matched[1]), path))
    indexed.sort()
    indices = [index for index, path in indexed]
    if indices != list(range(len(indices))):
        evidence['problems'].append('chunk sequence must be unique and contiguous from 00000')
        return evidence
    merged, last_chunk = [], []
    try:
        for index, path in indexed:
            chunk = read_json(path)
            if not isinstance(chunk, list) or not chunk:
                raise ValueError('chunks must contain nonempty event arrays')
            normalize_events(chunk)
            if any(not number(event.get('atMs')) for event in chunk):
                raise ValueError('chunk events need finite atMs')
            merged.extend(chunk)
            last_chunk = chunk
        normalize_events(probes)
        if any(not number(event.get('atMs')) for event in probes):
            raise ValueError('aggregate events need finite atMs')
        # This is the exact stable merge order used by ios.pull_probes.
        merged.sort(key=lambda event: event['atMs'])
        canonical = lambda stream: json.dumps(stream, sort_keys=True, separators=(',', ':'))
        if canonical(merged) != canonical(probes):
            evidence['problems'].append('chunk contents/order do not match aggregate stream')
        if run_end is None or max(event['wallMs'] for event in last_chunk) < run_end:
            evidence['problems'].append('last chunk does not cover run-end')
    except (OSError, ValueError, TypeError, KeyError) as error:
        evidence['problems'].append(f'invalid chunk stream: {error}')
    evidence['verified'] = not evidence['problems']
    return evidence


def stress_validation(marks, records):
    problems, completed = [], {}
    ordered = sorted(marks, key=lambda mark: mark_wall(mark) if number(mark_wall(mark)) else math.inf)
    cumulative = 0
    previous_end = -math.inf
    for phase in ('scroll20', 'scroll40', 'scroll60'):
        starts = [mark for mark in ordered if mark.get('event') == 'scroll-start' and mark.get('phase') == phase]
        ends = [mark for mark in ordered if mark.get('event') == 'scroll-end' and mark.get('phase') == phase]
        if len(starts) != 1 or len(ends) != 1 or not number(mark_wall(starts[0])) or not number(mark_wall(ends[0])):
            problems.append(f'missing/ambiguous completed {phase} scroll block')
            continue
        started, ended = mark_wall(starts[0]), mark_wall(ends[0])
        progress = [mark for mark in ordered if mark.get('event') == 'scroll-progress'
                    and number(mark_wall(mark)) and started < mark_wall(mark) < ended]
        valid = started > previous_end and ended > started and [mark.get('count') for mark in progress] == [5, 10, 15, 20]
        valid = valid and all(type(mark.get('count')) is int and mark.get('direction') == 'down'
                              and mark.get('fast') is False for mark in progress)
        if not valid:
            problems.append(f'{phase} needs ordered down progress 5,10,15,20 between its start/end')
            continue
        previous_end = ended
        cumulative += 20
        completed[phase] = {'wall': ended, 'downScrolls': cumulative}
        cached = [record for record in records if record['phase'] == phase and record['status'] == 'cached']
        if not cached or any(record['tapWallMs'] <= ended for record in cached):
            problems.append(f'{phase} needs cached opens after its completed scroll block')
    if cumulative < 60:
        problems.append('60 cumulative downward scrolls not established')
    for phase in ('warm', 'scroll20', 'scroll40', 'scroll60', 'recycled'):
        if not any(record['phase'] == phase and record['status'] == 'cached' for record in records):
            problems.append(f'missing cached {phase} cohort')
    fast_starts = [mark_wall(mark) for mark in ordered if mark.get('event') == 'fast-start']
    fast_ends = [mark_wall(mark) for mark in ordered if mark.get('event') == 'fast-end']
    fast_completed = None
    if len(fast_starts) == 1 and len(fast_ends) == 1 and number(fast_starts[0]) and number(fast_ends[0]):
        started, ended = fast_starts[0], fast_ends[0]
        progress = [mark for mark in ordered if mark.get('event') == 'scroll-progress'
                    and number(mark_wall(mark)) and started < mark_wall(mark) < ended]
        if (started > completed.get('scroll60', {}).get('wall', math.inf) and ended > started
                and [(mark.get('direction'), mark.get('count')) for mark in progress] == [('up', 5), ('up', 10), ('down', 5), ('down', 10)]
                and all(type(mark.get('count')) is int and mark.get('fast') is True for mark in progress)):
            fast_completed = ended
    recycled = [record for record in records if record['phase'] == 'recycled' and record['status'] == 'cached']
    if fast_completed is None or not recycled or any(record['tapWallMs'] <= fast_completed for record in recycled):
        problems.append('recycled cached opens require completed hard up/down progress first')
    return {'downScrolls': cumulative, 'completedScrollBlocks': completed, 'hardUpDownCompletedWallMs': fast_completed,
            'problems': problems}


def analyze(probes, marks, manifest, gestures_verified=False, chunk_coverage=None, ready_budget_ms=100):
    if not number(ready_budget_ms) or ready_budget_ms <= 0:
        raise ValueError('ready_budget_ms must be finite and positive')
    events = normalize_events(probes)
    journal, snapshots, journal_complete = {}, {}, True
    expected_generation = 1
    duplicate_taps = set()
    taps = []
    grouped = defaultdict(list)
    for event in events:
        name = event['name']
        if name == 'overlay-index-write':
            entry = identity(event)
            if entry is None or event.get('generation') != expected_generation:
                journal_complete = False
            if entry:
                journal[entry[0]] = entry
                expected_generation = entry[2] + 1
        elif name == 'overlay-index-drop':
            journal.pop(event.get('key'), None)
        elif name == 'overlay-index-clear':
            journal.clear()
        elif name == 'climb-press':
            tap_id = event.get('tapId')
            if tap_id in snapshots:
                duplicate_taps.add(tap_id)
            snapshots[tap_id] = dict(journal)
            taps.append(event)
        if event.get('tapId') is not None:
            grouped[event['tapId']].append(event)

    terminal_problems, run_end = terminal_validation(events, marks)
    chunk_evidence = chunk_coverage or {'present': False, 'verified': False, 'problems': ['pulled chunks unavailable']}
    explicit_attestation = not chunk_evidence['present'] and manifest.get('journalComplete') is True
    coverage = journal_complete and not terminal_problems and (chunk_evidence['verified'] or explicit_attestation)
    native_seen = any(event['name'] == 'play-full-art-displayed-native' for event in events)
    baseline_seen = any(event['name'] == 'play-full-art-displayed' and identity(event) for event in events)
    observed_variant = 'mixed' if native_seen and baseline_seen else 'candidate' if native_seen else 'baseline' if baseline_seen else 'unknown'
    records = []
    for tap_index, tap in enumerate(taps):
        tap_id, frames, started = tap.get('tapId'), tap.get('frames'), tap['wallMs']
        next_tap = taps[tap_index + 1]['wallMs'] if tap_index + 1 < len(taps) else math.inf
        record = {'tapId': tap_id, 'frames': frames, 'tapWallMs': started, 'phase': phase_at(started, marks),
                  'snapshotQuality': tap.get('snapshotQuality'), 'status': 'incomplete',
                  'cacheClassification': 'unknown', 'reason': None}
        records.append(record)
        if tap_id is None or tap_id in duplicate_taps or not frames:
            record['reason'] = 'missing/duplicate tap identity'
            continue
        window = [event for event in grouped[tap_id] if started <= event['wallMs'] < next_tap]
        targets = [event for event in window if event['name'] == 'play-opening-target'
                   and event.get('frames') == frames and event.get('climb') == tap.get('climb')
                   and event.get('nonce') is not None]
        nonces = {event['nonce'] for event in targets}
        if len(nonces) != 1:
            record['reason'] = 'missing/ambiguous target nonce'
            continue
        nonce = nonces.pop()
        record['nonce'] = nonce
        latest_target = max(targets, key=lambda event: (event['wallMs'], event['_position']))
        route_owner = latest_target.get('routeOwnerId')
        if manifest.get('openingProbeVersion', 1) >= 2 and route_owner is None:
            record['reason'] = 'missing serving route owner'
            continue
        record['routeOwnerId'] = route_owner
        matched = [event for event in grouped[tap_id] if event.get('nonce') == nonce and event.get('frames') == frames
                   and (route_owner is None or event.get('routeOwnerId') == route_owner)
                   and event['wallMs'] >= latest_target['wallMs']
                   and (started <= event['wallMs'] < next_tap or
                        event['name'] == 'play-gesture-geometry-committed-ui' and
                        number(event.get('uiWallMs')) and started <= event['uiWallMs'] < next_tap)]
        selections = [event for event in matched if event['name'] in ('play-overlay-selected', 'play-render-selection')]
        visible = [event for event in matched if event['name'] == 'play-full-art-displayed'
                   and event.get('quality') == 'full' and event.get('uri')]
        full_pairs = []
        for display in visible:
            render_events = [display] if identity(display) else [event for event in matched
                if event['name'] == 'play-full-art-displayed-native' and event.get('quality') == 'full'
                and event.get('uri') == display['uri']
                and (event['wallMs'], event['_position']) <= (display['wallMs'], display['_position'])]
            # Candidate native publication immediately precedes the owner
            # callback. Use its latest entry, never an older cached generation
            # that happened to share the replacement's URI.
            if not identity(display) and render_events:
                render_events = [max(render_events, key=lambda event: (event['wallMs'], event['_position']))]
            for rendered in render_events:
                full_entry = identity(rendered)
                if full_entry is None:
                    continue
                # Selection supplies the actual full render key. Its initial
                # URI/generation may predate recovery; displayed native art
                # supplies the eventual entry used for the pre-tap comparison.
                if any(selection.get('key') == full_entry[0] for selection in selections):
                    full_pairs.append((display, full_entry))
        geometry = [event for event in matched if event['name'] == 'play-gesture-geometry-committed-ui'
                    and number(event.get('uiWallMs')) and started <= event['uiWallMs'] < next_tap
                    and number(event.get('width')) and number(event.get('height'))
                    and event['width'] > 0 and event['height'] > 0]
        if not full_pairs or not geometry:
            record['reason'] = 'missing matched full display/selection' if not full_pairs else 'missing positive UI geometry commit'
            continue
        display, full_entry = min(full_pairs, key=lambda pair: pair[0]['wallMs'])
        geometry_event = min(geometry, key=lambda event: event['uiWallMs'])
        ended = max(display['wallMs'], geometry_event['uiWallMs'])
        record.update({'fullEntry': {'key': full_entry[0], 'uri': full_entry[1], 'generation': full_entry[2]},
                       'fullArtMs': display['wallMs'] - started, 'geometryProxyMs': geometry_event['uiWallMs'] - started,
                       'readyMs': ended - started, 'displaySource': display.get('source'),
                       'recognizerConfirmed': bool(gestures_verified)})
        decoded = [event for event in events if started <= event['wallMs'] < next_tap
                   and event['name'] == 'overlay-painted' and event.get('frames') == frames
                   and event.get('surface') in ('play', 'full')]
        record['decodeCacheType'] = decoded[0].get('cacheType') if decoded else None
        record['postTapRenderObserved'] = any(event['name'] == 'overlay-render' and event.get('frames') == frames
                                            and started <= event['wallMs'] <= ended for event in events)
        before = snapshots[tap_id].get(full_entry[0])
        if not coverage:
            record.update({'cacheClassification': 'unknown_journal_coverage', 'reason': 'incomplete cache journal coverage'})
        elif before == full_entry:
            record.update({'status': 'cached', 'cacheClassification': 'cached_at_tap'})
        else:
            record.update({'status': 'miss', 'cacheClassification': 'regenerated_after_tap' if before else 'index_miss_at_tap'})

    phases = {}
    for phase in sorted({record['phase'] for record in records}):
        phase_records = [record for record in records if record['phase'] == phase]
        cached = [record['readyMs'] for record in phase_records if record['status'] == 'cached']
        phases[phase] = {**describe(cached), 'taps': len(phase_records),
                         'classifications': dict(Counter(record['cacheClassification'] for record in phase_records)),
                         'incomplete': sum(record['status'] == 'incomplete' for record in phase_records)}
    cached_stats = describe([record['readyMs'] for record in records if record['status'] == 'cached'])
    problems = metadata_validation(manifest, observed_variant)
    problems.extend(terminal_problems)
    if not coverage:
        problems.append('cache journal coverage not established')
        if chunk_evidence['present']:
            problems.extend(chunk_evidence['problems'])
    if not gestures_verified:
        problems.append('physical swipe/pinch/dismiss verification absent')
    if cached_stats['count'] < 30:
        problems.append('fewer than 30 valid cached opens')
    if any(record['status'] == 'incomplete' for record in records):
        problems.append('incomplete openings present')
    if cached_stats['p95Ms'] is not None and cached_stats['p95Ms'] > ready_budget_ms:
        problems.append(f'overall cached p95 exceeds {ready_budget_ms:g} ms')
    for phase, result in phases.items():
        if result['count'] == 0:
            problems.append(f'phase {phase} has no valid cached openings')
        elif result['p95Ms'] > ready_budget_ms:
            problems.append(f'phase {phase} cached p95 exceeds {ready_budget_ms:g} ms')
    stress = stress_validation(marks, records)
    problems.extend(stress['problems'])
    return {'schemaVersion': 1, 'passed': not problems, 'validationProblems': problems,
            'readyBudgetMs': ready_budget_ms,
            'manifest': manifest, 'observedProbeVariant': observed_variant,
            'journalCoverageComplete': coverage, 'physicalGesturesVerified': bool(gestures_verified),
            'chunkEvidence': chunk_evidence, 'explicitJournalAttestation': explicit_attestation,
            'runEndWallMs': run_end, 'stressEvidence': stress,
            'endpoint': 'later of full-art JS receipt and positive-geometry UI commit; recognizer proxy',
            'cached': cached_stats, 'observedReady': describe([record['readyMs'] for record in records if 'readyMs' in record]), 'phases': phases,
            'counts': dict(Counter(record['status'] for record in records)),
            'snapshotQualities': dict(Counter(str(record['snapshotQuality']) for record in records)),
            'decodeCacheTypes': dict(Counter(str(record.get('decodeCacheType')) for record in records)),
            'postTapRenderCount': sum(record.get('postTapRenderObserved', False) for record in records),
            'openings': records}


def read_json(path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('run_directory', nargs='?', type=Path)
    parser.add_argument('--gestures-verified', action='store_true', help='explicitly attest physical swipe/pinch/dismiss checks')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--ready-budget-ms', type=float, default=100,
                        help='maximum cached p95 readiness, inclusive; default: 100 ms')
    parser.add_argument('--self-test', action='store_true')
    arguments = parser.parse_args()
    if arguments.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(OpeningAnalysisTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    if arguments.run_directory is None:
        parser.error('run_directory is required')
    run = arguments.run_directory
    try:
        probes = read_json(run / 'probe-events.json')
        marks = read_json(run / 'events.json', [])
        manifest = read_json(run / 'build-manifest.json', read_json(run / 'manifest.json', {}))
        if not isinstance(probes, list) or not isinstance(marks, list) or not isinstance(manifest, dict):
            raise ValueError('probe-events.json/events.json must be arrays; build manifest must be an object')
        if any(not isinstance(mark, dict) for mark in marks):
            raise ValueError('events.json marks must be objects')
        evidence = read_json(run / 'gestures-verified.json', {})
        verified = arguments.gestures_verified or isinstance(evidence, dict) and evidence.get('verified') is True
        terminal_problems, run_end = terminal_validation(normalize_events(probes), marks)
        chunk_coverage = verify_chunks(run, probes, run_end)
        summary = analyze(probes, marks, manifest, verified, chunk_coverage, arguments.ready_budget_ms)
        output = arguments.output or run / 'opening-summary.json'
        output.write_text(json.dumps(summary, indent=2) + '\n')
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f'Opening analysis input error: {error}', file=sys.stderr)
        return 2
    print(f"{'PASS' if summary['passed'] else 'NOT VALIDATED'}: cached {summary['cached']}; counts {summary['counts']}")
    for phase, result in summary['phases'].items():
        print(f"  {phase}: n={result['count']} p50={result['p50Ms']} p95={result['p95Ms']} max={result['maxMs']} ms; incomplete={result['incomplete']}")
    if summary['validationProblems']:
        print('  ' + '; '.join(summary['validationProblems']))
    print(output)
    return 0 if summary['passed'] else 1


class OpeningAnalysisTests(unittest.TestCase):
    """Scenario evidence, including order and identity failures the gate rejects."""

    @staticmethod
    def fixture(count=1):
        events = [{'name': 'overlay-index-write', 'wallMs': 1, 'key': 'full', 'uri': 'png', 'generation': 1}]
        for tap_id in range(1, count + 1):
            start = tap_id * 100
            common = {'tapId': tap_id, 'nonce': tap_id + 20, 'frames': 'holds'}
            events.extend([
                {'name': 'climb-press', 'wallMs': start, 'tapId': tap_id, 'frames': 'holds', 'climb': 'climb'},
                {'name': 'play-opening-target', 'wallMs': start + 1, 'climb': 'climb', **common},
                {'name': 'play-overlay-selected', 'wallMs': start + 2, 'key': 'full', 'uri': 'png', 'generation': 1, **common},
                {'name': 'play-full-art-displayed', 'wallMs': start + 20, 'key': 'full', 'uri': 'png', 'generation': 1, 'quality': 'full', **common},
                {'name': 'play-gesture-geometry-committed-ui', 'wallMs': start + 80, 'uiWallMs': start + 25, 'width': 100, 'height': 200, **common},
            ])
        manifest = {'commit': '8b842c4950', 'mode': 'Release', 'deviceId': 'physical', 'probeVariant': 'baseline',
                    'thermalBefore': 'nominal', 'thermalAfter': 'nominal', 'journalComplete': True}
        return events, manifest

    @staticmethod
    def marks(events):
        taps = [event for event in events if event['name'] == 'climb-press']
        marks = [{'wall': 0, 'event': 'run-start'}]
        if len(taps) >= 30:
            for phase, start in [('scroll20', 581), ('scroll40', 1081), ('scroll60', 1581)]:
                marks.append({'wall': start, 'event': 'scroll-start', 'phase': phase})
                marks.extend({'wall': start + offset, 'event': 'scroll-progress', 'direction': 'down', 'fast': False, 'count': count}
                             for offset, count in enumerate([5, 10, 15, 20], 1))
                marks.append({'wall': start + 5, 'event': 'scroll-end', 'phase': phase})
            marks.append({'wall': 2081, 'event': 'fast-start'})
            marks.extend({'wall': 2081 + offset, 'event': 'scroll-progress', 'direction': direction, 'fast': True, 'count': count}
                         for offset, (direction, count) in enumerate([('up', 5), ('up', 10), ('down', 5), ('down', 10)], 1))
            marks.append({'wall': 2086, 'event': 'fast-end'})
        for tap in taps:
            index = tap['tapId']
            phase = 'warm' if index <= 5 else 'scroll20' if index <= 10 else 'scroll40' if index <= 15 else 'scroll60' if index <= 20 else 'recycled'
            marks.append({'wall': tap['wallMs'] - 1, 'event': 'open-start', 'phase': phase})
            marks.append({'wall': tap['wallMs'] + 70, 'event': 'open-end', 'phase': phase})
        marks.append({'wall': max(event['wallMs'] for event in events), 'event': 'run-end'})
        return marks

    def test_verified_thirty_opens_use_ui_instant_and_configured_gate(self):
        events, manifest = self.fixture(30)
        result = analyze(events, self.marks(events), manifest, True)
        self.assertTrue(result['passed'])
        self.assertEqual(result['readyBudgetMs'], 100)
        self.assertEqual(result['cached']['p95Ms'], 25)
        events[-1]['uiWallMs'] = events[-1]['wallMs'] - 30
        # One tail outlier is below nearest-rank p95 for 30; two cannot hide.
        events[-6]['uiWallMs'] = events[-6]['wallMs'] - 30
        self.assertFalse(analyze(events, self.marks(events), manifest, True, ready_budget_ms=49)['passed'])

    def test_hundred_ms_budget_includes_boundary_and_rejects_one_ms_over(self):
        for ready_ms, expected in ((100, True), (101, False)):
            events, manifest = self.fixture(30)
            marks = self.marks(events)
            # Space taps far enough apart that readiness arrives before the
            # following target. Keep the completed scroll boundaries aligned.
            for event in events:
                event['wallMs'] *= 4
                if 'uiWallMs' in event:
                    event['uiWallMs'] *= 4
            for mark in marks:
                mark['wall'] *= 4
            for event in events:
                if event['name'] == 'play-gesture-geometry-committed-ui':
                    event['uiWallMs'] = event['tapId'] * 400 + ready_ms
            result = analyze(events, marks, manifest, True)
            self.assertEqual(result['passed'], expected)
            self.assertEqual(result['cached']['p95Ms'], ready_ms)

    def test_invalid_ready_budget_is_rejected(self):
        events, manifest = self.fixture()
        for budget in (0, -1, True, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                analyze(events, self.marks(events), manifest, ready_budget_ms=budget)

    def test_closing_route_readiness_cannot_satisfy_new_serving_route(self):
        events, manifest = self.fixture()
        manifest['openingProbeVersion'] = 2
        for event in events:
            if event['name'].startswith('play-'):
                event['routeOwnerId'] = 1
        events.append({'name': 'play-opening-target', 'wallMs': 110, 'tapId': 1,
                       'frames': 'holds', 'climb': 'climb', 'nonce': 21, 'routeOwnerId': 2})
        result = analyze(events, self.marks(events), manifest, True)
        self.assertEqual(result['openings'][0]['status'], 'incomplete')
        self.assertEqual(result['openings'][0]['routeOwnerId'], 2)

    def test_new_serving_route_can_complete_same_nonce_handoff(self):
        events, manifest = self.fixture()
        manifest['openingProbeVersion'] = 2
        target = next(event for event in events if event['name'] == 'play-opening-target')
        target['routeOwnerId'] = 1
        events.append({**target, 'wallMs': 103, 'routeOwnerId': 2})
        for event in events:
            if event['name'].startswith('play-') and event['name'] != 'play-opening-target':
                event['routeOwnerId'] = 2
                event['wallMs'] += 5
        result = analyze(events, self.marks(events), manifest, True)
        self.assertEqual(result['openings'][0]['status'], 'cached')

    def test_new_probe_manifest_requires_owner_identity(self):
        events, manifest = self.fixture()
        manifest['openingProbeVersion'] = 2
        result = analyze(events, self.marks(events), manifest, True)
        self.assertEqual(result['openings'][0]['reason'], 'missing serving route owner')

    def test_rejected_press_cannot_disappear_from_successful_openings(self):
        events, manifest = self.fixture(30)
        events.extend([
            {'name': 'climb-press', 'wallMs': 3100, 'tapId': 31, 'frames': 'withdrawn', 'climb': 'blocked'},
            {'name': 'climb-open-rejected', 'wallMs': 3101, 'tapId': 31, 'reason': 'withdrawn-loaded-snapshot'},
        ])
        result = analyze(events, self.marks(events), manifest, True)
        self.assertEqual(result['cached']['count'], 30)
        self.assertEqual(result['counts']['incomplete'], 1)
        self.assertFalse(result['passed'])

    def test_same_millisecond_post_tap_write_is_a_miss(self):
        events, manifest = self.fixture()
        events[0]['wallMs'] = 100
        events[0], events[1] = events[1], events[0]
        self.assertEqual(analyze(events, self.marks(events), manifest)['openings'][0]['cacheClassification'], 'index_miss_at_tap')

    def test_same_uri_rewritten_generation_does_not_qualify(self):
        events, manifest = self.fixture()
        events.insert(3, {'name': 'overlay-index-write', 'wallMs': 101, 'key': 'full', 'uri': 'png', 'generation': 2})
        for event in events:
            if event['name'] == 'play-full-art-displayed':
                event['generation'] = 2
        self.assertEqual(analyze(events, self.marks(events), manifest)['openings'][0]['cacheClassification'], 'regenerated_after_tap')

    def test_stale_nonce_and_wrong_full_key_are_incomplete(self):
        events, manifest = self.fixture()
        events[-2]['nonce'] = 999
        self.assertEqual(analyze(events, self.marks(events), manifest)['counts'], {'incomplete': 1})
        events, manifest = self.fixture()
        events[-2]['key'] = 'thumbnail'
        self.assertEqual(analyze(events, self.marks(events), manifest)['counts'], {'incomplete': 1})

    def test_candidate_bridge_counts_owner_visibility_after_native_display(self):
        events, manifest = self.fixture()
        manifest['probeVariant'] = 'candidate'
        native = {**events[-2], 'name': 'play-full-art-displayed-native'}
        events.insert(-2, native)
        owner = events[-2]
        for key in ('key', 'generation'):
            owner.pop(key)
        owner['wallMs'] = 140
        owner['source'] = 'bridge-visibility-commit'
        result = analyze(events, self.marks(events), manifest, True)
        self.assertEqual(result['cached']['maxMs'], 40)
        self.assertEqual(result['observedProbeVariant'], 'candidate')

    def test_missing_coverage_metadata_and_gesture_evidence_cannot_pass(self):
        events, manifest = self.fixture(30)
        manifest.pop('journalComplete')
        result = analyze(events, self.marks(events), manifest)
        self.assertFalse(result['passed'])
        self.assertEqual(result['counts'], {'incomplete': 30})
        events, manifest = self.fixture(30)
        manifest.pop('deviceId')
        result = analyze(events, self.marks(events), manifest)
        self.assertFalse(result['passed'])
        self.assertIn('physical swipe/pinch/dismiss verification absent', result['validationProblems'])

    def test_drop_clear_and_generation_gaps_cannot_create_cache_hits(self):
        for mutation in [
            {'name': 'overlay-index-drop', 'wallMs': 2, 'key': 'full'},
            {'name': 'overlay-index-clear', 'wallMs': 2},
        ]:
            events, manifest = self.fixture()
            events.insert(1, mutation)
            self.assertEqual(analyze(events, self.marks(events), manifest)['openings'][0]['cacheClassification'], 'index_miss_at_tap')
        events, manifest = self.fixture(30)
        events[0]['generation'] = 4
        for event in events:
            if event.get('generation') == 1:
                event['generation'] = 4
        self.assertFalse(analyze(events, self.marks(events), manifest, True)['passed'])

    def test_stress_phase_cannot_hide_behind_fast_warm_percentile(self):
        events, manifest = self.fixture(30)
        events[-1]['uiWallMs'] = events[-1]['wallMs'] = 3101
        marks = [{'wall': 0, 'event': 'warm-start'}, {'wall': 2950, 'event': 'stress-start'}, {'wall': 3101, 'event': 'run-end'}]
        result = analyze(events, marks, manifest, True)
        self.assertEqual(result['cached']['p95Ms'], 25)
        self.assertFalse(result['passed'])
        self.assertEqual(result['phases']['stress']['p95Ms'], 101)

    def test_post_tap_regeneration_is_reported_outside_cached_cohort(self):
        events, manifest = self.fixture(31)
        events.append({'name': 'overlay-index-write', 'wallMs': 3101, 'key': 'full', 'uri': 'png', 'generation': 2})
        for event in events:
            if event.get('tapId') == 31 and event.get('generation') == 1:
                event['generation'] = 2
        next(event for event in events if event['name'] == 'climb-press' and event['tapId'] == 31)['snapshotQuality'] = 'thumbnail'
        result = analyze(events, self.marks(events), manifest, True)
        self.assertTrue(result['passed'])
        self.assertEqual(result['counts'], {'cached': 30, 'miss': 1})
        self.assertEqual(result['openings'][-1]['cacheClassification'], 'regenerated_after_tap')

    def test_candidate_latest_native_generation_overrides_older_same_uri(self):
        events, manifest = self.fixture()
        manifest['probeVariant'] = 'candidate'
        old_native = {**events[-2], 'name': 'play-full-art-displayed-native'}
        new_native = {**old_native, 'wallMs': 135, 'generation': 2}
        owner = events[-2]
        owner.pop('key')
        owner.pop('generation')
        owner['wallMs'] = 140
        events.extend([old_native,
                       {'name': 'overlay-index-write', 'wallMs': 130, 'key': 'full', 'uri': 'png', 'generation': 2},
                       new_native])
        result = analyze(events, self.marks(events), manifest, True)
        self.assertEqual(result['openings'][0]['cacheClassification'], 'regenerated_after_tap')
        self.assertEqual(result['openings'][0]['fullEntry']['generation'], 2)

    def test_contiguous_chunks_with_missing_drop_cannot_attest_aggregate(self):
        events, manifest = self.fixture(30)
        events = [{**event, 'atMs': index + 1} for index, event in enumerate(events)]
        marks = self.marks(events)
        ended = next(mark['wall'] for mark in marks if mark['event'] == 'run-end')
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'probe').mkdir()
            chunks = [events[:50], events[50:]]
            for index, chunk in enumerate(chunks):
                (run / 'probe' / f'chunk-{index:05d}.json').write_text(json.dumps(chunk))
            clean = verify_chunks(run, events, ended)
            self.assertTrue(clean['verified'])
            self.assertTrue(analyze(events, marks, manifest, True, clean)['passed'])
            chunks[0].insert(1, {'name': 'overlay-index-drop', 'wallMs': 2, 'atMs': 1.5, 'key': 'full'})
            (run / 'probe' / 'chunk-00000.json').write_text(json.dumps(chunks[0]))
            corrupted = verify_chunks(run, events, ended)
            self.assertFalse(corrupted['verified'])
            # Even an explicit attestation cannot hide contradictory chunks.
            result = analyze(events, marks, manifest, True, corrupted)
            self.assertFalse(result['passed'])
            self.assertFalse(result['journalCoverageComplete'])

    def test_chunk_merge_is_stable_at_ms_and_requires_terminal_coverage(self):
        events = [{'name': 'first', 'wallMs': 10, 'atMs': 2},
                  {'name': 'second', 'wallMs': 11, 'atMs': 2},
                  {'name': 'earlier', 'wallMs': 9, 'atMs': 1}]
        aggregate = [events[2], events[0], events[1]]
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'probe').mkdir()
            (run / 'probe' / 'chunk-00000.json').write_text(json.dumps(events[:1]))
            (run / 'probe' / 'chunk-00001.json').write_text(json.dumps(events[1:]))
            self.assertTrue(verify_chunks(run, aggregate, 11)['verified'])
            self.assertFalse(verify_chunks(run, [aggregate[0], aggregate[2], aggregate[1]], 11)['verified'])
            self.assertFalse(verify_chunks(run, aggregate, 12)['verified'])

    def test_unmarked_pilot_and_late_or_malformed_stress_cannot_pass(self):
        events, manifest = self.fixture(30)
        run_end = {'event': 'run-end', 'wall': 3080}
        pilot = analyze(events, [run_end], manifest, True)
        self.assertFalse(pilot['passed'])
        self.assertEqual(pilot['cached']['count'], 30)
        for mutation in ('late', 'duplicate', 'missing', 'nonmonotonic'):
            marks = self.marks(events)
            progress = next(mark for mark in marks if mark.get('event') == 'scroll-progress' and mark.get('count') == 5)
            if mutation == 'late':
                for mark in marks:
                    if mark.get('phase') == 'scroll60' and mark['event'].startswith('scroll-'):
                        mark['wall'] += 1000
            elif mutation == 'duplicate':
                marks.append(dict(progress))
            elif mutation == 'missing':
                marks.remove(progress)
            else:
                progress['count'] = 15
            self.assertFalse(analyze(events, marks, manifest, True)['passed'], mutation)

    def test_boolean_thermal_and_early_run_end_are_rejected(self):
        events, manifest = self.fixture(30)
        manifest['thermalBefore'] = manifest['thermalAfter'] = True
        result = analyze(events, self.marks(events), manifest, True)
        self.assertFalse(result['passed'])
        self.assertIn('missing or unsuitable thermal observations', result['validationProblems'])
        events, manifest = self.fixture(30)
        marks = self.marks(events)
        next(mark for mark in marks if mark['event'] == 'run-end')['wall'] = 100
        result = analyze(events, marks, manifest, True)
        self.assertFalse(result['passed'])
        self.assertIn('run-end precedes a claimed tap/readiness endpoint', result['validationProblems'])


if __name__ == '__main__':
    sys.exit(main())
