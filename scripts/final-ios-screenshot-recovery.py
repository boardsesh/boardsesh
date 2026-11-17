"""One-campaign recovery. No store writes; all remote reads use GitHub's CLI."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import zipfile

REPO = 'boardsesh/boardsesh'
SOURCE = 'd5855045ff8170e4e72f9f2edfd1a2d5d396390d'
BASE_RUN = 43938833365
BASE_ARTIFACT = 14317567067
BASE_SHA = '84df9aaeccf8991c73781c777925b7b5332c5e822560432e92f1d803de19ba18'
WORKFLOW = '.github/workflows/final-ios-screenshot-recovery.yml'
RECOVERED_NAME = 'recovered-de-duo-d585'
LOCALES = ['en-US', 'es-ES', 'es-MX', 'fr-FR', 'de-DE', 'it']
PHONE = ['00-your-boards.png', '01-spray-wall.png', '02-more-boards.png', '03-your-crew.png', '04-on-the-wall.png', '05-one-logbook.png', '06-session-plan.png', '07-live-activity.png', '08-next-project.png']
TABLET = ['00-wall-kiosk.png', '01-wall-status.png', '02-home.png', '03-discover.png', '04-workout-generator.png', '05-profile.png']
DUO = ['00-board-view.png', '01-board-view-2.png', '02-climbs.png', '03-home.png', '04-playlist-detail.png', '05-profile.png', '06-session-detail.png', '07-workout-generator.png']
DEVICES = {'iphone-16-pro': PHONE, 'iphone-16-pro-max': PHONE, 'ipad-pro-13-inch-m5': TABLET, 'ipad-pro-11-inch-m5': TABLET, 'iphone-duo': DUO}
SLOTS = {'iphone-16-pro': 'APP_IPHONE_61', 'iphone-16-pro-max': 'APP_IPHONE_67', 'ipad-pro-13-inch-m5': 'APP_IPAD_PRO_3GEN_129', 'ipad-pro-11-inch-m5': 'APP_IPAD_PRO_3GEN_11', 'iphone-duo': 'APP_IPHONE_DUO'}
ALL = {f'{locale}/{device}/' + ('07-session-detail.png' if locale == 'it' and name == '07-live-activity.png' else name) for locale in LOCALES for device, names in DEVICES.items() for name in names}
MISSING = {f'de-DE/iphone-duo/{name}' for name in DUO}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPO}/{path}'], timeout=60))


def validate_artifact(metadata, run, artifact_id, run_id, name, source=None):
    require(metadata['id'] == artifact_id and metadata['name'] == name and not metadata['expired'], 'Artifact identity/expiry mismatch')
    require(metadata['workflow_run']['id'] == run_id and run['id'] == run_id, 'Artifact run mismatch')
    require(run['head_branch'] == 'main' and run['event'] == 'workflow_dispatch', 'Artifact must come from main dispatch')
    require(metadata['workflow_run']['head_sha'] == run['head_sha'], 'Artifact source mismatch')
    if source:
        require(run['head_sha'] == source and run['path'] == '.github/workflows/mobile-screenshots-ios.yml', 'Original campaign source/workflow mismatch')
    else:
        require(run['path'] == WORKFLOW and run['status'] == 'completed' and run['conclusion'] == 'success', 'Recovery capture run must have succeeded')


def download(artifact_id, target):
    with target.open('wb') as output:
        subprocess.run(['gh', 'api', f'repos/{REPO}/actions/artifacts/{artifact_id}/zip'], stdout=output, check=True, timeout=180)


def read_archive(path, expected, expected_sha=None):
    if expected_sha:
        require(digest(path.read_bytes()) == expected_sha, 'Archive checksum mismatch')
    images = {}
    presentations = {}
    provenance = None
    seen = set()
    with zipfile.ZipFile(path) as archive:
        require(sum(item.file_size for item in archive.infolist()) < 1_500_000_000, 'Archive exceeds bound')
        for item in archive.infolist():
            name = item.filename
            parts = PurePosixPath(name).parts
            require(name and not name.startswith('/') and '\\' not in name and '..' not in parts and ':' not in name, 'Unsafe archive path')
            require(name not in seen, 'Duplicate archive entry')
            seen.add(name)
            mode = item.external_attr >> 16
            require(not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)), 'Unsafe archive member type')
            if item.is_dir():
                continue
            if name == 'recovery-provenance.json':
                provenance = json.loads(archive.read(item))
            elif name.endswith('.png'):
                require(name in expected, 'Unexpected image or overlap')
                images[name] = archive.read(item)
            elif name.endswith('/presentation.json'):
                require(name.rsplit('/', 1)[0] in {image.rsplit('/', 1)[0] for image in expected}, 'Unexpected presentation directory')
                presentations[name] = archive.read(item)
            else:
                require(len(parts) == 3 and parts[0] in LOCALES and parts[1] in DEVICES and parts[2] in ('contact-sheet.jpg', 'presentation.json'), 'Unexpected archive file')
    require(set(images) == expected, 'Incomplete image inventory')
    validate_presentations(images, presentations)
    return images, provenance, presentations


def validate_presentations(images, presentations):
    directories = {name.rsplit('/', 1)[0] for name in images}
    require(set(presentations) == {directory + '/presentation.json' for directory in directories}, 'Missing presentation metadata')
    for name, content in presentations.items():
        directory = name.rsplit('/', 1)[0]
        locale = directory.split('/')[0]
        caption_locale = {'es-ES': 'es', 'es-MX': 'es', 'fr-FR': 'fr', 'de-DE': 'de'}.get(locale, locale)
        manifest = json.loads(content)
        require(manifest['version'] == 1 and manifest['locale'] == caption_locale, 'Presentation identity mismatch')
        expected = {path.rsplit('/', 1)[1]: image for path, image in images.items() if path.rsplit('/', 1)[0] == directory}
        require(set(manifest['files']) == set(expected), 'Presentation image inventory mismatch')
        for filename, entry in manifest['files'].items():
            require(type(entry['rawBytes']) is int and 0 < entry['rawBytes'] <= 9007199254740991, 'Invalid presentation raw byte count')
            require(isinstance(entry['rawSha256'], str) and re.fullmatch('[a-f0-9]{64}', entry['rawSha256']), 'Invalid presentation raw checksum')
            require(entry['framedSha256'] == digest(expected[filename]), 'Presentation frame checksum mismatch')


def capture_manifest(root):
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    require(source == SOURCE, 'Capture checkout is not frozen source')
    images = {p.relative_to(root).as_posix(): digest(p.read_bytes()) for p in root.rglob('*.png')}
    require(set(images) == MISSING, 'Capture must contain only eight German Duo images')
    report = {'source': source, 'baseRun': BASE_RUN, 'captureRun': int(os.environ['GITHUB_RUN_ID']), 'captureAttempt': int(os.environ['GITHUB_RUN_ATTEMPT']), 'files': images}
    (root / 'recovery-provenance.json').write_text(json.dumps(report, indent=2) + '\n')


def merge(root, evidence, capture_run, capture_artifact, capture_sha):
    require(re.fullmatch('[0-9a-f]{64}', capture_sha), 'Reviewed capture archive SHA256 required')
    base_meta = api(f'actions/artifacts/{BASE_ARTIFACT}')
    base_run = api(f'actions/runs/{BASE_RUN}')
    validate_artifact(base_meta, base_run, BASE_ARTIFACT, BASE_RUN, 'mobile-screenshots-ios', SOURCE)
    new_meta = api(f'actions/artifacts/{capture_artifact}')
    new_run = api(f'actions/runs/{capture_run}')
    validate_artifact(new_meta, new_run, capture_artifact, capture_run, RECOVERED_NAME)
    evidence.mkdir(parents=True, exist_ok=True)
    base_zip, new_zip = evidence / 'base.zip', evidence / 'recovery.zip'
    download(BASE_ARTIFACT, base_zip)
    download(capture_artifact, new_zip)
    base, _, base_presentations = read_archive(base_zip, ALL - MISSING, BASE_SHA)
    recovery, provenance, new_presentations = read_archive(new_zip, MISSING, capture_sha)
    require(provenance is not None and provenance['source'] == SOURCE and provenance['baseRun'] == BASE_RUN and provenance['captureRun'] == capture_run, 'Capture provenance mismatch')
    require(provenance['files'] == {name: digest(content) for name, content in recovery.items()}, 'Capture file checksums mismatch')
    require(not root.exists() or not any(root.iterdir()), 'Refusing to overwrite existing screenshot tree')
    merged = base | recovery
    require(set(merged) == ALL and len(merged) == 228, 'Full inventory mismatch')
    presentations = base_presentations | new_presentations
    for name, content in (merged | presentations).items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    require(all(digest((root / name).read_bytes()) == digest(content) for name, content in base.items()), 'Original 220 changed')
    report = {'source': SOURCE, 'baseRun': BASE_RUN, 'baseArtifact': BASE_ARTIFACT, 'baseArchiveSha256': BASE_SHA, 'captureRun': capture_run, 'captureArtifact': capture_artifact, 'captureArchiveSha256': capture_sha, 'captureProvenance': provenance, 'presentations': {name: digest(content) for name, content in sorted(presentations.items())}, 'files': {name: {'sha256': digest(content), 'md5': hashlib.md5(content).hexdigest()} for name, content in sorted(merged.items())}}
    (evidence / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')


def check_audit(report, manifest=None, before=None):
    require(report['appId'] == '6761350784' and report['expectedVersion'] == '2.7.1' and report['expectedBuild'] == '8' and not report['identityErrors'], 'Store identity mismatch')
    version, build = report['version'], report['build']
    require(version['id'] == '865f57db-609e-4710-a3e8-ef780a342340' and build['id'] == 'b92bd391-ac55-4c71-8437-60bf8161be59', 'Approved version/build record changed')
    require(not report['readinessIssues'], 'Store readiness issues require investigation')
    require(version['versionString'] == '2.7.1' and version['platform'] == 'IOS' and version['appStoreState'] == 'PREPARE_FOR_SUBMISSION' and version['releaseType'] == 'MANUAL', 'Draft is not editable/manual')
    require(build['version'] == '8' and build['processingState'] == 'VALID' and not build['expired'] and build['preReleaseVersion'] == {'version': '2.7.1', 'platform': 'IOS'}, 'Build not valid candidate')
    if before:
        def protected_fields(audit):
            protected = copy.deepcopy(audit)
            protected.pop('auditedAt', None)
            for localization in protected['localizations']:
                localization.pop('screenshotSets', None)
            return protected
        require(protected_fields(report) == protected_fields(before), 'Non-screenshot store state changed')
    if manifest:
        expected = {}
        for path, hashes in manifest['files'].items():
            locale, device, name = path.split('/')
            staged = re.sub(r'^(\d+)-', r'\1-' + device + '-', name)
            expected[(locale, SLOTS[device], int(name[:2]) + 1)] = (staged, hashes['md5'])
        actual = {}
        for localization in report['localizations']:
            for image_set in localization['screenshotSets']:
                for image in image_set['screenshots']:
                    require(image['processingState'] == 'COMPLETE', 'Screenshot processing incomplete')
                    key = (localization['locale'], image_set['displayType'], image['position'])
                    require(key not in actual, 'Duplicate store screenshot')
                    actual[key] = (image['fileName'], image['sourceFileChecksum'])
        require(len(actual) == 228 and actual == expected, 'Store readback differs from generated 228 images')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['capture-manifest', 'merge', 'check-audit'])
    parser.add_argument('--root', type=Path, default=Path('app-stores/apple/screenshots'))
    parser.add_argument('--evidence', type=Path, default=Path('recovery-evidence'))
    parser.add_argument('--capture-run', type=int)
    parser.add_argument('--capture-artifact', type=int)
    parser.add_argument('--capture-sha')
    parser.add_argument('--audit', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--before', type=Path)
    args = parser.parse_args()
    if args.mode == 'capture-manifest':
        capture_manifest(args.root)
    elif args.mode == 'merge':
        require(args.capture_run and args.capture_artifact and args.capture_sha, 'Capture run/artifact/hash required')
        merge(args.root, args.evidence, args.capture_run, args.capture_artifact, args.capture_sha)
    else:
        check_audit(json.loads(args.audit.read_text()), json.loads(args.manifest.read_text()) if args.manifest else None, json.loads(args.before.read_text()) if args.before else None)


if __name__ == '__main__':
    main()
