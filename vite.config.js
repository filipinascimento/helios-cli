import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const heliosWebSource = resolve(
  dirname(dirname(require.resolve('helios-web'))),
  'src/index.js',
);

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
    alias: { 'helios-web': heliosWebSource },
    preserveSymlinks: true,
    dedupe: ['helios-network'],
  },
  optimizeDeps: {
    exclude: ['helios-network'],
  },
});
