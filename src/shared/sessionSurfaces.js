import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { packageRoot } from './paths.js';

export const SESSION_SURFACES = new Set(['server', 'browser', 'managed', 'desktop', 'mac', 'auto']);
export const HELIOS_MAC_BUNDLE_IDS = ['org.heliosnetwork.HeliosMac', 'io.heliosweb.HeliosMac'];
export const HELIOS_DESKTOP_BUNDLE_IDS = ['org.heliosnetwork.Helios'];

export function normalizeSessionSurface(value) {
  if (value == null) return null;
  const surface = String(value).trim().toLowerCase();
  if (!SESSION_SURFACES.has(surface)) {
    throw new Error(`Unsupported session surface "${value}". Expected one of: ${Array.from(SESSION_SURFACES).join(', ')}`);
  }
  return surface;
}

export function isLocalSessionUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function buildMacSessionOpenURL(meta) {
  if (!meta?.sessionId) throw new Error('Cannot open Helios Mac session without a session id.');
  if (!isLocalSessionUrl(meta.url)) throw new Error('Cannot open Helios Mac session without a local session URL.');
  const url = new URL('helios-mac://session/open');
  url.searchParams.set('sessionId', meta.sessionId);
  url.searchParams.set('url', meta.url);
  return url.toString();
}

export function buildDesktopSessionOpenURL(meta) {
  if (!meta?.sessionId) throw new Error('Cannot open Helios Desktop session without a session id.');
  if (!isLocalSessionUrl(meta.url)) throw new Error('Cannot open Helios Desktop session without a local session URL.');
  const url = new URL('helios-desktop://session/open');
  url.searchParams.set('sessionId', meta.sessionId);
  url.searchParams.set('url', meta.url);
  return url.toString();
}

export async function appPathExists(appPath) {
  if (!appPath) return false;
  try {
    const stat = await fs.stat(appPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export async function macAppPathExists(appPath) {
  if (!appPath) return false;
  try {
    const stat = await fs.stat(appPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function runProbe(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function runDetached(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function findRegisteredMacBundleId(bundleIds = HELIOS_MAC_BUNDLE_IDS) {
  if (process.platform !== 'darwin') return null;
  for (const bundleId of bundleIds) {
    const query = `kMDItemCFBundleIdentifier == '${bundleId}'`;
    const found = await new Promise((resolve) => {
      const child = spawn('mdfind', [query], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0 && output.trim().length > 0));
    });
    if (found) return bundleId;
  }
  return null;
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await appPathExists(candidate)) return candidate;
  }
  return null;
}

export async function findDesktopAppPath() {
  const envPath = process.env.HELIOS_DESKTOP_APP_PATH;
  if (envPath && await appPathExists(envPath)) return envPath;

  const home = os.homedir();
  const repoRoot = path.resolve(packageRoot, '..');
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';

  if (process.platform === 'darwin') {
    const otherArch = arch === 'arm64' ? 'x64' : 'arm64';
    return firstExistingPath([
      path.join(home, 'Applications', 'Helios.app'),
      '/Applications/Helios.app',
      path.join(repoRoot, 'helios-desktop', 'dist', `osx-${arch}`, 'Helios.app'),
      path.join(repoRoot, 'helios-desktop', 'dist', `osx-${otherArch}`, 'Helios.app'),
    ]);
  }
  if (process.platform === 'win32') {
    return firstExistingPath([
      path.join(repoRoot, 'helios-desktop', 'dist', 'win-x64', 'Helios.exe'),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Helios', 'Helios.exe') : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Helios', 'Helios.exe') : null,
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Helios', 'Helios.exe') : null,
    ]);
  }
  return firstExistingPath([
    path.join(repoRoot, 'helios-desktop', 'dist', 'linux-x64', 'Helios'),
    '/usr/local/bin/Helios',
    '/usr/bin/Helios',
  ]);
}

export function desktopLaunchCommand(appPath, sessionURL) {
  if (!appPath) throw new Error('Cannot launch Helios Desktop without an app path.');
  if (process.platform === 'darwin' && /\.app$/iu.test(appPath)) {
    return {
      command: 'open',
      args: ['-n', '-a', appPath, '--args', '--helios-cli-session', sessionURL],
    };
  }
  return {
    command: appPath,
    args: ['--helios-cli-session', sessionURL],
  };
}

export async function launchDesktopSession(meta, { appPath = null } = {}) {
  if (!(await appPathExists(appPath))) {
    throw new Error(`Helios Desktop app was not found at ${appPath}`);
  }
  const sessionURL = buildDesktopSessionOpenURL(meta);
  const { command, args } = desktopLaunchCommand(appPath, sessionURL);
  const launched = command === 'open'
    ? await runProbe(command, args)
    : await runDetached(command, args);
  if (!launched) {
    throw new Error(`Unable to open Helios Desktop at ${appPath}. Check the path or run "helios config set desktop.appPath <path>".`);
  }
  return true;
}

export async function launchMacSession(meta, { appPath = null, bundleId = null } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Helios Mac sessions are only supported on macOS.');
  }
  const sessionURL = buildMacSessionOpenURL(meta);
  if (appPath) {
    if (!(await macAppPathExists(appPath))) {
      throw new Error(`Helios Mac app was not found at ${appPath}`);
    }
    return runProbe('open', ['-n', '-a', appPath, sessionURL]);
  }

  const resolvedBundleId = bundleId ?? await findRegisteredMacBundleId();
  if (!resolvedBundleId) {
    throw new Error('HeliosWeb is not registered. Build or install HeliosWeb.app, or pass --app-path /path/to/HeliosWeb.app.');
  }
  const opened = await runProbe('open', ['-b', resolvedBundleId, sessionURL]);
  if (!opened) {
    throw new Error(`Unable to open HeliosWeb using bundle id ${resolvedBundleId}. Pass --app-path /path/to/HeliosWeb.app for a development build.`);
  }
  return true;
}
