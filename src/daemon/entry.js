const rawConfig = process.argv[2];
if (!rawConfig) {
  throw new Error('Missing daemon configuration payload');
}

const config = JSON.parse(Buffer.from(rawConfig, 'base64url').toString('utf8'));
if (config.storageDir) process.env.HELIOS_CLI_STORAGE_DIR = config.storageDir;

const { SessionDaemon } = await import('./SessionDaemon.js');
const { saveSessionMeta } = await import('../shared/sessionRegistry.js');
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
    runtime: config.runtime,
    surface: config.surface ?? null,
    client: config.client ?? null,
    browserChannel: config.browserChannel ?? null,
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
