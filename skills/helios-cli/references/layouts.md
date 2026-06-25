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
