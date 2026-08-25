const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { createRunOncePlugin, IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const IOS_BUNDLE_NAME = 'BoardseshBoardArt.bundle';
const ANDROID_ASSET_DIRECTORY = 'boardsesh-board-art';
const OBJECT_KEY_PATTERN = /^static\/v1\/[0-9a-f]{64}\.webp$/;

function loadStaticAssetManifest(repoRoot) {
  const catalogPath = resolve(repoRoot, 'packages/shared/static-assets/src/generated/catalog.json');
  return JSON.parse(readFileSync(catalogPath, 'utf8'));
}

function nativeBoardArtRecords(manifest) {
  return Object.values(manifest).filter((record) => record.nativeBundle === true);
}

function copyNativeBoardArt({ repoRoot, destinationRoot, manifest }) {
  const records = nativeBoardArtRecords(manifest);
  if (records.length === 0) throw new Error('Static asset catalog contains no nativeBundle board art.');

  rmSync(destinationRoot, { force: true, recursive: true });
  mkdirSync(destinationRoot, { recursive: true });
  const copiedObjectKeys = new Set();

  for (const record of records) {
    if (
      !record.logicalPath.startsWith('/images/') ||
      !record.logicalPath.endsWith('.webp') ||
      record.logicalPath.includes('..') ||
      record.contentType !== 'image/webp'
    ) {
      throw new Error(`Invalid native board-art record: ${record.logicalPath}`);
    }
    if (!OBJECT_KEY_PATTERN.test(record.objectKey) || record.objectKey !== `static/v1/${record.sha256}.webp`) {
      throw new Error(`Native board art is not content-addressed: ${record.logicalPath}`);
    }

    const sourcePath = resolve(repoRoot, `packages/web/public${record.logicalPath}`);
    if (!existsSync(sourcePath)) throw new Error(`Native board-art source is missing: ${record.logicalPath}`);
    const sourceBytes = readFileSync(sourcePath);
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    if (sourceSha256 !== record.sha256 || sourceBytes.byteLength !== record.bytes) {
      throw new Error(`Native board-art catalog is stale: ${record.logicalPath}`);
    }

    if (copiedObjectKeys.has(record.objectKey)) continue;
    const destinationPath = resolve(destinationRoot, record.objectKey);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
    copiedObjectKeys.add(record.objectKey);
  }

  return copiedObjectKeys.size;
}

function addIosResourceBundle(
  project,
  projectName,
  addResourceFileToGroup = IOSConfig.XcodeUtils.addResourceFileToGroup,
  bundleName = IOS_BUNDLE_NAME,
) {
  const bundlePath = `${projectName}/${bundleName}`;
  if (typeof project.hasFile === 'function' && project.hasFile(bundlePath)) return project;
  const target = project.getFirstTarget();
  if (!target?.uuid) throw new Error('Could not find the main iOS target for board-art resources.');
  return addResourceFileToGroup({
    filepath: bundlePath,
    groupName: projectName,
    project,
    isBuildFile: true,
    targetUuid: target.uuid,
  });
}

function withBoardArtResources(config) {
  const repoRoot = resolve(__dirname, '../../..');
  const manifest = loadStaticAssetManifest(repoRoot);

  config = withDangerousMod(config, [
    'android',
    (modConfig) => {
      const destinationRoot = resolve(
        modConfig.modRequest.platformProjectRoot,
        'app/src/main/assets',
        ANDROID_ASSET_DIRECTORY,
      );
      copyNativeBoardArt({ repoRoot, destinationRoot, manifest });
      return modConfig;
    },
  ]);

  config = withDangerousMod(config, [
    'ios',
    (modConfig) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(modConfig.modRequest.projectRoot);
      const destinationRoot = resolve(modConfig.modRequest.platformProjectRoot, projectName, IOS_BUNDLE_NAME);
      copyNativeBoardArt({ repoRoot, destinationRoot, manifest });
      return modConfig;
    },
  ]);

  return withXcodeProject(config, (modConfig) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(modConfig.modRequest.projectRoot);
    modConfig.modResults = addIosResourceBundle(modConfig.modResults, projectName);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withBoardArtResources, 'with-board-art-resources', '1.0.0');
module.exports.ANDROID_ASSET_DIRECTORY = ANDROID_ASSET_DIRECTORY;
module.exports.IOS_BUNDLE_NAME = IOS_BUNDLE_NAME;
module.exports.addIosResourceBundle = addIosResourceBundle;
module.exports.copyNativeBoardArt = copyNativeBoardArt;
module.exports.nativeBoardArtRecords = nativeBoardArtRecords;
