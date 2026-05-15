import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStartArgs } from '../src/cli.js';

test('parseStartArgs defaults GPU requirement on', () => {
  const options = parseStartArgs([]);
  assert.equal(options.mode, 'headed');
  assert.equal(options.renderer, 'webgpu');
  assert.equal(options.noGpu, false);
});

test('parseStartArgs accepts --no-gpu and explicit renderer options', () => {
  const options = parseStartArgs([
    '--mode', 'headless',
    '--renderer', 'webgpu',
    '--layout', 'worker:force3d',
    '--network', './sample.bxnet',
    '--no-gpu',
  ]);
  assert.equal(options.mode, 'headless');
  assert.equal(options.renderer, 'webgpu');
  assert.equal(options.layout, 'worker:force3d');
  assert.equal(options.networkPath, './sample.bxnet');
  assert.equal(options.noGpu, true);
});
