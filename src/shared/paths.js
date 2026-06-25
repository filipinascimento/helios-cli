import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const packageRoot = path.resolve(__dirname, '..', '..');
export const clientDistDir = path.join(packageRoot, 'dist', 'client');
export const stateRoot = path.resolve(
  process.env.HELIOS_CLI_STORAGE_DIR
    ?? process.env.HELIOS_HOME
    ?? path.join(os.homedir(), '.helios'),
);
export const runtimeDir = path.join(stateRoot, 'runtime');
export const sessionsDir = path.join(runtimeDir, 'sessions');
export const sessionStateDir = path.join(runtimeDir, 'session-state');
export const socketsDir = path.join(runtimeDir, 'sockets');
export const logsDir = path.join(runtimeDir, 'logs');
export const storageSessionsDir = path.join(stateRoot, 'sessions');
export const sessionRecordsDir = path.join(storageSessionsDir, 'records');
export const sessionNetworksDir = path.join(storageSessionsDir, 'networks');
export const sessionPositionsDir = path.join(storageSessionsDir, 'positions');
export const sessionIndexPath = path.join(storageSessionsDir, 'index.json');
export const unfinishedSessionsPath = path.join(storageSessionsDir, 'unfinished.json');
export const cliConfigPath = path.join(stateRoot, 'config.json');

export function sessionMetaPath(sessionId) {
  return path.join(sessionsDir, `${sessionId}.json`);
}

export function sessionStatePath(sessionId) {
  return path.join(sessionStateDir, `${sessionId}.json`);
}

export function sessionSocketPath(sessionId) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\helios-cli-${sessionId}`;
  }
  const candidate = path.join(socketsDir, `${sessionId}.sock`);
  if (Buffer.byteLength(candidate, 'utf8') < 100) return candidate;
  return path.join(os.tmpdir(), 'helios-cli-sockets', `${sessionId}.sock`);
}
