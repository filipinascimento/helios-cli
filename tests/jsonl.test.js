import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonLineParser, JsonRpcResponseReader } from '../src/protocol/jsonl.js';

test('createJsonLineParser handles multiple newline-delimited JSON messages', () => {
  const messages = [];
  const parser = createJsonLineParser((message) => messages.push(message));
  parser('{"a":1}\n{"b":2');
  parser('}\n');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
});

test('JsonRpcResponseReader routes responses and notifications separately', async () => {
  const reader = new JsonRpcResponseReader();
  const notifications = [];
  reader.onNotification((message) => notifications.push(message));
  const pending = reader.waitForResponse('1', { timeoutMs: 1000 }, () => {});
  reader.handleMessage({ jsonrpc: '2.0', method: 'events.notification', params: { ok: true } });
  reader.handleMessage({ jsonrpc: '2.0', id: '1', result: { ok: true } });
  const result = await pending;
  assert.deepEqual(result, { jsonrpc: '2.0', id: '1', result: { ok: true } });
  assert.deepEqual(notifications, [{ jsonrpc: '2.0', method: 'events.notification', params: { ok: true } }]);
});
