# Layouts

The CLI supports headed, headless, and server sessions:

```sh
helios session start --mode headless --renderer webgpu --layout gpu-force
helios session start --layout d3force3d
helios session start --mode server --no-open
```

## Choices

Supported layout keys:

- `gpu-force`
- `static`
- `d3force3d`
- `worker:jitter`
- `worker:force3d`

Switch layout:

```sh
helios call "$SESSION" layout.set --json '{"layout":"gpu-force"}'
```

Inspect writable parameters:

```sh
helios call "$SESSION" layout.get
```

The response includes `descriptor.bindings`. Bindings with a writable `type` such as `number`, `boolean`, or `select` can be changed with `layout.setParameters`.

## Parameter Updates

```sh
helios call "$SESSION" layout.setParameters --json '{
  "outputScale": 7,
  "maxNeighborsPerNode": 64
}'
```

## Dynamic UMAP Tuning

When `layout.get` reports `forceModel: "umap"`, prefer UMAP-aware parameters and leave linear-only spring defaults alone:

```sh
helios call "$SESSION" layout.setParameters --json '{
  "outputScale": 30,
  "umapNegativeSampleRate": 7,
  "sampleChurn": 0.02,
  "kRepulsion": 1.15,
  "kAttraction": 0.95
}'
```

Component-aware layout controls such as `componentForces`, component seeding,
and component gravity are for non-UMAP linear GPU-force layouts only. For UMAP
embeddings, these controls should be absent or disabled; do not use `halo` or
component placement to tune semantic islands.

Use `camera.frame` after layout changes so exports include the full embedding:

```sh
helios call "$SESSION" camera.frame --json '{"animate":false,"resetOrientation":true}'
```

For D3 force:

```sh
helios call "$SESSION" layout.set --json '{"layout":"d3force3d"}'
helios call "$SESSION" layout.setParameters --json '{
  "forcesStrength": 1.4,
  "gravity": 0.04,
  "linkDistance": 35
}'
```

Run control:

```sh
helios call "$SESSION" layout.start
helios call "$SESSION" layout.stop --json '{"reason":"agent"}'
```

## Positions From Attributes

Use a numeric 2D or 3D node attribute as layout positions:

```sh
helios call "$SESSION" positions.fromAttribute --json '{
  "attribute": "umap_position",
  "stopLayout": true
}'
```

`layout.applyPositionAttribute` is an alias for the same workflow:

```sh
helios call "$SESSION" layout.applyPositionAttribute --json '{"attribute":"embedding3d"}'
```
