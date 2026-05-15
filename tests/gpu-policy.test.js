import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateManagedGpuPolicy } from '../src/daemon/SessionDaemon.js';

test('webgpu request accepts hardware webgpu', () => {
  const result = evaluateManagedGpuPolicy({
    mode: 'headed',
    rendererPreference: 'webgpu',
    actualRenderer: 'webgpu',
    webgl: { hardware: true, api: 'webgl2' },
    webgpu: { isFallbackAdapter: false },
  });
  assert.equal(result.ok, true);
  assert.equal(result.actualRenderer, 'webgpu');
  assert.equal(result.fallbackUsed, false);
});

test('headless webgpu request allows webgl2 fallback when webgpu is unavailable', () => {
  const result = evaluateManagedGpuPolicy({
    mode: 'headless',
    rendererPreference: 'webgpu',
    actualRenderer: 'webgl2',
    webgl: { hardware: true, api: 'webgl2' },
    webgpu: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actualRenderer, 'webgl2');
  assert.equal(result.fallbackUsed, true);
});

test('headed webgpu request rejects webgl2 fallback', () => {
  const result = evaluateManagedGpuPolicy({
    mode: 'headed',
    rendererPreference: 'webgpu',
    actualRenderer: 'webgl2',
    webgl: { hardware: true, api: 'webgl2' },
    webgpu: null,
  });
  assert.equal(result.ok, false);
});

test('policy rejects software-only rendering unless --no-gpu is set', () => {
  const strict = evaluateManagedGpuPolicy({
    mode: 'headless',
    rendererPreference: 'auto',
    actualRenderer: 'webgl2',
    webgl: { hardware: false, api: 'webgl2' },
    webgpu: { isFallbackAdapter: true },
  });
  assert.equal(strict.ok, false);

  const bypassed = evaluateManagedGpuPolicy({
    mode: 'headless',
    rendererPreference: 'auto',
    noGpu: true,
    actualRenderer: 'webgl2',
    webgl: { hardware: false, api: 'webgl2' },
    webgpu: { isFallbackAdapter: true },
  });
  assert.equal(bypassed.ok, true);
  assert.equal(bypassed.allowSoftware, true);
});
