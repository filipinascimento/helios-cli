import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureStateDirs, readJsonFile, writeJsonFile } from './fs.js';
import {
  sessionIndexPath,
  sessionNetworksDir,
  sessionPositionsDir,
  sessionRecordsDir,
  unfinishedSessionsPath,
} from './paths.js';

function filenameForId(id, extension = '.json') {
  return `${Buffer.from(String(id), 'utf8').toString('base64url')}${extension}`;
}

function recordPath(id) {
  return path.join(sessionRecordsDir, filenameForId(id));
}

function sidecarPath(directory, sessionId, extension) {
  return path.join(directory, filenameForId(sessionId, extension));
}

function asUint8Array(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value.__heliosBinary === 'base64') return new Uint8Array(Buffer.from(String(value.data ?? ''), 'base64'));
  return null;
}

export function encodeBinaryForJson(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => encodeBinaryForJson(entry));
  const bytes = asUint8Array(value);
  if (bytes) {
    return {
      __heliosBinary: 'base64',
      type: value.constructor?.name ?? 'Uint8Array',
      byteLength: bytes.byteLength,
      data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    };
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = encodeBinaryForJson(entry);
  return output;
}

export function decodeBinaryFromJson(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Buffer.isBuffer(value)) return value;
  if (value.__heliosBinary === 'base64') {
    return new Uint8Array(Buffer.from(String(value.data ?? ''), 'base64'));
  }
  if (Array.isArray(value)) return value.map((entry) => decodeBinaryFromJson(entry));
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = decodeBinaryFromJson(entry);
  return output;
}

function networkExtension(format) {
  const normalized = String(format ?? 'zxnet').trim().toLowerCase().replace(/^\./, '');
  if (normalized === 'bxnet') return '.bxnet';
  if (normalized === 'xnet') return '.xnet';
  return '.zxnet';
}

async function readIndex() {
  const parsed = await readJsonFile(sessionIndexPath, []);
  return Array.isArray(parsed) ? parsed.map((id) => String(id)).filter(Boolean) : [];
}

async function writeIndex(ids) {
  await writeJsonFile(sessionIndexPath, Array.from(new Set(ids.map((id) => String(id)).filter(Boolean))));
}

async function addToIndex(id) {
  if (!id) return;
  const ids = await readIndex();
  if (!ids.includes(String(id))) await writeIndex([...ids, String(id)]);
}

async function removeFromIndex(id) {
  if (!id) return;
  const target = String(id);
  await writeIndex((await readIndex()).filter((entry) => entry !== target));
}

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function sidecarMetadata(record, dataFile, byteLength) {
  const { data, ...metadata } = record;
  return {
    ...metadata,
    data: null,
    dataFile,
    byteLength: Number.isFinite(Number(record.byteLength)) ? Number(record.byteLength) : byteLength,
    updatedAt: record.updatedAt ?? Date.now(),
  };
}

export class FileSessionStore {
  async putSession(record) {
    await ensureStateDirs();
    const decoded = decodeBinaryFromJson(record);
    const id = decoded?.id;
    if (!id) throw new Error('Session record requires an id');

    if (decoded.kind === 'session-network-data') {
      const bytes = asUint8Array(decoded.data);
      if (!bytes) throw new Error(`Network side record ${id} is missing binary data`);
      const filePath = sidecarPath(sessionNetworksDir, decoded.sessionId ?? id, networkExtension(decoded.format));
      await fs.writeFile(filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const metadata = sidecarMetadata(decoded, filePath, bytes.byteLength);
      await writeJsonFile(recordPath(id), encodeBinaryForJson(metadata));
      return encodeBinaryForJson(metadata);
    }

    if (decoded.kind === 'session-position-data') {
      const bytes = asUint8Array(decoded.data);
      if (!bytes) throw new Error(`Position side record ${id} is missing binary data`);
      const filePath = sidecarPath(sessionPositionsDir, decoded.sessionId ?? id, '.positions.bin');
      await fs.writeFile(filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const metadata = sidecarMetadata(decoded, filePath, bytes.byteLength);
      await writeJsonFile(recordPath(id), encodeBinaryForJson(metadata));
      return encodeBinaryForJson(metadata);
    }

    await writeJsonFile(recordPath(id), encodeBinaryForJson(decoded));
    await addToIndex(id);
    return encodeBinaryForJson(decoded);
  }

  async getSession(id) {
    await ensureStateDirs();
    const record = decodeBinaryFromJson(await readJsonFile(recordPath(id), null));
    if (!record) return null;
    if ((record.kind === 'session-network-data' || record.kind === 'session-position-data') && record.dataFile) {
      try {
        const bytes = await fs.readFile(record.dataFile);
        record.data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        record.byteLength = record.byteLength ?? bytes.byteLength;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        record.data = null;
      }
    }
    return encodeBinaryForJson(record);
  }

  async listSessions() {
    await ensureStateDirs();
    const records = [];
    for (const id of await readIndex()) {
      const record = await this.getSession(id);
      if (record) records.push(record);
    }
    return records;
  }

  async deleteSession(id) {
    await ensureStateDirs();
    const session = decodeBinaryFromJson(await readJsonFile(recordPath(id), null));
    const networkId = session?.payload?.networkData?.dataRef ?? `${id}::network-data`;
    const positionId = session?.payload?.positionData?.dataRef ?? `${id}::position-data`;
    const network = decodeBinaryFromJson(await readJsonFile(recordPath(networkId), null));
    const position = decodeBinaryFromJson(await readJsonFile(recordPath(positionId), null));
    await Promise.all([
      unlinkIfExists(recordPath(id)),
      unlinkIfExists(recordPath(networkId)),
      unlinkIfExists(recordPath(positionId)),
      network?.dataFile ? unlinkIfExists(network.dataFile) : Promise.resolve(),
      position?.dataFile ? unlinkIfExists(position.dataFile) : Promise.resolve(),
    ]);
    await removeFromIndex(id);
    return true;
  }

  async getUnfinishedSessionId(workspaceId = null) {
    const records = await readJsonFile(unfinishedSessionsPath, {});
    const key = workspaceId == null || workspaceId === '' ? 'default' : String(workspaceId);
    return records?.[key] ?? null;
  }

  async setUnfinishedSessionId(id, workspaceId = null) {
    await ensureStateDirs();
    const records = await readJsonFile(unfinishedSessionsPath, {});
    const key = workspaceId == null || workspaceId === '' ? 'default' : String(workspaceId);
    if (id == null || id === '') delete records[key];
    else records[key] = String(id);
    await writeJsonFile(unfinishedSessionsPath, records);
    return id ?? null;
  }
}
