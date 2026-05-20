import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionId } from '../src/shared/sessionId.js';
import {
  deleteSessionMeta,
  deleteSessionState,
  loadSessionMeta,
  loadSessionState,
  saveSessionMeta,
  saveSessionState,
} from '../src/shared/sessionRegistry.js';

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

test('session registry saves and loads mirrored session state', async () => {
  const sessionId = `test-${createSessionId()}`;
  const state = {
    sessionId,
    persistenceId: `helios-cli:${sessionId}`,
    overrides: { 'appearance.shaded.enabled': true },
    journal: [{ seq: 1, source: 'cli', path: 'appearance.shaded.enabled' }],
  };
  await saveSessionState(sessionId, state);
  const loaded = await loadSessionState(sessionId);
  assert.deepEqual(loaded.overrides, state.overrides);
  assert.equal(loaded.persistenceId, `helios-cli:${sessionId}`);
  await deleteSessionState(sessionId);
  const deleted = await loadSessionState(sessionId);
  assert.equal(deleted, null);
});
