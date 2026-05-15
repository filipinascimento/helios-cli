import fs from 'node:fs/promises';
import { clientDistDir, logsDir, sessionsDir, socketsDir, stateRoot } from './paths.js';

export async function ensureStateDirs() {
  await Promise.all([
    fs.mkdir(stateRoot, { recursive: true }),
    fs.mkdir(sessionsDir, { recursive: true }),
    fs.mkdir(socketsDir, { recursive: true }),
    fs.mkdir(logsDir, { recursive: true }),
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
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
