# Persistence

Helios CLI sessions persist sparse overrides and a readable change journal through `helios.states` and `helios.storage`. The CLI daemon owns durable storage; browser localStorage and IndexedDB are not used for CLI session persistence. The CLI mirrors sparse runtime state for agents:

```text
~/.helios/runtime/session-state/<sessionId>.json
```

Durable session records live under `~/.helios/sessions`. Session envelopes are JSON, network side records are saved as `.zxnet`/`.bxnet`/`.xnet`, and position side records are saved as binary files. Use `--storage-dir <path>` or `HELIOS_CLI_STORAGE_DIR` for another root.

The persistence id is the raw CLI session id:

```text
<sessionId>
```

## Automatic Saves And Journaling

State writes are recorded with `source: "cli"` before the response is returned. Manual UI changes are recorded with `source: "ui"` when the underlying Helios behavior emits a durable state change.

Runtime events also schedule lightweight saves:

- behavior, mode, filter, camera, mapper, and layout changes schedule sparse override snapshots
- page unload attempts a final lightweight storage flush

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
helios state get <sessionId>
helios state set <sessionId> appearance.shaded.enabled true
helios state reset <sessionId> appearance.shaded.enabled
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

`fullSession: true` writes the network plus sparse visualization state through CLI filesystem storage. `fullSession: false` writes only sparse overrides. To force `helios.storage` to flush pending state and optionally save the network blob:

```sh
helios call <sessionId> persistence.flush --json '{"includeNetwork":true}'
```

## Reload Recovery

In a managed headed or headless browser session, reload the page and wait for the bridge to reconnect:

```sh
helios call <sessionId> browser.reload
helios call <sessionId> scene.getState
```

On page load, Web Next restores the active CLI session through the remote storage client backed by the daemon filesystem store. Reload recovery does not depend on browser storage.

## Explicit Restore And Clear

Restore the current checkpoint without reloading:

```sh
helios call <sessionId> persistence.restore
```

Clear the saved CLI session:

```sh
helios call <sessionId> persistence.clear
```

Inspect the persistence id and storage status:

```sh
helios call <sessionId> persistence.get
```

## Daemon Storage API

Managed and server sessions expose the remote storage API used by the browser client:

```text
GET    /api/storage/sessions
POST   /api/storage/session
GET    /api/storage/session/<id>
DELETE /api/storage/session/<id>
GET    /api/storage/unfinished?workspaceId=<workspaceId>
PUT    /api/storage/unfinished
```

The API is loopback-only with the session daemon and writes into the active storage root. It stores normal session envelopes under `sessions/records`, network side records under `sessions/networks`, and position side records under `sessions/positions`.

Use server mode plus `--storage-dir` for fast persistence API checks that do not need a browser bridge:

```sh
helios --storage-dir /tmp/helios-store session start --mode server
```

## What Persists

Sparse overrides cover changed values only, using stable paths such as `appearance.nodeStyle.sizeScale`, `appearance.shaded.enabled`, `layout.parameters.outputScale`, and `mappers.node.channels.color`. Full checkpoints additionally cover the network data, mode, camera, layout and behavior state, mapper descriptors, filters, density, labels, legends, and other Helios Web visualization state exposed by `serializeVisualizationState`.

Layout runtime is persisted separately from sparse overrides. It captures current positions from the active source, including delegate-backed and GPU-force layouts, plus layout type, run state, temperature/alpha, center, and encoded positions. Restore writes positions back to the active delegate when possible and mirrors them to the hidden network position attribute so interpolation, renderer buffers, and saved files agree.

When saving a network with visualization state, Helios stores sparse config and layout runtime in the graph-private `_helios_visualization_state` attribute and mirrors current positions in the node-private `_helios_visuals_position` attribute. The private convention is the leading underscore.

For function-backed mappers and custom code descriptors, persist the descriptor source that created them. A browser reload can restore function-like mapper descriptors that are serializable, but external closures or runtime-only JavaScript objects cannot be reconstructed from storage.
