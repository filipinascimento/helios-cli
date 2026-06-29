import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import HeliosNetwork, { AttributeType } from 'helios-network';
import { loadSessionMeta, loadSessionState } from '../src/shared/sessionRegistry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('./bin/helios.js');
const cliCwd = path.resolve('.');
const useSoftwareGpuForManagedBrowserTests = process.env.HELIOS_CLI_TEST_NO_GPU === '1';

function managedBrowserGpuArgs() {
  return useSoftwareGpuForManagedBrowserTests ? ['--no-gpu'] : [];
}

async function waitForSessionState(sessionId, predicate, { timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await loadSessionState(sessionId);
    if (state && (!predicate || predicate(state))) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function runCli(args, options = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: cliCwd,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, stderr };
}

async function waitForRpc(sessionId, method, predicate, { timeoutMs = 30_000, cliArgs = [] } = {}) {
  const startedAt = Date.now();
  let lastPayload = null;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await runCli([...cliArgs, 'call', sessionId, method], { timeout: 120_000 });
    lastPayload = JSON.parse(result.stdout);
    if (!predicate || predicate(lastPayload)) return lastPayload;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${method}: ${JSON.stringify(lastPayload)}`);
}

async function writeUmapFixtureNetwork(directory) {
  const network = await HeliosNetwork.create({ directed: false });
  network.addNodes(4);
  const edgeIds = network.addEdges([[0, 1], [1, 2], [2, 3], [3, 0]]);
  network.defineNodeAttribute('umap_mass', AttributeType.Float, 1);
  network.defineEdgeAttribute('umap_weight', AttributeType.Float, 1);
  network.defineNetworkAttribute('umap', AttributeType.String, 1);
  network.defineNetworkAttribute('umap_edge_weight_attr', AttributeType.String, 1);
  network.defineNetworkAttribute('umap_node_mass_attr', AttributeType.String, 1);
  network.setNetworkStringAttribute('umap', 'true');
  network.setNetworkStringAttribute('umap_edge_weight_attr', 'umap_weight');
  network.setNetworkStringAttribute('umap_node_mass_attr', 'umap_mass');
  network.withBufferAccess(() => {
    const mass = network.getNodeAttributeBuffer('umap_mass').view;
    const weight = network.getEdgeAttributeBuffer('umap_weight').view;
    mass.fill(1);
    for (const edgeId of edgeIds) weight[edgeId] = 1;
  });
  const bytes = await network.saveXNet({ format: 'uint8array' });
  network.dispose();
  const filePath = path.join(directory, 'umap-fixture.xnet');
  await fs.writeFile(filePath, bytes);
  return filePath;
}

async function readJsonResponse(response) {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

test('server session exposes daemon-owned storage API in custom storage dir', async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helios-cli-storage-api-'));
  const started = await runCli([
    '--storage-dir',
    storageDir,
    'session',
    'start',
    '--mode',
    'server',
  ]);
  const session = JSON.parse(started.stdout);
  assert.equal(session.mode, 'server');
  assert.equal(session.storageRoot, storageDir);
  assert.equal(session.storageSessionsPath, path.join(storageDir, 'sessions'));

  const sessionRecordId = 'storage-api-session';
  const networkRecordId = `${sessionRecordId}::network-data`;
  const networkBytes = Buffer.from([1, 2, 3, 4, 5]);
  const apiUrl = (pathname) => new URL(pathname, session.url).toString();

  try {
    const networkRecord = await readJsonResponse(await fetch(apiUrl('/api/storage/session'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: networkRecordId,
        kind: 'session-network-data',
        sessionId: sessionRecordId,
        format: 'zxnet',
        data: {
          __heliosBinary: 'base64',
          data: networkBytes.toString('base64'),
        },
      }),
    }));
    assert.equal(networkRecord.kind, 'session-network-data');
    assert.equal(networkRecord.byteLength, networkBytes.byteLength);
    assert.equal(networkRecord.dataFile, path.join(
      storageDir,
      'sessions',
      'networks',
      `${Buffer.from(sessionRecordId).toString('base64url')}.zxnet`,
    ));
    assert.equal((await fs.stat(networkRecord.dataFile)).size, networkBytes.byteLength);

    const saved = await readJsonResponse(await fetch(apiUrl('/api/storage/session'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: sessionRecordId,
        kind: 'helios-web.persistence.session',
        payload: {
          session: {
            id: sessionRecordId,
            workspaceId: 'storage-api-workspace',
            unfinished: true,
          },
          networkData: {
            dataRef: networkRecordId,
          },
          storageState: {
            state: {
              overrides: {
                'scene.dimension': '3d',
              },
            },
          },
        },
      }),
    }));
    assert.equal(saved.id, sessionRecordId);

    const fetched = await readJsonResponse(await fetch(apiUrl(`/api/storage/session/${encodeURIComponent(sessionRecordId)}`)));
    assert.equal(fetched.id, sessionRecordId);
    assert.equal(fetched.payload.storageState.state.overrides['scene.dimension'], '3d');

    const fetchedNetwork = await readJsonResponse(await fetch(apiUrl(`/api/storage/session/${encodeURIComponent(networkRecordId)}`)));
    assert.equal(fetchedNetwork.data.__heliosBinary, 'base64');
    assert.equal(Buffer.from(fetchedNetwork.data.data, 'base64').byteLength, networkBytes.byteLength);

    const listed = await readJsonResponse(await fetch(apiUrl('/api/storage/sessions')));
    assert.ok(listed.some((entry) => entry.id === sessionRecordId));

    const unfinishedSet = await readJsonResponse(await fetch(apiUrl('/api/storage/unfinished'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'storage-api-workspace',
        sessionId: sessionRecordId,
      }),
    }));
    assert.equal(unfinishedSet.sessionId, sessionRecordId);

    const unfinished = await readJsonResponse(await fetch(apiUrl('/api/storage/unfinished?workspaceId=storage-api-workspace')));
    assert.equal(unfinished.sessionId, sessionRecordId);

    const deleted = await readJsonResponse(await fetch(apiUrl(`/api/storage/session/${encodeURIComponent(sessionRecordId)}`), {
      method: 'DELETE',
    }));
    assert.equal(deleted.deleted, true);

    const missing = await fetch(apiUrl(`/api/storage/session/${encodeURIComponent(sessionRecordId)}`));
    assert.equal(missing.status, 404);
    await assert.rejects(fs.stat(networkRecord.dataFile), /ENOENT/);
  } finally {
    await runCli(['--storage-dir', storageDir, 'session', 'stop', session.sessionId], { timeout: 120_000 });
    await fs.rm(storageDir, { recursive: true, force: true });
  }
});

test('network file load rebuilds gpu-force layout with UMAP defaults', async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helios-cli-umap-storage-'));
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helios-cli-umap-fixture-'));
  const networkPath = await writeUmapFixtureNetwork(fixtureDir);
  const started = await runCli([
    '--storage-dir',
    storageDir,
    'session',
    'start',
    '--mode',
    'headless',
    '--renderer',
    'webgpu',
    '--layout',
    'gpu-force',
    '--network',
    networkPath,
    ...managedBrowserGpuArgs(),
  ], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);

  try {
    const cliArgs = ['--storage-dir', storageDir];
    await waitForRpc(session.sessionId, 'scene.getState', (state) => state.network?.nodeCount === 4, { cliArgs });
    const layout = await waitForRpc(session.sessionId, 'layout.get', (state) => (
      state.label === 'UMAP Force (GPU)'
      && state.descriptor?.bindings?.some((binding) => binding.key === 'outputScale' && binding.value === 24)
    ), { cliArgs });
    const bindings = Object.fromEntries(layout.descriptor.bindings.map((binding) => [binding.key, binding.value]));
    assert.equal(layout.key, 'gpu-force');
    assert.equal(layout.label, 'UMAP Force (GPU)');
    assert.equal(bindings.outputScale, 24);
    assert.equal(bindings.kRepulsion, 1);
    assert.equal(bindings.kAttraction, 1);
    assert.equal(bindings.kGravity, 0);
    assert.equal(bindings.alphaDecay, 0.0025);
    const scene = await waitForRpc(session.sessionId, 'scene.getState', (state) => (
      state.behaviors?.attached?.appearance?.state?.edgeStyle?.widthScale === 0
    ), { cliArgs });
    assert.equal(scene.behaviors.attached.appearance.state.edgeStyle.widthScale, 0);
  } finally {
    await runCli(['--storage-dir', storageDir, 'session', 'stop', session.sessionId], { timeout: 120_000 }).catch(() => null);
    await fs.rm(storageDir, { recursive: true, force: true });
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('categorical mapper defaults use frequency ordered category18 with Others overflow', async () => {
  const started = await runCli([
    'session',
    'start',
    '--mode',
    'headless',
    '--renderer',
    'webgl',
    '--layout',
    'static',
    ...managedBrowserGpuArgs(),
  ], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);

  try {
    await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'ranked_agent_class',
        functionCode: 'return ordinal < 100 ? "Zebra" : (ordinal < 180 ? "Alpha" : "Beta");',
        options: { type: 'string', dimension: 1 },
      }),
    ]);
    await runCli([
      'call',
      session.sessionId,
      'network.categorizeAttribute',
      '--json',
      '{"scope":"node","attribute":"ranked_agent_class","sortOrder":"alphabetical"}',
    ]);
    const rankedCategoricalMapperResult = await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      '{"nodeMapper":{"color":{"type":"categorical","attribute":"ranked_agent_class"}}}',
    ]);
    const rankedCategoricalMapper = JSON.parse(rankedCategoricalMapperResult.stdout);
    assert.equal(rankedCategoricalMapper.node.color.type, 'categorical');
    assert.equal(rankedCategoricalMapper.node.color.meta.categorical.palette, 'category18');
    assert.equal(rankedCategoricalMapper.node.color.meta.categorical.sortOrder, 'frequency');
    assert.deepEqual(rankedCategoricalMapper.node.color.meta.categorical.labels, ['Zebra', 'Alpha', 'Beta']);
    assert.deepEqual(rankedCategoricalMapper.node.color.domain, [2, 0, 1]);

    await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'many_agent_classes',
        functionCode: 'return `Class ${ordinal % 20}`;',
        options: { type: 'string', dimension: 1 },
      }),
    ]);
    await runCli([
      'call',
      session.sessionId,
      'network.categorizeAttribute',
      '--json',
      '{"scope":"node","attribute":"many_agent_classes"}',
    ]);
    const manyCategoricalMapperResult = await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      '{"nodeMapper":{"color":{"type":"categorical","attribute":"many_agent_classes"}}}',
    ]);
    const manyCategoricalMapper = JSON.parse(manyCategoricalMapperResult.stdout);
    assert.equal(manyCategoricalMapper.node.color.domain.length, 18);
    assert.equal(manyCategoricalMapper.node.color.range.length, 18);
    assert.equal(manyCategoricalMapper.node.color.defaultValue, '#888888ff');
    assert.equal(manyCategoricalMapper.node.color.meta.categorical.overflowLabel, 'Others');
  } finally {
    await runCli(['session', 'stop', session.sessionId], { timeout: 120_000 }).catch(() => null);
  }
});

test('attributeSet functionCode can derive from existing attribute buffers', async () => {
  const started = await runCli([
    'session',
    'start',
    '--mode',
    'headless',
    '--renderer',
    'webgl',
    '--layout',
    'static',
    ...managedBrowserGpuArgs(),
  ], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);

  try {
    await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'score',
        functionCode: 'return ordinal;',
        options: { type: 'float', dimension: 1 },
      }),
    ]);
    const derivedResult = await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'high_score',
        functionCode: 'const score = context.score ??= network.getNodeAttributeBuffer("score").view; return score[id] >= 100 ? 1 : 0;',
        options: { type: 'float', dimension: 1 },
      }),
    ]);
    const derivedStats = JSON.parse(derivedResult.stdout);
    assert.ok(derivedStats.nodeAttributes.includes('high_score'));

    const mapperResult = await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      '{"nodeMapper":{"color":{"type":"colormap","attribute":"high_score","domain":[0,1],"colormap":"CET_L08-NeonBurst"}}}',
    ]);
    const mapper = JSON.parse(mapperResult.stdout);
    assert.equal(mapper.node.color.attributes, 'high_score');
    assert.equal(mapper.node.color.type, 'colormap');
  } finally {
    await runCli(['session', 'stop', session.sessionId], { timeout: 120_000 }).catch(() => null);
  }
});

test('headless webgpu session supports managed rendering, export, and stop', async () => {
  const started = await runCli([
    'session',
    'start',
    '--mode',
    'headless',
    '--renderer',
    'webgpu',
    ...managedBrowserGpuArgs(),
  ], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);
  assert.equal(session.mode, 'headless');
  assert.equal(session.renderer, 'webgpu');
  assert.equal(session.bridgeConnected, true);
  assert.equal(session.gpu?.ok, true);
  assert.equal(session.noGpu, useSoftwareGpuForManagedBrowserTests);
  assert.ok(['webgpu', 'webgl2'].includes(session.gpu?.actualRenderer));
  if (useSoftwareGpuForManagedBrowserTests) {
    assert.equal(session.gpu?.allowSoftware, true);
    assert.equal(session.gpu?.actualRenderer, 'webgl2');
    assert.equal(session.gpu?.webgl?.hardware, false);
  } else if (session.gpu?.actualRenderer === 'webgl2') {
    assert.equal(session.gpu?.fallbackUsed, true);
  }

  try {
    const stateResult = await runCli(['call', session.sessionId, 'scene.getState'], { timeout: 120_000 });
    const state = JSON.parse(stateResult.stdout);
    assert.equal(state.network.nodeCount, 200);
    assert.equal(state.renderer, session.gpu.actualRenderer);

    const stateSetResult = await runCli([
      'state',
      'set',
      session.sessionId,
      'scene.dimension',
      '"3d"',
      '--reason',
      'cli-session-test',
    ]);
    const stateSet = JSON.parse(stateSetResult.stdout);
    assert.equal(stateSet.value, '3d');

    const stateGetResult = await runCli(['state', 'get', session.sessionId, 'scene.dimension']);
    const stateGet = JSON.parse(stateGetResult.stdout);
    assert.equal(stateGet.value, '3d');

    const stateResetResult = await runCli([
      'state',
      'reset',
      session.sessionId,
      'scene.dimension',
      '--reason',
      'cli-session-test-reset',
    ]);
    const stateReset = JSON.parse(stateResetResult.stdout);
    assert.ok(stateReset);

    const layoutUpdateResult = await runCli([
      'call',
      session.sessionId,
      'layout.setParameters',
      '--json',
      '{"outputScale":7}',
    ]);
    const layoutUpdate = JSON.parse(layoutUpdateResult.stdout);
    assert.equal(layoutUpdate.changed.outputScale, 7);

    const mapperResult = await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      JSON.stringify({
        nodeMapper: {
          size: {
            type: 'attribute',
            attribute: 'weight',
            transformCode: 'inputs[0] * 10 + 4',
          },
        },
      }),
    ]);
    const mappers = JSON.parse(mapperResult.stdout);
    assert.equal(mappers.node.size.attributes, 'weight');
    assert.equal(mappers.node.size.meta.transformCode, 'inputs[0] * 10 + 4');
    const mapperReadbackResult = await runCli([
      'call',
      session.sessionId,
      'mappers.get',
    ]);
    const mapperReadback = JSON.parse(mapperReadbackResult.stdout);
    assert.equal(mapperReadback.node.size.attributes, 'weight');
    assert.equal(mapperReadback.node.size.meta.transformCode, 'inputs[0] * 10 + 4');

    const degreeResult = await runCli([
      'call',
      session.sessionId,
      'metrics.measure',
      '--json',
      '{"metric":"degree","options":{"nodes":[0,1,2],"outNodeAttribute":"degree"}}',
    ]);
    const degree = JSON.parse(degreeResult.stdout);
    assert.deepEqual(degree.values, [2, 2, 2]);

    const behaviorUpdateResult = await runCli([
      'call',
      session.sessionId,
      'behaviors.update',
      '--json',
      '{"id":"hover","options":{"hoverConnectedEdges":false,"hoverAffectsOtherElements":true}}',
    ]);
    const hoverBehavior = JSON.parse(behaviorUpdateResult.stdout);
    assert.equal(hoverBehavior.state.hoverConnectedEdges, false);
    assert.equal(hoverBehavior.state.hoverAffectsOtherElements, true);

    const legendsDisabledResult = await runCli([
      'call',
      session.sessionId,
      'behaviors.setEnabled',
      '--json',
      '{"id":"legends","enabled":false}',
    ]);
    const legendsDisabled = JSON.parse(legendsDisabledResult.stdout);
    assert.equal(legendsDisabled.state.enabled, false);

    const attributeResult = await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'agent_position',
        functionCode: 'return [ordinal * 2, ordinal * -1, 0];',
        options: { type: 'float', dimension: 3 },
      }),
    ]);
    const attributeStats = JSON.parse(attributeResult.stdout);
    assert.ok(attributeStats.nodeAttributes.includes('agent_position'));

    await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'agent_class',
        functionCode: 'return ["Physics", "Chemistry", "Biology"][ordinal % 3];',
        options: { type: 'string', dimension: 1 },
      }),
    ]);
    const categorizedResult = await runCli([
      'call',
      session.sessionId,
      'network.categorizeAttribute',
      '--json',
      '{"scope":"node","attribute":"agent_class"}',
    ]);
    const categorizedStats = JSON.parse(categorizedResult.stdout);
    const agentClassInfo = categorizedStats.attributes.node.find((entry) => entry.name === 'agent_class');
    assert.equal(agentClassInfo.typeName, 'Category');
    assert.equal(agentClassInfo.categorical, true);

    const categoricalMapperResult = await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      '{"nodeMapper":{"color":{"type":"categorical","attribute":"agent_class"}}}',
    ]);
    const categoricalMapper = JSON.parse(categoricalMapperResult.stdout);
    assert.equal(categoricalMapper.node.color.attributes, 'agent_class');
    assert.equal(categoricalMapper.node.color.type, 'categorical');
    assert.deepEqual(categoricalMapper.node.color.domain, [0, 1, 2]);
    assert.equal(categoricalMapper.node.color.range.length, 3);
    assert.equal(categoricalMapper.node.color.meta.categorical.sortOrder, 'frequency');

    await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'many_agent_classes',
        functionCode: 'return `Class ${ordinal % 20}`;',
        options: { type: 'string', dimension: 1 },
      }),
    ]);
    await runCli([
      'call',
      session.sessionId,
      'network.categorizeAttribute',
      '--json',
      '{"scope":"node","attribute":"many_agent_classes"}',
    ]);
    const manyCategoricalMapperResult = await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      '{"nodeMapper":{"color":{"type":"categorical","attribute":"many_agent_classes"}}}',
    ]);
    const manyCategoricalMapper = JSON.parse(manyCategoricalMapperResult.stdout);
    assert.equal(manyCategoricalMapper.node.color.domain.length, 18);
    assert.equal(manyCategoricalMapper.node.color.range.length, 18);
    assert.equal(manyCategoricalMapper.node.color.defaultValue, '#888888ff');
    assert.equal(manyCategoricalMapper.node.color.meta.categorical.palette, 'category18');
    assert.equal(manyCategoricalMapper.node.color.meta.categorical.sortOrder, 'frequency');
    assert.equal(manyCategoricalMapper.node.color.meta.categorical.overflowLabel, 'Others');

    await runCli([
      'call',
      session.sessionId,
      'network.attributeSet',
      '--json',
      JSON.stringify({
        scope: 'node',
        name: 'ranked_agent_class',
        functionCode: 'return ordinal < 100 ? "Zebra" : (ordinal < 180 ? "Alpha" : "Beta");',
        options: { type: 'string', dimension: 1 },
      }),
    ]);
    await runCli([
      'call',
      session.sessionId,
      'network.categorizeAttribute',
      '--json',
      '{"scope":"node","attribute":"ranked_agent_class","sortOrder":"alphabetical"}',
    ]);
    const rankedCategoricalMapperResult = await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      '{"nodeMapper":{"color":{"type":"categorical","attribute":"ranked_agent_class"}}}',
    ]);
    const rankedCategoricalMapper = JSON.parse(rankedCategoricalMapperResult.stdout);
    assert.equal(rankedCategoricalMapper.node.color.meta.categorical.sortOrder, 'frequency');
    assert.deepEqual(rankedCategoricalMapper.node.color.meta.categorical.labels, ['Zebra', 'Alpha', 'Beta']);
    assert.deepEqual(rankedCategoricalMapper.node.color.domain, [2, 0, 1]);

    const positionsFromAttributeResult = await runCli([
      'call',
      session.sessionId,
      'positions.fromAttribute',
      '--json',
      '{"attribute":"agent_position","stopLayout":true}',
    ]);
    const positionsFromAttribute = JSON.parse(positionsFromAttributeResult.stdout);
    assert.equal(positionsFromAttribute.layout.runState, 'stopped');

    const customPositionsResult = await runCli([
      'call',
      session.sessionId,
      'positions.set',
      '--json',
      JSON.stringify({
        values: [[0, 0, 0], [10, 5, 0], [20, 10, 0]],
        dimension: 3,
        stopLayout: true,
        includeValues: true,
        limit: 3,
      }),
    ]);
    const customPositions = JSON.parse(customPositionsResult.stdout);
    assert.deepEqual(customPositions.values.slice(0, 9), [0, 0, 0, 10, 5, 0, 20, 10, 0]);

    const controlsResult = await runCli([
      'call',
      session.sessionId,
      'camera.controls',
      '--json',
      '{"orbit":false,"autoFit":true}',
    ]);
    const controls = JSON.parse(controlsResult.stdout);
    assert.equal(controls.autoFit, true);

    await runCli([
      'call',
      session.sessionId,
      'scene.setMode',
      '--json',
      '{"mode":"3d"}',
    ]);
    await runCli([
      'call',
      session.sessionId,
      'mappers.set',
      '--json',
      '{"nodeMapper":{"color":{"type":"constant","value":[1,1,1,1]}}}',
    ]);
    await runCli([
      'call',
      session.sessionId,
      'behaviors.update',
      '--json',
      '{"id":"appearance","options":{"shaded":{"enabled":true,"nodes":true},"ambientOcclusion":{"enabled":true,"nodes":true}}}',
    ]);

    const changesResult = await runCli([
      'call',
      session.sessionId,
      'persistence.changes',
      '--json',
      '{"source":"cli","sinceCheckpoint":false}',
    ]);
    const changes = JSON.parse(changesResult.stdout);
    assert.ok(changes.some((entry) => entry.source === 'cli' && entry.path === 'appearance.shaded.enabled'));
    assert.ok(changes.some((entry) => entry.source === 'cli' && entry.path === 'appearance.ambientOcclusion.enabled'));

    const overridesResult = await runCli(['call', session.sessionId, 'persistence.overrides']);
    const overrides = JSON.parse(overridesResult.stdout);
    assert.equal(overrides.overrides['appearance.shaded.enabled'], true);
    assert.equal(overrides.overrides['appearance.ambientOcclusion.enabled'], true);

    const checkpointResult = await runCli(['call', session.sessionId, 'persistence.checkpoint']);
    const checkpoint = JSON.parse(checkpointResult.stdout);
    assert.ok(checkpoint.checkpointSeq > 0);
    const hiddenChangesResult = await runCli(['call', session.sessionId, 'persistence.changes']);
    const hiddenChanges = JSON.parse(hiddenChangesResult.stdout);
    const hiddenOverrideChanges = hiddenChanges.filter((entry) => (
      entry.source === 'cli'
      || entry.overrideChanged === true
      || entry.trackOverride !== false
    ));
    assert.deepEqual(hiddenOverrideChanges, []);

    const mirroredState = await waitForSessionState(
      session.sessionId,
      (state) => state.checkpointSeq === checkpoint.checkpointSeq
        && state.overrides?.['appearance.shaded.enabled'] === true,
    );
    assert.ok(mirroredState);
    assert.equal(mirroredState.persistenceId, session.sessionId);
    assert.equal(mirroredState.storage.cli, 'filesystem');
    assert.equal(mirroredState.status.overrideCount >= 1, true);

    const savedResult = await runCli([
      'call',
      session.sessionId,
      'persistence.save',
      '--json',
      '{"fullSession":true}',
    ], { timeout: 120_000 });
    const saved = JSON.parse(savedResult.stdout);
    assert.equal(saved.id, session.sessionId);
    assert.equal(saved.thumbnail?.dataUrl, true);
    assert.equal(saved.thumbnail?.type, 'image/png');
    assert.ok(saved.thumbnail?.byteLength > 0);

    const reloadedResult = await runCli([
      'call',
      session.sessionId,
      'browser.reload',
      '--json',
      '{"timeoutMs":30000}',
    ], { timeout: 120_000 });
    const reloaded = JSON.parse(reloadedResult.stdout);
    assert.equal(reloaded.reloaded, true);

    const restoredStateResult = await runCli(['call', session.sessionId, 'scene.getState'], { timeout: 120_000 });
    const restoredState = JSON.parse(restoredStateResult.stdout);
    assert.equal(restoredState.mode, '3d');
    assert.deepEqual(restoredState.mappers.node.color.value, [1, 1, 1, 1]);
    assert.equal(restoredState.behaviors.attached.appearance.state.shaded.enabled, true);
    assert.equal(restoredState.behaviors.attached.appearance.state.ambientOcclusion.enabled, true);

    const restoredPositionsResult = await runCli([
      'call',
      session.sessionId,
      'positions.snapshot',
      '--json',
      '{"includeValues":true,"limit":3}',
    ], { timeout: 120_000 });
    const restoredPositions = JSON.parse(restoredPositionsResult.stdout);
    const restoredFirstPositions = restoredPositions.values.slice(0, 9);
    assert.deepEqual(
      restoredFirstPositions.filter((_, index) => index % 3 !== 2),
      [0, 0, 10, 5, 20, 10],
    );
    assert.ok(restoredFirstPositions.every((value) => Number.isFinite(value)));
    assert.ok(restoredFirstPositions.filter((_, index) => index % 3 === 2).every((value) => Math.abs(value) < 1));

    const exportPath = path.join(os.tmpdir(), `helios-cli-export-${session.sessionId}.png`);
    await runCli([
      'call',
      session.sessionId,
      'export.figure',
      '--json',
      JSON.stringify({ format: 'png', preset: 'window', outputPath: exportPath }),
    ], { timeout: 120_000 });
    const exportStat = await fs.stat(exportPath);
    assert.ok(exportStat.size > 0);
    await fs.unlink(exportPath);

    const clearResult = await runCli(['call', session.sessionId, 'persistence.clear']);
    const cleared = JSON.parse(clearResult.stdout);
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.id, session.sessionId);
  } finally {
    const stopped = await runCli(['session', 'stop', session.sessionId], { timeout: 120_000 });
    const result = JSON.parse(stopped.stdout);
    assert.equal(result.stopping, true);
  }

  let meta = await loadSessionMeta(session.sessionId);
  for (let attempt = 0; attempt < 20 && meta; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    meta = await loadSessionMeta(session.sessionId);
  }
  assert.equal(meta, null);
});

test('headless webgl session validates webgl2 rendering policy', async () => {
  const started = await runCli([
    'session',
    'start',
    '--mode',
    'headless',
    '--renderer',
    'webgl',
    ...managedBrowserGpuArgs(),
  ], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);
  assert.equal(session.mode, 'headless');
  assert.equal(session.renderer, 'webgl');
  assert.equal(session.noGpu, useSoftwareGpuForManagedBrowserTests);
  assert.equal(session.gpu?.ok, true);
  assert.equal(session.gpu?.actualRenderer, 'webgl2');
  assert.equal(session.gpu?.fallbackUsed, false);
  if (useSoftwareGpuForManagedBrowserTests) {
    assert.equal(session.gpu?.allowSoftware, true);
    assert.equal(session.gpu?.webgl?.hardware, false);
  } else {
    assert.equal(session.gpu?.webgl?.hardware, true);
  }

  try {
    const stateResult = await runCli(['call', session.sessionId, 'scene.getState'], { timeout: 120_000 });
    const state = JSON.parse(stateResult.stdout);
    assert.equal(state.renderer, 'webgl2');
  } finally {
    await runCli(['session', 'stop', session.sessionId], { timeout: 120_000 });
  }
});

test('server mode starts without a managed bridge and exposes session info', async () => {
  const started = await runCli(['session', 'start', '--mode', 'server'], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);
  assert.equal(session.mode, 'server');
  assert.equal(session.bridgeConnected, false);

  try {
    const infoResult = await runCli(['session', 'info', session.sessionId]);
    const info = JSON.parse(infoResult.stdout);
    assert.equal(info.mode, 'server');
    assert.ok(info.url.startsWith('http://127.0.0.1:'));
  } finally {
    await runCli(['session', 'stop', session.sessionId], { timeout: 120_000 });
  }
});
