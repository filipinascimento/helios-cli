# Positions

Inspect the active position source:

```sh
helios call "$SESSION" positions.get
```

Snapshot positions. Delegate-backed GPU layouts are read back when possible:

```sh
helios call "$SESSION" positions.snapshot --json '{"limit":10}'
```

## Set Custom Positions

Write explicit 3D positions into `_helios_visuals_position` and apply them:

```sh
helios call "$SESSION" positions.set --json '{
  "values": [[0, 0, 0], [10, 5, 0], [20, 10, 0]],
  "dimension": 3,
  "stopLayout": true
}'
```

For large arrays, use a flat array and set `dimension`:

```sh
helios call "$SESSION" positions.set --json '{
  "values": [0, 0, 0, 10, 5, 0, 20, 10, 0],
  "dimension": 3,
  "indexBy": "auto"
}'
```

## Build Positions From Code

Create a position attribute using a JS-like callback, then apply it:

```sh
helios call "$SESSION" network.attributeSet --json '{
  "scope": "node",
  "name": "agent_position",
  "functionCode": "return [ordinal * 2, Math.sin(ordinal / 10) * 50, 0];",
  "options": { "type": "float", "dimension": 3 }
}'

helios call "$SESSION" positions.fromAttribute --json '{
  "attribute": "agent_position",
  "stopLayout": true
}'
```

## Positions From Existing Attributes

Any numeric 2D or 3D node attribute can seed layout positions:

```sh
helios call "$SESSION" positions.fromAttribute --json '{"attribute":"umap_position"}'
```

Use `layout.start` after applying an attribute when the layout should continue from the custom seed.
