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
        if (params.nodeMapper) payload.nodeMapper = buildMapper('node', this.helios.network, params.nodeMapper);
        if (params.edgeMapper) payload.edgeMapper = buildMapper('edge', this.helios.network, params.edgeMapper);
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
