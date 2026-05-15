import { once } from 'node:events';

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function createJsonLineParser(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    while (true) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) break;
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      onMessage(parsed);
    }
  };
}

export function writeJsonLine(stream, value) {
  stream.write(encodeMessage(value));
}

export async function callJsonRpc(stream, reader, payload, { timeoutMs = 30_000 } = {}) {
  const id = payload.id;
  const response = await reader.waitForResponse(id, { timeoutMs }, () => {
    writeJsonLine(stream, payload);
  });
  if (response?.error) {
    const error = new Error(response.error.message ?? 'RPC request failed');
    error.code = response.error.code;
    error.data = response.error.data;
    throw error;
  }
  return response?.result;
}

export class JsonRpcResponseReader {
  constructor() {
    this.pending = new Map();
    this.notifications = new Set();
  }

  onNotification(handler) {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message ?? {}, 'id') && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    for (const handler of this.notifications) handler(message);
  }

  waitForResponse(id, { timeoutMs = 30_000 } = {}, send) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for RPC response ${id}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
      try {
        send();
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export async function pipeStreams(source, destination) {
  source.pipe(destination);
  await once(source, 'close');
}
