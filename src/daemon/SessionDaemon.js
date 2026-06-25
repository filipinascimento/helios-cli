import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createJsonLineParser, encodeMessage } from '../protocol/jsonl.js';
import { ensureClientBundle, ensureStateDirs } from '../shared/fs.js';
import { decodeBinaryFromJson, encodeBinaryForJson, FileSessionStore } from '../shared/fileSessionStore.js';
import { inferNetworkFormat } from '../shared/networkFormats.js';
import { clientDistDir, sessionSocketPath, sessionStatePath, stateRoot, storageSessionsDir } from '../shared/paths.js';
import {
  deleteSessionMeta,
  loadSessionState,
  saveSessionMeta,
  saveSessionState,
} from '../shared/sessionRegistry.js';

function mimeTypeForExtension(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.map': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

function encodeBufferBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function decodeBase64ToBuffer(value) {
  return Buffer.from(String(value ?? ''), 'base64');
}

function writableNetworkOutputPath(outputPath, format) {
  if (!outputPath) return outputPath;
  const normalizedFormat = String(format ?? '').toLowerCase();
  return normalizedFormat === 'gt' && String(outputPath).toLowerCase().endsWith('.gt.zst')
    ? outputPath.slice(0, -4)
    : outputPath;
}

function sanitizeDownloadFilename(value, fallback = 'helios-download') {
  const text = String(value ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_');
  return text || fallback;
}

async function uniqueDownloadPath(directory, filename) {
  const safeFilename = sanitizeDownloadFilename(filename);
  const extension = path.extname(safeFilename);
  const stem = extension ? safeFilename.slice(0, -extension.length) : safeFilename;
  let candidate = path.join(directory, safeFilename);
  for (let index = 1; index < 1000; index += 1) {
    try {
      await fs.access(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate;
      throw error;
    }
    candidate = path.join(directory, `${stem}-${index}${extension}`);
  }
  return path.join(directory, `${stem}-${Date.now()}${extension}`);
}

function normalizeLayoutValue(value, fallback = 'gpu-force') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'static' || normalized === 'none') return 'static';
  if (normalized === 'd3force3d' || normalized === 'd3-force-3d') return 'd3force3d';
  if (normalized === 'worker:jitter' || normalized === 'jitter') return 'worker:jitter';
  if (normalized === 'worker:force3d' || normalized === 'worker' || normalized === 'force3d') return 'worker:force3d';
  return 'gpu-force';
}

function normalizeActualRenderer(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'webgpu') return 'webgpu';
  if (normalized === 'webgl2' || normalized === 'webgl') return 'webgl2';
  return null;
}

export function evaluateManagedGpuPolicy({
  mode = 'headed',
  rendererPreference = 'auto',
  noGpu = false,
  actualRenderer = null,
  webgl = null,
  webgpu = null,
} = {}) {
  const normalizedRenderer = normalizeActualRenderer(actualRenderer);
  const webglHardware = Boolean(webgl?.hardware);
  const webgpuHardware = Boolean(webgpu && webgpu.isFallbackAdapter !== true);

  if (noGpu) {
    return {
      ok: true,
      actualRenderer: normalizedRenderer,
      fallbackUsed: false,
      allowSoftware: true,
      reason: 'GPU requirement disabled by --no-gpu',
    };
  }

  if (!webglHardware && !webgpuHardware) {
    return {
      ok: false,
      actualRenderer: normalizedRenderer,
      fallbackUsed: false,
      allowSoftware: false,
      reason: 'No hardware-accelerated WebGPU or WebGL renderer is available',
    };
  }

  if (rendererPreference === 'webgl') {
    if (normalizedRenderer !== 'webgl2' || !webglHardware) {
      return {
        ok: false,
        actualRenderer: normalizedRenderer,
        fallbackUsed: false,
        allowSoftware: false,
        reason: 'Renderer webgl requires a hardware-accelerated WebGL2 runtime',
      };
    }
    return {
      ok: true,
      actualRenderer: 'webgl2',
      fallbackUsed: false,
      allowSoftware: false,
      reason: null,
    };
  }

  if (rendererPreference === 'webgpu') {
    if (normalizedRenderer === 'webgpu' && webgpuHardware) {
      return {
        ok: true,
        actualRenderer: 'webgpu',
        fallbackUsed: false,
        allowSoftware: false,
        reason: null,
      };
    }
    if (mode === 'headless' && normalizedRenderer === 'webgl2' && webglHardware && !webgpuHardware) {
      return {
        ok: true,
        actualRenderer: 'webgl2',
        fallbackUsed: true,
        allowSoftware: false,
        reason: 'Headless session fell back from WebGPU to WebGL2 because WebGPU was unavailable',
      };
    }
    return {
      ok: false,
      actualRenderer: normalizedRenderer,
      fallbackUsed: false,
      allowSoftware: false,
      reason: mode === 'headless'
        ? 'Renderer webgpu requires hardware WebGPU or the allowed headless fallback to hardware WebGL2'
        : 'Renderer webgpu requires hardware WebGPU',
    };
  }

  if (normalizedRenderer === 'webgpu' && webgpuHardware) {
    return {
      ok: true,
      actualRenderer: 'webgpu',
      fallbackUsed: false,
      allowSoftware: false,
      reason: null,
    };
  }

  if (normalizedRenderer === 'webgl2' && webglHardware) {
    return {
      ok: true,
      actualRenderer: 'webgl2',
      fallbackUsed: false,
      allowSoftware: false,
      reason: null,
    };
  }

  return {
    ok: false,
    actualRenderer: normalizedRenderer,
    fallbackUsed: false,
    allowSoftware: false,
    reason: 'Renderer initialized without a supported hardware-accelerated backend',
  };
}

export class SessionDaemon {
  constructor(config = {}) {
    this.config = {
      mode: 'headed',
      open: false,
      renderer: 'webgpu',
      layout: 'gpu-force',
      runtime: 'cli',
      browserChannel: null,
      sessionId: null,
      networkPath: null,
      noGpu: false,
      ...config,
    };
    this.config.layout = normalizeLayoutValue(this.config.layout);
    this.sessionId = this.config.sessionId;
    this.socketPath = sessionSocketPath(this.sessionId);
    this.httpServer = null;
    this.wsServer = null;
    this.controlServer = null;
    this.browser = null;
    this.browserContext = null;
    this.browserPage = null;
    this.bridgeSocket = null;
    this.bridgeReady = false;
    this.bridgeRequests = new Map();
    this.bridgeWaiters = new Set();
    this.controlConnections = new Set();
    this.subscriptions = new Map();
    this.pendingStop = false;
    this.metadata = null;
    this.nextConnectionId = 1;
    this.gpu = null;
    this.sessionStore = new FileSessionStore();
  }

  async start() {
    await ensureStateDirs();
    await ensureClientBundle();
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
    if (process.platform !== 'win32') {
      try {
        await fs.unlink(this.socketPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    this.metadata = this.buildMetadata({ status: 'starting' });
    await saveSessionMeta(this.sessionId, this.metadata);
    await this.startHttpServer();
    await this.startBridgeServer();
    await this.startControlServer();
    if (this.config.mode === 'headed' || this.config.mode === 'headless') {
      await this.launchManagedBrowser();
    } else if (this.config.open) {
      await this.openExternalBrowser();
    }

    this.metadata = this.buildMetadata({ status: 'ready' });
    await saveSessionMeta(this.sessionId, this.metadata);

    if (this.config.networkPath) {
      this.waitForBridge({ timeoutMs: 30_000 })
        .then(() => this.handleNetworkLoad({ path: this.config.networkPath }))
        .catch((error) => {
          this.emitEvent('session.warning', { message: error?.message ?? String(error) });
        });
    }
  }

  buildMetadata(extra = {}) {
    return {
      sessionId: this.sessionId,
      pid: process.pid,
      status: extra.status ?? this.metadata?.status ?? 'unknown',
      mode: this.config.mode,
      renderer: this.config.renderer,
      layout: this.config.layout,
      runtime: this.config.runtime,
      surface: this.config.surface ?? null,
      client: this.config.client ?? null,
      browserChannel: this.config.browserChannel ?? null,
      noGpu: this.config.noGpu === true,
      url: this.sessionUrl(),
      controlSocket: this.socketPath,
      sessionStatePath: sessionStatePath(this.sessionId),
      storageRoot: stateRoot,
      storageSessionsPath: storageSessionsDir,
      httpPort: this.httpPort ?? null,
      bridgeConnected: this.bridgeReady,
      gpu: extra.gpu ?? this.gpu ?? null,
      networkPath: this.config.networkPath ?? null,
      createdAt: this.metadata?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: extra.lastError ?? this.metadata?.lastError ?? null,
      persistence: extra.persistence ?? this.metadata?.persistence ?? null,
    };
  }

  sessionUrl() {
    const params = new URLSearchParams({ sessionId: this.sessionId });
    if (this.config.runtime && this.config.runtime !== 'cli') params.set('runtime', this.config.runtime);
    return `http://127.0.0.1:${this.httpPort}/?${params.toString()}`;
  }

  async updateMetadata(extra = {}) {
    this.metadata = this.buildMetadata(extra);
    await saveSessionMeta(this.sessionId, this.metadata);
  }

  async startHttpServer() {
    this.httpServer = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', this.sessionUrl());
        if (url.pathname.startsWith('/api/storage/')) {
          await this.handleStorageApi(request, response, url);
          return;
        }
        if (url.pathname === '/api/config') {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({
            sessionId: this.sessionId,
            renderer: this.config.renderer,
            layout: this.config.layout,
            runtime: this.config.runtime,
            mode: this.config.mode,
            noGpu: this.config.noGpu === true,
            storage: {
              type: 'remote',
              root: stateRoot,
              sessionsPath: storageSessionsDir,
            },
          }));
          return;
        }
        const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        const filePath = path.join(clientDistDir, relativePath);
        const normalized = path.normalize(filePath);
        if (!normalized.startsWith(clientDistDir)) {
          response.writeHead(403).end('Forbidden');
          return;
        }
        const body = await fs.readFile(normalized);
        response.writeHead(200, { 'content-type': mimeTypeForExtension(normalized) });
        response.end(body);
      } catch (error) {
        response.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error?.message ?? 'Server error');
      }
    });
    await new Promise((resolve) => this.httpServer.listen(0, '127.0.0.1', resolve));
    this.httpPort = this.httpServer.address().port;
  }

  async readJsonRequest(request, { maxBytes = 256 * 1024 * 1024 } = {}) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    if (chunks.length <= 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    return text.trim() ? JSON.parse(text) : {};
  }

  writeJsonResponse(response, statusCode, payload) {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(encodeBinaryForJson(payload)));
  }

  async handleStorageApi(request, response, url) {
    const method = request.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean);
    const resource = segments[2] ?? null;
    const id = segments[3] ? decodeURIComponent(segments.slice(3).join('/')) : null;

    if (resource === 'sessions' && method === 'GET') {
      this.writeJsonResponse(response, 200, await this.sessionStore.listSessions());
      return;
    }
    if (resource === 'session' && method === 'POST') {
      const payload = decodeBinaryFromJson(await this.readJsonRequest(request));
      this.writeJsonResponse(response, 200, await this.sessionStore.putSession(payload.record ?? payload));
      return;
    }
    if (resource === 'session' && id && method === 'GET') {
      const record = await this.sessionStore.getSession(id);
      this.writeJsonResponse(response, record ? 200 : 404, record ?? { error: 'not-found', id });
      return;
    }
    if (resource === 'session' && id && method === 'DELETE') {
      this.writeJsonResponse(response, 200, { deleted: await this.sessionStore.deleteSession(id), id });
      return;
    }
    if (resource === 'unfinished' && method === 'GET') {
      const workspaceId = url.searchParams.get('workspaceId');
      this.writeJsonResponse(response, 200, {
        sessionId: await this.sessionStore.getUnfinishedSessionId(workspaceId),
      });
      return;
    }
    if (resource === 'unfinished' && (method === 'PUT' || method === 'POST')) {
      const payload = await this.readJsonRequest(request);
      const sessionId = await this.sessionStore.setUnfinishedSessionId(payload.sessionId ?? payload.id ?? null, payload.workspaceId ?? null);
      this.writeJsonResponse(response, 200, { sessionId });
      return;
    }

    this.writeJsonResponse(response, 404, { error: 'unknown-storage-endpoint' });
  }

  async startBridgeServer() {
    this.wsServer = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', this.sessionUrl());
      if (url.pathname !== '/bridge') {
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(request, socket, head, (ws) => {
        this.wsServer.emit('connection', ws, request);
      });
    });
    this.wsServer.on('connection', (socket) => {
      this.attachBridgeSocket(socket);
    });
  }

  attachBridgeSocket(socket) {
    if (this.bridgeSocket && this.bridgeSocket !== socket) {
      try {
        this.bridgeSocket.close();
      } catch (_) {
        // ignore
      }
    }
    this.bridgeSocket = socket;
    this.bridgeReady = false;
    this.updateMetadata().catch(() => {});
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      this.handleBridgeMessage(message);
    });
    socket.on('close', () => {
      if (this.bridgeSocket === socket) {
        this.bridgeSocket = null;
        this.bridgeReady = false;
        this.updateMetadata().catch(() => {});
        this.emitEvent('bridge.disconnected', { sessionId: this.sessionId });
      }
    });
  }

  handleBridgeMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message ?? {}, 'id') && this.bridgeRequests.has(message.id)) {
      const pending = this.bridgeRequests.get(message.id);
      this.bridgeRequests.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? 'Bridge request failed');
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message?.method === 'bridge.ready') {
      this.bridgeReady = true;
      this.updateMetadata().catch(() => {});
      for (const waiter of this.bridgeWaiters) waiter.resolve(true);
      this.bridgeWaiters.clear();
      this.emitEvent('bridge.ready', message.params ?? {});
      return;
    }
    if (message?.method === 'bridge.event') {
      const type = message.params?.type ?? 'bridge.event';
      const detail = message.params?.detail ?? {};
      if (type === 'persistence.snapshot') {
        this.updateSessionState(detail).catch((error) => {
          this.emitEvent('session.warning', { message: error?.message ?? String(error) });
        });
      }
      this.emitEvent(type, detail);
    }
  }

  async updateSessionState(detail = {}) {
    const previous = await loadSessionState(this.sessionId);
    const state = {
      kind: 'helios-cli-session-state',
      version: 1,
      sessionId: this.sessionId,
      persistenceId: detail.persistenceId ?? previous?.persistenceId ?? this.sessionId,
      storage: detail.storage ?? previous?.storage ?? null,
      status: detail.status ?? previous?.status ?? null,
      overrides: detail.overrides ?? previous?.overrides ?? {},
      dirtyState: detail.dirtyState ?? previous?.dirtyState ?? { controls: {}, sections: {}, panels: {} },
      journal: Array.isArray(detail.journal) ? detail.journal : (previous?.journal ?? []),
      checkpointSeq: Number.isFinite(detail.checkpointSeq)
        ? Number(detail.checkpointSeq)
        : (previous?.checkpointSeq ?? 0),
      networkData: detail.networkData ?? previous?.networkData ?? null,
      savedAt: detail.savedAt ?? previous?.savedAt ?? null,
      updatedAt: new Date().toISOString(),
    };
    await saveSessionState(this.sessionId, state);
    await this.updateMetadata({
      persistence: {
        statePath: sessionStatePath(this.sessionId),
        overrideCount: state.status?.overrideCount ?? Object.keys(state.overrides ?? {}).length,
        journalCount: state.status?.journalCount ?? state.journal.length,
        checkpointSeq: state.checkpointSeq,
        networkData: state.networkData ?? null,
        updatedAt: state.updatedAt,
      },
    });
    return state;
  }

  async startControlServer() {
    this.controlServer = net.createServer((socket) => this.attachControlConnection(socket));
    await new Promise((resolve) => this.controlServer.listen(this.socketPath, resolve));
  }

  attachControlConnection(socket) {
    const connection = {
      id: this.nextConnectionId++,
      socket,
      subscriptions: new Set(),
    };
    this.controlConnections.add(connection);
    const parser = createJsonLineParser((message) => {
      this.handleControlMessage(connection, message).catch((error) => {
        socket.write(encodeMessage({
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: {
            code: -32000,
            message: error?.message ?? String(error),
          },
        }));
      });
    });
    socket.setEncoding('utf8');
    socket.on('data', parser);
    socket.on('close', () => {
      for (const subscriptionId of connection.subscriptions) {
        this.subscriptions.delete(subscriptionId);
      }
      this.controlConnections.delete(connection);
    });
  }

  async handleControlMessage(connection, message) {
    if (!message || typeof message !== 'object') return;
    const response = {
      jsonrpc: '2.0',
      id: message.id ?? null,
    };
    try {
      response.result = await this.dispatchMethod(connection, message.method, message.params ?? {});
    } catch (error) {
      response.error = {
        code: error?.code ?? -32000,
        message: error?.message ?? String(error),
        data: error?.data ?? null,
      };
      delete response.result;
    }
    connection.socket.write(encodeMessage(response));
  }

  async dispatchMethod(connection, method, params) {
    switch (method) {
      case 'session.getInfo':
        return this.buildMetadata();
      case 'session.getStateFile':
        return await loadSessionState(this.sessionId);
      case 'session.stop':
        setTimeout(() => {
          this.stop().catch(() => {});
        }, 0);
        return { stopping: true };
      case 'events.subscribe':
        return this.subscribe(connection, params);
      case 'events.unsubscribe':
        return this.unsubscribe(connection, params);
      case 'network.load':
        return this.handleNetworkLoad(params);
      case 'network.replace':
        return this.handleNetworkReplace(params);
      case 'network.save':
        return this.handleNetworkSave(params);
      case 'export.figure':
        return this.handleExportFigure(params);
      case 'browser.reload':
        return this.handleBrowserReload(params);
      default:
        return this.callBridge(method, params);
    }
  }

  subscribe(connection, params = {}) {
    const subscriptionId = params.subscriptionId ?? randomUUID();
    this.subscriptions.set(subscriptionId, { connection });
    connection.subscriptions.add(subscriptionId);
    return { subscriptionId };
  }

  unsubscribe(connection, params = {}) {
    const subscriptionId = params.subscriptionId;
    if (!subscriptionId) return { removed: false };
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry || entry.connection !== connection) return { removed: false };
    this.subscriptions.delete(subscriptionId);
    connection.subscriptions.delete(subscriptionId);
    return { removed: true };
  }

  emitEvent(type, detail) {
    const message = {
      jsonrpc: '2.0',
      method: 'events.notification',
      params: {
        type,
        detail,
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
      },
    };
    for (const { connection } of this.subscriptions.values()) {
      connection.socket.write(encodeMessage(message));
    }
  }

  async waitForBridge({ timeoutMs = 30_000 } = {}) {
    if (this.bridgeReady && this.bridgeSocket) return true;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.bridgeWaiters.delete(waiter);
        const error = new Error(`Timed out waiting for browser bridge in session ${this.sessionId}`);
        error.code = -32010;
        reject(error);
      }, timeoutMs);
      const waiter = {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      };
      this.bridgeWaiters.add(waiter);
    });
  }

  async callBridge(method, params = {}, { timeoutMs = 30_000 } = {}) {
    await this.waitForBridge({ timeoutMs });
    if (!this.bridgeSocket) {
      const error = new Error('Browser bridge is not connected');
      error.code = -32011;
      throw error;
    }
    const id = randomUUID();
    const payload = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.bridgeRequests.delete(id);
        const error = new Error(`Timed out waiting for browser bridge method ${method}`);
        error.code = -32012;
        reject(error);
      }, timeoutMs);
      this.bridgeRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.bridgeSocket.send(JSON.stringify(payload));
    return promise;
  }

  async handleNetworkLoad(params = {}) {
    const filePath = params.path ?? params.filePath;
    if (!filePath) {
      const error = new Error('network.load requires params.path');
      error.code = -32602;
      throw error;
    }
    const format = params.format ?? inferNetworkFormat(filePath);
    const bytes = await fs.readFile(filePath);
    const result = await this.callBridge('network.loadPayload', {
      name: path.basename(filePath),
      format,
      base64: encodeBufferBase64(bytes),
      options: params.options ?? {},
    });
    await this.restoreDocumentSidecar(filePath, { reason: 'network.load' });
    if (this.config.runtime === 'desktop' || params.markSaved === true) {
      await this.callBridge('persistence.documentSaved', {
        reason: params.reason ?? 'network.load',
        filePath,
        format,
      }).catch(() => null);
    }
    return result;
  }

  async handleNetworkReplace(params = {}) {
    if (params.path || params.filePath) {
      return this.handleNetworkLoad(params);
    }
    return this.callBridge('network.replace', params);
  }

  async handleNetworkSave(params = {}) {
    const requestedFormat = params.format ?? (params.outputPath ? inferNetworkFormat(params.outputPath) : null);
    const outputPath = writableNetworkOutputPath(params.outputPath ?? null, requestedFormat);
    const result = await this.callBridge('network.savePayload', {
      ...params,
      outputPath,
      filename: outputPath ? path.basename(outputPath) : params.filename,
      format: requestedFormat ?? params.format,
    });
    if (outputPath && result?.base64) {
      await fs.writeFile(outputPath, decodeBase64ToBuffer(result.base64));
      await this.writeDocumentSidecar(outputPath, params);
      if (params.markSaved === true) {
        await this.callBridge('persistence.documentSaved', {
          reason: params.reason ?? 'network.save',
          filePath: outputPath,
          format: params.format ?? result.format ?? inferNetworkFormat(outputPath),
        }).catch(() => null);
      }
    }
    return {
      ...result,
      wroteFile: Boolean(outputPath && result?.base64),
      outputPath: outputPath ?? null,
      base64: outputPath ? undefined : result?.base64,
    };
  }

  documentSidecarPath(filePath) {
    return `${filePath}.helios-state.json`;
  }

  formatCarriesHeliosState(format) {
    return ['xnet', 'zxnet', 'bxnet'].includes(String(format ?? '').toLowerCase());
  }

  async writeDocumentSidecar(outputPath, params = {}) {
    const format = params.format ?? inferNetworkFormat(outputPath);
    const sidecarPath = this.documentSidecarPath(outputPath);
    if (this.formatCarriesHeliosState(format)) {
      await fs.rm(sidecarPath, { force: true }).catch(() => {});
      return null;
    }
    if (params.includeVisualization !== true) return null;
    const snapshot = await this.callBridge('persistence.exportDocumentState', {
      reason: params.reason ?? 'network.save',
      includeCurrentPositions: params.includeCurrentPositions !== false,
      trackedOnly: params.trackedOnly !== false,
    }).catch(() => null);
    if (!snapshot) return null;
    const payload = {
      schema: 'helios-desktop.document-sidecar',
      version: 1,
      networkFile: path.basename(outputPath),
      format,
      savedAt: new Date().toISOString(),
      visualizationState: snapshot,
    };
    await fs.writeFile(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`);
    return sidecarPath;
  }

  async restoreDocumentSidecar(filePath, options = {}) {
    const format = inferNetworkFormat(filePath);
    if (this.formatCarriesHeliosState(format)) return null;
    const sidecarPath = this.documentSidecarPath(filePath);
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const visualizationState = parsed?.visualizationState ?? parsed;
    if (!visualizationState) return null;
    return this.callBridge('persistence.restoreDocumentState', {
      visualizationState,
      reason: options.reason ?? 'document-sidecar-restore',
    });
  }

  async handleExportFigure(params = {}) {
    const result = await this.callBridge('export.figurePayload', params);
    const outputPath = params.outputPath ?? null;
    if (outputPath && result?.base64) {
      await fs.writeFile(outputPath, decodeBase64ToBuffer(result.base64));
    }
    return {
      ...result,
      wroteFile: Boolean(outputPath && result?.base64),
      outputPath: outputPath ?? null,
      base64: outputPath ? undefined : result?.base64,
    };
  }

  async handleBrowserReload(params = {}) {
    if (!this.browserPage) {
      const error = new Error('browser.reload requires a managed headed or headless browser session');
      error.code = -32602;
      throw error;
    }
    this.bridgeReady = false;
    await this.updateMetadata();
    await this.browserPage.reload({ waitUntil: params.waitUntil ?? 'networkidle' });
    await this.browserPage.waitForFunction(() => Boolean(window.__HELIOS_CLI_RUNTIME__?.ready), null, {
      timeout: params.timeoutMs ?? 30_000,
    });
    await this.waitForBridge({ timeoutMs: params.timeoutMs ?? 30_000 });
    return {
      reloaded: true,
      runtime: await this.browserPage.evaluate(() => window.__HELIOS_CLI_RUNTIME__ ?? null),
      metadata: this.buildMetadata(),
    };
  }

  managedBrowserLaunchOptions() {
    const headed = this.config.mode === 'headed';
    const args = this.config.noGpu
      ? [
          '--disable-gpu',
          '--enable-webgl',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]
      : [
          '--enable-gpu',
          '--enable-webgl',
          '--ignore-gpu-blocklist',
          '--enable-unsafe-webgpu',
          '--disable-software-rasterizer',
        ];
    if (headed) args.push('--window-size=1600,1000');
    const options = {
      headless: this.config.mode === 'headless',
      args,
    };
    const browserChannel = String(this.config.browserChannel ?? '').trim();
    if (browserChannel) {
      options.channel = browserChannel;
    }
    return options;
  }

  managedBrowserContextOptions() {
    const base = {
      acceptDownloads: true,
    };
    if (this.config.mode === 'headed') {
      return {
        ...base,
        viewport: null,
      };
    }
    return {
      ...base,
      viewport: { width: 1600, height: 1000 },
    };
  }

  async validateGpuRuntime() {
    const gpu = await this.browserPage.evaluate(async ({ rendererPreference, mode, noGpu }) => {
      const canvas = document.createElement('canvas');
      let gl = null;
      try {
        gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
          || canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true });
      } catch (_) {
        gl = null;
      }

      let webgl = null;
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
        const vendor = debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR);
        const text = `${renderer ?? ''} ${vendor ?? ''}`.toLowerCase();
        webgl = {
          api: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
          renderer: renderer ?? null,
          vendor: vendor ?? null,
          hardware: !/(swiftshader|llvmpipe|software|mesa offscreen|microsoft basic render)/i.test(text),
        };
      }

      let webgpu = null;
      if (navigator.gpu?.requestAdapter) {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (adapter) {
          let info = null;
          if (typeof adapter.requestAdapterInfo === 'function') {
            try {
              info = await adapter.requestAdapterInfo();
            } catch (_) {
              info = null;
            }
          }
          webgpu = {
            isFallbackAdapter: adapter.isFallbackAdapter ?? null,
            features: Array.from(adapter.features ?? []),
            info,
          };
        }
      }

      const runtime = window.__HELIOS_CLI_RUNTIME__ ?? null;
      const actualRenderer = runtime?.renderer ?? null;

      return {
        actualRenderer,
        requestedRenderer: rendererPreference,
        mode,
        noGpu,
        webgl,
        webgpu,
        window: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
      };
    }, {
      rendererPreference: this.config.renderer,
      mode: this.config.mode,
      noGpu: this.config.noGpu === true,
    });

    const decision = evaluateManagedGpuPolicy({
      mode: this.config.mode,
      rendererPreference: this.config.renderer,
      noGpu: this.config.noGpu === true,
      actualRenderer: gpu.actualRenderer,
      webgl: gpu.webgl,
      webgpu: gpu.webgpu,
    });

    this.gpu = {
      ...gpu,
      ...decision,
    };
    await this.updateMetadata({ gpu });
    this.emitEvent('browser.gpu', this.gpu);

    if (!this.gpu?.ok) {
      const error = new Error(this.gpu?.reason ?? `Managed browser session ${this.sessionId} did not get a hardware GPU path`);
      error.code = -32020;
      error.data = this.gpu;
      throw error;
    }
    return this.gpu;
  }

  async launchManagedBrowser() {
    this.browser = await chromium.launch(this.managedBrowserLaunchOptions());
    this.browserContext = await this.browser.newContext(this.managedBrowserContextOptions());
    this.browserPage = await this.browserContext.newPage();
    this.browserPage.on('console', (msg) => {
      this.emitEvent('browser.console', { type: msg.type(), text: msg.text() });
    });
    this.browserPage.on('pageerror', (error) => {
      this.emitEvent('browser.pageerror', { message: error?.message ?? String(error) });
    });
    this.browserPage.on('download', (download) => {
      this.saveManagedBrowserDownload(download).catch((error) => {
        this.emitEvent('browser.downloadError', { message: error?.message ?? String(error) });
      });
    });
    await this.browserPage.goto(this.sessionUrl(), { waitUntil: 'networkidle' });
    await this.browserPage.waitForFunction(() => Boolean(window.__HELIOS_CLI_RUNTIME__?.ready), null, { timeout: 30_000 });
    await this.validateGpuRuntime();
  }

  async saveManagedBrowserDownload(download) {
    const directory = path.join(os.homedir(), 'Downloads');
    await fs.mkdir(directory, { recursive: true });
    const suggestedFilename = sanitizeDownloadFilename(download.suggestedFilename?.() ?? null);
    const outputPath = await uniqueDownloadPath(directory, suggestedFilename);
    await download.saveAs(outputPath);
    this.emitEvent('browser.download', {
      path: outputPath,
      suggestedFilename,
    });
  }

  async openExternalBrowser() {
    const url = this.sessionUrl();
    if (process.platform === 'darwin') {
      const { spawn } = await import('node:child_process');
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      return;
    }
    if (process.platform === 'win32') {
      const { spawn } = await import('node:child_process');
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
      return;
    }
    const { spawn } = await import('node:child_process');
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }

  async stop() {
    if (this.pendingStop) return;
    this.pendingStop = true;
    try {
      this.emitEvent('session.stopping', { sessionId: this.sessionId });
      for (const connection of this.controlConnections) {
        try {
          connection.socket.end();
        } catch (_) {
          // ignore
        }
      }
      if (this.bridgeSocket) {
        try {
          this.bridgeSocket.close();
        } catch (_) {
          // ignore
        }
      }
      await this.browserContext?.close?.();
      await this.browser?.close?.();
      await new Promise((resolve) => this.controlServer?.close(resolve));
      await new Promise((resolve) => this.httpServer?.close(resolve));
      this.wsServer?.close?.();
      if (process.platform !== 'win32') {
        try {
          await fs.unlink(this.socketPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      await deleteSessionMeta(this.sessionId);
    } finally {
      setTimeout(() => process.exit(0), 25);
    }
  }
}
