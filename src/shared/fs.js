import fs from 'node:fs/promises';
import {
  clientDistDir,
  logsDir,
  sessionNetworksDir,
  sessionPositionsDir,
  sessionRecordsDir,
  sessionsDir,
  sessionStateDir,
  socketsDir,
  stateRoot,
  storageSessionsDir,
} from './paths.js';

export async function ensureStateDirs() {
  await Promise.all([
    fs.mkdir(stateRoot, { recursive: true }),
    fs.mkdir(sessionsDir, { recursive: true }),
    fs.mkdir(sessionStateDir, { recursive: true }),
    fs.mkdir(socketsDir, { recursive: true }),
    fs.mkdir(logsDir, { recursive: true }),
    fs.mkdir(storageSessionsDir, { recursive: true }),
    fs.mkdir(sessionRecordsDir, { recursive: true }),
    fs.mkdir(sessionNetworksDir, { recursive: true }),
    fs.mkdir(sessionPositionsDir, { recursive: true }),
  ]);
}

export async function ensureClientBundle() {
  try {
    const stat = await fs.stat(clientDistDir);
    if (!stat.isDirectory()) {
      throw new Error(`Client bundle path is not a directory: ${clientDistDir}`);
    }
  } catch (error) {
    throw new Error(
      `Missing built client bundle at ${clientDistDir}. Run "npm run build-client" in helios-cli before starting sessions.`,
      { cause: error },
    );
  }
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    if (text.trim() === '') return fallback;
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export async function writeJsonFile(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
}
