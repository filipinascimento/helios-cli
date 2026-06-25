import fs from 'node:fs/promises';
import path from 'node:path';
import HeliosNetwork, { AttributeType } from 'helios-network';
import { inferNetworkFormat } from './networkFormats.js';

const ATTRIBUTE_TYPE_NAMES = new Map(
  Object.entries(AttributeType).map(([name, value]) => [value, name]),
);

function attributeTypeName(type) {
  return ATTRIBUTE_TYPE_NAMES.get(type) ?? `Unknown(${type})`;
}

function serializeAttributeInfo(name, info) {
  const type = info?.type ?? AttributeType.Unknown;
  return {
    name,
    type,
    typeName: attributeTypeName(type),
    dimension: Number(info?.dimension ?? 1),
    complex: info?.complex === true,
    categorical: type === AttributeType.Category || type === AttributeType.MultiCategory,
    stringLike: type === AttributeType.String,
  };
}

function inspectAttributes(network, scope) {
  const namesMethod = `get${scope}AttributeNames`;
  const infoMethod = `get${scope}AttributeInfo`;
  const names = typeof network?.[namesMethod] === 'function' ? network[namesMethod]() : [];
  return names.map((name) => serializeAttributeInfo(name, network?.[infoMethod]?.(name)));
}

async function loadNetwork(bytes, format, options = {}) {
  if (format === 'bxnet') return HeliosNetwork.fromBXNet(bytes, options);
  if (format === 'zxnet') return HeliosNetwork.fromZXNet(bytes, options);
  if (format === 'xnet') return HeliosNetwork.fromXNet(bytes, options);
  if (format === 'gt') return HeliosNetwork.fromGT(bytes, options);
  throw new Error(`Unsupported Helios network format "${format}"`);
}

export async function inspectNetworkFile(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const format = options.format ?? inferNetworkFormat(resolvedPath, null);
  if (!format) throw new Error(`Cannot infer Helios network format from "${filePath}"`);

  const warnings = [];
  const originalWarn = console.warn;
  let network = null;
  try {
    const stat = await fs.stat(resolvedPath);
    const bytes = await fs.readFile(resolvedPath);
    console.warn = (...args) => {
      const message = args.map((entry) => String(entry)).join(' ');
      if (message.includes('[Helios serialization]')) warnings.push(message);
      else originalWarn(...args);
    };
    network = await loadNetwork(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), format, options.loadOptions ?? {});
    return {
      kind: 'helios-network-inspection',
      version: 1,
      path: resolvedPath,
      name: path.basename(resolvedPath),
      format,
      fileSize: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      nodeCount: network.nodeCount ?? 0,
      edgeCount: network.edgeCount ?? 0,
      directed: Boolean(network.directed),
      attributes: {
        node: inspectAttributes(network, 'Node'),
        edge: inspectAttributes(network, 'Edge'),
        network: inspectAttributes(network, 'Network'),
      },
      warnings,
    };
  } finally {
    console.warn = originalWarn;
    network?.dispose?.();
  }
}
