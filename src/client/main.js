import HeliosNetwork, { AttributeType } from 'helios-network';
import { Helios, HeliosUI, EVENTS, Mapper } from 'helios-web-next';

function wsUrlForCurrentLocation() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/bridge`;
}

function publishRuntimeState(helios) {
  window.__HELIOS_CLI_RUNTIME__ = {
    renderer: helios.renderer?.device?.type ?? null,
    mode: helios.mode(),
    ready: true,
  };
}

function installHoverInteractions(helios) {
  helios
    .resetStateStyles()
    .nodeStateStyle('HIGHLIGHTED', {
      sizeMul: 1.15,
      opacityMul: 1.0,
      outlineMul: 1.2,
      colorAdd: [0.0, 0.25, 0.25, 0.0],
    });

  let highlightedNode = null;
  helios.on(EVENTS.NODE_HOVER, (event) => {
    const detail = event?.detail;
    if (!detail) return;
    if (detail.state === 'in' && Number.isInteger(detail.index) && detail.index >= 0) {
      highlightedNode = detail.index;
      helios.hoverNodeState(detail.index, 'HIGHLIGHTED');
      return;
    }
    if (detail.state === 'out' && highlightedNode === detail.index) {
      highlightedNode = null;
      helios.hoverNodeState(null, 0);
    }
  });
}

function normalizeLayoutKey(value, fallback = 'gpu-force') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'static' || normalized === 'none') return 'static';
  if (normalized === 'd3force3d' || normalized === 'd3-force-3d') return 'd3force3d';
  if (normalized === 'worker:jitter' || normalized === 'jitter') return 'worker:jitter';
  if (normalized === 'worker:force3d' || normalized === 'worker' || normalized === 'force3d') return 'worker:force3d';
  return 'gpu-force';
}

function resolveRendererPreference(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'webgl' || normalized === 'webgpu') return normalized;
  return null;
}

function cloneJsonSafe(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (value instanceof Set) return Array.from(value).map((entry) => cloneJsonSafe(entry));
  if (value instanceof Map) {
    const out = {};
    for (const [key, entry] of value.entries()) out[key] = cloneJsonSafe(entry);
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((entry) => cloneJsonSafe(entry));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'function') continue;
    if (key.startsWith('__')) continue;
    out[key] = cloneJsonSafe(entry);
  }
  return out;
}

function serializeChannelConfig(config) {
  return cloneJsonSafe(config ?? null);
}

function serializeMapperCollection(collection) {
  const mapper = collection?.defaultMapper ?? null;
  const channels = {};
  if (!mapper?.channels) return channels;
  for (const [name, config] of mapper.channels.entries()) {
    channels[name] = serializeChannelConfig(config);
  }
  return channels;
}

function serializeLayoutBinding(binding) {
  return {
    key: binding?.key ?? null,
    label: binding?.label ?? null,
    type: binding?.type ?? null,
    value: typeof binding?.get === 'function' ? cloneJsonSafe(binding.get()) : null,
    min: binding?.min ?? null,
    max: binding?.max ?? null,
    options: Array.isArray(binding?.options) ? cloneJsonSafe(binding.options) : null,
  };
}

function findLayoutBinding(helios, key) {
  const layout = helios.layout();
  const descriptor = typeof layout?.getParameterBindings === 'function'
    ? layout.getParameterBindings()
    : null;
  const binding = descriptor?.bindings?.find((entry) => entry?.key === key) ?? null;
  if (!binding) throw new Error(`Unknown layout parameter "${key}"`);
  return binding;
}

function normalizeBindingValue(binding, value) {
  if (binding?.type === 'boolean') return value === true || value === 'true' || value === 1;
  if (binding?.type === 'number' || typeof binding?.get?.() === 'number') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`Layout parameter "${binding.key}" expects a finite number`);
    return numeric;
  }
  return value;
}

function normalizeAttributeWriteValue(value) {
  if (value && typeof value === 'object' && value.__typedArray) {
    const ctor = globalThis[value.__typedArray];
    if (typeof ctor !== 'function') throw new Error(`Unsupported typed array "${value.__typedArray}"`);
    return new ctor(value.values ?? []);
  }
  return value;
}

function normalizeAttributeWriteOptions(options = {}) {
  return {
    ...(options ?? {}),
    type: options?.type ?? 'float',
  };
}

function compileAttributeFunction(source) {
  if (typeof source !== 'string' || !source.trim()) return null;
  const body = source.trim();
  if (/\breturn\b/.test(body) || /[;{}]/.test(body)) {
    return new Function('current', 'id', 'ordinal', 'network', 'context', body);
  }
  return new Function('current', 'id', 'ordinal', 'network', 'context', `return (${body});`);
}

function writeNetworkAttribute(network, params = {}) {
  const scope = String(params.scope ?? 'node').trim().toLowerCase();
  const name = params.name ?? params.attribute;
  const names = params.names ?? params.attributes;
  const options = normalizeAttributeWriteOptions(params.options ?? {
    type: params.type,
    dimension: params.dimension,
    indexBy: params.indexBy,
  });
  const context = cloneJsonSafe(params.context ?? {});
  const functionCode = params.functionCode ?? params.valueCode ?? null;
  const value = functionCode
    ? (current, id, ordinal, net) => compileAttributeFunction(functionCode)(current, id, ordinal, net, context)
    : normalizeAttributeWriteValue(params.values ?? params.value);

  if (scope === 'node') {
    if (Array.isArray(names)) return network.nodeAttributes(names, value, options);
    return network.nodeAttribute(name, value, options);
  }
  if (scope === 'edge') {
    if (Array.isArray(names)) return network.edgeAttributes(names, value, options);
    return network.edgeAttribute(name, value, options);
  }
  if (scope === 'network') {
    if (Array.isArray(names)) return network.networkAttributes(names, value, options);
    return network.networkAttribute(name, value, options);
  }
  throw new Error('network.attributeSet scope must be "node", "edge", or "network"');
}

function applyLayoutParameters(helios, params = {}) {
  const values = params.values ?? params.parameters ?? params;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('layout.setParameters expects an object of parameter values');
  }
  const changed = {};
  for (const [key, rawValue] of Object.entries(values)) {
    if (key === 'values' || key === 'parameters' || key === 'reheat' || key === 'start') continue;
    const binding = findLayoutBinding(helios, key);
    if (typeof binding.set !== 'function') {
      throw new Error(`Layout parameter "${key}" is read-only`);
    }
    const value = normalizeBindingValue(binding, rawValue);
    binding.set(value);
    changed[key] = typeof binding.get === 'function' ? cloneJsonSafe(binding.get()) : value;
  }
  if (params.start === true) helios.startLayout?.();
  helios.requestRender?.();
  return { changed, layout: getLayoutState(helios) };
}

function identifyLayout(layout) {
  if (!layout) return 'none';
  const descriptor = typeof layout.getParameterBindings === 'function'
    ? layout.getParameterBindings()
    : null;
  if (descriptor?.key) return descriptor.key;
  const name = String(layout.constructor?.name ?? '').toLowerCase();
  if (name.includes('gpuforce')) return 'gpu-force';
  if (name.includes('d3force')) return 'd3force3d';
  if (name.includes('static')) return 'static';
  if (name.includes('worker')) {
    const variant = String(layout.options?.layout ?? '').toLowerCase();
    if (variant === 'jitter') return 'worker:jitter';
    return 'worker:force3d';
  }
  return name || 'unknown';
}

function buildLayoutOptions(helios, key) {
  const mode = helios.mode();
  const nodeCount = Math.max(1, Number(helios.network?.nodeCount ?? 200));
  const radius = 220 * Math.sqrt(nodeCount / 1000);
  const depth = mode === '3d' ? 140 : 0;
  const normalized = normalizeLayoutKey(key);
  if (normalized === 'static') {
    return { type: 'static', options: { bounds: [-500, -500, 500, 500] } };
  }
  if (normalized === 'd3force3d') {
    return {
      type: 'd3force3d',
      options: { settings: { use2D: mode !== '3d', alphaDecay: 0.003 } },
    };
  }
  if (normalized === 'worker:jitter') {
    return {
      type: 'worker',
      options: { layout: 'jitter', mode, center: [0, 0, 0], radius, depth, jitter: 3 },
    };
  }
  if (normalized === 'worker:force3d') {
    return {
      type: 'worker',
      options: {
        layout: 'force3d',
        mode,
        center: [0, 0, 0],
        radius,
        depth,
        kRepulsion: 3,
        kAttraction: 0.003,
        kGravity: 0.0008,
        repulsionStrategy: 'barnes-hut',
        negativesPerNode: 64,
        negativeSampling: true,
      },
    };
  }
  return {
    type: 'gpu-force',
    options: {
      mode,
      center: [0, 0, 0],
      radius,
      depth,
      outputScale: 6.5,
      linkDistance: 1,
      kRepulsion: 0.07,
      kAttraction: 0.62,
      kGravity: 0.005,
      eta: 0.4,
      damping: 0.92,
      maxStep: 2.5,
      minDistance: 0.15,
    },
  };
}

function seedGridPositions(network, nodeCount, mode) {
  network.defineNodeAttribute('_helios_visuals_position', AttributeType.Float, 3);
  network.withBufferAccess(() => {
    const pos = network.getNodeAttributeBuffer('_helios_visuals_position').view;
    if (mode === '3d') {
      const side = Math.ceil(Math.cbrt(nodeCount));
      const spacing = 24;
      for (let i = 0; i < nodeCount; i += 1) {
        const z = Math.floor(i / (side * side));
        const rem = i - z * side * side;
        const y = Math.floor(rem / side);
        const x = rem - y * side;
        const offset = i * 3;
        pos[offset] = (x - side / 2) * spacing;
        pos[offset + 1] = (y - side / 2) * spacing;
        pos[offset + 2] = (z - side / 2) * spacing;
      }
    } else {
      const side = Math.ceil(Math.sqrt(nodeCount));
      const spacing = 24;
      for (let i = 0; i < nodeCount; i += 1) {
        const row = Math.floor(i / side);
        const col = i - row * side;
        const offset = i * 3;
        pos[offset] = (col - side / 2) * spacing;
        pos[offset + 1] = (row - side / 2) * spacing;
        pos[offset + 2] = 0;
      }
    }
  });
}

function seedRandomPositions(network, nodeCount, mode) {
  network.defineNodeAttribute('_helios_visuals_position', AttributeType.Float, 3);
  network.withBufferAccess(() => {
    const pos = network.getNodeAttributeBuffer('_helios_visuals_position').view;
    const depth = mode === '3d' ? 200 : 0;
    for (let i = 0; i < nodeCount; i += 1) {
      const offset = i * 3;
      pos[offset] = (Math.random() - 0.5) * 400;
      pos[offset + 1] = (Math.random() - 0.5) * 400;
      pos[offset + 2] = (Math.random() - 0.5) * depth;
    }
  });
}

async function createSeedNetwork({ nodeCount = 200, mode = '2d', layout = 'gpu-force' } = {}) {
  const network = await HeliosNetwork.create({ directed: false, initialNodes: 0 });
  network.defineNodeAttribute('_helios_visuals_size', AttributeType.Float, 1);
  network.defineNodeAttribute('_helios_visuals_color', AttributeType.Float, 4);
  network.defineEdgeAttribute('_helios_visuals_edge_color', AttributeType.Float, 8);
  network.defineEdgeAttribute('_helios_visuals_edge_width', AttributeType.Float, 2);
  network.defineNodeAttribute('weight', AttributeType.Float, 1);
  network.defineNodeAttribute('label', AttributeType.String, 1);
  const nodes = network.addNodes(nodeCount);
  const edges = [];
  for (let index = 0; index < nodes.length; index += 1) {
    edges.push([nodes[index], nodes[(index + 1) % nodes.length]]);
  }
  const edgeIds = network.addEdges(edges);
  network.withBufferAccess(() => {
    const size = network.getNodeAttributeBuffer('_helios_visuals_size').view;
    const color = network.getNodeAttributeBuffer('_helios_visuals_color').view;
    const edgeColor = network.getEdgeAttributeBuffer('_helios_visuals_edge_color').view;
    const edgeWidth = network.getEdgeAttributeBuffer('_helios_visuals_edge_width').view;
    const weight = network.getNodeAttributeBuffer('weight').view;
    for (let i = 0; i < nodes.length; i += 1) {
      const id = nodes[i];
      size[id] = 10;
      weight[id] = i / Math.max(1, nodes.length - 1);
      const c = [(i * 97) % 255, (i * 57) % 255, (i * 17) % 255].map((v) => (v / 255) * 0.9 + 0.1);
      color.set([c[0], c[1], c[2], 1], id * 4);
    }
    for (const edgeId of edgeIds) {
      edgeColor.set([0.35, 0.55, 1.0, 0.5, 0.35, 0.55, 1.0, 0.5], edgeId * 8);
      edgeWidth[edgeId * 2] = 1.5;
      edgeWidth[(edgeId * 2) + 1] = 1.5;
    }
  });
  for (let i = 0; i < nodes.length; i += 1) {
    network.setNodeStringAttribute('label', nodes[i], `node-${i}`);
  }
  if (normalizeLayoutKey(layout) === 'static') {
    seedGridPositions(network, nodeCount, mode);
  } else {
    seedRandomPositions(network, nodeCount, mode);
  }
  return network;
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(String(base64 ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fileFromBase64({ name, base64, mimeType = 'application/octet-stream' }) {
  const bytes = base64ToUint8Array(base64);
  return new File([bytes], name, { type: mimeType });
}

function getNetworkStats(helios) {
  const network = helios.network;
  return {
    nodeCount: network?.nodeCount ?? 0,
    edgeCount: network?.edgeCount ?? 0,
    nodeAttributes: network?.getNodeAttributeNames?.() ?? [],
    edgeAttributes: network?.getEdgeAttributeNames?.() ?? [],
  };
}

function getLayoutState(helios) {
  const layout = helios.layout();
  const descriptor = typeof layout?.getParameterBindings === 'function'
    ? layout.getParameterBindings()
    : null;
  return {
    key: identifyLayout(layout),
    label: descriptor?.label ?? layout?.constructor?.name ?? null,
    runState: typeof helios.scheduler?.getLayoutState === 'function'
      ? helios.scheduler.getLayoutState()
      : (helios.scheduler?.layoutEnabled !== false ? 'running' : 'stopped'),
    descriptor: descriptor
      ? {
          key: descriptor.key ?? null,
          label: descriptor.label ?? null,
          dynamic: descriptor.dynamic === true,
          bindings: Array.isArray(descriptor.bindings) ? descriptor.bindings.map(serializeLayoutBinding) : [],
        }
      : null,
  };
}

function serializeBehavior(behavior) {
  if (!behavior) return null;
  return {
    id: behavior.id ?? behavior.constructor?.id ?? null,
    options: cloneJsonSafe(behavior.options ?? {}),
    state: cloneJsonSafe(behavior.state ?? null),
    serialized: typeof behavior.serialize === 'function' ? cloneJsonSafe(behavior.serialize()) : null,
  };
}

function getBehaviorState(helios) {
  const entries = typeof helios.behaviors?.entries === 'function' ? helios.behaviors.entries() : [];
  const attached = {};
  for (const [id, behavior] of entries) {
    attached[id] = serializeBehavior(behavior);
  }
  return {
    attached,
    serialized: cloneJsonSafe(helios.serializeBehaviorState?.() ?? {}),
  };
}

function findBehavior(helios, id) {
  const behavior = helios.getBehavior?.(id) ?? helios.behaviors?.get?.(id) ?? null;
  if (!behavior) throw new Error(`Behavior "${id}" is not attached`);
  return behavior;
}

function setBehaviorEnabled(helios, id, enabled, options = {}) {
  const behavior = findBehavior(helios, id);
  const value = enabled !== false;
  if (typeof behavior.enabled === 'function') {
    behavior.enabled(value);
  } else if (behavior.state && Object.prototype.hasOwnProperty.call(behavior.state, 'enabled')) {
    behavior.state.enabled = value;
    behavior.emit?.('change', { reason: 'cli-enabled', state: cloneJsonSafe(behavior.state) });
  } else if (value === false && options.detach === true) {
    helios.behaviors?.detach?.(id);
    return getBehaviorState(helios);
  } else if (typeof behavior.update === 'function') {
    behavior.update({ enabled: value });
  } else {
    throw new Error(`Behavior "${id}" does not expose enabled state`);
  }
  helios.requestRender?.();
  return serializeBehavior(helios.getBehavior?.(id) ?? helios.behaviors?.get?.(id) ?? behavior);
}

function invokeBehavior(helios, params = {}) {
  const id = params.id ?? params.behavior;
  const method = params.method ?? params.accessor;
  const args = Array.isArray(params.args) ? params.args : [];
  if (!method || typeof method !== 'string') throw new Error('behaviors.call expects a method name');
  if (method === 'attach' || method === 'detach' || method === 'constructor') {
    throw new Error(`Refusing to call behavior method "${method}" through behaviors.call`);
  }
  const behavior = findBehavior(helios, id);
  if (typeof behavior[method] !== 'function') {
    throw new Error(`Behavior "${id}" does not expose method "${method}"`);
  }
  const result = behavior[method](...args);
  helios.requestRender?.();
  return {
    result: result === behavior ? serializeBehavior(behavior) : cloneJsonSafe(result),
    behavior: serializeBehavior(behavior),
  };
}

function getPositionSourceState(helios) {
  const raw = helios.positions?.() ?? null;
  const delegate = raw?.delegate ?? null;
  const source = {
    source: raw?.source ?? null,
    delegate: delegate
      ? {
          id: delegate.id ?? delegate.constructor?.name ?? 'delegate',
          type: delegate.constructor?.name ?? null,
          version: delegate.version ?? null,
        }
      : null,
  };
  return {
    ...source,
    choices: cloneJsonSafe(helios.getLayoutPositionAttributeChoices?.() ?? []),
    layout: getLayoutState(helios),
  };
}

function readPositionAttribute(helios, attribute = '_helios_visuals_position', options = {}) {
  const network = helios.network;
  const info = network?.getNodeAttributeInfo?.(attribute) ?? null;
  if (!info) return { attribute, exists: false, count: 0, dimension: 0 };
  const dimension = Math.max(1, Number(info.dimension ?? 1));
  const includeValues = options.includeValues !== false;
  const limit = options.limit == null ? null : Math.max(0, Number(options.limit) || 0);
  let values = null;
  let count = 0;
  if (includeValues) {
    network.withBufferAccess?.(() => {
      const view = network.getNodeAttributeBuffer(attribute).view;
      count = Math.floor(view.length / dimension);
      const itemCount = limit == null ? count : Math.min(count, limit);
      values = Array.from(view.slice(0, itemCount * dimension));
    });
  } else {
    count = Math.floor((network.getNodeAttributeBuffer?.(attribute)?.view?.length ?? 0) / dimension);
  }
  return { attribute, exists: true, dimension, count, values };
}

async function snapshotPositions(helios, params = {}) {
  const source = helios.positions?.() ?? { source: 'network' };
  if (source?.source === 'delegate') {
    const snapshot = await helios.snapshotDelegatePositions?.();
    const limit = params.limit == null ? null : Math.max(0, Number(params.limit) || 0);
    const values = snapshot
      ? Array.from(snapshot.slice(0, limit == null ? snapshot.length : Math.min(snapshot.length, limit * 3)))
      : null;
    return {
      source: 'delegate',
      dimension: 3,
      count: snapshot ? Math.floor(snapshot.length / 3) : 0,
      values,
    };
  }
  return { source: 'network', ...readPositionAttribute(helios, params.attribute ?? '_helios_visuals_position', params) };
}

function applyPositionsFromAttribute(helios, params = {}) {
  const attribute = params.attribute ?? params.name ?? '_helios_visuals_position';
  if (params.stopLayout === true) helios.stopLayout?.('cli:positions-from-attribute');
  const wrote = helios.setLayoutPositionsFromNodeAttribute(attribute, params.options ?? {});
  if (!wrote) throw new Error(`Could not apply node attribute "${attribute}" as layout positions`);
  helios.behavior?.layout?.positionAttribute?.(attribute);
  if (params.start === true) helios.startLayout?.();
  helios.requestRender?.();
  return getPositionSourceState(helios);
}

function setCustomPositions(helios, params = {}) {
  const attribute = params.attribute ?? '_helios_visuals_position';
  const rawValues = params.values ?? params.positions;
  if (!Array.isArray(rawValues) && !ArrayBuffer.isView(rawValues)) {
    throw new Error('positions.set expects a flat or nested values array');
  }
  const first = Array.isArray(rawValues) ? rawValues.find((entry) => entry != null) : null;
  const nested = Array.isArray(first) || ArrayBuffer.isView(first);
  const dimension = Number(params.dimension ?? (nested ? first.length : 3));
  const rows = nested
    ? rawValues.map((entry) => Array.from(entry))
    : Array.from({ length: Math.floor(rawValues.length / dimension) }, (_, index) => (
        Array.from(rawValues).slice(index * dimension, (index + 1) * dimension)
      ));
  const nodeIds = Array.isArray(params.nodes) ? params.nodes.map((entry) => Number(entry)) : null;
  const byNode = nodeIds ? new Map(nodeIds.map((node, index) => [node, rows[index]])) : null;
  writeNetworkAttribute(helios.network, {
    scope: 'node',
    name: attribute,
    value: (current, id, ordinal) => byNode?.get(id) ?? rows[ordinal] ?? current ?? new Array(dimension).fill(0),
    options: { type: params.type ?? 'float', dimension, indexBy: params.indexBy ?? 'auto' },
  });
  if (params.apply !== false) {
    applyPositionsFromAttribute(helios, { attribute, stopLayout: params.stopLayout, start: params.start });
  }
  return snapshotPositions(helios, { attribute, includeValues: params.includeValues === true, limit: params.limit });
}

function getSceneState(helios) {
  return {
    mode: helios.mode(),
    renderer: helios.renderer?.device?.type ?? null,
    size: cloneJsonSafe(helios.size ?? helios.layers?.size ?? null),
    network: getNetworkStats(helios),
    camera: cloneJsonSafe(helios.cameraPose?.() ?? null),
    cameraControls: cloneJsonSafe(helios.cameraControls?.() ?? null),
    labels: cloneJsonSafe(helios.labels?.() ?? null),
    legends: cloneJsonSafe(helios.legends?.() ?? null),
    density: cloneJsonSafe(helios.density?.() ?? null),
    filter: cloneJsonSafe(helios.getGraphFilter?.() ?? null),
    behaviors: getBehaviorState(helios),
    positions: getPositionSourceState(helios),
    layout: getLayoutState(helios),
    mappers: {
      node: serializeMapperCollection(helios.nodeMapper),
      edge: serializeMapperCollection(helios.edgeMapper),
    },
    url: window.location.href,
  };
}

function buildMapper(mode, network, descriptor) {
  if (!descriptor) return null;
  const mapper = new Mapper({ mode, network });
  const entries = Array.isArray(descriptor.channels)
    ? descriptor.channels.map((entry) => [entry.name, entry.config ?? entry])
    : Object.entries(descriptor);
  for (const [name, config] of entries) {
    if (!name || !config) continue;
    mapper.setChannel(name, config);
  }
  return mapper;
}

function compileMapperFunction(source, label) {
  if (typeof source !== 'string' || !source.trim()) return null;
  // Agents can pass either an expression or a function body. Arguments mirror
  // Mapper.js custom callbacks: inputs, item, context.
  const body = source.trim();
  if (/\breturn\b/.test(body) || /[;{}]/.test(body)) {
    return new Function('inputs', 'item', 'context', body);
  }
  return new Function('inputs', 'item', 'context', `return (${body});`);
}

function hydrateMapperFunctionConfig(config, label = 'mapper') {
  if (Array.isArray(config)) return config.map((entry, index) => hydrateMapperFunctionConfig(entry, `${label}[${index}]`));
  if (!config || typeof config !== 'object') return config;
  const next = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'transformCode') {
      next.transform = compileMapperFunction(value, `${label}.transformCode`);
      next.meta = { ...(next.meta ?? config.meta ?? {}), transformCode: value };
      continue;
    }
    if (key === 'scaleCode') {
      next.scale = compileMapperFunction(value, `${label}.scaleCode`);
      next.meta = { ...(next.meta ?? config.meta ?? {}), scaleCode: value };
      continue;
    }
    if (key === 'whenCode') {
      next.when = compileMapperFunction(value, `${label}.whenCode`);
      next.meta = { ...(next.meta ?? config.meta ?? {}), whenCode: value };
      continue;
    }
    next[key] = hydrateMapperFunctionConfig(value, `${label}.${key}`);
  }
  return next;
}

function buildMapperWithFunctions(mode, network, descriptor) {
  return buildMapper(mode, network, hydrateMapperFunctionConfig(descriptor, `${mode}Mapper`));
}

function serializeMetricResult(result, { includeValuesByNode = false } = {}) {
  const normalized = cloneJsonSafe(result);
  if (!includeValuesByNode && normalized && typeof normalized === 'object') {
    delete normalized.valuesByNode;
  }
  return normalized;
}

async function runSteppableSession(session, options = {}) {
  const budget = Math.max(1, Number(options.budget ?? 500) || 500);
  const maxSteps = Math.max(1, Number(options.maxSteps ?? 10000) || 10000);
  let progress = null;
  let steps = 0;
  while (steps < maxSteps) {
    progress = session.step({ budget });
    steps += 1;
    const phase = Number(progress?.phase ?? progress?.status ?? 0);
    if (progress?.done === true || phase === 3 || phase === 5) break;
    if (steps % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (steps >= maxSteps) throw new Error(`Metric session did not finish within ${maxSteps} steps`);
  const result = session.finalize(options.finalize ?? {});
  session.dispose?.();
  return { steps, progress: cloneJsonSafe(progress), result };
}

async function measureNetworkMetric(network, params = {}) {
  const metric = String(params.metric ?? params.name ?? params.measure ?? '').trim();
  const options = params.options ?? { ...params };
  delete options.metric;
  delete options.name;
  delete options.measure;
  const includeValuesByNode = params.includeValuesByNode === true || options.includeValuesByNode === true;
  delete options.includeValuesByNode;

  switch (metric) {
    case 'degree':
      return serializeMetricResult(network.measureDegree(options), { includeValuesByNode });
    case 'strength':
      return serializeMetricResult(network.measureStrength(options), { includeValuesByNode });
    case 'localClustering':
    case 'localClusteringCoefficient':
    case 'clustering':
      return serializeMetricResult(network.measureLocalClusteringCoefficient(options), { includeValuesByNode });
    case 'coreness':
      return serializeMetricResult(network.measureCoreness(options), { includeValuesByNode });
    case 'eigenvector':
    case 'eigenvectorCentrality':
      return serializeMetricResult(network.measureEigenvectorCentrality(options), { includeValuesByNode });
    case 'betweenness':
    case 'betweennessCentrality':
      return serializeMetricResult(network.measureBetweennessCentrality(options), { includeValuesByNode });
    case 'connectedComponents':
    case 'components':
      return serializeMetricResult(network.measureConnectedComponents(options), { includeValuesByNode });
    case 'dimension':
      return serializeMetricResult(network.measureDimension(options), { includeValuesByNode: true });
    case 'nodeDimension':
      return serializeMetricResult(network.measureNodeDimension(params.node ?? options.node, options), { includeValuesByNode: true });
    case 'leiden':
    case 'leidenModularity':
      return serializeMetricResult(network.leidenModularity(options), { includeValuesByNode: true });
    case 'corenessSession': {
      const session = network.createCorenessSession(options);
      return serializeMetricResult(await runSteppableSession(session, params), { includeValuesByNode });
    }
    case 'connectedComponentsSession': {
      const session = network.createConnectedComponentsSession(options);
      return serializeMetricResult(await runSteppableSession(session, params), { includeValuesByNode });
    }
    case 'dimensionSession': {
      const session = network.createDimensionSession(options);
      return serializeMetricResult(await runSteppableSession(session, params), { includeValuesByNode: true });
    }
    default:
      throw new Error(`Unknown metric "${metric}". Use degree, strength, localClustering, coreness, eigenvectorCentrality, betweennessCentrality, connectedComponents, dimension, nodeDimension, or leiden.`);
  }
}

class BrowserBridge {
  constructor(socket, helios, ui) {
    this.socket = socket;
    this.helios = helios;
    this.ui = ui;
    this.handlers = this.buildHandlers();
    this.unsubscribers = [];
    this.bindEvents();
  }

  bindEvents() {
    const forward = (type, detail) => {
      this.notify('bridge.event', { type, detail });
    };
    const on = (eventName, type = eventName) => {
      const off = this.helios.on(eventName, (event) => {
        forward(type, event?.detail ?? null);
      });
      this.unsubscribers.push(off);
    };
    on(EVENTS.MODE_CHANGED, 'helios.modeChanged');
    on(EVENTS.NETWORK_REPLACED, 'helios.networkReplaced');
    on(EVENTS.GRAPH_FILTER_CHANGED, 'helios.graphFilterChanged');
    on(EVENTS.LAYOUT_START, 'helios.layoutStart');
    on(EVENTS.LAYOUT_STOP, 'helios.layoutStop');
    on(EVENTS.CAMERA_MOVE, 'helios.cameraMove');
  }

  notify(method, params) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  async handleMessage(raw) {
    const message = JSON.parse(String(raw));
    if (!message?.method) return;
    const handler = this.handlers[message.method];
    if (!handler) {
      this.socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32601, message: `Unknown bridge method ${message.method}` },
      }));
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }));
    } catch (error) {
      this.socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: error?.code ?? -32000, message: error?.message ?? String(error) },
      }));
    }
  }

  buildHandlers() {
    return {
      'session.getInfo': async () => getSceneState(this.helios),
      'network.stats': async () => getNetworkStats(this.helios),
      'network.attributeSet': async (params) => {
        writeNetworkAttribute(this.helios.network, params);
        if (params.applyAsPositions === true || params.positionAttribute === true) {
          applyPositionsFromAttribute(this.helios, { attribute: params.name ?? params.attribute });
        }
        this.helios.requestRender?.();
        return getNetworkStats(this.helios);
      },
      'network.loadPayload': async (params) => {
        const file = fileFromBase64({
          name: params.name ?? `network.${params.format ?? 'bxnet'}`,
          base64: params.base64,
        });
        await this.helios.loadNetwork(file, {
          format: params.format,
          disposeOld: true,
          recreateRenderer: true,
          keepCamera: false,
          ...(params.options ?? {}),
        });
        return getSceneState(this.helios);
      },
      'network.replace': async (params) => {
        if (params.base64) {
          return this.handlers['network.loadPayload'](params);
        }
        if (params.synthetic) {
          const network = await createSeedNetwork({
            nodeCount: params.synthetic.nodeCount ?? 200,
            mode: params.synthetic.mode ?? this.helios.mode(),
            layout: params.synthetic.layout ?? identifyLayout(this.helios.layout()),
          });
          await this.helios.replaceNetwork(network, params.options ?? {});
          return getSceneState(this.helios);
        }
        throw new Error('network.replace requires a base64 payload or synthetic descriptor');
      },
      'network.savePayload': async (params) => {
        const format = params.format ?? 'bxnet';
        const blob = await this.helios.saveNetwork(format, { output: 'blob' });
        return {
          format,
          mimeType: blob.type || 'application/octet-stream',
          filename: params.filename ?? `network.${format}`,
          base64: await blobToBase64(blob),
        };
      },
      'scene.getState': async () => getSceneState(this.helios),
      'scene.requestRender': async () => {
        this.helios.requestRender();
        return getSceneState(this.helios);
      },
      'scene.setMode': async (params) => {
        await this.helios.setMode(params.mode, params.options ?? {});
        return getSceneState(this.helios);
      },
      'camera.getPose': async () => cloneJsonSafe(this.helios.cameraPose()),
      'camera.setPose': async (params) => {
        this.helios.setCameraPose(params.pose ?? params, params.options ?? {});
        return cloneJsonSafe(this.helios.cameraPose());
      },
      'camera.transition': async (params) => {
        await this.helios.transitionCamera(params.pose ?? params, params.options ?? {});
        return cloneJsonSafe(this.helios.cameraPose());
      },
      'camera.frame': async (params) => {
        const ok = this.helios.frameNetwork(params ?? {});
        return { ok, pose: cloneJsonSafe(this.helios.cameraPose()) };
      },
      'camera.controls': async (params) => {
        if (!params || Object.keys(params).length === 0) return cloneJsonSafe(this.helios.cameraControls());
        this.helios.cameraControls(params);
        return cloneJsonSafe(this.helios.cameraControls());
      },
      'camera.targetNodes': async (params) => {
        if (!params || !Object.prototype.hasOwnProperty.call(params, 'nodeIndices')) {
          return cloneJsonSafe(this.helios.cameraTargetNodes());
        }
        this.helios.cameraTargetNodes(params.nodeIndices, params.options ?? {});
        return cloneJsonSafe(this.helios.cameraTargetNodes());
      },
      'layout.get': async () => getLayoutState(this.helios),
      'layout.set': async (params) => {
        const instance = this.helios.createLayout(buildLayoutOptions(this.helios, params.layout ?? params.key));
        this.helios.layout(instance);
        return getLayoutState(this.helios);
      },
      'layout.setParameters': async (params) => applyLayoutParameters(this.helios, params),
      'layout.applyPositionAttribute': async (params) => applyPositionsFromAttribute(this.helios, params),
      'layout.start': async (params) => {
        this.helios.startLayout(params?.algo ?? null, params?.params ?? null);
        return getLayoutState(this.helios);
      },
      'layout.stop': async (params) => {
        this.helios.stopLayout(params?.reason ?? 'user');
        return getLayoutState(this.helios);
      },
      'mappers.get': async () => ({
        node: serializeMapperCollection(this.helios.nodeMapper),
        edge: serializeMapperCollection(this.helios.edgeMapper),
      }),
      'mappers.set': async (params) => {
        const payload = {};
        if (params.nodeMapper) payload.nodeMapper = buildMapperWithFunctions('node', this.helios.network, params.nodeMapper);
        if (params.edgeMapper) payload.edgeMapper = buildMapperWithFunctions('edge', this.helios.network, params.edgeMapper);
        this.helios.mappers(payload);
        return {
          node: serializeMapperCollection(this.helios.nodeMapper),
          edge: serializeMapperCollection(this.helios.edgeMapper),
        };
      },
      'mappers.reset': async () => {
        this.helios.mappers({ nodeMapper: null, edgeMapper: null });
        return {
          node: serializeMapperCollection(this.helios.nodeMapper),
          edge: serializeMapperCollection(this.helios.edgeMapper),
        };
      },
      'behaviors.get': async () => getBehaviorState(this.helios),
      'behaviors.use': async (params) => {
        const id = params.id ?? params.behavior;
        const behavior = this.helios.useBehavior(id, params.options ?? true);
        return serializeBehavior(behavior);
      },
      'behaviors.detach': async (params) => {
        const id = params.id ?? params.behavior;
        const detached = this.helios.behaviors?.detach?.(id) === true;
        this.helios.requestRender?.();
        return { detached, behaviors: getBehaviorState(this.helios) };
      },
      'behaviors.setEnabled': async (params) => setBehaviorEnabled(
        this.helios,
        params.id ?? params.behavior,
        params.enabled,
        params.options ?? {},
      ),
      'behaviors.update': async (params) => {
        const id = params.id ?? params.behavior;
        const behavior = this.helios.useBehavior(id, params.options ?? {});
        this.helios.requestRender?.();
        return serializeBehavior(behavior);
      },
      'behaviors.restore': async (params) => {
        this.helios.restoreBehaviorState(params.snapshot ?? params);
        this.helios.requestRender?.();
        return getBehaviorState(this.helios);
      },
      'behaviors.call': async (params) => invokeBehavior(this.helios, params),
      'positions.get': async () => getPositionSourceState(this.helios),
      'positions.snapshot': async (params) => snapshotPositions(this.helios, params),
      'positions.set': async (params) => setCustomPositions(this.helios, params),
      'positions.fromAttribute': async (params) => applyPositionsFromAttribute(this.helios, params),
      'filters.get': async () => cloneJsonSafe(this.helios.getGraphFilter()),
      'filters.set': async (params) => {
        this.helios.setGraphFilter(params);
        return cloneJsonSafe(this.helios.getGraphFilter());
      },
      'filters.clear': async () => {
        this.helios.clearGraphFilter();
        return cloneJsonSafe(this.helios.getGraphFilter());
      },
      'labels.get': async () => cloneJsonSafe(this.helios.labels()),
      'labels.set': async (params) => {
        this.helios.labels(params);
        return cloneJsonSafe(this.helios.labels());
      },
      'legends.get': async () => cloneJsonSafe(this.helios.legends()),
      'legends.set': async (params) => {
        this.helios.legends(params);
        return cloneJsonSafe(this.helios.legends());
      },
      'density.get': async () => cloneJsonSafe(this.helios.density()),
      'density.set': async (params) => {
        this.helios.density(params);
        return cloneJsonSafe(this.helios.density());
      },
      'metrics.measure': async (params) => measureNetworkMetric(this.helios.network, params),
      'aesthetic.measure': async (params) => measureNetworkMetric(this.helios.network, params),
      'picking.pick': async (params) => this.helios.pickAttributesAt(params.x, params.y),
      'export.figurePayload': async (params) => {
        const blob = await this.helios.exportFigureBlob(params);
        return {
          format: params.format ?? 'png',
          mimeType: blob.type || 'application/octet-stream',
          filename: params.filename ?? `figure.${params.format ?? 'png'}`,
          base64: await blobToBase64(blob),
        };
      },
      'events.subscribe': async () => ({ supported: true }),
      'events.unsubscribe': async () => ({ supported: true }),
    };
  }
}

async function bootstrap() {
  const config = await fetch('/api/config').then((response) => response.json());
  const network = await createSeedNetwork({
    mode: config.mode === '3d' ? '3d' : '2d',
    layout: config.layout,
  });
  const helios = new Helios(network, {
    container: document.getElementById('app'),
    mode: config.mode === '3d' ? '3d' : '2d',
    clearColor: [0, 0, 0, 1],
    projection: 'perspective',
    layout: buildLayoutOptions({ network, mode: () => config.mode }, config.layout),
    renderer: resolveRendererPreference(config.renderer) ?? undefined,
  });
  await helios.ready;
  const ui = new HeliosUI({ helios, theme: 'dark', allowDrag: true });
  publishRuntimeState(helios);
  helios.on?.(EVENTS.MODE_CHANGED, () => publishRuntimeState(helios));
  ui.createDemoPanel();
  ui.createMappersPanel({ dock: 'top-right', position: { x: 16, y: 16 } });
  ui.createLayoutPanel({ dock: 'top-right', position: { x: 16, y: 360 } });
  ui.createLegendsPanel({ dock: 'top-right', position: { x: 16, y: 560 } });
  ui.createFilterPanel({ dock: 'top-right' });
  ui.createCameraPanel({ dock: 'top-right' });
  helios.enableAttributeTracking('$index', '$index', {
    resolutionScale: 1,
    trackDepth: true,
    autoUpdate: true,
    autoUpdateMaxFps: 60,
  });
  helios.enableNodePicking?.({ resolutionScale: 1, trackDepth: true, maxFps: 60 });
  helios.enableEdgePicking?.({ resolutionScale: 1, trackDepth: true, maxFps: 60 });
  installHoverInteractions(helios);
  const socket = new WebSocket(wsUrlForCurrentLocation());
  socket.addEventListener('error', (event) => {
    console.error('Helios CLI bridge socket error', event);
  });
  socket.addEventListener('open', () => {
    const bridge = new BrowserBridge(socket, helios, ui);
    socket.addEventListener('message', (event) => {
      bridge.handleMessage(event.data);
    });
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'bridge.ready',
      params: {
        mode: helios.mode(),
        renderer: helios.renderer?.device?.type ?? null,
        nodeCount: helios.network?.nodeCount ?? 0,
        edgeCount: helios.network?.edgeCount ?? 0,
      },
    }));
  });
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap Helios CLI client', error);
});
