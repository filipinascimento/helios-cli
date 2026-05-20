# Persistence

Helios CLI sessions persist sparse overrides and a readable change journal through the Helios Web session controller. Browser local storage is still the reload source of truth for web sessions. The CLI also mirrors sparse session state to the local filesystem for agents:

```text
~/.helios-cli/session-state/<sessionId>.json
```

Full network checkpoints are optional and use browser IndexedDB when requested or when a workflow explicitly needs network reload recovery.

The persistence id is derived from the CLI session id:

```text
helios-cli:<sessionId>
```

## Automatic Saves And Journaling

Mutating RPC calls are recorded with `source: "cli"` before the response is returned. Manual UI changes are recorded with `source: "user"` when the underlying Helios behavior emits a durable change.

Runtime events also schedule lightweight saves:

- behavior, mode, filter, and layout-stop changes schedule sparse override snapshots
- page unload attempts a final lightweight visualization-state save

Read changes since the last agent checkpoint:

```sh
helios call <sessionId> persistence.changes
```

Read all recent CLI-origin changes:

```sh
helios call <sessionId> persistence.changes --json '{"source":"cli","sinceCheckpoint":false,"limit":25}'
```

Mark the current journal position as seen by the agent:

```sh
helios call <sessionId> persistence.checkpoint
```

Inspect sparse overrides and dirty state:

```sh
helios call <sessionId> persistence.overrides
helios call <sessionId> persistence.status
helios session state <sessionId>
```

Reset a single override or a section:

```sh
helios call <sessionId> persistence.reset --json '{"path":"appearance.nodeStyle.sizeScale"}'
helios call <sessionId> persistence.reset --json '{"scope":"appearance.nodeStyle"}'
```

## Manual Save

Use `persistence.save` before reloads, screenshots, handoff points, or multi-step workflows where recovering exactly the current state matters:

```sh
helios call <sessionId> persistence.save --json '{"fullSession":true}'
```

`fullSession: true` writes the network plus visualization state. `fullSession: false` writes only sparse overrides and the local visualization fallback. To force the Helios Web session controller to flush its manifest and optionally save the network blob:

```sh
helios call <sessionId> persistence.flush --json '{"includeNetwork":true}'
```

## Reload Recovery

In a managed headed or headless browser session, reload the page and wait for the bridge to reconnect:

```sh
helios call <sessionId> browser.reload
helios call <sessionId> scene.getState
```

On page load, the client first tries to restore the full IndexedDB checkpoint. If that fails or is unavailable, it restores sparse overrides and the localStorage visualization fallback against the current network. The CLI filesystem mirror is for daemon/agent inspection; it does not replace browser storage for the web app.

## Explicit Restore And Clear

Restore the current checkpoint without reloading:

```sh
helios call <sessionId> persistence.restore
```

Clear the saved checkpoint and fallback:

```sh
helios call <sessionId> persistence.clear
```

Inspect the persistence id and storage key:

```sh
helios call <sessionId> persistence.get
```

## What Persists

Sparse overrides cover changed values only, using stable paths such as `appearance.nodeStyle.sizeScale`, `appearance.shaded.enabled`, `layout.parameters.outputScale`, and `mappers.node.channels.color`. Full checkpoints additionally cover the network data, mode, camera, layout and behavior state, mapper descriptors, filters, density, labels, legends, and other Helios Web visualization state exposed by `serializeVisualizationState`.

Layout runtime is persisted separately from sparse overrides. It captures current positions from the active source, including delegate-backed and GPU-force layouts, plus layout type, run state, temperature/alpha, center, and encoded positions. Restore writes positions back to the active delegate when possible and mirrors them to the hidden network position attribute so interpolation, renderer buffers, and saved files agree.

When saving a network with visualization state, Helios stores sparse config and layout runtime in the graph-private `_helios_visualization_state` attribute and mirrors current positions in the node-private `_helios_visuals_position` attribute. The private convention is the leading underscore.

For function-backed mappers and custom code descriptors, persist the descriptor source that created them. A browser reload can restore function-like mapper descriptors that are serializable, but external closures or runtime-only JavaScript objects cannot be reconstructed from storage.
