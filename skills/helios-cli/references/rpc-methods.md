# RPC Methods

Call methods with:

```sh
helios call <sessionId> <method> --json '<payload>'
```

Omit `--json` when the method takes no payload.

## Scene

- `scene.getState`: returns mode, renderer, network stats, camera, labels, legends, density, filter, layout, and mapper snapshots.
- `scene.requestRender`: requests a render and returns scene state.
- `scene.setMode`: payload `{ "mode": "2d" }` or `{ "mode": "3d" }`.

## Network

- `network.stats`: returns node count, edge count, node attributes, and edge attributes.
- `network.load`: daemon-side file load. Payload `{ "path": "./graph.bxnet", "format": "bxnet" }`.
- `network.attributeSet`: writes node, edge, or network attributes. Supports scalar values, arrays, and `functionCode`.
- `network.categorizeAttribute`: converts a string label attribute into a real categorical attribute. Payload `{ "scope": "node", "attribute": "nsf_category" }`; omit `sortOrder` for the default frequency order.
- `network.replace`: accepts either a file payload like `network.load` or a synthetic descriptor:

```json
{
  "synthetic": {
    "nodeCount": 500,
    "mode": "2d",
    "layout": "gpu-force"
  }
}
```

- `network.save`: payload `{ "format": "bxnet", "outputPath": "./out.bxnet" }`.

Use `network.attributeSet` with `functionCode` for simple derived attributes.
The callback receives `(current, id, ordinal, network, context)`. When reading
existing numeric buffers, cache them on `context` so the source buffer is looked
up once inside the CLI-managed buffer-access block:

```sh
helios call "$SESSION" network.attributeSet --json '{
  "scope": "node",
  "name": "recent_3y",
  "functionCode": "const year = context.year ??= network.getNodeAttributeBuffer(\"publication_year\").view; return year[id] >= 2021 ? 1 : 0;",
  "options": { "type": "float", "dimension": 1 }
}'
```

## Camera

- `camera.getPose`: returns the current camera pose.
- `camera.setPose`: payload `{ "pose": { ... }, "options": { ... } }`.
- `camera.transition`: payload `{ "pose": { ... }, "options": { "durationMs": 750 } }`.
- `camera.frame`: payload can include `{ "animate": true, "durationMs": 500, "resetOrientation": true }`.
- `camera.controls`: reads controls with `{}` or patches controls, for example `{ "orbit": false, "autoFit": true }`.
- `camera.targetNodes`: get or set target nodes with `{ "nodeIndices": [1, 2, 3], "options": { "follow": true } }`.

## Layout

- `layout.get`: returns current layout key, run state, and parameter descriptor.
- `layout.set`: payload `{ "layout": "gpu-force" }`, `{ "layout": "static" }`, `{ "layout": "d3force3d" }`, `{ "layout": "worker:jitter" }`, or `{ "layout": "worker:force3d" }`.
- `layout.setParameters`: patches writable parameters exposed by `layout.get`, for example `{ "outputScale": 7, "linkDistance": 1.2 }`.
- `layout.applyPositionAttribute`: copies a numeric 2D/3D node attribute into current layout positions.
- `layout.start`: starts layout execution.
- `layout.stop`: payload `{ "reason": "agent" }`.

## Visual State

- `mappers.get`, `mappers.set`, `mappers.reset`
- `behaviors.get`, `behaviors.use`, `behaviors.update`, `behaviors.setEnabled`, `behaviors.detach`, `behaviors.restore`, `behaviors.call`
- `positions.get`, `positions.snapshot`, `positions.set`, `positions.fromAttribute`
- `filters.get`, `filters.set`, `filters.clear`
- `labels.get`, `labels.set`
- `legends.get`, `legends.set`
- `density.get`, `density.set`
- `metrics.measure`, `aesthetic.measure`: run graph/aesthetic measurements such as degree, strength, clustering, coreness, centralities, connected components, dimension, and Leiden.

## Persistence

- `state.get`, `state.set`, `state.reset`: read, write, or reset Web Next tracked state paths through `helios.states` with CLI-origin writes.
- `persistence.get`: returns the CLI persistence id, storage status, and availability.
- `persistence.save`: payload can include `{ "fullSession": true, "networkFormat": "bxnet", "captureThumbnail": true }`. Full saves persist network data plus sparse visualization state and capture a PNG thumbnail by default; lightweight saves persist sparse overrides only and use throttled automatic thumbnail capture.
- `persistence.restore`: restores the current session checkpoint without reloading the page.
- `persistence.clear`: removes the CLI filesystem session checkpoint.
- `persistence.changes`: returns journal entries since the last checkpoint by default. Payload can include `{ "since": 12, "limit": 25, "source": "user", "sinceCheckpoint": false }`.
- `persistence.checkpoint`: marks changes through a sequence id as seen. Omit `seq` to checkpoint through the latest entry.
- `persistence.overrides`: returns sparse overrides and dirty state.
- `persistence.reset`: payload `{ "path": "appearance.nodeStyle.sizeScale" }` or `{ "scope": "appearance.nodeStyle" }`.
- `persistence.flush`: payload `{ "includeNetwork": true, "captureThumbnail": "auto" }` writes pending overrides and optionally network data if size limits allow. Use `captureThumbnail: false` to preserve the existing thumbnail or provide a `thumbnail` object with a `dataUrl`.
- `persistence.status`: returns session id, override counts, journal counts, dirty state, and network persistence status.
- `browser.reload`: reloads the managed browser page, waits for the Helios runtime and bridge to reconnect, then returns runtime and session metadata.

## Picking And Export

- `picking.pick`: payload `{ "x": 400, "y": 300 }`.
- `export.figure`: payload `{ "format": "png", "preset": "window", "outputPath": "./figure.png" }`.
