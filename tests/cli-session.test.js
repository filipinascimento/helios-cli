import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSessionMeta, loadSessionState } from '../src/shared/sessionRegistry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('./bin/helios.js');
const cliCwd = path.resolve('.');

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

test('headless webgpu session supports hardware rendering, export, and stop', async () => {
  const started = await runCli(['session', 'start', '--mode', 'headless', '--renderer', 'webgpu'], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);
  assert.equal(session.mode, 'headless');
  assert.equal(session.renderer, 'webgpu');
  assert.equal(session.bridgeConnected, true);
  assert.equal(session.gpu?.ok, true);
  assert.equal(session.noGpu, false);
  assert.ok(['webgpu', 'webgl2'].includes(session.gpu?.actualRenderer));
  if (session.gpu?.actualRenderer === 'webgl2') {
    assert.equal(session.gpu?.fallbackUsed, true);
  }

  try {
    const stateResult = await runCli(['call', session.sessionId, 'scene.getState'], { timeout: 120_000 });
    const state = JSON.parse(stateResult.stdout);
    assert.equal(state.network.nodeCount, 200);
    assert.equal(state.renderer, session.gpu.actualRenderer);

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
            attributes: 'weight',
            transformCode: 'inputs[0] * 10 + 4',
          },
        },
      }),
    ]);
    const mappers = JSON.parse(mapperResult.stdout);
    assert.equal(mappers.node.size.meta.transformCode, 'inputs[0] * 10 + 4');

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
    assert.deepEqual(hiddenChanges, []);

    const mirroredState = await waitForSessionState(
      session.sessionId,
      (state) => state.checkpointSeq === checkpoint.checkpointSeq
        && state.overrides?.['appearance.shaded.enabled'] === true,
    );
    assert.ok(mirroredState);
    assert.equal(mirroredState.persistenceId, `helios-cli:${session.sessionId}`);
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
    assert.equal(saved.id, `helios-cli:${session.sessionId}`);

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
    assert.ok(restoredState.network.nodeAttributes.includes('agent_position'));

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

test('headless webgl session uses hardware webgl2', async () => {
  const started = await runCli(['session', 'start', '--mode', 'headless', '--renderer', 'webgl'], { timeout: 120_000 });
  const session = JSON.parse(started.stdout);
  assert.equal(session.mode, 'headless');
  assert.equal(session.renderer, 'webgl');
  assert.equal(session.gpu?.ok, true);
  assert.equal(session.gpu?.actualRenderer, 'webgl2');
  assert.equal(session.gpu?.fallbackUsed, false);
  assert.equal(session.gpu?.webgl?.hardware, true);

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
