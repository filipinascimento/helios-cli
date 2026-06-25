import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import HeliosNetwork, { AttributeType } from 'helios-network';
import { parseDesktopOpenArgs, parseInspectArgs } from '../src/cli.js';
import { inferNetworkFormat, isHeliosNetworkPath } from '../src/shared/networkFormats.js';
import { inspectNetworkFile } from '../src/shared/networkInspect.js';

async function writeFixtureNetworks(directory) {
  const network = await HeliosNetwork.create({ directed: true });
  network.defineNodeAttribute('weight', AttributeType.Float, 1);
  network.defineEdgeAttribute('label', AttributeType.String, 1);
  network.defineNetworkAttribute('source', AttributeType.String, 1);
  network.addNodes(3);
  network.addEdges([[0, 1], [1, 2]]);

  const outputs = {
    xnet: await network.saveXNet({ format: 'uint8array' }),
    zxnet: await network.saveZXNet({ format: 'uint8array' }),
    bxnet: await network.saveBXNet({ format: 'uint8array' }),
    gt: await network.saveGT({ format: 'uint8array' }),
    gtZst: Uint8Array.from(Buffer.from(
      'KLUv/QBofQgA8o0wKpA7B1i1qLvdL2f13wJtPJEw+fNDUqIkCXbKP8LgElq9YTmfa+fwBGokSdroQ/1Gq2OqCR4MBSiAWkiaBnnie2X1IAFSmsjxlflFjouS+B6h4tZZSGV9Eu27nM/r8+b6QeX26wek6QHeIuNW7i7uuhdtTX/puE46vRttZZf1G53lj5870VZ/5bgrEe14YIy23JqxX1oz6ekfsVucdsInNh3jlYwpFFnW/W+IdlsprcHRUidt7/1r6yKmUkd6T9vDAQUiKJBG7G4DEBjjKA0KhQ6LjBNmuZEQhxihLRcUFGMcSzSeYBXpsPASACW2lNDPtcZQMM2WsZzQcVhNbKbFsH2uEglJCwBi2OMXCQ==',
      'base64',
    )),
  };
  network.dispose();

  const paths = {};
  for (const [format, bytes] of Object.entries(outputs)) {
    const key = format === 'gtZst' ? 'gt.zst' : format;
    const filePath = path.join(directory, `fixture.${key}`);
    await fs.writeFile(filePath, bytes);
    paths[key] = filePath;
  }
  return paths;
}

test('network format helpers recognize Helios network extensions', () => {
  assert.equal(inferNetworkFormat('/tmp/a.xnet'), 'xnet');
  assert.equal(inferNetworkFormat('/tmp/a.zxnet'), 'zxnet');
  assert.equal(inferNetworkFormat('/tmp/a.bxnet'), 'bxnet');
  assert.equal(inferNetworkFormat('/tmp/a.gt'), 'gt');
  assert.equal(inferNetworkFormat('/tmp/a.gt.zst'), 'gt');
  assert.equal(inferNetworkFormat('/tmp/a.txt', 'xnet'), 'xnet');
  assert.equal(isHeliosNetworkPath('/tmp/a.gt'), true);
  assert.equal(isHeliosNetworkPath('/tmp/a.gt.zst'), true);
  assert.equal(isHeliosNetworkPath('/tmp/a.zxnet'), true);
  assert.equal(isHeliosNetworkPath('/tmp/a.json'), false);
});

test('parseInspectArgs and parseDesktopOpenArgs validate command arguments', () => {
  assert.deepEqual(parseInspectArgs(['./graph.xnet', '--json']), {
    filePath: './graph.xnet',
    json: true,
    format: null,
  });
  assert.deepEqual(parseInspectArgs(['./graph.data', '--format', 'zxnet']), {
    filePath: './graph.data',
    json: false,
    format: 'zxnet',
  });
  assert.deepEqual(parseInspectArgs(['./graph.data', '--format', 'gt']), {
    filePath: './graph.data',
    json: false,
    format: 'gt',
  });
  assert.throws(() => parseInspectArgs(['./graph.data', '--format', 'gml']), /Unsupported inspect format/);
  assert.equal(parseDesktopOpenArgs(['./graph.xnet']).filePath, path.resolve('./graph.xnet'));
});

test('inspectNetworkFile reports counts, direction, and attribute metadata for supported formats', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'helios-inspect-'));
  const fixtures = await writeFixtureNetworks(directory);
  for (const [format, filePath] of Object.entries(fixtures)) {
    const inspection = await inspectNetworkFile(filePath);
    const effectiveFormat = format === 'gt.zst' ? 'gt' : format;
    assert.equal(inspection.kind, 'helios-network-inspection');
    assert.equal(inspection.format, effectiveFormat);
    assert.equal(inspection.nodeCount, 3);
    assert.equal(inspection.edgeCount, format === 'gt.zst' ? 3 : 2);
    assert.equal(inspection.directed, true);
    if (format === 'gt.zst') {
      assert.ok(inspection.attributes.node.some((entry) => entry.name === 'label' && entry.stringLike === true));
      assert.ok(inspection.attributes.node.some((entry) => entry.name === 'score' && entry.typeName === 'Double'));
      assert.ok(inspection.attributes.node.some((entry) => entry.name === 'coords' && entry.typeName === 'Double' && entry.dimension === 2));
      assert.ok(inspection.attributes.edge.some((entry) => entry.name === 'weight' && entry.typeName === 'Double'));
      assert.ok(inspection.attributes.network.some((entry) => entry.name === 'title' && entry.stringLike === true));
    } else {
      const expectedWeightType = effectiveFormat === 'gt' ? 'Double' : 'Float';
      assert.ok(inspection.attributes.node.some((entry) => entry.name === 'weight' && entry.typeName === expectedWeightType));
      assert.ok(inspection.attributes.edge.some((entry) => entry.name === 'label' && entry.stringLike === true));
      assert.ok(inspection.attributes.network.some((entry) => entry.name === 'source'));
    }
  }
});
