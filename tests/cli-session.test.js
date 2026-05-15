import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSessionMeta } from '../src/shared/sessionRegistry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('./bin/helios.js');
const cliCwd = path.resolve('.');

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

    const controlsResult = await runCli([
      'call',
      session.sessionId,
      'camera.controls',
      '--json',
      '{"orbit":false,"autoFit":true}',
    ]);
    const controls = JSON.parse(controlsResult.stdout);
    assert.equal(controls.autoFit, true);

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
