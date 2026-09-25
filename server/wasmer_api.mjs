// Minimal Wasmer registry client: identity and remote-build deploys.
import { config } from './config.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function gql(query, variables = {}, token) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'auto-story/0.1' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(config.registryUrl, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Registry returned HTTP ${response.status}: ${text.slice(0, 200)}`); }
  if (body.errors?.length) throw new Error(`Registry: ${body.errors.map(e => e.message).join('; ')}`);
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  return body.data;
}

// Same identity `wasmer whoami` reports, plus namespace memberships.
export async function whoami(token) {
  const data = await gql(`query { viewer { username namespaces(first: 100) { edges { node { globalName } } } } }`, {}, token);
  if (!data.viewer) throw new Error('The token is not valid for this registry');
  return {
    username: data.viewer.username,
    namespaces: data.viewer.namespaces.edges.map(e => e.node.globalName),
  };
}


// Reimplements `wasmer deploy --build-remote`: signed upload, autobuild, poll.
export async function deployZip({ zip, appName, owner, token, onEvent = () => {}, signal, timeoutMs = 10 * 60 * 1000 }) {
  onEvent({ stage: 'upload', message: `Requesting an upload slot for ${owner}/${appName}` });
  const upload = await gql(`mutation ($filename: String!, $name: String) {
    generateUploadUrl(input: { filename: $filename, name: $name, expiresAfterSeconds: 600, method: "R2" }) { signedUrl { url } } }`,
  { filename: `${appName}-upload.zip`, name: appName }, token);
  const uploadUrl = upload.generateUploadUrl.signedUrl.url;
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: zip });
  if (!put.ok) throw new Error(`Upload failed with HTTP ${put.status}`);
  onEvent({ stage: 'upload', message: `Uploaded ${(zip.length / 1024 / 1024).toFixed(1)} MiB` });

  const detected = await gql(`mutation ($uploadUrl: String!) {
    autobuildConfigForZipUpload(input: { uploadUrl: $uploadUrl }) { buildConfig { presetName } } }`, { uploadUrl }, token);
  const preset = detected.autobuildConfigForZipUpload.buildConfig?.presetName;
  if (!preset) throw new Error('Wasmer did not recognise the generated site');
  onEvent({ stage: 'build', message: `Wasmer detected a ${preset} project` });

  const started = await gql(`mutation ($uploadUrl: String!, $appName: String!, $owner: String!) {
    deployViaAutobuild(input: { uploadUrl: $uploadUrl, appName: $appName, owner: $owner, buildCmd: "", installCmd: "",
      enableDatabase: false, secrets: [], waitForScreenshotGeneration: false, allowExistingApp: true }) { success buildId } }`,
  { uploadUrl, appName, owner }, token);
  if (!started.deployViaAutobuild.success) throw new Error('Wasmer rejected the deployment');
  const buildId = started.deployViaAutobuild.buildId;
  onEvent({ stage: 'build', message: `Remote build ${buildId} queued` });

  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    await sleep(4000);
    if (signal?.aborted) throw new Error(`Aborted; remote build ${buildId} may still finish on Wasmer`);
    let status;
    try {
      status = (await gql(`query ($id: UUID!) { autobuildDeploymentStatus(buildId: $id) {
        status appVersion { id url app { id url } } } }`, { id: buildId }, token)).autobuildDeploymentStatus;
    } catch (error) {
      onEvent({ stage: 'build', message: `Status check failed, retrying: ${error.message}` });
      continue;
    }
    if (status?.status !== last) {
      last = status?.status;
      onEvent({ stage: 'build', message: `Build ${String(last).toLowerCase()}` });
    }
    if (status?.status === 'SUCCESS') {
      const app = await appByName(appName, owner, token).catch(() => null);
      const url = app?.url || status.appVersion?.app?.url || status.appVersion?.url;
      if (!url) throw new Error('Build succeeded but Wasmer returned no URL');
      return { url, appId: app?.id || status.appVersion?.app?.id, versionId: status.appVersion?.id, adminUrl: app?.adminUrl, buildId };
    }
    if (['FAILED', 'TIMEOUT', 'INTERNAL_ERROR', 'CANCELLED'].includes(status?.status)) {
      throw new Error(`Remote build ${buildId} ended with ${status.status}`);
    }
  }
  throw new Error(`Remote build ${buildId} did not finish in time`);
}

export async function appByName(name, owner, token) {
  const data = await gql(`query ($name: String!, $owner: String!) { getDeployApp(name: $name, owner: $owner) { id url adminUrl } }`,
    { name, owner }, token);
  return data.getDeployApp;
}

// Wait until the new version answers, like the CLI does.
export async function waitLive(url, versionId, timeoutMs = 3 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      const served = response.headers.get('x-edge-app-version-id');
      if (response.status < 500 && (!versionId || served === versionId)) return true;
    } catch {}
    await sleep(5000);
  }
  return false;
}
