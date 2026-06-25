# Helios CLI

Agent-friendly CLI for starting and controlling Helios Web sessions backed by the current `helios-web-next` and `helios-network` packages.

The CLI starts a small local session daemon, serves a Helios Web client, opens the OS/default browser for normal interactive sessions, launches Playwright-managed browsers only when explicitly requested, and exposes JSON-RPC methods for scene, network, camera, layout, mapper, filter, label, legend, density, picking, and export workflows.

## Install

Clone the CLI next to the current Helios repos:

```sh
mkdir -p helios-new
cd helios-new
git clone git@github.com:filipinascimento/helios-network.git helios-network-v2
git clone git@github.com:filipinascimento/helios-web-next.git helios-web-next
git clone git@github.com:filipinascimento/helios-cli.git
cd helios-cli
npm install
npm run build
npm link
```

The package intentionally uses `file:../helios-network-v2` and `file:../helios-web-next` so CLI sessions run against the current local Helios Network and Helios Web source. The Vite build uses `../helios-web-next/src/index.js` when it exists.

CLI browser sessions use the `helios-web-next` state machine and storage facade. CLI-origin changes should go through tracked state paths (`state.set` / `helios.states.set(..., { source: "cli" })`) so only explicit overrides are saved. Durable session storage is owned by the CLI daemon, not browser localStorage or IndexedDB: session JSON lives under `~/.helios/sessions`, network side records are saved as `.zxnet`/`.bxnet`/`.xnet`, position side records are saved as binary files, session thumbnails are stored as data URLs in the private session JSON payload, and runtime daemon metadata lives under `~/.helios/runtime`. Use global `--storage-dir <path>` or `HELIOS_CLI_STORAGE_DIR` to choose another root.

## Basic Usage

```sh
helios version
helios browser install
helios inspect ./graph.xnet --json
helios desktop open ./graph.xnet
helios session start
helios session start --mode headless --renderer webgpu
helios session list
helios session state <sessionId>
helios call <sessionId> scene.getState
helios state set <sessionId> scene.dimension '"3d"'
helios state reset <sessionId> scene.dimension
helios call <sessionId> camera.frame --json '{"animate":true,"durationMs":500}'
helios call <sessionId> persistence.changes
helios call <sessionId> persistence.checkpoint
helios call <sessionId> persistence.save --json '{"fullSession":true}'
helios call <sessionId> browser.reload
helios call <sessionId> export.figure --json '{"format":"png","preset":"window","outputPath":"./figure.png"}'
helios session stop <sessionId>
```

Start with a network file:

```sh
helios session start --network ./graph.bxnet
```

Supported network extensions are `.bxnet`, `.zxnet`, `.xnet`, `.gml`, `.gt`, and `.gt.zst`.

By default, `helios session start` runs in `server` mode and opens the session URL with the platform browser opener (`open` on macOS, `start` on Windows, `xdg-open` on Linux). This avoids spawning Playwright's bundled "Chrome for Testing" as a visible app. Use `--mode server --no-open` to serve only, `--mode headless` for automated rendering/export, or explicit `--mode headed` only when a Playwright-managed visible browser is wanted for debugging. Managed headed/headless sessions use bundled Chromium by default so they stay independent from the user's Chrome profile; add `--browser-channel chrome` or another Playwright browser channel only when an explicit installed browser channel is needed. Downloads triggered from the managed browser UI are copied to `~/Downloads` with the browser's suggested filename, and RPC figure exports can still write directly to an `outputPath`.

Use `helios session start --surface desktop` to start a CLI-owned session and open it in Helios Desktop. The CLI will use a discovered Desktop app when possible. If it cannot locate the app, pass `--app-path <path-to-Helios-Desktop>` once or run `helios config set desktop.appPath <path-to-Helios-Desktop>`; the path is stored in the CLI config file and reused on later runs.

Initialize the bundled managed browser with:

```sh
helios browser install
```

This installs Playwright's bundled Chromium. Use `helios browser install --with-deps` on Linux when system browser dependencies are missing, or pass explicit targets such as `helios browser install chromium chrome`.

## Commands

- `helios version` prints CLI, `helios-network`, and `helios-web-next` versions visible to the current install.
- `helios browser install [browser...] [--with-deps]` installs Playwright browser binaries for managed sessions. It defaults to `chromium`.
- `helios config get` prints the CLI config path and stored config.
- `helios config set desktop.appPath <path>` records the Helios Desktop app path for `--surface desktop`.
- `helios inspect <network-path> [--json] [--format bxnet|zxnet|xnet|gt]` reads `.xnet`, `.zxnet`, `.bxnet`, `.gt`, or `.gt.zst` metadata without launching the visualization renderer.
- `helios desktop open <network-path> [--app <app-name-or-path>]` asks the OS to open a network file with the registered Helios desktop app.
- `helios session start` starts a session and prints session metadata as JSON. Pass `--storage-dir <path>` to use a custom CLI storage root for that session, or pass global `--storage-dir` before the command for all CLI file lookups in that invocation.
- `helios session list` lists known live-session daemon metadata from `~/.helios/runtime/sessions`.
- `helios session info <sessionId>` prints one session's daemon metadata.
- `helios session state <sessionId>` prints the CLI-mirrored sparse session state from `~/.helios/runtime/session-state`.
- `helios session stop <sessionId>` stops a daemon and removes its metadata.
- `helios state get <sessionId> [path]` reads the Web Next tracked state snapshot or one state path.
- `helios state set <sessionId> <path> <json-value> [--scope user|workspace|network|session]` writes through `helios.states` with `source: "cli"` and persists the sparse override.
- `helios state reset <sessionId> <path>` resets a tracked path/prefix to default and removes the override.
- `helios call <sessionId> <method> [--json <payload>]` calls a JSON-RPC method.
- `helios events <sessionId>` streams session events as newline-delimited JSON.
- `helios session attach <sessionId> --stdio` bridges JSON-RPC over stdio.

Full session saves capture a PNG thumbnail by default and store it in the session JSON payload used by the session list UI. Lightweight autosaves request thumbnail capture with the Web Next `auto` policy, so thumbnail refreshes are throttled while the user is actively interacting. Pass `"captureThumbnail": false` to `persistence.save` or `persistence.flush` to keep an existing thumbnail, or pass a custom `"thumbnail"` object with a `dataUrl` when an external preview should be stored.

## Common RPC Methods

- `scene.getState`
- `scene.requestRender`
- `scene.setMode`
- `persistence.get`
- `persistence.save`
- `persistence.restore`
- `persistence.clear`
- `persistence.changes`
- `persistence.checkpoint`
- `persistence.overrides`
- `persistence.reset`
- `persistence.flush`
- `persistence.status`
- `persistence.backendStatus`
- `state.get`
- `state.set`
- `state.reset`
- `browser.reload`
- `network.stats`
- `network.inspect`
- `network.load`
- `network.replace`
- `network.save`
- `network.attributeSet`
- `camera.getPose`
- `camera.setPose`
- `camera.transition`
- `camera.frame`
- `camera.controls`
- `layout.get`
- `layout.set`
- `layout.setParameters`
- `layout.applyPositionAttribute`
- `layout.start`
- `layout.stop`
- `mappers.get`
- `mappers.set`
- `mappers.reset`
- `behaviors.get`
- `behaviors.use`
- `behaviors.update`
- `behaviors.setEnabled`
- `behaviors.detach`
- `behaviors.restore`
- `behaviors.call`
- `positions.get`
- `positions.snapshot`
- `positions.set`
- `positions.fromAttribute`
- `filters.get`
- `filters.set`
- `filters.clear`
- `labels.get`
- `labels.set`
- `legends.get`
- `legends.set`
- `density.get`
- `density.set`
- `metrics.measure`
- `aesthetic.measure`
- `picking.pick`
- `export.figure`

More detail for agent usage lives in `skills/helios-cli/`.
