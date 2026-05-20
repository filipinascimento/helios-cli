import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const packageRoot = path.resolve(__dirname, '..', '..');
export const clientDistDir = path.join(packageRoot, 'dist', 'client');
export const stateRoot = path.join(os.homedir(), '.helios-cli');
export const sessionsDir = path.join(stateRoot, 'sessions');
export const sessionStateDir = path.join(stateRoot, 'session-state');
export const socketsDir = path.join(stateRoot, 'sockets');
export const logsDir = path.join(stateRoot, 'logs');

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
  return path.join(socketsDir, `${sessionId}.sock`);
}
