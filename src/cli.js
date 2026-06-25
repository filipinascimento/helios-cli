import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createJsonLineParser, JsonRpcResponseReader, callJsonRpc } from './protocol/jsonl.js';
import { inspectNetworkFile } from './shared/networkInspect.js';
import { inferNetworkFormat } from './shared/networkFormats.js';
import { packageRoot } from './shared/paths.js';
import {
  cliConfigPath,
  getConfiguredDesktopAppPath,
  loadCliConfig,
  setConfiguredDesktopAppPath,
} from './shared/cliConfig.js';
import {
  appPathExists,
  findDesktopAppPath,
  findRegisteredMacBundleId,
  HELIOS_MAC_BUNDLE_IDS,
  launchDesktopSession,
  launchMacSession,
  macAppPathExists,
  normalizeSessionSurface,
} from './shared/sessionSurfaces.js';
import {
  listSessionMetas,
  loadSessionMeta,
  loadSessionState,
  openRpcSocket,
  rpcCall,
  startSession as startManagedSession,
} from './shared/sessionClient.js';

const require = createRequire(import.meta.url);

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

const PLAYWRIGHT_BROWSER_TARGETS = new Set([
  'chromium',
  'chrome',
  'chrome-beta',
  'msedge',
  'msedge-beta',
  'msedge-dev',
  'firefox',
  'webkit',
]);

export function parseBrowserInstallArgs(inputArgs) {
  const args = [...inputArgs];
  const withDeps = popFlag(args, '--with-deps') === true;
  const browsers = args.length > 0 ? args : ['chromium'];
  for (const browser of browsers) {
    if (!PLAYWRIGHT_BROWSER_TARGETS.has(browser)) {
      throw new Error(`Unsupported browser "${browser}". Expected one of: ${Array.from(PLAYWRIGHT_BROWSER_TARGETS).join(', ')}`);
    }
  }
  return { browsers, withDeps };
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

async function installBrowser(argv) {
  const options = parseBrowserInstallArgs(argv);
  const playwrightRoot = path.dirname(require.resolve('playwright/package.json'));
  const playwrightCli = path.join(playwrightRoot, 'cli.js');
  const installArgs = [
    playwrightCli,
    'install',
    ...(options.withDeps ? ['--with-deps'] : []),
    ...options.browsers,
  ];
  const child = spawn(process.execPath, installArgs, {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`Playwright browser install failed with exit code ${exitCode}`);
  }
}

export function parseStartArgs(inputArgs) {
  const args = [...inputArgs];
  const browserChannel = popFlag(args, '--browser-channel', { hasValue: true });
  const storageDir = popFlag(args, '--storage-dir', { hasValue: true });
  const mode = popFlag(args, '--mode', { hasValue: true });
  const surface = normalizeSessionSurface(popFlag(args, '--surface', { hasValue: true }));
  const appPath = popFlag(args, '--app-path', { hasValue: true });
  const openFlag = popFlag(args, '--open') === true;
  const noOpen = popFlag(args, '--no-open') === true;
  const resolvedMode = surface === 'managed'
    ? (mode ?? 'headed')
    : (surface == null ? (mode ?? 'server') : 'server');
  const resolvedOpen = noOpen
    ? false
    : (surface === 'server' || surface === 'managed' || surface === 'mac' || surface === 'desktop')
      ? false
      : (surface === 'browser' ? true : (openFlag || mode == null));
  return {
    mode: resolvedMode,
    open: resolvedOpen,
    surface,
    appPath: appPath == null ? null : path.resolve(String(appPath)),
    renderer: popFlag(args, '--renderer', { hasValue: true }) ?? 'webgpu',
    layout: popFlag(args, '--layout', { hasValue: true }) ?? 'gpu-force',
    browserChannel: browserChannel == null ? null : (String(browserChannel).trim() || null),
    storageDir: storageDir == null ? null : path.resolve(String(storageDir)),
    networkPath: popFlag(args, '--network', { hasValue: true }) ?? null,
    noGpu: popFlag(args, '--no-gpu') === true,
    remaining: args,
  };
}

export async function resolveStartSurface(options) {
  if (options.surface !== 'auto') return options.surface;
  if (process.platform === 'darwin' && (options.appPath || await findRegisteredMacBundleId())) return 'mac';
  const configuredDesktopPath = await getConfiguredDesktopAppPath();
  if (configuredDesktopPath && await appPathExists(configuredDesktopPath)) return 'desktop';
  if (await findDesktopAppPath()) return 'desktop';
  return 'browser';
}

async function resolveDesktopAppPath(options) {
  if (options.appPath) {
    if (!(await appPathExists(options.appPath))) {
      throw new Error(`Helios Desktop app was not found at ${options.appPath}`);
    }
    return setConfiguredDesktopAppPath(options.appPath);
  }
  const configuredPath = await getConfiguredDesktopAppPath();
  if (configuredPath) {
    if (await appPathExists(configuredPath)) return configuredPath;
    throw new Error(`Configured Helios Desktop app path does not exist: ${configuredPath}. Pass --app-path <path-to-Helios-Desktop> once, or run "helios config set desktop.appPath <path>".`);
  }
  const discoveredPath = await findDesktopAppPath();
  if (discoveredPath) return setConfiguredDesktopAppPath(discoveredPath);
  throw new Error('Helios Desktop could not be located. Pass --app-path <path-to-Helios-Desktop> once, or run "helios config set desktop.appPath <path>". The path will be saved in the helios-cli config file.');
}

async function startSession(argv) {
  const options = parseStartArgs(argv);
  const surface = await resolveStartSurface(options);
  let macBundleId = null;
  let desktopAppPath = null;
  if (surface === 'mac') {
    if (process.platform !== 'darwin') {
      throw new Error('Helios Mac sessions are only supported on macOS.');
    }
    if (options.appPath) {
      if (!(await macAppPathExists(options.appPath))) {
        throw new Error(`Helios Mac app was not found at ${options.appPath}`);
      }
    } else {
      macBundleId = await findRegisteredMacBundleId();
      if (!macBundleId) {
        throw new Error('HeliosWeb is not registered. Build or install HeliosWeb.app, or pass --app-path /path/to/HeliosWeb.app.');
      }
    }
  } else if (surface === 'desktop') {
    desktopAppPath = await resolveDesktopAppPath(options);
  }
  const runtime = surface === 'mac' ? 'mac' : (surface === 'desktop' ? 'desktop' : 'cli');
  const client = surface === 'mac'
    ? {
      kind: 'helios-mac',
      bundleId: macBundleId ?? HELIOS_MAC_BUNDLE_IDS[0],
      appPath: options.appPath,
    }
    : (surface === 'desktop'
      ? {
        kind: 'helios-desktop',
        appPath: desktopAppPath,
      }
      : null);
  const meta = await startManagedSession({
    mode: options.mode,
    open: surface === 'browser' ? true : options.open,
    renderer: options.renderer,
    layout: options.layout,
    runtime,
    surface,
    client,
    browserChannel: options.browserChannel,
    storageDir: options.storageDir,
    networkPath: options.networkPath ? path.resolve(options.networkPath) : null,
    noGpu: options.noGpu,
    requireBridge: surface === 'mac' || surface === 'desktop' ? false : undefined,
  });
  if (surface === 'mac') await launchMacSession(meta, { appPath: options.appPath, bundleId: macBundleId });
  if (surface === 'desktop') await launchDesktopSession(meta, { appPath: desktopAppPath });
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

async function stateGet(argv) {
  const [sessionId, pathArg] = argv;
  if (!sessionId) throw new Error('Usage: helios state get <sessionId> [path]');
  const result = await rpcCall(sessionId, 'state.get', pathArg ? { path: pathArg } : {});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function stateSet(argv) {
  const [sessionId, pathArg, rawValue, ...rest] = argv;
  if (!sessionId || !pathArg || rawValue == null) {
    throw new Error('Usage: helios state set <sessionId> <path> <json-value> [--scope user|workspace|network|session]');
  }
  const scope = popFlag(rest, '--scope', { hasValue: true });
  const reason = popFlag(rest, '--reason', { hasValue: true }) ?? 'cli-state-set';
  const value = JSON.parse(rawValue);
  const result = await rpcCall(sessionId, 'state.set', {
    path: pathArg,
    value,
    scope: scope ?? undefined,
    reason,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function stateReset(argv) {
  const [sessionId, pathArg, ...rest] = argv;
  if (!sessionId || !pathArg) throw new Error('Usage: helios state reset <sessionId> <path>');
  const reason = popFlag(rest, '--reason', { hasValue: true }) ?? 'cli-state-reset';
  const result = await rpcCall(sessionId, 'state.reset', { path: pathArg, reason });
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

export function parseInspectArgs(inputArgs) {
  const args = [...inputArgs];
  const json = popFlag(args, '--json') === true;
  const format = popFlag(args, '--format', { hasValue: true });
  const [filePath, ...remaining] = args;
  if (!filePath || remaining.length > 0) {
    throw new Error('Usage: helios inspect <network-path> [--json] [--format bxnet|zxnet|xnet|gt]');
  }
  const normalizedFormat = format == null ? null : String(format).trim().toLowerCase();
  if (normalizedFormat && !['bxnet', 'zxnet', 'xnet', 'gt'].includes(normalizedFormat)) {
    throw new Error(`Unsupported inspect format "${format}"`);
  }
  return { filePath, json, format: normalizedFormat };
}

function renderInspectionSummary(inspection) {
  const lines = [
    `${inspection.name} (${inspection.format})`,
    `Path: ${inspection.path}`,
    `Nodes: ${inspection.nodeCount}`,
    `Edges: ${inspection.edgeCount}`,
    `Directed: ${inspection.directed ? 'yes' : 'no'}`,
    `File size: ${inspection.fileSize} bytes`,
    `Node attributes: ${inspection.attributes.node.map((entry) => `${entry.name}:${entry.typeName}[${entry.dimension}]`).join(', ') || 'none'}`,
    `Edge attributes: ${inspection.attributes.edge.map((entry) => `${entry.name}:${entry.typeName}[${entry.dimension}]`).join(', ') || 'none'}`,
    `Network attributes: ${inspection.attributes.network.map((entry) => `${entry.name}:${entry.typeName}[${entry.dimension}]`).join(', ') || 'none'}`,
  ];
  if (inspection.warnings.length > 0) lines.push(`Warnings: ${inspection.warnings.join(' | ')}`);
  return `${lines.join('\n')}\n`;
}

async function inspectNetwork(argv) {
  const options = parseInspectArgs(argv);
  const inspection = await inspectNetworkFile(options.filePath, {
    format: options.format ?? inferNetworkFormat(options.filePath, null),
  });
  process.stdout.write(options.json ? `${JSON.stringify(inspection, null, 2)}\n` : renderInspectionSummary(inspection));
}

export function parseDesktopOpenArgs(inputArgs) {
  const args = [...inputArgs];
  const app = popFlag(args, '--app', { hasValue: true });
  const [filePath, ...remaining] = args;
  if (!filePath || remaining.length > 0) {
    throw new Error('Usage: helios desktop open <network-path> [--app <app-name-or-path>]');
  }
  return { filePath: path.resolve(filePath), app: app == null ? null : String(app).trim() || null };
}

async function spawnAndWait(command, args) {
  const child = spawn(command, args, { stdio: 'ignore', detached: false });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) throw new Error(`${command} failed with exit code ${exitCode}`);
}

async function openDesktop(argv) {
  const options = parseDesktopOpenArgs(argv);
  if (process.platform === 'darwin') {
    const args = options.app ? ['-a', options.app, options.filePath] : [options.filePath];
    await spawnAndWait('open', args);
  } else if (process.platform === 'win32') {
    await spawnAndWait('cmd', ['/c', 'start', '', options.filePath]);
  } else {
    await spawnAndWait('xdg-open', [options.filePath]);
  }
  process.stdout.write(`${JSON.stringify({ opened: true, path: options.filePath, app: options.app }, null, 2)}\n`);
}

async function showConfig(argv) {
  if (argv.length > 0) throw new Error('Usage: helios config get');
  const config = await loadCliConfig();
  process.stdout.write(`${JSON.stringify({ path: cliConfigPath, config }, null, 2)}\n`);
}

async function setConfig(argv) {
  const [key, value, ...remaining] = argv;
  if (!key || value == null || remaining.length > 0) {
    throw new Error('Usage: helios config set desktop.appPath <path>');
  }
  if (key !== 'desktop.appPath') {
    throw new Error(`Unsupported config key "${key}". Supported keys: desktop.appPath`);
  }
  const resolvedPath = path.resolve(value);
  if (!(await appPathExists(resolvedPath))) {
    throw new Error(`Helios Desktop app was not found at ${resolvedPath}`);
  }
  const appPath = await setConfiguredDesktopAppPath(resolvedPath);
  process.stdout.write(`${JSON.stringify({ path: cliConfigPath, key, value: appPath }, null, 2)}\n`);
}

export async function runCli(argv) {
  const [command, subcommand, ...rest] = argv;
  if (command === '--version' || command === '-v' || command === 'version') return showVersion();
  if (command === 'browser' && subcommand === 'install') return installBrowser(rest);
  if (command === 'config' && subcommand === 'get') return showConfig(rest);
  if (command === 'config' && subcommand === 'set') return setConfig(rest);
  if (command === 'inspect') return inspectNetwork([subcommand, ...rest].filter((entry) => entry != null));
  if (command === 'desktop' && subcommand === 'open') return openDesktop(rest);
  if (command === 'session' && subcommand === 'start') return startSession(rest);
  if (command === 'session' && subcommand === 'list') return listSessions();
  if (command === 'session' && subcommand === 'info') return sessionInfo(rest[0]);
  if (command === 'session' && subcommand === 'state') return sessionState(rest[0]);
  if (command === 'session' && subcommand === 'stop') return stopSession(rest[0]);
  if (command === 'session' && subcommand === 'attach') return attachSession(rest);
  if (command === 'state' && subcommand === 'get') return stateGet(rest);
  if (command === 'state' && subcommand === 'set') return stateSet(rest);
  if (command === 'state' && subcommand === 'reset') return stateReset(rest);
  if (command === 'call') return callMethod([subcommand, ...rest]);
  if (command === 'events') return streamEvents([subcommand, ...rest]);
  throw new Error(
    'Usage:\n'
    + '  helios version\n'
    + '  helios browser install [chromium|chrome|firefox|webkit] [--with-deps]\n'
    + '  helios config get\n'
    + '  helios config set desktop.appPath <path>\n'
    + '  helios inspect <network-path> [--json] [--format bxnet|zxnet|xnet|gt]\n'
    + '  helios desktop open <network-path> [--app <app-name-or-path>]\n'
    + '  helios session start [--surface server|browser|managed|desktop|mac|auto] [--app-path <Helios.app|HeliosWeb.app>] [--mode headed|headless|server] [--open|--no-open] [--renderer auto|webgl|webgpu] [--layout <name>] [--browser-channel <channel>] [--storage-dir <path>] [--network <path>] [--no-gpu]\n'
    + '  helios session list\n'
    + '  helios session info <sessionId>\n'
    + '  helios session state <sessionId>\n'
    + '  helios session stop <sessionId>\n'
    + '  helios state get <sessionId> [path]\n'
    + '  helios state set <sessionId> <path> <json-value> [--scope user|workspace|network|session]\n'
    + '  helios state reset <sessionId> <path>\n'
    + '  helios session attach <sessionId> --stdio\n'
    + '  helios call <sessionId> <method> [--json <payload>]\n'
    + '  helios events <sessionId>\n',
  );
}
