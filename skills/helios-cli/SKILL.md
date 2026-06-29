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
npm install -g helios-web-cli@latest
helios browser install
helios version
```

Use `helios browser install --with-deps` on Linux when Playwright reports missing system dependencies.

The `helios-web-cli` npm package ships this skill under `skills/helios-cli`. After installing the CLI, locate the packaged skill:

```sh
SKILL_SRC="$(npm root -g)/helios-web-cli/skills/helios-cli"
```

To install the skill for Codex, copy it into the local Codex skills directory:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R "$SKILL_SRC" "${CODEX_HOME:-$HOME/.codex}/skills/helios-cli"
```

To install the skill for Claude in a project, copy it into `.claude/skills`:

```sh
mkdir -p ".claude/skills"
cp -R "$SKILL_SRC" ".claude/skills/helios-cli"
```

If your Claude client supports global skills, copy the same folder into `~/.claude/skills` instead:

```sh
mkdir -p "$HOME/.claude/skills"
cp -R "$SKILL_SRC" "$HOME/.claude/skills/helios-cli"
```

From a source checkout, use `skills/helios-cli` as `SKILL_SRC`. The skill is plain Markdown plus reference files, so it does not require Codex-specific tooling.

For source checkout development, clone `helios-cli`, then run `npm install`, `npm run build`, and `npm link` inside the checkout. The CLI depends on the published `helios-network` and `helios-web` packages; for coordinated renderer or graph-store development, publish or pack those packages first, then install the resulting versions here so agent runs exercise the same package boundary users receive from npm.

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
6. Always verify visual results yourself after creating or changing a visualization. For interactive sessions, bring the browser forward and inspect the scene; for headless or repeatable checks, call `camera.frame`, export a PNG with `export.figure`, and inspect the rendered image before reporting success. Do not rely only on JSON state.
7. For simple user requests such as "color by this label", "hide edges", "frame the view", or "open the map", perform the change directly, then check that the rendered result matches the request. Keep the explanation short unless the result is wrong or a tool/API gap must be documented.
8. Treat RPC errors as blocking. Do not continue with cosmetic state changes after a failed data, mapper, density, or layout call; inspect the error, change route, rerun the failed step, and verify the effective state changed.
9. Use `persistence.save` before intentional reloads or handoff points when the current visual state matters. Full saves capture a session thumbnail by default; pass `{"captureThumbnail":false}` only when preserving an older preview is intentional.
10. Stop sessions with `helios session stop <sessionId>` when finished.

## Embedding And Dynamic UMAP Workflow

For raw embedding tables or arrays, read `references/embeddings.md` before
generating anything. The default route is the graph-only dynamic UMAP export
used by `helios-embedding-example`: call
`helios_network.HeliosUMAP.fit_graph_network(...)`, attach metadata attributes,
and save a Helios XNET that lets Helios Web run its GPU UMAP force model.

Loading an existing embedding XNET needs only the Node CLI install:

```sh
helios session start --mode headless --renderer webgpu --layout gpu-force --network ./ukraine_tweets_dynamic_umap.xnet
helios call <sessionId> network.stats
helios call <sessionId> layout.get
```

If the XNET has graph-level `umap=true` metadata plus `umap_weight` and `umap_mass`, Helios Web auto-selects the dynamic UMAP force model under `gpu-force`. Do not force linear layout defaults for those files; inspect `layout.get` and tune UMAP parameters through `layout.setParameters`:

```sh
helios call <sessionId> layout.setParameters --json '{"outputScale":30,"umapNegativeSampleRate":7,"sampleChurn":0.02}'
helios call <sessionId> layout.start
helios call <sessionId> camera.frame --json '{"animate":false,"resetOrientation":true}'
```

For embedding visualizations, keep UMAP edges in the graph for layout but hide
rendered edges by default. The CLI applies edge width scale `0` automatically
when a loaded network has dynamic UMAP metadata. Verify the state before
handoff, and set it manually only when repairing an older session:

```sh
helios state set <sessionId> appearance.edgeStyle.widthScale 0
```

For classification labels, convert the label attribute to a categorical
attribute before mapping color. Prefer:

```sh
helios call <sessionId> network.categorizeAttribute --json '{"scope":"node","attribute":"nsf_category"}'
helios call <sessionId> mappers.set --json '{"nodeMapper":{"color":{"type":"categorical","attribute":"nsf_category"}}}'
```

Default categorical colors should mirror the Mappers panel defaults: sort
categories by frequency, use the discrete `category18` palette once, and route
categories beyond the palette length to the mapper default value shown as
`Others`. Only specify another `sortOrder`, palette, or category cap when the
user explicitly asks for it.

Do not tune component-aware layout controls for UMAP embeddings. If `layout.get`
labels the layout as `UMAP Force (GPU)`, `componentForces`, component seeding,
and component gravity should be absent or disabled; tune only UMAP parameters
such as `outputScale`, `umapNegativeSampleRate`, `sampleChurn`, `kRepulsion`,
and `kAttraction`.

For feedback-guided styling, compute graph measures into attributes and then map those attributes:

```sh
helios call <sessionId> metrics.measure --json '{"metric":"degree","options":{"outNodeAttribute":"degree"}}'
helios call <sessionId> metrics.measure --json '{"metric":"leiden","options":{"outNodeCommunityAttribute":"community","resolution":1.1,"seed":13}}'
helios call <sessionId> mappers.set --json '{"nodeMapper":{"color":{"type":"colormap","attribute":"community","colormap":"CET_L08-NeonBurst"},"size":{"type":"attribute","attribute":"degree","range":[2.5,10]}}}'
```

For simple attributes derived from existing node or edge attributes, use
`network.attributeSet` with `functionCode` instead of exporting data to a
separate script. The callback receives `(current, id, ordinal, network,
context)`. Cache source buffers on `context` so each buffer is resolved once
inside the CLI-managed buffer-access block:

```sh
helios call <sessionId> network.attributeSet --json '{
  "scope": "node",
  "name": "recent_3y",
  "functionCode": "const year = context.year ??= network.getNodeAttributeBuffer(\"publication_year\").view; return year[id] >= 2021 ? 1 : 0;",
  "options": { "type": "float", "dimension": 1 }
}'
```

For density over-representation questions, derive a numeric indicator attribute
first, then compare its density against `Uniform` with `comparisonMode:
"logRatio"`. This shows enrichment relative to the background map density, not
just where there are many nodes. Read `references/density.md` before building
one of these views.

Regenerating text embeddings needs Python dependencies. The `helios-network>=0.10.3` Python package provides the Helios graph/export layer, but tweet embedding generation also needs `sentence-transformers`, `torch`, `umap-learn`, `pynndescent`, and `scikit-learn`. For the Ukraine tweets demo, install `helios-embedding-example/requirements.txt` and run `create_tweet_umap_xnet.py`; use that script as the reference implementation for embedding-table-to-dynamic-UMAP-XNET workflows.

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
- `references/embeddings.md` covers embedding-table workflows and dynamic UMAP XNET export.
- `references/rendering-export.md` covers renderer choices, GPU policy, screenshots, and figure export.
- `references/density.md` covers density and over-representation views.
- `references/layouts.md` covers layout choices and parameter updates.
- `references/metrics.md` covers graph/aesthetic measurements and writing results into node attributes.
- `references/behaviors.md` covers enabling, disabling, updating, detaching, restoring, and invoking Helios behaviors.
- `references/positions.md` covers custom positions, positions from attributes, and position snapshots.
- `references/persistence.md` covers automatic session persistence, browser reload recovery, and explicit save/restore calls.
