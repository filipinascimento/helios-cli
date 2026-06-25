import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'helios-cli-store-'));
process.env.HELIOS_CLI_STORAGE_DIR = root;

const { FileSessionStore, decodeBinaryFromJson, encodeBinaryForJson } = await import('../src/shared/fileSessionStore.js');
const { storageSessionsDir } = await import('../src/shared/paths.js');

test('file session store saves session JSON with network and position side files', async () => {
  const store = new FileSessionStore();
  const sessionId = 'store-test-session';
  const networkId = `${sessionId}::network-data`;
  const positionId = `${sessionId}::position-data`;

  await store.putSession({
    id: networkId,
    kind: 'session-network-data',
    sessionId,
    format: 'zxnet',
    data: Uint8Array.from([1, 2, 3, 4]),
  });
  await store.putSession({
    id: positionId,
    kind: 'session-position-data',
    sessionId,
    data: Uint8Array.from([5, 6, 7, 8]),
  });
  await store.putSession({
    id: sessionId,
    kind: 'helios-web.persistence.session',
    payload: {
      session: { id: sessionId, workspaceId: 'workspace', unfinished: true },
      networkData: { format: 'zxnet', data: null, dataRef: networkId },
      positionData: { data: null, dataRef: positionId },
      visualizationState: {
        payload: {
          storageState: {
            state: { overrides: { 'scene.dimension': '3d' } },
          },
        },
      },
    },
  });

  const network = decodeBinaryFromJson(await store.getSession(networkId));
  const position = decodeBinaryFromJson(await store.getSession(positionId));
  const [listed] = await store.listSessions();

  assert.deepEqual(Array.from(network.data), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(position.data), [5, 6, 7, 8]);
  assert.equal(listed.id, sessionId);
  assert.match(network.dataFile, /\.zxnet$/);
  assert.match(position.dataFile, /\.positions\.bin$/);
  assert.ok((await fs.stat(storageSessionsDir)).isDirectory());

  await store.deleteSession(sessionId);
  assert.equal(await store.getSession(sessionId), null);
  assert.equal(await store.getSession(networkId), null);
  assert.equal(await store.getSession(positionId), null);
});

test('binary JSON encoder preserves normal arrays and encodes typed arrays', () => {
  const encoded = encodeBinaryForJson({
    sessions: [{ id: 'a' }],
    color: [1, 0.5, 0, 1],
    bytes: Uint8Array.from([1, 2, 3]),
  });

  assert.deepEqual(encoded.sessions, [{ id: 'a' }]);
  assert.deepEqual(encoded.color, [1, 0.5, 0, 1]);
  assert.equal(encoded.bytes.__heliosBinary, 'base64');
  assert.equal(Buffer.from(encoded.bytes.data, 'base64').byteLength, 3);
});
