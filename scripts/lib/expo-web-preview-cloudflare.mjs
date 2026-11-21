// This module runs only from trusted preview tooling. PR artifacts never choose
// the Pages project, DNS zone, branch, hostname or deletion targets.
export const PREVIEW_PROJECT = 'boardsesh-app-previews';
export const RETIRED_COMMIT_SHA = '0000000000000000000000000000000000000000';
export const RETIRED_COMMIT_MESSAGE = 'boardsesh:retired-web-preview:v1';
const API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = 'boardsesh.com';
const PAGE_SIZE = 100;
const PAGES_PAGE_SIZE = 25;
const DOMAIN_LIMIT = 100;
const MAX_PAGES = 1000;
const PR_PATTERN = /^pr-([1-9][0-9]*)$/;
const HOST_PATTERN = /^pr-([1-9][0-9]*)\.boardsesh\.com$/;
const DNS_COMMENT_PREFIX = 'boardsesh:web-preview:';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_SMOKE_SCRIPTS = 16;
const MAX_SMOKE_FONTS = 32;
const MAX_SMOKE_SCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_SMOKE_TOTAL_SCRIPT_BYTES = 64 * 1024 * 1024;
const REQUIRED_ICON_FONTS = ['MaterialCommunityIcons', 'MaterialSymbols_400Regular'];

function previewIdentity(input) {
  const text = String(input);
  const prNumber = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(prNumber)) {
    throw new Error('Preview PR number must be a positive safe integer.');
  }
  const branch = `pr-${prNumber}`;
  const hostname = `${branch}.${ZONE_NAME}`;
  return {
    prNumber,
    branch,
    hostname,
    url: `https://${hostname}`,
    target: `${branch}.${PREVIEW_PROJECT}.pages.dev`,
    comment: `${DNS_COMMENT_PREFIX}${branch}`,
  };
}

function identifier(input, label) {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input)) {
    throw new Error(`Invalid Cloudflare ${label}.`);
  }
  return input;
}

function object(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Invalid Cloudflare ${label}.`);
  }
  return input;
}

function assertProject(project) {
  object(project, 'Pages project');
  if (project.name !== PREVIEW_PROJECT || project.production_branch !== 'main' || project.source) {
    throw new Error(`${PREVIEW_PROJECT} must be a direct-upload Pages project with production branch main.`);
  }
  return project;
}

function hasRetirementMarker(deployment, branch) {
  const metadata = deployment?.deployment_trigger?.metadata;
  return (
    deployment?.environment === 'preview' &&
    metadata?.branch === branch &&
    metadata.commit_hash === RETIRED_COMMIT_SHA &&
    metadata.commit_message === RETIRED_COMMIT_MESSAGE
  );
}

function isRetiredDeployment(deployment, branch) {
  return (
    hasRetirementMarker(deployment, branch) &&
    deployment.latest_stage?.name === 'deploy' &&
    deployment.latest_stage?.status === 'success'
  );
}

function branchDeployments(deployments, branch) {
  const targets = deployments.filter((deployment) => deployment.deployment_trigger?.metadata?.branch === branch);
  for (const deployment of targets) {
    identifier(deployment.id, 'deployment ID');
    if (deployment.environment !== 'preview')
      throw new Error(`Refusing to delete a non-preview deployment on ${branch}.`);
    if (typeof deployment.created_on !== 'string' || !Number.isFinite(Date.parse(deployment.created_on))) {
      throw new Error(`Cannot identify the latest deployment on ${branch}: invalid creation timestamp.`);
    }
  }
  return targets.sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
}

function ownsRecord(record, identity, domainExists) {
  // Pages can create its ordinary project CNAME while a custom domain is being
  // attached. Adopt only that exact target on a domain already attached to THIS
  // project; an unmarked pre-existing DNS record remains somebody else's.
  return (
    record.name === identity.hostname &&
    record.type === 'CNAME' &&
    [identity.target, `${PREVIEW_PROJECT}.pages.dev`].includes(record.content) &&
    (record.comment === identity.comment || (domainExists && !record.comment))
  );
}

async function responsePrefix(response, length = 512) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const prefix = new Uint8Array(length);
  let offset = 0;
  try {
    while (offset < length) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      const bytes = chunk.subarray(0, length - offset);
      prefix.set(bytes, offset);
      offset += bytes.length;
    }
    return prefix.subarray(0, offset);
  } finally {
    await reader.cancel();
  }
}

async function boundedResponseText(response, limit, label) {
  if (!response.body) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.length;
      if (bytes > limit) throw new Error(`${label} exceeds the smoke byte limit.`);
      text += decoder.decode(chunk, { stream: true });
    }
    return { text: text + decoder.decode(), bytes };
  } finally {
    await reader.cancel();
  }
}

function smokeAssetPath(path, prefix, origin) {
  const url = new URL(path, origin);
  if (
    !path.startsWith(prefix) ||
    !/^\/[a-zA-Z0-9_@+./=-]+$/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..') ||
    url.origin !== origin ||
    url.pathname !== path ||
    url.search ||
    url.hash
  ) {
    throw new Error('Preview contains an unsafe smoke asset path.');
  }
  return path;
}

function assertResponse(response, pattern, label) {
  if (response.status !== 200 || !pattern.test(response.headers.get('content-type') ?? '')) {
    throw new Error(
      `${label}: expected HTTP 200 with ${pattern}, got ${response.status} ${response.headers.get('content-type') ?? ''}.`,
    );
  }
}

export function createCloudflareClient({
  token,
  accountId,
  zoneId,
  retireDeployment,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('CLOUDFLARE_API_TOKEN is required for web previews.');
  identifier(accountId, 'account ID');
  if (zoneId !== undefined) identifier(zoneId, 'zone ID');
  const projectPath = `/accounts/${accountId}/pages/projects/${PREVIEW_PROJECT}`;
  let resolvedZoneId = zoneId;

  async function request(method, path, body, allowMissing = false) {
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`Cloudflare ${method} ${path} could not connect or timed out.`, { cause: error });
    }
    if (allowMissing && response.status === 404) return null;
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(`Cloudflare ${method} ${path} returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok || envelope?.success !== true) {
      const messages = Array.isArray(envelope?.errors)
        ? envelope.errors
            .map((error) => `${error.code}: ${error.message}`)
            .join('; ')
            .slice(0, 1000)
        : '';
      throw new Error(
        `Cloudflare ${method} ${path} failed (HTTP ${response.status})${messages ? `: ${messages}` : '.'}`,
      );
    }
    return envelope;
  }

  async function list(path, allowMissing = false, { pageSize = PAGE_SIZE, singlePageWithoutInfo = false } = {}) {
    const results = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const envelope = await request(
        'GET',
        `${path}${separator}page=${page}&per_page=${pageSize}`,
        undefined,
        allowMissing,
      );
      if (envelope === null) return [];
      if (!Array.isArray(envelope.result)) throw new Error(`Cloudflare ${path} did not return a list.`);
      results.push(...envelope.result);
      const pageInfo = envelope.result_info;
      if (pageInfo !== undefined && pageInfo !== null) {
        object(pageInfo, 'pagination metadata');
        const effectivePageSize = pageInfo.per_page ?? pageSize;
        if (
          !Number.isSafeInteger(effectivePageSize) ||
          effectivePageSize < 1 ||
          (pageInfo.total_pages !== undefined &&
            (!Number.isSafeInteger(pageInfo.total_pages) || pageInfo.total_pages < 0)) ||
          (pageInfo.total_count !== undefined &&
            (!Number.isSafeInteger(pageInfo.total_count) || pageInfo.total_count < 0)) ||
          (pageInfo.page !== undefined && pageInfo.page !== page)
        ) {
          throw new Error(`Cloudflare ${path} returned invalid pagination metadata.`);
        }
        const totalPages =
          pageInfo.total_pages ??
          (pageInfo.total_count === undefined ? undefined : Math.ceil(pageInfo.total_count / effectivePageSize));
        if (totalPages !== undefined && page >= totalPages) {
          if (
            (totalPages === 0 && results.length > 0) ||
            (pageInfo.total_count !== undefined && results.length !== pageInfo.total_count)
          ) {
            throw new Error(`Cloudflare ${path} returned a truncated or inconsistent listing.`);
          }
          return results;
        }
        if (totalPages !== undefined && envelope.result.length === 0) {
          throw new Error(`Cloudflare ${path} returned a truncated listing before its final page.`);
        }
        if (totalPages === undefined && envelope.result.length < effectivePageSize) return results;
      } else if (singlePageWithoutInfo || envelope.result.length < pageSize) {
        return results;
      }
    }
    throw new Error(`Cloudflare ${path} exceeded ${MAX_PAGES} pages; refusing a partial listing.`);
  }

  async function zonePath() {
    if (!resolvedZoneId) {
      const zones = await list(`/zones?name=${encodeURIComponent(ZONE_NAME)}`, false, { pageSize: PAGES_PAGE_SIZE });
      const matching = zones.filter((zone) => zone.name === ZONE_NAME);
      if (matching.length !== 1)
        throw new Error(
          `Expected one Cloudflare zone for ${ZONE_NAME}; grant Zone.Zone Read or set CLOUDFLARE_ZONE_ID.`,
        );
      resolvedZoneId = identifier(matching[0].id, 'zone ID');
    }
    return `/zones/${resolvedZoneId}`;
  }

  async function projectOrMissing() {
    const envelope = await request('GET', projectPath, undefined, true);
    return envelope === null ? null : assertProject(envelope.result);
  }

  async function ensureProject() {
    const project = await projectOrMissing();
    if (project) return project;
    try {
      const envelope = await request('POST', `/accounts/${accountId}/pages/projects`, {
        name: PREVIEW_PROJECT,
        production_branch: 'main',
      });
      return assertProject(envelope.result);
    } catch (error) {
      // Different PRs can both make the first deployment at once. A create
      // conflict is safe only when a fresh read confirms the expected project.
      const concurrent = await projectOrMissing();
      if (concurrent) return concurrent;
      throw error;
    }
  }

  async function domainRecords(identity) {
    return list(`${await zonePath()}/dns_records?name=${encodeURIComponent(identity.hostname)}`);
  }

  function listDomains() {
    // The REST contract permits pages of at most 25. Older API/SDK versions
    // return one complete SinglePage without result_info, even for 100 domains.
    // https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/list/
    return list(`${projectPath}/domains`, false, { pageSize: PAGES_PAGE_SIZE, singlePageWithoutInfo: true });
  }

  function listDeployments() {
    return list(`${projectPath}/deployments`, false, { pageSize: PAGES_PAGE_SIZE });
  }

  async function ensurePreviewDomain(prNumber) {
    const identity = previewIdentity(prNumber);
    if (!(await projectOrMissing())) throw new Error(`Create ${PREVIEW_PROJECT} before attaching preview domains.`);
    const domains = await listDomains();
    let domainExists = domains.some((domain) => domain.name === identity.hostname);
    if (!domainExists && domains.length >= DOMAIN_LIMIT) {
      throw new Error(
        `Web preview domain capacity reached (${DOMAIN_LIMIT}/${DOMAIN_LIMIT}). Close unused app previews before deploying another; no plan upgrade was requested.`,
      );
    }
    let records = await domainRecords(identity);
    if (records.length > 1 || records.some((record) => !ownsRecord(record, identity, domainExists))) {
      throw new Error(`Refusing to replace unrelated DNS for ${identity.hostname}.`);
    }
    if (!domainExists) {
      await request('POST', `${projectPath}/domains`, { name: identity.hostname });
      domainExists = true;
      // Domain registration may have inserted the ordinary project CNAME.
      records = await domainRecords(identity);
      if (records.length > 1 || records.some((record) => !ownsRecord(record, identity, domainExists))) {
        throw new Error(`Refusing to replace unrelated DNS created concurrently for ${identity.hostname}.`);
      }
    }
    const expected = {
      type: 'CNAME',
      name: identity.hostname,
      content: identity.target,
      proxied: true,
      ttl: 1,
      comment: identity.comment,
    };
    const record = records[0];
    if (!record) {
      await request('POST', `${await zonePath()}/dns_records`, expected);
    } else if (record.content !== expected.content || record.proxied !== true || record.comment !== expected.comment) {
      await request('PATCH', `${await zonePath()}/dns_records/${identifier(record.id, 'DNS record ID')}`, expected);
    }
    return { hostname: identity.hostname, branch: identity.branch, url: identity.url };
  }

  async function removePreview(prNumber) {
    const identity = previewIdentity(prNumber);
    const project = await projectOrMissing();
    // Finish every listing and all ownership checks before the first deletion.
    const domains = project ? await listDomains() : [];
    const deployments = project ? await listDeployments() : [];
    const records = await domainRecords(identity);
    const domainExists = domains.some((domain) => domain.name === identity.hostname);
    if (records.length > 1 || records.some((record) => !ownsRecord(record, identity, domainExists))) {
      throw new Error(`Refusing to delete unrelated DNS for ${identity.hostname}.`);
    }
    let targets = branchDeployments(deployments, identity.branch);
    for (const record of records) identifier(record.id, 'DNS record ID');
    if (targets.length > 0 && !isRetiredDeployment(targets[0], identity.branch)) {
      // Pages protects the newest deployment of EACH branch, even with force.
      // Move the alias to a trusted inert document before deleting old app code.
      // https://developers.cloudflare.com/pages/configuration/preview-deployments/#delete-preview-deployments
      if (typeof retireDeployment !== 'function') {
        throw new Error(`Retiring ${identity.branch} requires a trusted tombstone uploader before cleanup.`);
      }
      await retireDeployment({
        prNumber: identity.prNumber,
        branch: identity.branch,
        hostname: identity.hostname,
        url: identity.url,
      });
      // Wrangler can return while the provider still reports an intermediate
      // stage. A successful build/initialize is not proof the inert site serves.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        targets = branchDeployments(await listDeployments(), identity.branch);
        if (isRetiredDeployment(targets[0], identity.branch)) break;
        const failed =
          hasRetirementMarker(targets[0], identity.branch) &&
          ['failure', 'canceled'].includes(targets[0].latest_stage?.status);
        if (failed || attempt === 11) {
          throw new Error(
            `Cannot clean ${identity.branch}: its latest deployment is not the successful trusted retirement marker.`,
          );
        }
        await sleep(5000);
      }
    }
    for (const record of records) {
      await request('DELETE', `${await zonePath()}/dns_records/${record.id}`, undefined, true);
    }
    if (domainExists) await request('DELETE', `${projectPath}/domains/${identity.hostname}`, undefined, true);
    // Keep the one provider-protected newest tombstone. Older tombstones are
    // deletable too, so interrupted cleanup does not accumulate retirement code.
    for (const deployment of targets.slice(1)) {
      await request('DELETE', `${projectPath}/deployments/${deployment.id}?force=true`, undefined, true);
    }
  }

  async function listPreviews() {
    const project = await projectOrMissing();
    const domains = project ? await listDomains() : [];
    const deployments = project ? await listDeployments() : [];
    const records = await list(`${await zonePath()}/dns_records`);
    const previews = new Map();
    function include(prNumber) {
      const identity = previewIdentity(prNumber);
      if (!previews.has(identity.prNumber)) previews.set(identity.prNumber, { prNumber: identity.prNumber });
      return previews.get(identity.prNumber);
    }
    for (const domain of domains) {
      const match = HOST_PATTERN.exec(domain.name ?? '');
      if (match) include(match[1]);
    }
    for (const record of records) {
      const match = HOST_PATTERN.exec(record.name ?? '');
      if (
        match &&
        record.comment === previewIdentity(match[1]).comment &&
        ownsRecord(record, previewIdentity(match[1]), false)
      )
        include(match[1]);
    }
    for (const deployment of deployments) {
      const metadata = deployment.deployment_trigger?.metadata;
      const match = PR_PATTERN.exec(metadata?.branch ?? '');
      if (!match || deployment.environment !== 'preview' || isRetiredDeployment(deployment, metadata.branch)) continue;
      const preview = include(match[1]);
      if (!preview.createdOn || Date.parse(deployment.created_on) > Date.parse(preview.createdOn)) {
        if (typeof deployment.created_on === 'string' && Number.isFinite(Date.parse(deployment.created_on)))
          preview.createdOn = deployment.created_on;
        if (SHA_PATTERN.test(metadata.commit_hash ?? '')) preview.sha = metadata.commit_hash;
        else delete preview.sha;
      }
    }
    return [...previews.values()].sort((left, right) => left.prNumber - right.prNumber);
  }

  async function smokePreview(prNumber, sha) {
    const identity = previewIdentity(prNumber);
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha))
      throw new Error('Preview smoke requires the full deployed commit SHA.');
    const deadline = Date.now() + 180000;
    async function get(path) {
      return fetchImpl(`${identity.url}${path}`, {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
    }
    async function attempt() {
      const [root, deep, metadata, manifest, wasm, missing] = await Promise.all([
        get('/'),
        get('/climbs'),
        get('/preview-meta.json'),
        get('/manifest.json'),
        get('/wasm/board_renderer_wasm_bg.wasm'),
        get('/_expo/static/js/web/boardsesh-preview-missing.js'),
      ]);
      assertResponse(root, /^text\/html\b/i, 'Preview root');
      assertResponse(deep, /^text\/html\b/i, 'Preview deep link');
      if (!/\bnoindex\b/i.test(root.headers.get('x-robots-tag') ?? ''))
        throw new Error('Preview root is missing noindex.');
      if (/\bimmutable\b/i.test(root.headers.get('cache-control') ?? ''))
        throw new Error('Preview HTML must revalidate, not be immutable.');
      assertResponse(metadata, /^application\/json\b/i, 'Preview source metadata');
      const source = await metadata.json();
      if (source.prNumber !== identity.prNumber || source.sha !== sha)
        throw new Error('Preview host is serving a different PR or commit SHA.');
      assertResponse(manifest, /^application\/json\b|^application\/manifest\+json\b/i, 'Preview PWA manifest');
      const manifestBody = await manifest.json();
      if (manifestBody.start_url !== '/' || manifestBody.scope !== '/')
        throw new Error('Preview PWA manifest must start and scope at /.');
      assertResponse(wasm, /^application\/(?:wasm|octet-stream)\b/i, 'Preview board-renderer WASM');
      const prefix = await responsePrefix(wasm, 4);
      if (prefix.length < 4 || prefix[0] !== 0 || prefix[1] !== 97 || prefix[2] !== 115 || prefix[3] !== 109)
        throw new Error('Preview WASM response is not a WASM binary.');
      if (missing.status !== 404 || !/\bno-store\b/i.test(missing.headers.get('cache-control') ?? ''))
        throw new Error('Missing preview assets must return HTTP 404 without caching.');
      const { text: html } = await boundedResponseText(root, 1024 * 1024, 'Preview HTML');
      if (!/\bid=["']root["']/.test(html) || !/\bid=["']root["']/.test(await deep.text()))
        throw new Error('Preview root/deep link did not serve the Expo shell.');
      if (!/<link\b[^>]*\bhref=["']\/manifest\.json["']/i.test(html))
        throw new Error('Preview shell must link its root PWA manifest.');
      const scriptPaths = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
        .map((match) => match[1])
        .filter((path) => path.startsWith('/_expo/') && path.endsWith('.js') && !path.startsWith('//'));
      if (scriptPaths.length === 0) throw new Error('Preview shell contains no root-relative Expo JavaScript chunks.');
      if (scriptPaths.length > MAX_SMOKE_SCRIPTS) throw new Error('Preview exceeds the smoke JavaScript chunk limit.');
      const fontPaths = new Set();
      let scriptBytes = 0;
      for (const path of new Set(scriptPaths)) {
        smokeAssetPath(path, '/_expo/', identity.url);
        const chunk = await get(path);
        assertResponse(chunk, /^(?:application|text)\/(?:javascript|ecmascript)\b/i, `Preview JavaScript ${path}`);
        if (!/\bimmutable\b/i.test(chunk.headers.get('cache-control') ?? ''))
          throw new Error('Preview JavaScript must be immutable-cached.');
        const { text: javascript, bytes } = await boundedResponseText(
          chunk,
          Math.min(MAX_SMOKE_SCRIPT_BYTES, MAX_SMOKE_TOTAL_SCRIPT_BYTES - scriptBytes),
          'Preview JavaScript',
        );
        scriptBytes += bytes;
        if (!javascript || /^\s*</.test(javascript))
          throw new Error('Preview JavaScript response is empty or contains HTML.');
        // Metro emits static asset URLs as string literals. Treat the bundle only
        // as bounded text: never import/evaluate PR code in this privileged job.
        for (const match of javascript.matchAll(/(["'])(\/assets\/[^"'\\\r\n]*\.ttf)\1/g)) {
          fontPaths.add(smokeAssetPath(match[2], '/assets/', identity.url));
          if (fontPaths.size > MAX_SMOKE_FONTS) throw new Error('Preview exceeds the smoke font limit.');
        }
      }
      for (const name of REQUIRED_ICON_FONTS) {
        if (![...fontPaths].some((path) => path.split('/').at(-1)?.startsWith(`${name}.`)))
          throw new Error(`Preview JavaScript is missing the ${name} icon font reference.`);
      }
      for (const path of fontPaths) {
        const font = await get(path);
        assertResponse(
          font,
          /^(?:font\/(?:ttf|sfnt)|application\/(?:octet-stream|font-sfnt|x-font-ttf))\b/i,
          `Preview font ${path}`,
        );
        const signature = [...(await responsePrefix(font, 4))].join(',');
        if (!['0,1,0,0', '116,114,117,101', '79,84,84,79'].includes(signature))
          throw new Error(`Preview font ${path} is not a TrueType/OpenType binary.`);
      }
      return identity.url;
    }
    let failure;
    for (let index = 0; index < 24 && Date.now() < deadline; index += 1) {
      try {
        return await attempt();
      } catch (error) {
        failure = error;
        if (index < 23 && Date.now() < deadline) await sleep(5000);
      }
    }
    throw new Error(
      `Preview HTTPS smoke failed for ${identity.url}: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    );
  }

  return { ensureProject, ensurePreviewDomain, removePreview, listPreviews, smokePreview };
}
