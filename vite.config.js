import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

function resolveHeliosWebSource() {
  const localSource = resolve(__dirname, '../helios-web-next/src/index.js');
  if (fs.existsSync(localSource)) return localSource;
  try {
    const packageJsonPath = require.resolve('helios-web/package.json');
    const packageRoot = dirname(packageJsonPath);
    const packageSource = resolve(packageRoot, 'src/index.js');
    if (fs.existsSync(packageSource)) return packageSource;
  } catch (_) {
    // Fall through to package export resolution.
  }
  return null;
}

const heliosWebSource = resolveHeliosWebSource();

export default defineConfig({
  root: resolve(__dirname, 'src/client'),
  base: '/',
  assetsInclude: ['**/*.wasm'],
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  resolve: {
    alias: heliosWebSource ? { 'helios-web': heliosWebSource } : {},
    preserveSymlinks: true,
    dedupe: ['helios-network'],
  },
  optimizeDeps: {
    exclude: ['helios-network'],
  },
});
