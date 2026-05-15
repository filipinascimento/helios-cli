# Helios CLI Skill

Use this skill when an agent needs to create, inspect, render, manipulate, or export Helios visualizations through the `helios` command-line session daemon.

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
helios version
```

The CLI intentionally depends on `file:../helios-network-v2` and `file:../helios-web-next`. Keep the three repositories adjacent so agents use the current local Helios Network and Helios Web source rather than older published packages.

## Basic Usage

Start a managed session:

```sh
helios session start --mode headless --renderer webgpu
```

Save the returned `sessionId`, then call methods:

```sh
helios call <sessionId> scene.getState
helios call <sessionId> camera.frame --json '{"animate":true,"durationMs":500}'
helios call <sessionId> export.figure --json '{"format":"png","preset":"window","outputPath":"./figure.png"}'
helios session stop <sessionId>
```

For interactive inspection use headed mode:

```sh
helios session start --mode headed --renderer webgpu --network ./graph.bxnet
```

## Agent Workflow

1. Run `helios version` to confirm the CLI and visible Helios package versions.
2. Start with `--mode headless` for automated rendering/export, or `--mode headed` when human visual inspection matters.
3. Capture the JSON session metadata from `session start`; all subsequent calls need `sessionId`.
4. Use `scene.getState` before changes and after changes to confirm renderer, network counts, layout state, mapper state, labels, legends, density, filters, and camera state.
5. Use `persistence.save` before intentional reloads or handoff points when the current visual state matters.
6. Stop sessions with `helios session stop <sessionId>` when finished.

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
