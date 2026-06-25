import path from 'node:path';
import { ensureStateDirs, readJsonFile, writeJsonFile } from './fs.js';
import { cliConfigPath } from './paths.js';

const defaultConfig = Object.freeze({
  version: 1,
  apps: {},
});

function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultConfig, apps: {} };
  const apps = value.apps && typeof value.apps === 'object' && !Array.isArray(value.apps)
    ? { ...value.apps }
    : {};
  return {
    version: Number.isInteger(value.version) ? value.version : 1,
    ...value,
    apps,
  };
}

export async function loadCliConfig() {
  await ensureStateDirs();
  return normalizeConfig(await readJsonFile(cliConfigPath, defaultConfig));
}

export async function saveCliConfig(config) {
  await ensureStateDirs();
  const normalized = normalizeConfig(config);
  await writeJsonFile(cliConfigPath, normalized);
  return normalized;
}

export async function getConfiguredDesktopAppPath() {
  const config = await loadCliConfig();
  const value = config.apps?.desktop?.appPath;
  return value == null ? null : String(value);
}

export async function setConfiguredDesktopAppPath(appPath) {
  const resolvedPath = path.resolve(String(appPath));
  const config = await loadCliConfig();
  config.apps = config.apps ?? {};
  config.apps.desktop = {
    ...(config.apps.desktop && typeof config.apps.desktop === 'object' ? config.apps.desktop : {}),
    appPath: resolvedPath,
  };
  await saveCliConfig(config);
  return resolvedPath;
}

export { cliConfigPath };
