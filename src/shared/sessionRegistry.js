import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureStateDirs, readJsonFile, writeJsonFile } from './fs.js';
import { sessionMetaPath, sessionsDir } from './paths.js';

export async function loadSessionMeta(sessionId) {
  return readJsonFile(sessionMetaPath(sessionId), null);
}

export async function saveSessionMeta(sessionId, value) {
  await ensureStateDirs();
  await writeJsonFile(sessionMetaPath(sessionId), value);
  return value;
}

export async function deleteSessionMeta(sessionId) {
  try {
    await fs.unlink(sessionMetaPath(sessionId));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function listSessionMetas() {
  await ensureStateDirs();
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const metas = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== '.json') continue;
    const meta = await readJsonFile(path.join(sessionsDir, entry.name), null);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => String(a.sessionId ?? '').localeCompare(String(b.sessionId ?? '')));
  return metas;
}
