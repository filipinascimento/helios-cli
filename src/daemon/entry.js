import { SessionDaemon } from './SessionDaemon.js';
import { saveSessionMeta } from '../shared/sessionRegistry.js';

const rawConfig = process.argv[2];
if (!rawConfig) {
  throw new Error('Missing daemon configuration payload');
}

const config = JSON.parse(Buffer.from(rawConfig, 'base64url').toString('utf8'));
const daemon = new SessionDaemon(config);

try {
  await daemon.start();
} catch (error) {
  await saveSessionMeta(config.sessionId, {
    sessionId: config.sessionId,
    pid: process.pid,
    status: 'error',
    mode: config.mode,
    renderer: config.renderer,
    layout: config.layout,
    noGpu: config.noGpu === true,
    bridgeConnected: false,
    gpu: error?.data ?? null,
    networkPath: config.networkPath ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: error?.stack ?? error?.message ?? String(error),
  });
  throw error;
}
