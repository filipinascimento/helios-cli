import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseBrowserInstallArgs, parseStartArgs } from '../src/cli.js';
import { SessionDaemon } from '../src/daemon/SessionDaemon.js';
import {
  buildDesktopSessionOpenURL,
  buildMacSessionOpenURL,
  desktopLaunchCommand,
  normalizeSessionSurface,
} from '../src/shared/sessionSurfaces.js';

const root = path.resolve('.');

test('parseStartArgs defaults to OS browser session with GPU requirement on', () => {
  const options = parseStartArgs([]);
  assert.equal(options.mode, 'server');
  assert.equal(options.open, true);
  assert.equal(options.renderer, 'webgpu');
  assert.equal(options.browserChannel, null);
  assert.equal(options.noGpu, false);
});

test('parseStartArgs keeps explicit server mode browserless unless --open is passed', () => {
  assert.equal(parseStartArgs(['--mode', 'server']).open, false);
  assert.equal(parseStartArgs(['--mode', 'server', '--open']).open, true);
  assert.equal(parseStartArgs(['--no-open']).open, false);
});

test('parseStartArgs accepts --no-gpu, browser channel, and explicit renderer options', () => {
  const options = parseStartArgs([
    '--mode', 'headless',
    '--renderer', 'webgpu',
    '--layout', 'worker:force3d',
    '--browser-channel', 'chrome',
    '--storage-dir', './.helios-test',
    '--network', './sample.bxnet',
    '--no-gpu',
  ]);
  assert.equal(options.mode, 'headless');
  assert.equal(options.renderer, 'webgpu');
  assert.equal(options.layout, 'worker:force3d');
  assert.equal(options.browserChannel, 'chrome');
  assert.equal(options.storageDir, path.resolve('./.helios-test'));
  assert.equal(options.networkPath, './sample.bxnet');
  assert.equal(options.noGpu, true);
});

test('parseStartArgs supports explicit session surfaces', () => {
  const mac = parseStartArgs(['--surface', 'mac', '--app-path', './HeliosWeb.app']);
  assert.equal(mac.surface, 'mac');
  assert.equal(mac.mode, 'server');
  assert.equal(mac.open, false);
  assert.equal(mac.appPath, path.resolve('./HeliosWeb.app'));

  const desktop = parseStartArgs(['--surface', 'desktop', '--app-path', './Helios.app']);
  assert.equal(desktop.surface, 'desktop');
  assert.equal(desktop.mode, 'server');
  assert.equal(desktop.open, false);
  assert.equal(desktop.appPath, path.resolve('./Helios.app'));

  const managed = parseStartArgs(['--surface', 'managed']);
  assert.equal(managed.surface, 'managed');
  assert.equal(managed.mode, 'headed');
  assert.equal(managed.open, false);

  const browser = parseStartArgs(['--surface', 'browser', '--no-open']);
  assert.equal(browser.surface, 'browser');
  assert.equal(browser.mode, 'server');
  assert.equal(browser.open, false);

  assert.equal(normalizeSessionSurface('auto'), 'auto');
  assert.throws(() => parseStartArgs(['--surface', 'native']), /Unsupported session surface/);
});

test('buildMacSessionOpenURL creates a local helios-mac session URL', () => {
  const url = buildMacSessionOpenURL({
    sessionId: 'abc',
    url: 'http://127.0.0.1:1234/?sessionId=abc&runtime=mac',
  });
  assert.match(url, /^helios-mac:\/\/session\/open\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('sessionId'), 'abc');
  assert.equal(parsed.searchParams.get('url'), 'http://127.0.0.1:1234/?sessionId=abc&runtime=mac');
  assert.throws(
    () => buildMacSessionOpenURL({ sessionId: 'abc', url: 'https://example.com/' }),
    /local session URL/,
  );
});

test('buildDesktopSessionOpenURL creates a local helios-desktop session URL', () => {
  const url = buildDesktopSessionOpenURL({
    sessionId: 'abc',
    url: 'http://127.0.0.1:1234/?sessionId=abc&runtime=desktop',
  });
  assert.match(url, /^helios-desktop:\/\/session\/open\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('sessionId'), 'abc');
  assert.equal(parsed.searchParams.get('url'), 'http://127.0.0.1:1234/?sessionId=abc&runtime=desktop');
  assert.throws(
    () => buildDesktopSessionOpenURL({ sessionId: 'abc', url: 'https://example.com/' }),
    /local session URL/,
  );
});

test('desktopLaunchCommand launches app bundles through open and executables directly', () => {
  const sessionURL = 'helios-desktop://session/open?sessionId=abc';
  const mac = desktopLaunchCommand('/Applications/Helios.app', sessionURL);
  if (process.platform === 'darwin') {
    assert.equal(mac.command, 'open');
    assert.deepEqual(mac.args, ['-n', '-a', '/Applications/Helios.app', '--args', '--helios-cli-session', sessionURL]);
  }

  const executable = desktopLaunchCommand('/opt/Helios/Helios', sessionURL);
  assert.equal(executable.command, '/opt/Helios/Helios');
  assert.deepEqual(executable.args, ['--helios-cli-session', sessionURL]);
});

test('managed browser uses bundled Chromium only for explicit managed modes unless a browser channel is explicit', () => {
  const bundled = new SessionDaemon({ sessionId: 'test-session', mode: 'headed' });
  assert.equal(Object.hasOwn(bundled.managedBrowserLaunchOptions(), 'channel'), false);

  const chrome = new SessionDaemon({ sessionId: 'test-session', mode: 'headed', browserChannel: 'chrome' });
  assert.equal(chrome.managedBrowserLaunchOptions().channel, 'chrome');
});

test('parseBrowserInstallArgs defaults to chromium and accepts explicit targets', () => {
  assert.deepEqual(parseBrowserInstallArgs([]), {
    browsers: ['chromium'],
    withDeps: false,
  });
  assert.deepEqual(parseBrowserInstallArgs(['--with-deps', 'chromium', 'chrome']), {
    browsers: ['chromium', 'chrome'],
    withDeps: true,
  });
  assert.throws(
    () => parseBrowserInstallArgs(['safari']),
    /Unsupported browser/,
  );
});

test('CLI client uses state-backed remote storage and compact session network payloads', async () => {
  const source = await fs.readFile(path.join(root, 'src/client/main.js'), 'utf8');

  assert.doesNotMatch(source, /CustomPersistenceBackend/);
  assert.doesNotMatch(source, /localStorage/);
  assert.match(source, /class CliStorageClient/);
  assert.match(source, /type: 'remote'/);
  assert.match(source, /this\.helios\.states\?\.set\?\.\(path, params\.value/);
  assert.match(source, /networkPersistence: \{ enabled: true, autosave: true, format: 'zxnet' \}/);
  assert.match(source, /positionPersistence: \{ enabled: true, autosave: true \}/);
  assert.doesNotMatch(source, /networkPersistence: \{ enabled: true, format: 'bxnet' \}/);
  assert.match(source, /'persistence\.backendStatus'/);
  assert.match(source, /this\.helios\.storage\?\.persistenceStatus\?\.\(\)/);
  assert.match(source, /networkFormat: params\.networkFormat \?\? 'zxnet'/);
  assert.match(source, /networkFormat: options\.networkFormat \?\? 'zxnet'/);
  assert.match(source, /includeNetwork \? true : 'auto'/);
  assert.match(source, /thumbnail: options\.thumbnail \?\? options\.sessionThumbnail/);
  assert.match(source, /dataUrl: Boolean\(thumbnail\.dataUrl\)/);
  assert.match(source, /sessionThumbnail: \{ enabled: true \}/);
  assert.doesNotMatch(source, /sessionThumbnail: \{ enabled: false \}/);
});

test('CLI client exposes desktop runtime as document-backed state mode', async () => {
  const source = await fs.readFile(path.join(root, 'src/client/main.js'), 'utf8');
  const sessionClient = await fs.readFile(path.join(root, 'src/shared/sessionClient.js'), 'utf8');
  const daemon = await fs.readFile(path.join(root, 'src/daemon/SessionDaemon.js'), 'utf8');

  assert.match(sessionClient, /runtime: options\.runtime \?\? 'cli'/);
  assert.match(sessionClient, /surface: options\.surface \?\? null/);
  assert.match(sessionClient, /client: options\.client \?\? null/);
  assert.match(daemon, /runtime: this\.config\.runtime/);
  assert.match(daemon, /surface: this\.config\.surface \?\? null/);
  assert.match(daemon, /client: this\.config\.client \?\? null/);
  assert.match(source, /function isDesktopRuntime/);
  assert.match(source, /runtime === 'desktop' \|\| runtime === 'mac'/);
  assert.match(source, /type: 'dummy'/);
  assert.match(source, /showNetworkFileActions: !desktopRuntime/);
  assert.match(source, /showPersistenceSync: !desktopRuntime/);
  assert.match(source, /showSessionTab: !desktopRuntime/);
  assert.match(source, /'persistence\.exportDocumentState'/);
  assert.match(source, /'persistence\.documentSaved'/);
  assert.match(source, /includeCurrentPositions: params\.includeCurrentPositions === true/);
});

test('CLI client supports desktop synthetic model replacement', async () => {
  const source = await fs.readFile(path.join(root, 'src/client/main.js'), 'utf8');

  assert.match(source, /function decorateSyntheticNetwork/);
  assert.match(source, /function seedPositionsFromGenerator/);
  assert.match(source, /seedGridPositions\(network, nodeCount, options\.mode \?\? '2d', options\)/);
  assert.match(source, /async function createGrid2DNetwork/);
  assert.match(source, /async function createGrid3DNetwork/);
  assert.match(source, /async function createSmallWorldNetwork/);
  assert.match(source, /async function createBarabasiAlbertNetwork/);
  assert.match(source, /async function createRandomGeometricNetwork/);
  assert.match(source, /async function createWaxmanNetwork/);
  assert.match(source, /async function createStochasticBlockNetwork/);
  assert.match(source, /async function createConfigurationModelNetwork/);
  assert.match(source, /HeliosNetwork\.generateLattice2D/);
  assert.match(source, /HeliosNetwork\.generateWattsStrogatz/);
  assert.match(source, /HeliosNetwork\.generateBarabasiAlbert/);
  assert.match(source, /HeliosNetwork\.generateRandomGeometric/);
  assert.match(source, /HeliosNetwork\.generateWaxman/);
  assert.match(source, /HeliosNetwork\.generateStochasticBlockModel/);
  assert.match(source, /HeliosNetwork\.generateConfigurationModel/);
  assert.match(source, /rows,\s+columns,\s+nodeCount: rows \* columns,/);
  assert.match(source, /side,\s+nodeCount,/);
  assert.match(source, /async function createSyntheticNetwork/);
  assert.match(source, /params\.synthetic/);
  assert.match(source, /createSyntheticNetwork/);
});
