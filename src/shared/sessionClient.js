import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createJsonLineParser, JsonRpcResponseReader, callJsonRpc } from '../protocol/jsonl.js';
import { ensureClientBundle, ensureStateDirs } from './fs.js';
import { packageRoot } from './paths.js';
import { createSessionId } from './sessionId.js';
import { listSessionMetas, loadSessionMeta, loadSessionState } from './sessionRegistry.js';

const daemonEntryPath = path.join(packageRoot, 'src', 'daemon', 'entry.js');

export function normalizeSessionStartConfig(options = {}) {
  return {
    sessionId: options.sessionId ?? createSessionId(),
    mode: options.mode ?? 'server',
    open: options.open === true,
    renderer: options.renderer ?? 'webgpu',
    layout: options.layout ?? 'gpu-force',
    runtime: options.runtime ?? 'cli',
    surface: options.surface ?? null,
    client: options.client ?? null,
    browserChannel: options.browserChannel ?? null,
    storageDir: options.storageDir ? path.resolve(options.storageDir) : (process.env.HELIOS_CLI_STORAGE_DIR ?? null),
    networkPath: options.networkPath ? path.resolve(options.networkPath) : null,
    noGpu: options.noGpu === true,
  };
}

export async function waitForSessionMeta(sessionId, { timeoutMs = 30_000, requireBridge = false } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const meta = await loadSessionMeta(sessionId);
    if (meta?.status === 'ready' && (!requireBridge || meta.bridgeConnected === true)) return meta;
    if (meta?.status === 'error') {
      throw new Error(meta.lastError ?? `Session ${sessionId} failed to start`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for session ${sessionId} to start`);
}

export async function startSession(options = {}) {
  await ensureStateDirs();
  await ensureClientBundle();
  const config = normalizeSessionStartConfig(options);
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
  const child = spawn(process.execPath, [daemonEntryPath, encoded], {
    cwd: packageRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return waitForSessionMeta(config.sessionId, {
    timeoutMs: options.timeoutMs ?? 30_000,
    requireBridge: options.requireBridge ?? (config.mode !== 'server' || config.open === true),
  });
}

export async function openRpcSocket(sessionId) {
  const meta = await loadSessionMeta(sessionId);
  if (!meta) throw new Error(`Unknown session ${sessionId}`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(meta.controlSocket, () => resolve({ socket, meta }));
    socket.on('error', reject);
  });
}

export async function rpcCall(sessionId, method, params = {}) {
  const { socket } = await openRpcSocket(sessionId);
  const reader = new JsonRpcResponseReader();
  const parser = createJsonLineParser((message) => reader.handleMessage(message));
  socket.setEncoding('utf8');
  socket.on('data', parser);
  try {
    const result = await callJsonRpc(socket, reader, {
      jsonrpc: '2.0',
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params,
    });
    socket.end();
    return result;
  } finally {
    socket.end();
  }
}

export { listSessionMetas, loadSessionMeta, loadSessionState };
