"""Behavioral guards for the one-campaign recovery, run locally and in CI."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'final-ios-screenshot-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def audit():
    return {
        'appId': '6761350784', 'expectedVersion': '2.7.1', 'expectedBuild': '8',
        'identityErrors': [], 'readinessIssues': [], 'auditedAt': 'before',
        'version': {'id': '865f57db-609e-4710-a3e8-ef780a342340', 'versionString': '2.7.1', 'platform': 'IOS', 'appStoreState': 'PREPARE_FOR_SUBMISSION', 'releaseType': 'MANUAL'},
        'build': {'id': 'b92bd391-ac55-4c71-8437-60bf8161be59', 'version': '8', 'processingState': 'VALID', 'expired': False, 'preReleaseVersion': {'version': '2.7.1', 'platform': 'IOS'}},
        'localizations': [{'locale': locale, 'metadata': {'title': 'Boardsesh'}, 'screenshotSets': []} for locale in recovery.LOCALES],
        'customProductPages': [{'screenshotSets': ['unchanged']}], 'reviewSubmissions': [],
    }


def metadata(artifact_id, run_id, name, source):
    return {'id': artifact_id, 'name': name, 'expired': False, 'workflow_run': {'id': run_id, 'head_sha': source}}


def run(run_id, source, workflow):
    return {'id': run_id, 'head_sha': source, 'head_branch': 'main', 'event': 'workflow_dispatch', 'path': workflow, 'status': 'completed', 'conclusion': 'success'}


def presentations(images):
    manifests = {}
    for path, content in images.items():
        directory, name = path.rsplit('/', 1)
        locale = {'es-ES': 'es', 'es-MX': 'es', 'fr-FR': 'fr', 'de-DE': 'de'}.get(directory.split('/')[0], directory.split('/')[0])
        manifest = manifests.setdefault(directory + '/presentation.json', {'version': 1, 'locale': locale, 'files': {}})
        manifest['files'][name] = {'rawBytes': 1000000, 'rawSha256': 'a' * 64, 'framedSha256': recovery.digest(content)}
    return {name: json.dumps(manifest).encode() for name, manifest in manifests.items()}


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def archive(self, entries):
        path = self.root / 'input.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, content in entries:
                archive.writestr(name, content)
        return path

    def test_archive_rejects_traversal_symlinks_duplicates_and_overlap(self):
        valid = next(iter(recovery.MISSING))
        link = zipfile.ZipInfo(valid)
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in [ [('../escape', b'x')], [('/absolute', b'x')], [('de-DE\\escape', b'x')], [(link, b'target')], [(valid, b'a'), (valid, b'b')], [('en-US/iphone-duo/00-board-view.png', b'a')] ]:
            with self.subTest(entries=str(entries)), self.assertRaises(ValueError):
                recovery.read_archive(self.archive(entries), recovery.MISSING)

    def test_archive_requires_exact_inventory_and_digest(self):
        entries = [(name, name.encode()) for name in recovery.MISSING]
        path = self.archive(entries + list(presentations(dict(entries)).items()))
        images, _, sidecars = recovery.read_archive(path, recovery.MISSING, recovery.digest(path.read_bytes()))
        self.assertEqual(set(images), recovery.MISSING)
        self.assertEqual(sidecars, presentations(dict(entries)))
        with self.assertRaises(ValueError):
            recovery.read_archive(path, recovery.MISSING, '0' * 64)
        with self.assertRaises(ValueError):
            recovery.read_archive(self.archive(entries[:-1]), recovery.MISSING)

    def test_archive_rejects_missing_mismatched_or_forged_presentation(self):
        images = {name: name.encode() for name in recovery.MISSING}
        valid = presentations(images)
        with self.assertRaises(ValueError):
            recovery.read_archive(self.archive(list(images.items())), recovery.MISSING)
        name = next(iter(valid))
        for field, replacement in [('rawBytes', 0), ('rawSha256', 'invalid'), ('framedSha256', 'a' * 64)]:
            manifest = json.loads(valid[name])
            manifest['files'][next(iter(manifest['files']))][field] = replacement
            with self.assertRaises(ValueError):
                recovery.read_archive(self.archive(list(images.items()) + [(name, json.dumps(manifest))]), recovery.MISSING)
        manifest = json.loads(valid[name])
        manifest['files'].pop(next(iter(manifest['files'])))
        with self.assertRaises(ValueError):
            recovery.read_archive(self.archive(list(images.items()) + [(name, json.dumps(manifest))]), recovery.MISSING)

    def test_artifact_metadata_rejects_wrong_source_run_workflow_and_expiry(self):
        meta = metadata(1, 2, recovery.RECOVERED_NAME, 'a' * 40)
        record = run(2, 'a' * 40, recovery.WORKFLOW)
        recovery.validate_artifact(meta, record, 1, 2, recovery.RECOVERED_NAME)
        for field, bad in [('path', 'other.yml'), ('head_branch', 'feature'), ('event', 'pull_request'), ('head_sha', 'b' * 40), ('conclusion', 'failure')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                recovery.validate_artifact(meta, {**record, field: bad}, 1, 2, recovery.RECOVERED_NAME)
        for changed in [{**meta, 'expired': True}, {**meta, 'id': 3}, {**meta, 'workflow_run': {'id': 3, 'head_sha': 'a' * 40}}]:
            with self.assertRaises(ValueError):
                recovery.validate_artifact(changed, record, 1, 2, recovery.RECOVERED_NAME)
        with self.assertRaises(ValueError):
            recovery.validate_artifact(meta, record, 1, 2, recovery.RECOVERED_NAME, recovery.SOURCE)

    def test_merge_preserves_220_and_rejects_tampered_provenance(self):
        base = {name: name.encode() for name in recovery.ALL - recovery.MISSING}
        fresh = {name: name.encode() for name in recovery.MISSING}
        provenance = {'source': recovery.SOURCE, 'baseRun': recovery.BASE_RUN, 'captureRun': 2, 'files': {name: recovery.digest(content) for name, content in fresh.items()}}
        records = [metadata(recovery.BASE_ARTIFACT, recovery.BASE_RUN, 'mobile-screenshots-ios', recovery.SOURCE), run(recovery.BASE_RUN, recovery.SOURCE, '.github/workflows/mobile-screenshots-ios.yml'), metadata(1, 2, recovery.RECOVERED_NAME, 'a' * 40), run(2, 'a' * 40, recovery.WORKFLOW)]
        for tampered in [False, True]:
            proof = copy.deepcopy(provenance)
            if tampered:
                proof['source'] = 'b' * 40
            output = self.root / str(tampered)
            with patch.object(recovery, 'api', side_effect=records), patch.object(recovery, 'download'), patch.object(recovery, 'read_archive', side_effect=[(base, None, presentations(base)), (fresh, proof, presentations(fresh))]):
                if tampered:
                    with self.assertRaises(ValueError):
                        recovery.merge(output, self.root / 'evidence', 2, 1, 'a' * 64)
                    self.assertFalse(output.exists())
                else:
                    recovery.merge(output, self.root / 'evidence', 2, 1, 'a' * 64)
                    self.assertEqual(len(list(output.rglob('*.png'))), 228)
                    for name, content in (base | presentations(base) | presentations(fresh)).items():
                        self.assertEqual((output / name).read_bytes(), content)

    def test_preflight_pins_approved_records_and_rejects_invalid_readiness(self):
        recovery.check_audit(audit())
        for key, field, bad in [('version', 'id', 'replacement'), ('build', 'id', 'replacement'), ('version', 'releaseType', 'AFTER_APPROVAL'), ('version', 'appStoreState', 'READY_FOR_SALE'), ('build', 'expired', True), ('build', 'processingState', 'PROCESSING')]:
            report = audit()
            report[key][field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                recovery.check_audit(report)
        report = audit()
        report['readinessIssues'] = ['missing build']
        with self.assertRaises(ValueError):
            recovery.check_audit(report)

    def test_readback_requires_228_complete_checksums_and_protects_cpp_metadata(self):
        report = audit()
        before = copy.deepcopy(report)
        manifest = {'files': {name: {'md5': hashlib.md5(name.encode()).hexdigest()} for name in recovery.ALL}}
        for localization in report['localizations']:
            for device, slot in recovery.SLOTS.items():
                images = []
                for path, hashes in sorted(manifest['files'].items()):
                    locale, image_device, name = path.split('/')
                    if locale == localization['locale'] and image_device == device:
                        images.append({'position': int(name[:2]) + 1, 'fileName': name[:3] + device + '-' + name[3:], 'sourceFileChecksum': hashes['md5'], 'processingState': 'COMPLETE'})
                localization['screenshotSets'].append({'displayType': slot, 'screenshots': images})
        report['auditedAt'] = 'after'
        recovery.check_audit(report, manifest, before)
        for field, bad in [('processingState', 'PROCESSING'), ('sourceFileChecksum', 'wrong'), ('position', 2)]:
            changed = copy.deepcopy(report)
            changed['localizations'][0]['screenshotSets'][0]['screenshots'][0][field] = bad
            with self.assertRaises(ValueError):
                recovery.check_audit(changed, manifest, before)
        changed = copy.deepcopy(report)
        sets = changed['localizations'][0]['screenshotSets']
        sets[0]['displayType'], sets[1]['displayType'] = sets[1]['displayType'], sets[0]['displayType']
        with self.assertRaises(ValueError):
            recovery.check_audit(changed, manifest, before)
        changed = copy.deepcopy(report)
        images = changed['localizations'][0]['screenshotSets'][0]['screenshots']
        images[0]['position'], images[1]['position'] = images[1]['position'], images[0]['position']
        with self.assertRaises(ValueError):
            recovery.check_audit(changed, manifest, before)
        for key, bad in [('customProductPages', []), ('reviewSubmissions', ['new'])]:
            with self.assertRaises(ValueError):
                recovery.check_audit({**report, key: bad}, manifest, before)
        changed = copy.deepcopy(report)
        changed['localizations'][0]['metadata']['title'] = 'changed'
        with self.assertRaises(ValueError):
            recovery.check_audit(changed, manifest, before)


if __name__ == '__main__':
    unittest.main()
