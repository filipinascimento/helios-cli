import HeliosNetwork, { AttributeType } from 'helios-network';
import { Helios, HeliosUI, EVENTS, Mapper } from 'helios-web';

function wsUrlForCurrentLocation() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/bridge`;
}

function cliPersistenceId(sessionId) {
  return String(sessionId ?? 'unknown');
}

function isDesktopRuntime(config = {}) {
  const runtime = String(config.runtime ?? new URLSearchParams(window.location.search).get('runtime') ?? '').toLowerCase();
  return runtime === 'desktop' || runtime === 'mac';
}

function publishRuntimeState(helios) {
  window.__HELIOS_CLI_RUNTIME__ = {
    renderer: helios.renderer?.device?.type ?? null,
    mode: helios.mode(),
    ready: true,
  };
}

function normalizeLayoutKey(value, fallback = 'gpu-force') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'static' || normalized === 'none') return 'static';
  if (normalized === 'd3force3d' || normalized === 'd3-force-3d') return 'd3force3d';
  if (normalized === 'worker:jitter' || normalized === 'jitter') return 'worker:jitter';
  if (normalized === 'worker:force3d' || normalized === 'worker' || normalized === 'force3d') return 'worker:force3d';
  return 'gpu-force';
}

function readNetworkScalarAttribute(network, name) {
  const info = network?.getNetworkAttributeInfo?.(name) ?? null;
  if (!info || Number(info.dimension ?? 1) !== 1) return undefined;
  if (Number(info.type) === AttributeType.String || Number(info.type) === AttributeType.Category) {
    return network.getNetworkStringAttribute?.(name);
  }
  let value;
  const read = () => {
    value = network.getNetworkAttributeBuffer?.(name)?.view?.[0];
  };
  if (typeof network.withBufferAccess === 'function') network.withBufferAccess(read);
  else read();
  return value;
}

function networkHasUmapForceMetadata(network) {
  const value = readNetworkScalarAttribute(network, 'umap');
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return Number(value) !== 0 && Number.isFinite(Number(value));
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
    const statePath = `layout.parameters.${key}`;
    if (typeof helios.states?.entry === 'function' && helios.states.entry(statePath)) {
      helios.states.set(statePath, value, {
        source: 'cli',
        reason: params.reason ?? 'layout.setParameters',
        scope: params.scope ?? 'network',
        trackOverride: params.trackOverride !== false,
      });
    } else {
      binding.set(value);
    }
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
    options: networkHasUmapForceMetadata(helios.network)
      ? {
          mode,
          center: [0, 0, 0],
          radius,
          depth,
        }
      : {
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

function seedGridPositions(network, nodeCount, mode, options = {}) {
  network.defineNodeAttribute('_helios_visuals_position', AttributeType.Float, 3);
  network.withBufferAccess(() => {
    const pos = network.getNodeAttributeBuffer('_helios_visuals_position').view;
    if (mode === '3d') {
      const side = clampInteger(options.side, Math.ceil(Math.cbrt(nodeCount)), 1);
      const spacing = 24;
      for (let i = 0; i < nodeCount; i += 1) {
        const z = Math.floor(i / (side * side));
        const rem = i - z * side * side;
        const y = Math.floor(rem / side);
        const x = rem - y * side;
        const offset = i * 3;
        pos[offset] = (x - (side - 1) / 2) * spacing;
        pos[offset + 1] = (y - (side - 1) / 2) * spacing;
        pos[offset + 2] = (z - (side - 1) / 2) * spacing;
      }
    } else {
      const columns = clampInteger(options.columns, Math.ceil(Math.sqrt(nodeCount)), 1);
      const rows = clampInteger(options.rows, Math.ceil(nodeCount / columns), 1);
      const spacing = 24;
      for (let i = 0; i < nodeCount; i += 1) {
        const row = Math.floor(i / columns);
        const col = i - row * columns;
        const offset = i * 3;
        pos[offset] = (col - (columns - 1) / 2) * spacing;
        pos[offset + 1] = (row - (rows - 1) / 2) * spacing;
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

function seedPositionsFromGenerator(network, nodeCount) {
  if (!network.hasNodeAttribute?.('_helios_generator_position')) return false;
  network.defineNodeAttribute('_helios_visuals_position', AttributeType.Float, 3);
  network.withBufferAccess(() => {
    const source = network.getNodeAttributeBuffer('_helios_generator_position').view;
    const pos = network.getNodeAttributeBuffer('_helios_visuals_position').view;
    for (let i = 0; i < nodeCount; i += 1) {
      pos[i * 3] = (source[i * 2] - 0.5) * 400;
      pos[(i * 3) + 1] = (source[(i * 2) + 1] - 0.5) * 400;
      pos[(i * 3) + 2] = 0;
    }
  });
  return true;
}

function clampInteger(value, fallback, min = 1, max = 1_000_000) {
  const numeric = Number(value);
  const fallbackNumeric = Number(fallback);
  const candidate = Number.isFinite(numeric) ? numeric : fallbackNumeric;
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(candidate) ? candidate : min)));
}

function clampNumber(value, fallback, min = -Infinity, max = Infinity) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function decorateSyntheticNetwork(network, options = {}) {
  const nodeCount = network.nodeCount ?? 0;
  const edgeCount = network.edgeCount ?? 0;
  const labelNodes = nodeCount <= 50_000;
  network.defineNodeAttribute('_helios_visuals_size', AttributeType.Float, 1);
  network.defineNodeAttribute('_helios_visuals_color', AttributeType.Float, 4);
  network.defineEdgeAttribute('_helios_visuals_edge_color', AttributeType.Float, 8);
  network.defineEdgeAttribute('_helios_visuals_edge_width', AttributeType.Float, 2);
  network.defineNodeAttribute('weight', AttributeType.Float, 1);
  network.defineEdgeAttribute('intensity', AttributeType.Float, 1);
  if (labelNodes) {
    network.defineNodeAttribute('label', AttributeType.String, 1);
    network.defineNodeAttribute('category', AttributeType.String, 1);
  }
  network.withBufferAccess(() => {
    const nodeIds = network.nodeIndices;
    const edgeIds = network.edgeIndices;
    const size = network.getNodeAttributeBuffer('_helios_visuals_size').view;
    const color = network.getNodeAttributeBuffer('_helios_visuals_color').view;
    const edgeColor = network.getEdgeAttributeBuffer('_helios_visuals_edge_color').view;
    const edgeWidth = network.getEdgeAttributeBuffer('_helios_visuals_edge_width').view;
    const weight = network.getNodeAttributeBuffer('weight').view;
    const intensity = network.getEdgeAttributeBuffer('intensity').view;
    for (let ordinal = 0; ordinal < nodeIds.length; ordinal += 1) {
      const id = nodeIds[ordinal];
      const ratio = ordinal / Math.max(1, nodeIds.length - 1);
      size[id] = options.nodeSize ?? 9;
      weight[id] = ratio;
      const hue = (ordinal * 37) % 360;
      const phase = hue / 60;
      const x = 1 - Math.abs((phase % 2) - 1);
      const palette = phase < 1 ? [1, x, 0]
        : phase < 2 ? [x, 1, 0]
          : phase < 3 ? [0, 1, x]
            : phase < 4 ? [0, x, 1]
              : phase < 5 ? [x, 0, 1]
                : [1, 0, x];
      color.set([
        palette[0] * 0.55 + 0.25,
        palette[1] * 0.55 + 0.25,
        palette[2] * 0.55 + 0.25,
        1,
      ], id * 4);
    }
    for (let ordinal = 0; ordinal < edgeIds.length; ordinal += 1) {
      const edgeId = edgeIds[ordinal];
      const value = ordinal / Math.max(1, edgeCount - 1);
      intensity[edgeId] = value;
      edgeColor.set([0.16, 0.28, 0.42, 0.42, 0.16, 0.28, 0.42, 0.42], edgeId * 8);
      edgeWidth[edgeId * 2] = options.edgeWidth ?? 1.2;
      edgeWidth[(edgeId * 2) + 1] = options.edgeWidth ?? 1.2;
    }
  }, { nodeIndices: true, edgeIndices: true });
  if (labelNodes) {
    let nodes = [];
    network.withBufferAccess(() => {
      nodes = Uint32Array.from(network.nodeIndices);
    }, { nodeIndices: true });
    const categoryCount = 8;
    for (let ordinal = 0; ordinal < nodes.length; ordinal += 1) {
      const id = nodes[ordinal];
      const bucket = Math.min(categoryCount - 1, Math.floor((ordinal / Math.max(1, nodes.length)) * categoryCount));
      network.setNodeStringAttribute('label', id, `node-${ordinal}`);
      network.setNodeStringAttribute('category', id, `category${bucket + 1}`);
    }
    network.categorizeNodeAttribute?.('category', { sortOrder: 'frequency' });
  }
  const layout = normalizeLayoutKey(options.layout ?? 'static');
  if (layout === 'static') {
    if (!seedPositionsFromGenerator(network, nodeCount)) {
      seedGridPositions(network, nodeCount, options.mode ?? '2d', options);
    }
  } else {
    seedRandomPositions(network, nodeCount, options.mode ?? '2d');
  }
  return network;
}

async function createGrid2DNetwork(options = {}) {
  const columns = clampInteger(options.columns, 50);
  const rows = clampInteger(options.rows, 50);
  const neighborLevel = clampInteger(options.neighborLevel, 1, 1, 64);
  const periodic = options.periodic === true;
  const network = await HeliosNetwork.generateLattice2D({
    rows,
    columns,
    neighborLevel,
    periodic,
    directed: options.directed === true,
  });
  return decorateSyntheticNetwork(network, {
    ...options,
    rows,
    columns,
    nodeCount: rows * columns,
    mode: '2d',
    layout: options.layout ?? 'static',
  });
}

async function createGrid3DNetwork(options = {}) {
  const requestedNodeCount = clampInteger(options.nodeCount, 4096);
  const side = clampInteger(options.side, Math.ceil(Math.cbrt(requestedNodeCount)));
  const nodeCount = Math.min(requestedNodeCount, side ** 3);
  const neighborLevel = clampInteger(options.neighborLevel, 1, 1, 64);
  const periodic = options.periodic === true;
  const edgeCountEstimate = nodeCount * 3 * neighborLevel;
  const network = await HeliosNetwork.create({
    directed: false,
    initialNodes: nodeCount,
    initialEdges: edgeCountEstimate,
  });
  const edges = new Uint32Array(edgeCountEstimate * 2);
  let edgeOffset = 0;
  const indexAt = (x, y, z) => z * side * side + y * side + x;
  const pushEdge = (from, x, y, z) => {
    let nx = x;
    let ny = y;
    let nz = z;
    if (periodic) {
      nx = (nx + side) % side;
      ny = (ny + side) % side;
      nz = (nz + side) % side;
    }
    if (nx < 0 || nx >= side || ny < 0 || ny >= side || nz < 0 || nz >= side) return;
    const to = indexAt(nx, ny, nz);
    if (to >= nodeCount || to === from) return;
    edges[edgeOffset] = from;
    edges[edgeOffset + 1] = to;
    edgeOffset += 2;
  };
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const from = indexAt(x, y, z);
        if (from >= nodeCount) break;
        for (let level = 1; level <= neighborLevel; level += 1) {
          pushEdge(from, x + level, y, z);
          pushEdge(from, x, y + level, z);
          pushEdge(from, x, y, z + level);
        }
      }
    }
  }
  if (edgeOffset > 0) network.addEdges(edges.subarray(0, edgeOffset));
  return decorateSyntheticNetwork(network, {
    ...options,
    side,
    nodeCount,
    mode: '3d',
    layout: options.layout ?? 'static',
  });
}

async function createSmallWorldNetwork(options = {}) {
  const nodeCount = clampInteger(options.nodeCount, 1000);
  const neighborLevel = clampInteger(options.neighborLevel, 2, 1, Math.max(1, Math.floor(nodeCount / 2)));
  const rewiringProbability = clampNumber(options.rewiringProbability, 0.01, 0, 1);
  const seed = clampInteger(options.seed, 1, 1, 0x7fffffff);
  const network = await HeliosNetwork.generateWattsStrogatz({
    nodeCount,
    neighborLevel,
    rewiringProbability,
    seed,
    directed: options.directed === true,
  });
  return decorateSyntheticNetwork(network, { ...options, mode: options.mode ?? '2d', layout: options.layout ?? 'gpu-force' });
}

async function createBarabasiAlbertNetwork(options = {}) {
  const nodeCount = clampInteger(options.nodeCount, 1000);
  const edgesPerNewNode = clampInteger(options.edgesPerNewNode, 2, 1, Math.max(1, nodeCount - 1));
  const initialCliqueSize = clampInteger(options.initialCliqueSize, edgesPerNewNode + 1, 2, nodeCount);
  const seed = clampInteger(options.seed, 1, 1, 0x7fffffff);
  const network = await HeliosNetwork.generateBarabasiAlbert({
    nodeCount,
    edgesPerNewNode,
    initialCliqueSize,
    directed: options.directed === true,
    seed,
  });
  return decorateSyntheticNetwork(network, { ...options, mode: options.mode ?? '2d', layout: options.layout ?? 'gpu-force' });
}

async function createRandomGeometricNetwork(options = {}) {
  const nodeCount = clampInteger(options.nodeCount, 1000, 1, 100_000);
  const radius = clampNumber(options.radius, 0.05, 0, 1);
  const seed = clampInteger(options.seed, 1, 1, 0x7fffffff);
  const network = await HeliosNetwork.generateRandomGeometric({
    nodeCount,
    radius,
    directed: options.directed === true,
    seed,
  });
  return decorateSyntheticNetwork(network, { ...options, mode: options.mode ?? '2d', layout: options.layout ?? 'static' });
}

async function createWaxmanNetwork(options = {}) {
  const nodeCount = clampInteger(options.nodeCount, 1000, 1, 100_000);
  const alpha = clampNumber(options.alpha, 0.4, 0.001, 10);
  const beta = clampNumber(options.beta, 0.2, 0, 1);
  const seed = clampInteger(options.seed, 1, 1, 0x7fffffff);
  const network = await HeliosNetwork.generateWaxman({
    nodeCount,
    alpha,
    beta,
    directed: options.directed === true,
    seed,
  });
  return decorateSyntheticNetwork(network, { ...options, mode: options.mode ?? '2d', layout: options.layout ?? 'static' });
}

async function createStochasticBlockNetwork(options = {}) {
  const blockCount = clampInteger(options.blockCount, 4, 1, 64);
  const blockSize = clampInteger(options.blockSize, 50, 1, 20_000);
  const intraProbability = clampNumber(options.intraProbability, 0.08, 0, 1);
  const interProbability = clampNumber(options.interProbability, 0.01, 0, 1);
  const seed = clampInteger(options.seed, 1, 1, 0x7fffffff);
  const blockSizes = Array.from({ length: blockCount }, () => blockSize);
  const probabilities = Array.from({ length: blockCount }, (_, row) => (
    Array.from({ length: blockCount }, (_, column) => (row === column ? intraProbability : interProbability))
  ));
  const network = await HeliosNetwork.generateStochasticBlockModel({
    blockSizes,
    probabilities,
    directed: options.directed === true,
    seed,
  });
  return decorateSyntheticNetwork(network, {
    ...options,
    nodeCount: blockCount * blockSize,
    mode: options.mode ?? '2d',
    layout: options.layout ?? 'gpu-force',
  });
}

async function createConfigurationModelNetwork(options = {}) {
  const nodeCount = clampInteger(options.nodeCount, 500, 1, 200_000);
  const maxDegree = options.allowSelfLoops === true || options.allowMultiEdges === true ? 10_000 : Math.max(0, nodeCount - 1);
  const degree = clampInteger(options.degree, 4, 0, maxDegree);
  const seed = clampInteger(options.seed, 1, 1, 0x7fffffff);
  const degrees = Array.from({ length: nodeCount }, () => degree);
  if ((degree * nodeCount) % 2 !== 0) {
    degrees[nodeCount - 1] = Math.max(0, degree - 1);
  }
  const network = await HeliosNetwork.generateConfigurationModel({
    degrees,
    directed: options.directed === true,
    allowSelfLoops: options.allowSelfLoops === true,
    allowMultiEdges: options.allowMultiEdges !== false,
    seed,
  });
  return decorateSyntheticNetwork(network, { ...options, mode: options.mode ?? '2d', layout: options.layout ?? 'gpu-force' });
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

async function createSyntheticNetwork(options = {}) {
  const model = String(options.model ?? options.name ?? 'ring').trim().toLowerCase();
  if (['grid', 'grid2d', 'lattice', 'lattice2d'].includes(model)) return createGrid2DNetwork(options);
  if (['grid3d', 'lattice3d'].includes(model)) return createGrid3DNetwork(options);
  if (['sw', 'small-world', 'smallworld', 'watts-strogatz', 'watts_strogatz'].includes(model)) return createSmallWorldNetwork(options);
  if (['ba', 'barabasi-albert', 'barabasi_albert', 'preferential-attachment'].includes(model)) return createBarabasiAlbertNetwork(options);
  if (['random-geometric', 'random_geometric', 'geometric'].includes(model)) return createRandomGeometricNetwork(options);
  if (model === 'waxman') return createWaxmanNetwork(options);
  if (['sbm', 'stochastic-block', 'stochastic_block', 'stochastic-block-model'].includes(model)) return createStochasticBlockNetwork(options);
  if (['configuration', 'configuration-model', 'configuration_model'].includes(model)) return createConfigurationModelNetwork(options);
  return createSeedNetwork({
    nodeCount: clampInteger(options.nodeCount, 200),
    mode: options.mode ?? '2d',
    layout: options.layout ?? 'gpu-force',
  });
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

function encodeBinaryForJson(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return {
      __heliosBinary: 'base64',
      type: value.constructor?.name ?? 'Uint8Array',
      byteLength: bytes.byteLength,
      data: btoa(binary),
    };
  }
  if (Array.isArray(value)) return value.map((entry) => encodeBinaryForJson(entry));
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = encodeBinaryForJson(entry);
  return out;
}

function decodeBinaryFromJson(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (value.__heliosBinary === 'base64') return base64ToUint8Array(value.data ?? '');
  if (Array.isArray(value)) return value.map((entry) => decodeBinaryFromJson(entry));
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = decodeBinaryFromJson(entry);
  return out;
}

class CliStorageClient {
  constructor({ baseUrl = '' } = {}) {
    this.baseUrl = baseUrl;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
    });
    const payload = decodeBinaryFromJson(await response.json().catch(() => null));
    if (!response.ok) {
      throw new Error(payload?.error ?? `CLI storage request failed with HTTP ${response.status}`);
    }
    return payload;
  }

  putSession(record) {
    return this.request('/api/storage/session', {
      method: 'POST',
      body: JSON.stringify(encodeBinaryForJson(record)),
    });
  }

  getSession(id) {
    return this.request(`/api/storage/session/${encodeURIComponent(String(id))}`)
      .catch((error) => {
        if (String(error?.message ?? '').includes('not-found')) return null;
        throw error;
      });
  }

  listSessions() {
    return this.request('/api/storage/sessions');
  }

  deleteSession(id) {
    return this.request(`/api/storage/session/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
      .then((result) => result.deleted === true);
  }

  getUnfinishedSessionId(workspaceId = null) {
    const query = workspaceId == null ? '' : `?workspaceId=${encodeURIComponent(String(workspaceId))}`;
    return this.request(`/api/storage/unfinished${query}`).then((result) => result.sessionId ?? null);
  }

  setUnfinishedSessionId(id, workspaceId = null) {
    return this.request('/api/storage/unfinished', {
      method: 'PUT',
      body: JSON.stringify({ sessionId: id ?? null, workspaceId }),
    }).then((result) => result.sessionId ?? null);
  }
}

function getNetworkStats(helios) {
  const network = helios.network;
  const typeNames = new Map(Object.entries(AttributeType).map(([name, value]) => [value, name]));
  const serializeInfo = (name, info) => {
    const type = info?.type ?? AttributeType.Unknown;
    return {
      name,
      type,
      typeName: typeNames.get(type) ?? `Unknown(${type})`,
      dimension: Number(info?.dimension ?? 1),
      complex: info?.complex === true,
      categorical: type === AttributeType.Category || type === AttributeType.MultiCategory,
      stringLike: type === AttributeType.String,
    };
  };
  const inspectScope = (scope) => {
    const names = network?.[`get${scope}AttributeNames`]?.() ?? [];
    return names.map((name) => serializeInfo(name, network?.[`get${scope}AttributeInfo`]?.(name)));
  };
  return {
    nodeCount: network?.nodeCount ?? 0,
    edgeCount: network?.edgeCount ?? 0,
    directed: Boolean(network?.directed),
    nodeAttributes: network?.getNodeAttributeNames?.() ?? [],
    edgeAttributes: network?.getEdgeAttributeNames?.() ?? [],
    networkAttributes: network?.getNetworkAttributeNames?.() ?? [],
    attributes: {
      node: inspectScope('Node'),
      edge: inspectScope('Edge'),
      network: inspectScope('Network'),
    },
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

function findOptionalBehavior(helios, id) {
  return helios.getBehavior?.(id) ?? helios.behaviors?.get?.(id) ?? helios.behavior?.[id] ?? null;
}

function sanitizeFigureRpcOptions(params = {}) {
  const {
    outputPath,
    useCurrentOptions,
    current,
    ...options
  } = params && typeof params === 'object' ? params : {};
  return options;
}

function resolveFigureRpcOptions(helios, params = {}) {
  const exporter = findOptionalBehavior(helios, 'exporter');
  const options = sanitizeFigureRpcOptions(params);
  const useCurrentOptions = params.useCurrentOptions === true || params.current === true;
  if (useCurrentOptions && typeof exporter?.getResolvedOptions === 'function') {
    return exporter.getResolvedOptions(options);
  }
  if (typeof helios?._resolveFigureExportOptions === 'function') {
    return helios._resolveFigureExportOptions(options);
  }
  return options;
}

async function exportFigureRpcBlob(helios, params = {}) {
  const exporter = findOptionalBehavior(helios, 'exporter');
  const options = sanitizeFigureRpcOptions(params);
  const useCurrentOptions = params.useCurrentOptions === true || params.current === true;
  if (useCurrentOptions && typeof exporter?.exportBlob === 'function') {
    return exporter.exportBlob(options);
  }
  return helios.exportFigureBlob(resolveFigureRpcOptions(helios, params));
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
  setRegisteredCliState(helios, [`${id}.enabled`, `behaviors.${id}.enabled`], value, {
    reason: options.reason ?? 'behaviors.setEnabled',
    scope: options.scope ?? 'session',
    trackOverride: options.trackOverride,
  });
  helios.requestRender?.();
  return serializeBehavior(helios.getBehavior?.(id) ?? helios.behaviors?.get?.(id) ?? behavior);
}

function flattenObjectLeaves(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return prefix ? [[prefix, value]] : [];
  }
  const leaves = [];
  for (const [key, entry] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && !ArrayBuffer.isView(entry)) {
      const childLeaves = flattenObjectLeaves(entry, next);
      if (childLeaves.length > 0) leaves.push(...childLeaves);
      else leaves.push([next, entry]);
    } else {
      leaves.push([next, entry]);
    }
  }
  return leaves;
}

function setRegisteredCliState(helios, candidates, value, options = {}) {
  for (const candidate of candidates) {
    if (!candidate || !helios.states?.entry?.(candidate)) continue;
    return helios.states.set(candidate, value, {
      source: 'cli',
      reason: options.reason ?? 'cli-rpc',
      scope: options.scope ?? 'session',
      trackOverride: options.trackOverride !== false,
      applyBinding: options.applyBinding !== false,
      debounceMs: options.debounceMs ?? 0,
    });
  }
  return null;
}

function trackBehaviorOptionOverrides(helios, id, options = {}, detail = {}) {
  const tracked = [];
  for (const [path, value] of flattenObjectLeaves(options)) {
    const result = setRegisteredCliState(helios, [
      `${id}.${path}`,
      `behaviors.${id}.${path}`,
    ], value, {
      reason: detail.reason ?? `behaviors.${id}`,
      scope: detail.scope ?? 'session',
      trackOverride: detail.trackOverride,
      applyBinding: false,
    });
    if (result?.key) tracked.push(result.key);
  }
  return tracked;
}

function assignNested(target, path, value) {
  const parts = String(path).split('.').filter(Boolean);
  let cursor = target;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  if (parts.length === 1) cursor[parts[0]] = value;
}

function applyAppearanceOverridesFromState(helios, overrides = {}) {
  const patch = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.startsWith('appearance.')) continue;
    assignNested(patch, key.slice('appearance.'.length), value);
  }
  if (Object.keys(patch).length === 0) return null;
  const behavior = helios.useBehavior?.('appearance', patch) ?? helios.behavior?.appearance;
  if (behavior && typeof behavior.update === 'function') behavior.update(patch);
  helios.requestRender?.();
  return patch;
}

function reapplyRestoredStateBindings(helios, reason = 'cli-post-restore-bindings') {
  const overrides = helios.states?.getOverrides?.({ aliases: false });
  const preferredOverrides = helios.states?.getOverrides?.({ aliases: 'preferred' });
  if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) return null;
  const restored = helios.states?.restore?.(overrides, {
    source: 'restore',
    reason,
    trackOverride: true,
  });
  applyAppearanceOverridesFromState(helios, preferredOverrides ?? {});
  return restored;
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
  const graphLayer = helios.renderer?.graphLayer ?? null;
  return {
    mode: helios.mode(),
    renderer: helios.renderer?.device?.type ?? null,
    rendererState: graphLayer ? {
      propagateHoveredNodeToEdges: graphLayer.propagateHoveredNodeToEdges === true,
      propagateSelectedNodesToEdges: graphLayer.propagateSelectedNodesToEdges === true,
      nodeNoStateStyleEnabled: graphLayer.nodeNoStateStyleEnabled === true,
      edgeNoStateStyleEnabled: graphLayer.edgeNoStateStyleEnabled === true,
    } : null,
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

function createCliPersistence({ helios, config }) {
  const sessionId = config.sessionId ?? new URLSearchParams(window.location.search).get('sessionId') ?? 'unknown';
  const persistenceId = cliPersistenceId(sessionId);
  let saveTimer = null;
  let pendingSave = Promise.resolve(null);

  const save = async (options = {}) => {
    if (options.enabled === false) return null;
    const storage = helios.storage;
    if (!storage?.capabilities?.sessions) return { saved: false, id: persistenceId, reason: 'storage-unavailable' };
    const includeNetwork = options.fullSession !== false && options.includeNetwork !== false;
    const captureThumbnail = Object.hasOwn(options, 'captureThumbnail') && options.captureThumbnail !== undefined
      ? options.captureThumbnail
      : includeNetwork ? true : 'auto';
    const envelope = await storage.flush({
      id: persistenceId,
      reason: options.reason ?? 'cli-save',
      includeNetwork,
      includePositions: options.includePositions === true || includeNetwork,
      snapshotLayoutRuntime: options.snapshotLayoutRuntime === true,
      networkFormat: options.networkFormat ?? 'zxnet',
      captureThumbnail,
      thumbnail: options.thumbnail ?? options.sessionThumbnail,
      fullVisualizationState: options.fullVisualizationState === true,
    });
    const thumbnail = envelope?.payload?.thumbnail ?? null;
    return {
      storage: 'cli-filesystem',
      id: envelope?.id ?? envelope?.payload?.session?.id ?? storage.sessionId ?? persistenceId,
      updatedAt: envelope?.payload?.session?.updatedAt ?? Date.now(),
      session: envelope?.payload?.session ?? null,
      thumbnail: thumbnail ? {
        type: thumbnail.type ?? null,
        encoding: thumbnail.encoding ?? null,
        width: thumbnail.width ?? null,
        height: thumbnail.height ?? null,
        byteLength: thumbnail.byteLength ?? null,
        capturedAt: thumbnail.capturedAt ?? null,
        dataUrl: Boolean(thumbnail.dataUrl),
      } : null,
      networkData: envelope?.payload?.networkData ? {
        ...envelope.payload.networkData,
        data: undefined,
        byteLength: envelope.payload.networkData.byteLength
          ?? envelope.payload.networkData.data?.byteLength
          ?? null,
      } : null,
      positionData: envelope?.payload?.positionData ? {
        ...envelope.payload.positionData,
        data: undefined,
        byteLength: envelope.payload.positionData.byteLength
          ?? envelope.payload.positionData.data?.byteLength
          ?? null,
        storedByteLength: envelope.payload.positionData.storedByteLength
          ?? envelope.payload.positionData.data?.byteLength
          ?? null,
      } : null,
    };
  };

  const scheduleSave = (options = {}) => {
    if (options.enabled === false) return pendingSave;
    const delay = Number.isFinite(options.delayMs) ? Math.max(0, Number(options.delayMs)) : 500;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      pendingSave = save(options);
    }, delay);
    return pendingSave;
  };

  const restore = async (options = {}) => {
    const restored = await helios.storage?.restoreSession?.(persistenceId, {
      markFinished: false,
      disposeOld: true,
      recreateRenderer: true,
      restoreVisualizationState: options.restoreVisualizationState,
      reason: options.reason ?? 'cli-session-restore',
    });
    if (restored) {
      helios.requestRender?.();
      return {
        storage: 'cli-filesystem',
        id: restored?.id ?? restored?.payload?.session?.id ?? persistenceId,
        updatedAt: restored?.payload?.session?.updatedAt ?? null,
      };
    }
    return null;
  };

  const clear = async () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    await helios.storage?.deleteSession?.(persistenceId);
    return { cleared: true, id: persistenceId };
  };

  const flush = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      pendingSave = save({ fullSession: false });
    }
    return pendingSave;
  };

  return {
    id: persistenceId,
    save,
    scheduleSave,
    restore,
    clear,
    flush,
    isRestoring: () => false,
  };
}

async function waitForSessionBaselineIdle() {
  if (typeof requestAnimationFrame !== 'function') {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return;
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 150));
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

const MUTATING_METHODS = new Set([
  'network.attributeSet',
  'network.loadPayload',
  'network.replace',
  'scene.requestRender',
  'scene.setMode',
  'camera.setPose',
  'camera.transition',
  'camera.frame',
  'camera.controls',
  'camera.targetNodes',
  'layout.set',
  'layout.setParameters',
  'layout.applyPositionAttribute',
  'layout.start',
  'layout.stop',
  'mappers.set',
  'mappers.reset',
  'behaviors.use',
  'behaviors.detach',
  'behaviors.setEnabled',
  'behaviors.update',
  'behaviors.restore',
  'behaviors.call',
  'positions.set',
  'positions.fromAttribute',
  'filters.set',
  'filters.clear',
  'labels.set',
  'legends.set',
  'density.set',
  'metrics.measure',
  'aesthetic.measure',
]);

class BrowserBridge {
  constructor(socket, helios, ui) {
    this.socket = socket;
    this.helios = helios;
    this.ui = ui;
    this.persistence = window.__HELIOS_CLI_PERSISTENCE__ ?? null;
    this.checkpointSeq = 0;
    this.handlers = this.buildHandlers();
    this.unsubscribers = [];
    this.bindEvents();
    setTimeout(() => this.snapshotPersistenceState('bridge-ready'), 0);
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

    if (this.persistence) {
      const schedule = () => this.persistence.scheduleSave({ fullSession: false, delayMs: 750 });
      for (const behavior of this.helios.behaviors?.values?.() ?? []) {
        if (typeof behavior?.on === 'function') this.unsubscribers.push(behavior.on('change', schedule));
      }
      this.unsubscribers.push(this.helios.on(EVENTS.MODE_CHANGED, schedule));
      this.unsubscribers.push(this.helios.on(EVENTS.NETWORK_REPLACED, schedule));
      this.unsubscribers.push(this.helios.on(EVENTS.GRAPH_FILTER_CHANGED, schedule));
      this.unsubscribers.push(this.helios.on(EVENTS.LAYOUT_STOP, schedule));
      this.unsubscribers.push(this.helios.on(EVENTS.CAMERA_MOVE, () => {
        this.persistence.scheduleSave({ fullSession: false, delayMs: 1000 });
      }));
    }
  }

  notify(method, params) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  snapshotPersistenceState(reason = 'snapshot') {
    const status = this.helios.storage?.persistenceStatus?.() ?? null;
    const overrides = this.helios.states?.getOverrides?.({ aliases: 'preferred' }) ?? {};
    const dirtyState = this.helios.states?.dirtyState?.() ?? { controls: {}, sections: {}, panels: {} };
    const journal = this.helios.states?.journal ?? [];
    this.notify('bridge.event', {
      type: 'persistence.snapshot',
      detail: {
        reason,
        persistenceId: this.persistence?.id ?? status?.sessionId ?? null,
        storage: {
          cli: 'filesystem',
        },
        status,
        backendStatus: [],
        overrides,
        dirtyState,
        journal,
        checkpointSeq: this.checkpointSeq,
        networkData: status?.networkData ?? null,
        savedAt: Date.now(),
      },
    });
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
      const mutates = MUTATING_METHODS.has(message.method);
      const execute = () => handler(message.params ?? {});
      const result = await execute();
      const networkMutation = message.method === 'network.attributeSet'
        || message.method === 'network.loadPayload'
        || message.method === 'network.replace';
      const positionMutation = message.method === 'positions.set'
        || message.method === 'positions.fromAttribute'
        || message.method === 'layout.applyPositionAttribute';
      if (mutates) {
        if (networkMutation) {
          this.helios.storage?.markNetworkDirty?.(message.method);
        }
        if (positionMutation) {
          this.helios.storage?.markPositionsDirty?.(message.method);
        }
      }
      if (this.persistence && mutates) {
        await this.persistence.save({
          fullSession: networkMutation,
          includePositions: positionMutation,
          reason: message.method,
        });
        this.snapshotPersistenceState(message.method);
      }
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
    const readPersistenceStatus = () => {
      const status = this.helios.storage?.persistenceStatus?.() ?? null;
      if (!status) return null;
      const journal = this.helios.states?.journal ?? [];
      const maxSeq = Math.max(0, ...journal.map((entry) => Number(entry.seq ?? 0)));
      const dirtyByJournal = maxSeq > this.checkpointSeq;
      const networkData = status.networkData ?? {};
      return {
        ...status,
        backendStatus: [],
        journalCount: maxSeq,
        checkpointSeq: this.checkpointSeq,
        hasUnsavedChanges: dirtyByJournal
          || networkData.dirty === true
          || networkData.positionsDirty === true
          || status.sessionSync?.pending === true,
      };
    };
    const stateJournal = (params = {}) => {
      let entries = Array.isArray(this.helios.states?.journal) ? this.helios.states.journal : [];
      if (params.sinceCheckpoint !== false) {
        entries = entries.filter((entry) => Number(entry.seq ?? 0) > this.checkpointSeq);
      }
      if (params.since != null) {
        entries = entries.filter((entry) => Number(entry.seq ?? 0) > Number(params.since));
      }
      if (params.source) entries = entries.filter((entry) => entry.source === params.source);
      if (Number.isFinite(params.limit)) entries = entries.slice(-Math.max(0, Number(params.limit)));
      const aliases = params.aliases ?? 'preferred';
      return cloneJsonSafe(entries.map((entry) => {
        if (!(aliases === true || aliases === 'preferred')) return entry;
        const preferred = this.helios.states?.preferredKey?.(entry.key ?? entry.path);
        if (!preferred || preferred === entry.path) return entry;
        return { ...entry, canonicalPath: entry.path, path: preferred };
      }));
    };
    return {
      'session.getInfo': async () => getSceneState(this.helios),
      'state.get': async (params) => {
        const path = params.path ?? params.key ?? null;
        if (!path) {
          return {
            snapshot: cloneJsonSafe(this.helios.states?.snapshot?.({ aliases: params.aliases ?? 'preferred', includeJournal: params.includeJournal === true }) ?? null),
            status: readPersistenceStatus(),
          };
        }
        return {
          path,
          value: cloneJsonSafe(this.helios.states?.get?.(path)),
          status: cloneJsonSafe(this.helios.states?.status?.(path) ?? null),
          entry: cloneJsonSafe(this.helios.states?.entry?.(path) ?? null),
        };
      },
      'state.set': async (params) => {
        const path = params.path ?? params.key;
        if (!path) throw new Error('state.set requires params.path');
        const result = this.helios.states?.set?.(path, params.value, {
          source: 'cli',
          reason: params.reason ?? 'cli-state-set',
          scope: params.scope ?? 'session',
          trackOverride: params.trackOverride !== false,
          debounceMs: params.debounceMs ?? 0,
        });
        await this.persistence?.save?.({ fullSession: false, reason: params.reason ?? 'state.set' });
        this.snapshotPersistenceState('state.set');
        return {
          result: cloneJsonSafe(result),
          value: cloneJsonSafe(this.helios.states?.get?.(path)),
          status: cloneJsonSafe(this.helios.states?.status?.(path) ?? null),
        };
      },
      'state.reset': async (params) => {
        const path = params.path ?? params.key ?? params.scope;
        if (!path) throw new Error('state.reset requires params.path');
        const result = this.helios.states?.reset?.(path, {
          source: 'cli',
          reason: params.reason ?? 'cli-state-reset',
        });
        await this.persistence?.save?.({ fullSession: false, reason: params.reason ?? 'state.reset' });
        this.snapshotPersistenceState('state.reset');
        return cloneJsonSafe(result);
      },
      'persistence.get': async () => ({
        id: this.persistence?.id ?? null,
        available: Boolean(this.persistence),
        status: readPersistenceStatus(),
        backendStatus: [],
      }),
      'persistence.save': async (params) => {
        const result = await (this.persistence?.save({
          fullSession: params.fullSession !== false,
          networkFormat: params.networkFormat ?? 'zxnet',
          captureThumbnail: Object.hasOwn(params, 'captureThumbnail') ? params.captureThumbnail : undefined,
          thumbnail: params.thumbnail ?? params.sessionThumbnail,
        }) ?? { saved: false });
        this.snapshotPersistenceState('persistence.save');
        return result;
      },
      'persistence.restore': async (params) => {
        const result = await (this.persistence?.restore(params) ?? { restored: false });
        this.snapshotPersistenceState('persistence.restore');
        return result;
      },
      'persistence.clear': async () => {
        const result = await (this.persistence?.clear() ?? { cleared: false });
        this.snapshotPersistenceState('persistence.clear');
        return result;
      },
      'persistence.changes': async (params) => stateJournal(params),
      'persistence.checkpoint': async (params) => {
        const maxSeq = Math.max(0, ...((this.helios.states?.journal ?? []).map((entry) => Number(entry.seq ?? 0))));
        this.checkpointSeq = Number.isFinite(Number(params.seq)) ? Number(params.seq) : maxSeq;
        const result = { checkpointSeq: this.checkpointSeq };
        this.snapshotPersistenceState('persistence.checkpoint');
        return result;
      },
      'persistence.overrides': async () => ({
        overrides: this.helios.states?.getOverrides?.({ aliases: 'preferred' }) ?? {},
        dirtyState: this.helios.states?.dirtyState?.() ?? { controls: {}, sections: {}, panels: {} },
      }),
      'persistence.reset': async (params) => {
        const result = this.helios.states?.reset?.(params.path ?? params.scope, {
          source: 'cli',
          reason: params.reason ?? 'persistence.reset',
        }) ?? { reset: false };
        await this.persistence?.save?.({ fullSession: false, reason: 'persistence.reset' });
        this.snapshotPersistenceState('persistence.reset');
        return result;
      },
      'persistence.flush': async (params) => {
        const result = await (this.helios.storage?.flush?.({
          includeNetwork: params.includeNetwork === true,
          includePositions: params.includePositions === true,
          snapshotLayoutRuntime: params.snapshotLayoutRuntime !== false,
          network: params.network ?? {},
          networkFormat: params.networkFormat ?? params.network?.format ?? 'zxnet',
          captureThumbnail: params.captureThumbnail,
          thumbnail: params.thumbnail ?? params.sessionThumbnail,
          reason: params.reason ?? 'persistence.flush',
        }) ?? null);
        this.snapshotPersistenceState('persistence.flush');
        return result;
      },
      'persistence.status': async () => readPersistenceStatus(),
      'persistence.backendStatus': async () => [],
      'persistence.exportDocumentState': async (params) => cloneJsonSafe(
        await this.helios.storage?.serializeNetworkSnapshot?.({
          reason: params.reason ?? 'desktop-document-save',
          includeCurrentPositions: params.includeCurrentPositions !== false,
          trackedOnly: params.trackedOnly !== false,
          fullVisualizationState: params.fullVisualizationState === true,
        }) ?? null,
      ),
      'persistence.restoreDocumentState': async (params) => {
        const snapshot = params.visualizationState ?? params.snapshot ?? params;
        if (!snapshot) return null;
        if (this.helios.importVisualizationState) {
          await this.helios.importVisualizationState(snapshot, {
            restoreLayoutRunState: params.restoreLayoutRunState !== false,
            hydratePersistence: false,
            refreshPersistence: false,
            source: 'restore',
            reason: params.reason ?? 'desktop-document-restore',
          });
        } else if (snapshot?.payload?.storageState) {
          this.helios.storage?.restoreSnapshot?.(snapshot.payload.storageState, {
            source: 'restore',
            reason: params.reason ?? 'desktop-document-restore',
          });
        }
        reapplyRestoredStateBindings(this.helios, 'desktop-document-restore-bindings');
        this.helios.requestRender?.();
        this.snapshotPersistenceState('persistence.restoreDocumentState');
        return { restored: true };
      },
      'persistence.documentSaved': async (params) => {
        const storage = this.helios.storage ?? null;
        const maxSeq = Math.max(0, ...((this.helios.states?.journal ?? []).map((entry) => Number(entry.seq ?? 0))));
        this.checkpointSeq = maxSeq;
        if (storage?.networkData) {
          const savedAt = Date.now();
          storage.sessionSavedAt = savedAt;
          storage.sessionSaveError = null;
          storage.networkData = {
            ...storage.networkData,
            enabled: true,
            status: 'saved',
            dirty: false,
            positionsDirty: false,
            dirtyAt: null,
            savedAt,
            format: params.format ?? storage.networkData.format ?? null,
            documentPath: params.filePath ?? storage.networkData.documentPath ?? null,
          };
          storage._pendingStateOverrideDeltas?.clear?.();
          storage.dispatchEvent?.(new CustomEvent('change', {
            detail: { reason: params.reason ?? 'document-saved', status: storage.persistenceStatus?.() ?? null },
          }));
        }
        this.snapshotPersistenceState(params.reason ?? 'persistence.documentSaved');
        return readPersistenceStatus();
      },
      'network.stats': async () => getNetworkStats(this.helios),
      'network.inspect': async () => getNetworkStats(this.helios),
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
          const network = await createSyntheticNetwork({
            ...params.synthetic,
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
        const blob = await this.helios.savePortableNetwork(format, {
          output: 'blob',
          includeVisualization: params.includeVisualization === true,
          trackedOnly: params.trackedOnly === true,
          includeCurrentPositions: params.includeCurrentPositions === true,
          fullVisualizationState: params.fullVisualizationState === true,
        });
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
        await this.helios.setMode(params.mode, {
          ...(params.options ?? {}),
          source: 'cli',
          reason: params.reason ?? 'scene.setMode',
          trackOverride: params.trackOverride ?? true,
        });
        return getSceneState(this.helios);
      },
      'camera.getPose': async () => cloneJsonSafe(this.helios.cameraPose()),
      'camera.setPose': async (params) => {
        this.helios.setCameraPose(params.pose ?? params, {
          ...(params.options ?? {}),
          source: 'cli',
          reason: params.reason ?? 'camera.setPose',
        });
        return cloneJsonSafe(this.helios.cameraPose());
      },
      'camera.transition': async (params) => {
        await this.helios.transitionCamera(params.pose ?? params, {
          ...(params.options ?? {}),
          source: 'cli',
          reason: params.reason ?? 'camera.transition',
        });
        return cloneJsonSafe(this.helios.cameraPose());
      },
      'camera.frame': async (params) => {
        const ok = this.helios.frameNetwork(params ?? {});
        return { ok, pose: cloneJsonSafe(this.helios.cameraPose()) };
      },
      'camera.controls': async (params) => {
        if (!params || Object.keys(params).length === 0) return cloneJsonSafe(this.helios.cameraControls());
        this.helios.cameraControls(params, {
          source: 'cli',
          reason: params.reason ?? 'camera.controls',
        });
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
        const key = params.layout ?? params.key;
        if (this.helios.states?.entry?.('layout.layoutType')) {
          this.helios.states.set('layout.layoutType', normalizeLayoutKey(key), {
            source: 'cli',
            reason: params.reason ?? 'layout.set',
            scope: params.scope ?? 'network',
            trackOverride: params.trackOverride !== false,
          });
          return getLayoutState(this.helios);
        }
        const instance = this.helios.createLayout(buildLayoutOptions(this.helios, key));
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
        for (const [mode, descriptor] of [['node', params.nodeMapper], ['edge', params.edgeMapper]]) {
          if (!descriptor || typeof descriptor !== 'object') continue;
          for (const [channel, config] of Object.entries(descriptor)) {
            setRegisteredCliState(this.helios, [
              `mappers.${mode}.${channel}`,
              `behaviors.mappers.${mode}.${channel}`,
            ], cloneJsonSafe(config), {
              reason: params.reason ?? 'mappers.set',
              scope: params.scope ?? 'network',
              trackOverride: params.trackOverride,
              applyBinding: false,
            });
          }
        }
        return {
          node: serializeMapperCollection(this.helios.nodeMapper),
          edge: serializeMapperCollection(this.helios.edgeMapper),
        };
      },
      'mappers.reset': async () => {
        this.helios.mappers({ nodeMapper: null, edgeMapper: null });
        this.helios.states?.reset?.('mappers', { source: 'cli', reason: 'mappers.reset' });
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
        trackBehaviorOptionOverrides(this.helios, id, params.options ?? {}, {
          reason: params.reason ?? 'behaviors.update',
          scope: params.scope,
          trackOverride: params.trackOverride,
        });
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
        setRegisteredCliState(this.helios, ['filters.rules', 'behaviors.filter.rules'], cloneJsonSafe(params), {
          reason: params.reason ?? 'filters.set',
          scope: params.scope ?? 'network',
          trackOverride: params.trackOverride,
        });
        return cloneJsonSafe(this.helios.getGraphFilter());
      },
      'filters.clear': async () => {
        this.helios.clearGraphFilter();
        this.helios.states?.reset?.('filters', { source: 'cli', reason: 'filters.clear' });
        return cloneJsonSafe(this.helios.getGraphFilter());
      },
      'labels.get': async () => cloneJsonSafe(this.helios.labels()),
      'labels.set': async (params) => {
        this.helios.labels(params);
        for (const [path, value] of flattenObjectLeaves(params)) {
          setRegisteredCliState(this.helios, [`labels.${path}`, `behaviors.labels.${path}`], cloneJsonSafe(value), {
            reason: params.reason ?? 'labels.set',
            scope: params.scope ?? 'network',
            trackOverride: params.trackOverride,
          });
        }
        return cloneJsonSafe(this.helios.labels());
      },
      'legends.get': async () => cloneJsonSafe(this.helios.legends()),
      'legends.set': async (params) => {
        this.helios.legends(params);
        for (const [path, value] of flattenObjectLeaves(params)) {
          setRegisteredCliState(this.helios, [`legends.${path}`, `behaviors.legends.${path}`], cloneJsonSafe(value), {
            reason: params.reason ?? 'legends.set',
            scope: params.scope ?? 'network',
            trackOverride: params.trackOverride,
          });
        }
        return cloneJsonSafe(this.helios.legends());
      },
      'density.get': async () => cloneJsonSafe(this.helios.density()),
      'density.set': async (params) => {
        this.helios.density(params);
        for (const [path, value] of flattenObjectLeaves(params)) {
          setRegisteredCliState(this.helios, [`density.${path}`, `behaviors.density.${path}`], cloneJsonSafe(value), {
            reason: params.reason ?? 'density.set',
            scope: params.scope ?? 'network',
            trackOverride: params.trackOverride,
          });
        }
        return cloneJsonSafe(this.helios.density());
      },
      'metrics.measure': async (params) => measureNetworkMetric(this.helios.network, params),
      'aesthetic.measure': async (params) => measureNetworkMetric(this.helios.network, params),
      'picking.pick': async (params) => this.helios.pickAttributesAt(params.x, params.y),
      'export.figurePayload': async (params) => {
        const resolved = resolveFigureRpcOptions(this.helios, params);
        const blob = await exportFigureRpcBlob(this.helios, params);
        return {
          format: resolved.format ?? params.format ?? 'png',
          mimeType: blob.type || 'application/octet-stream',
          filename: params.filename ?? resolved.filename ?? `figure.${resolved.format ?? params.format ?? 'png'}`,
          base64: await blobToBase64(blob),
        };
      },
      'export.figureOptions': async (params) => {
        const exporter = findOptionalBehavior(this.helios, 'exporter');
        return {
          options: cloneJsonSafe(resolveFigureRpcOptions(this.helios, params)),
          state: cloneJsonSafe(exporter?.getPublicState?.() ?? null),
        };
      },
      'events.subscribe': async () => ({ supported: true }),
      'events.unsubscribe': async () => ({ supported: true }),
    };
  }
}

async function bootstrap() {
  const config = await fetch('/api/config').then((response) => response.json());
  const sessionId = config.sessionId ?? new URLSearchParams(window.location.search).get('sessionId') ?? 'unknown';
  const persistenceId = cliPersistenceId(sessionId);
  const desktopRuntime = isDesktopRuntime(config);
  const network = await createSeedNetwork({
    mode: config.mode === '3d' ? '3d' : '2d',
    layout: config.layout,
  });
  const helios = new Helios(network, {
    container: document.getElementById('app'),
    mode: config.mode === '3d' ? '3d' : '2d',
    clearColor: [0, 0, 0, 1],
    projection: 'perspective',
    ui: false,
    layout: buildLayoutOptions({ network, mode: () => config.mode }, config.layout),
    renderer: resolveRendererPreference(config.renderer) ?? undefined,
    workspaceId: persistenceId,
    storage: desktopRuntime
      ? {
          type: 'dummy',
          workspaceId: persistenceId,
          sessionId: persistenceId,
          restore: false,
          persistNetwork: false,
          networkPersistence: { enabled: true, autosave: false, format: 'zxnet' },
          positionPersistence: { enabled: true, autosave: false },
          autosyncPayloadLimits: config.autosyncPayloadLimits,
        }
      : {
          type: 'remote',
          workspaceId: persistenceId,
          sessionId: persistenceId,
          restore: false,
          persistNetwork: true,
          client: new CliStorageClient(),
          networkPersistence: { enabled: true, autosave: true, format: 'zxnet' },
          positionPersistence: { enabled: true, autosave: true },
          autosyncPayloadLimits: config.autosyncPayloadLimits,
        },
    networkPersistence: { enabled: true, autosave: !desktopRuntime, format: 'zxnet' },
    positionPersistence: { enabled: true, autosave: !desktopRuntime },
    persistNetwork: !desktopRuntime,
    sessionThumbnail: { enabled: true },
    session: {
      id: persistenceId,
      sessionId: persistenceId,
      saveInitialManifest: true,
      restore: !desktopRuntime,
      networkPersistence: { enabled: true, autosave: !desktopRuntime, format: 'zxnet' },
    },
    persistence: false,
  });
  await helios.ready;
  const ui = new HeliosUI({ helios, theme: 'dark', allowDrag: true });
  window.__helios = helios;
  window.__heliosUI = ui;
  publishRuntimeState(helios);
  helios.on?.(EVENTS.MODE_CHANGED, () => publishRuntimeState(helios));
  const buildCliInterface = () => {
    ui.createDemoPanel({
      showNetworkFileActions: !desktopRuntime,
      showPersistenceSync: !desktopRuntime,
      showSessionTab: !desktopRuntime,
    });
    ui.createMetricsPanel();
    ui.createMappersPanel({ dock: 'top-right', position: { x: 16, y: 16 } });
    ui.createLayoutPanel({ dock: 'top-right', position: { x: 16, y: 360 } });
    ui.createLegendsPanel({ dock: 'top-right', position: { x: 16, y: 560 } });
    ui.createFilterPanel({ dock: 'top-right' });
    ui.createCameraPanel({ dock: 'top-right' });
    ui.createSelectionPanel({ dock: 'top-right' });
    helios.enableAttributeTracking('$index', '$index', {
      resolutionScale: 1,
      trackDepth: true,
      autoUpdate: true,
      autoUpdateMaxFps: 60,
    });
  };
  buildCliInterface();
  await waitForSessionBaselineIdle();
  helios.storage?.setOverrideTrackingReady?.(true);
  const persistence = createCliPersistence({ helios, config });
  window.__HELIOS_CLI_PERSISTENCE__ = persistence;
  const restored = desktopRuntime
    ? null
    : helios._sessionRestoreResult
    ? { storage: 'cli-filesystem', id: helios.storage?.persistenceStatus?.()?.sessionId ?? null }
    : await persistence.restore({ reason: 'page-load' });
  if (restored) {
    reapplyRestoredStateBindings(helios, 'cli-session-restore-bindings');
    console.info('Helios CLI restored persisted session state', restored);
  } else {
    await persistence.save({ fullSession: false });
  }
  window.addEventListener('beforeunload', () => {
    try {
      persistence.save({ fullSession: false });
    } catch (_) {
      // best-effort only during page teardown
    }
  });
  publishRuntimeState(helios);
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
