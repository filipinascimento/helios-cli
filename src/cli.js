import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createJsonLineParser, JsonRpcResponseReader, callJsonRpc } from './protocol/jsonl.js';
import { ensureClientBundle, ensureStateDirs } from './shared/fs.js';
import { createSessionId } from './shared/sessionId.js';
import { listSessionMetas, loadSessionMeta, loadSessionState } from './shared/sessionRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const packageRoot = path.resolve(__dirname, '..');

function popFlag(args, name, { hasValue = false } = {}) {
  const index = args.findIndex((entry) => entry === name || entry.startsWith(`${name}=`));
  if (index === -1) return null;
  const current = args[index];
  args.splice(index, 1);
  if (!hasValue) return true;
  if (current.includes('=')) return current.slice(current.indexOf('=') + 1);
  const next = args[index];
  if (next == null) throw new Error(`Missing value for ${name}`);
  args.splice(index, 1);
  return next;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  return JSON.parse(value);
}

async function readPackageVersion(packageName) {
  try {
    let currentDir = path.dirname(require.resolve(packageName));
    while (currentDir && currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      try {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
        if (packageJson.name === packageName) return packageJson.version ?? null;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      currentDir = path.dirname(currentDir);
    }
    const packageJson = JSON.parse(await fs.readFile(require.resolve(`${packageName}/package.json`), 'utf8'));
    return packageJson.version ?? null;
  } catch (_) {
    try {
      const packageJson = JSON.parse(
        await fs.readFile(path.join(packageRoot, 'node_modules', packageName, 'package.json'), 'utf8'),
      );
      return packageJson.version ?? null;
    } catch {
      return null;
    }
  }
}

async function showVersion() {
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const versions = {
    cli: packageJson.version ?? null,
    'helios-network': await readPackageVersion('helios-network'),
    'helios-web-next': await readPackageVersion('helios-web-next'),
  };
  process.stdout.write(`${JSON.stringify(versions, null, 2)}\n`);
}

export function parseStartArgs(inputArgs) {
  const args = [...inputArgs];
  return {
    mode: popFlag(args, '--mode', { hasValue: true }) ?? 'headed',
    open: popFlag(args, '--open') === true,
    renderer: popFlag(args, '--renderer', { hasValue: true }) ?? 'webgpu',
    layout: popFlag(args, '--layout', { hasValue: true }) ?? 'gpu-force',
    networkPath: popFlag(args, '--network', { hasValue: true }) ?? null,
    noGpu: popFlag(args, '--no-gpu') === true,
    remaining: args,
  };
}

async function waitForSessionMeta(sessionId, { timeoutMs = 30_000, requireBridge = false } = {}) {
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

async function openRpcSocket(sessionId) {
  const meta = await loadSessionMeta(sessionId);
  if (!meta) throw new Error(`Unknown session ${sessionId}`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(meta.controlSocket, () => resolve({ socket, meta }));
    socket.on('error', reject);
  });
}

async function rpcCall(sessionId, method, params = {}) {
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

async function startSession(argv) {
  await ensureStateDirs();
  await ensureClientBundle();
  const options = parseStartArgs(argv);
  const sessionId = createSessionId();
  const config = {
    sessionId,
    mode: options.mode,
    open: options.open,
    renderer: options.renderer,
    layout: options.layout,
    networkPath: options.networkPath ? path.resolve(options.networkPath) : null,
    noGpu: options.noGpu,
  };
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon', 'entry.js'), encoded], {
    cwd: path.resolve(__dirname, '..'),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const meta = await waitForSessionMeta(sessionId, {
    requireBridge: options.mode !== 'server',
  });
  process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
}

async function listSessions() {
  const sessions = await listSessionMetas();
  process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
}

async function sessionInfo(sessionId) {
  const meta = await loadSessionMeta(sessionId);
  if (!meta) throw new Error(`Unknown session ${sessionId}`);
  process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
}

async function sessionState(sessionId) {
  if (!sessionId) throw new Error('Usage: helios session state <sessionId>');
  const state = await loadSessionState(sessionId);
  if (!state) throw new Error(`No saved session state for ${sessionId}`);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

async function stopSession(sessionId) {
  const result = await rpcCall(sessionId, 'session.stop', {});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function callMethod(argv) {
  const [sessionId, method, ...rest] = argv;
  if (!sessionId || !method) {
    throw new Error('Usage: helios call <sessionId> <method> [--json <payload>]');
  }
  const json = popFlag(rest, '--json', { hasValue: true });
  const result = await rpcCall(sessionId, method, parseJson(json, {}));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function attachSession(argv) {
  const [sessionId, ...rest] = argv;
  if (!sessionId) throw new Error('Usage: helios session attach <sessionId> --stdio');
  const stdio = popFlag(rest, '--stdio');
  if (!stdio) throw new Error('Only --stdio attach is supported');
  const { socket } = await openRpcSocket(sessionId);
  process.stdin.setEncoding('utf8');
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise((resolve, reject) => {
    socket.on('close', resolve);
    socket.on('error', reject);
  });
}

async function streamEvents(argv) {
  const [sessionId] = argv;
  if (!sessionId) throw new Error('Usage: helios events <sessionId>');
  const { socket } = await openRpcSocket(sessionId);
  const reader = new JsonRpcResponseReader();
  const parser = createJsonLineParser((message) => {
    reader.handleMessage(message);
  });
  socket.setEncoding('utf8');
  socket.on('data', parser);
  reader.onNotification((message) => {
    if (message?.method === 'events.notification') {
      process.stdout.write(`${JSON.stringify(message.params)}\n`);
    }
  });
  await callJsonRpc(socket, reader, {
    jsonrpc: '2.0',
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method: 'events.subscribe',
    params: {},
  });
  await new Promise((resolve, reject) => {
    socket.on('close', resolve);
    socket.on('error', reject);
  });
}

export async function runCli(argv) {
  const [command, subcommand, ...rest] = argv;
  if (command === '--version' || command === '-v' || command === 'version') return showVersion();
  if (command === 'session' && subcommand === 'start') return startSession(rest);
  if (command === 'session' && subcommand === 'list') return listSessions();
  if (command === 'session' && subcommand === 'info') return sessionInfo(rest[0]);
  if (command === 'session' && subcommand === 'state') return sessionState(rest[0]);
  if (command === 'session' && subcommand === 'stop') return stopSession(rest[0]);
  if (command === 'session' && subcommand === 'attach') return attachSession(rest);
  if (command === 'call') return callMethod([subcommand, ...rest]);
  if (command === 'events') return streamEvents([subcommand, ...rest]);
  throw new Error(
    'Usage:\n'
    + '  helios version\n'
    + '  helios session start [--mode headed|headless|server] [--open] [--renderer auto|webgl|webgpu] [--layout <name>] [--network <path>] [--no-gpu]\n'
    + '  helios session list\n'
    + '  helios session info <sessionId>\n'
    + '  helios session state <sessionId>\n'
    + '  helios session stop <sessionId>\n'
    + '  helios session attach <sessionId> --stdio\n'
    + '  helios call <sessionId> <method> [--json <payload>]\n'
    + '  helios events <sessionId>\n',
  );
}
