import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionId } from '../src/shared/sessionId.js';
import { deleteSessionMeta, loadSessionMeta, saveSessionMeta } from '../src/shared/sessionRegistry.js';

test('session registry saves and loads metadata', async () => {
  const sessionId = `test-${createSessionId()}`;
  const meta = { sessionId, status: 'ready' };
  await saveSessionMeta(sessionId, meta);
  const loaded = await loadSessionMeta(sessionId);
  assert.deepEqual(loaded.sessionId, sessionId);
  assert.equal(loaded.status, 'ready');
  await deleteSessionMeta(sessionId);
  const deleted = await loadSessionMeta(sessionId);
  assert.equal(deleted, null);
});
