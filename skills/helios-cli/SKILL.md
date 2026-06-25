# Helios CLI Skill

Use this skill when an agent needs to create, inspect, render, manipulate, or export Helios visualizations through the `helios` command-line session daemon.

## Install

Check that Node.js is available before using the CLI:

```sh
node --version
npm --version
```

If `node` or `npm` is missing, install Node.js 18 or newer first. On macOS with Homebrew:

```sh
brew install node
```

On Linux, use the distribution package manager or NodeSource packages. On Windows, install the current LTS build from the official Node.js installer.

Install the published CLI and its managed browser:

```sh
npm install -g helios-cli
helios browser install
helios version
```

Use `helios browser install --with-deps` on Linux when Playwright reports missing system dependencies.

To install this skill for Codex, copy the `skills/helios-cli` directory into the local Codex skills directory:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/helios-cli "${CODEX_HOME:-$HOME/.codex}/skills/helios-cli"
```

To install this skill for Claude, copy the same `skills/helios-cli` directory into the Claude skills location used by your Claude client or project. The skill is plain Markdown plus reference files, so it does not require Codex-specific tooling.

For source checkout development, clone `helios-network`, `helios-web`, and `helios-cli` next to each other, run `npm install`, `npm run build`, and `npm link` inside `helios-cli`. The published package depends on `helios-network` and `helios-web`; source checkouts can still alias adjacent local sources during development.

## Basic Usage

Start an interactive session in the OS/default browser:

```sh
helios session start
```

Start a managed automation session:

```sh
helios session start --mode headless --renderer webgpu
```

Use a custom daemon-owned storage root when a workflow must be isolated or reproducible:

```sh
helios --storage-dir /tmp/helios-run session start --mode headless --renderer webgpu
```

Save the returned `sessionId`, then call methods:

```sh
helios call <sessionId> scene.getState
helios state set <sessionId> appearance.shaded.enabled true
helios state get <sessionId> appearance.shaded.enabled
helios call <sessionId> camera.frame --json '{"animate":true,"durationMs":500}'
helios call <sessionId> export.figure --json '{"format":"png","preset":"window","outputPath":"./figure.png"}'
helios session stop <sessionId>
```

For interactive inspection with a network file, prefer the default OS/browser path:

```sh
helios session start --network ./graph.bxnet
```

## Agent Workflow

1. Run `helios version` to confirm the CLI and visible Helios package versions.
2. Use plain `session start` for human visual inspection in the OS/default browser; use `--mode headless` for automated rendering/export. Reserve explicit `--mode headed` for Playwright-managed debugging.
3. Capture the JSON session metadata from `session start`; all subsequent calls need `sessionId`.
4. Use `scene.getState` before changes and after changes to confirm renderer, network counts, layout state, mapper state, labels, legends, density, filters, and camera state.
5. Prefer `helios state set/get/reset` or the `state.*` RPC methods for tracked Helios Web parameters. These calls flow through `helios.states` and are saved by `helios.storage`.
6. Use `persistence.save` before intentional reloads or handoff points when the current visual state matters. Full saves capture a session thumbnail by default; pass `{"captureThumbnail":false}` only when preserving an older preview is intentional.
7. Stop sessions with `helios session stop <sessionId>` when finished.

## Persistence Validation

When changing CLI session or persistence behavior, run the full test script and include at least one managed-session smoke that saves, reloads, restores, and clears persistence:

```sh
npm test
helios --storage-dir /tmp/helios-run session start --mode headless --renderer webgl --no-gpu
helios state set <sessionId> scene.dimension '"3d"'
helios call <sessionId> persistence.save --json '{"fullSession":true}'
helios call <sessionId> persistence.save --json '{"fullSession":true,"captureThumbnail":true}'
helios call <sessionId> browser.reload --json '{"timeoutMs":30000}'
helios call <sessionId> persistence.clear
helios --storage-dir /tmp/helios-run session stop <sessionId>
```

The CLI daemon is the storage owner. Do not rely on browser localStorage or IndexedDB for CLI persistence tests; use the daemon storage API and the filesystem under the active storage root.
Session thumbnails are private session payload metadata, not browser storage. Full saves should return thumbnail metadata with a true `dataUrl` flag, and the saved session record should contain `payload.thumbnail.dataUrl`.

## References

- `references/rpc-methods.md` lists available JSON-RPC methods and payload shapes.
- `references/mappers.md` explains mapper descriptors for node and edge visual channels.
- `references/networks.md` covers loading, replacing, saving, and synthetic test networks.
- `references/rendering-export.md` covers renderer choices, GPU policy, screenshots, and figure export.
- `references/layouts.md` covers layout choices and parameter updates.
- `references/metrics.md` covers graph/aesthetic measurements and writing results into node attributes.
- `references/behaviors.md` covers enabling, disabling, updating, detaching, restoring, and invoking Helios behaviors.
- `references/positions.md` covers custom positions, positions from attributes, and position snapshots.
- `references/persistence.md` covers automatic session persistence, browser reload recovery, and explicit save/restore calls.
