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

## Picking And Export

- `picking.pick`: payload `{ "x": 400, "y": 300 }`.
- `export.figure`: payload `{ "format": "png", "preset": "window", "outputPath": "./figure.png" }`.
