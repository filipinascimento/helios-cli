# Helios CLI

Agent-friendly CLI for starting and controlling Helios Web sessions backed by the current `helios-web-next` and `helios-network` packages.

The CLI starts a small local session daemon, serves a Helios Web client, launches Chromium through Playwright when requested, and exposes JSON-RPC methods for scene, network, camera, layout, mapper, filter, label, legend, density, picking, and export workflows.

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

CLI browser sessions automatically checkpoint network and visualization state by session id. A page reload restores the saved network, camera, mode, layout, mappers, behaviors, filters, density, labels, and legends when possible.

## Basic Usage

```sh
helios version
helios session start --mode headless --renderer webgpu
helios session list
helios call <sessionId> scene.getState
helios call <sessionId> camera.frame --json '{"animate":true,"durationMs":500}'
helios call <sessionId> persistence.save --json '{"fullSession":true}'
helios call <sessionId> browser.reload
helios call <sessionId> export.figure --json '{"format":"png","preset":"window","outputPath":"./figure.png"}'
helios session stop <sessionId>
```

Start with a network file:

```sh
helios session start --mode headed --renderer webgpu --network ./graph.bxnet
```

Supported network extensions are `.bxnet`, `.zxnet`, and `.xnet`.

## Commands

- `helios version` prints CLI, `helios-network`, and `helios-web-next` versions visible to the current install.
- `helios session start` starts a session and prints session metadata as JSON.
- `helios session list` lists known sessions from `~/.helios-cli/sessions`.
- `helios session info <sessionId>` prints one session's daemon metadata.
- `helios session stop <sessionId>` stops a daemon and removes its metadata.
- `helios call <sessionId> <method> [--json <payload>]` calls a JSON-RPC method.
- `helios events <sessionId>` streams session events as newline-delimited JSON.
- `helios session attach <sessionId> --stdio` bridges JSON-RPC over stdio.

## Common RPC Methods

- `scene.getState`
- `scene.requestRender`
- `scene.setMode`
- `persistence.get`
- `persistence.save`
- `persistence.restore`
- `persistence.clear`
- `browser.reload`
- `network.stats`
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
