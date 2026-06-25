#!/usr/bin/env node

function extractStorageDir(argv) {
  const index = argv.findIndex((entry) => entry === '--storage-dir' || entry.startsWith('--storage-dir='));
  if (index === -1) return;
  const current = argv[index];
  let value = null;
  if (current.includes('=')) {
    value = current.slice(current.indexOf('=') + 1);
    argv.splice(index, 1);
  } else {
    value = argv[index + 1];
    argv.splice(index, 2);
  }
  if (!value) throw new Error('Missing value for --storage-dir');
  process.env.HELIOS_CLI_STORAGE_DIR = value;
}

const argv = process.argv.slice(2);

try {
  extractStorageDir(argv);
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exit(1);
}

const { runCli } = await import('../src/cli.js');

runCli(argv).catch((error) => {
  const message = error?.stack ?? error?.message ?? String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
