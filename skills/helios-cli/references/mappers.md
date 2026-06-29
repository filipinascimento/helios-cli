# Mappers

Mapper descriptors configure Helios Web visual channels from attributes, constants, or rules.

Use:

```sh
helios call <sessionId> mappers.set --json '<payload>'
```

## Shape

The CLI accepts `nodeMapper` and `edgeMapper` descriptors. For single-attribute channels, agents may pass either `attribute` or `attributes`; the CLI normalizes `attribute` to Helios Web's `attributes` field. Each descriptor can be either:

```json
{
  "channels": [
    { "name": "color", "config": { "type": "attribute", "attribute": "community" } },
    { "name": "size", "config": { "type": "constant", "value": 8 } }
  ]
}
```

or an object keyed by channel:

```json
{
  "color": { "type": "colormap", "attribute": "community" },
  "size": { "type": "constant", "value": 8 }
}
```

## Node Example

```sh
helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "color": {
      "type": "colormap",
      "attribute": "community",
      "colormap": "CET_L08-NeonBurst"
    },
    "size": {
      "type": "attribute",
      "attribute": "degree",
      "range": [4, 18]
    }
  }
}'
```

## Edge Example

```sh
helios call "$SESSION" mappers.set --json '{
  "edgeMapper": {
    "edgeColor": {
      "type": "constant",
      "value": [0.35, 0.55, 1.0, 0.55]
    },
    "edgeWidth": {
      "type": "attribute",
      "attribute": "weight",
      "range": [0.5, 4]
    }
  }
}'
```

## Agent Checks

`mappers.set` verifies that each requested channel is present in the live mapper
after application and returns an RPC error if a channel did not stick. After
setting mappers, still call:

```sh
helios call "$SESSION" mappers.get
helios call "$SESSION" scene.getState
```

Confirm the returned mapper channel uses the requested attribute/type before
changing unrelated appearance settings. Use `mappers.reset` when you need to
return to Helios defaults.

## Function-Like Custom Mappers

JSON cannot carry JavaScript functions, so the CLI accepts code strings and compiles them in the browser session:

- `transformCode`: becomes `transform(inputs, item, context)`.
- `scaleCode`: becomes `scale(value, inputs, item, context)`.
- rule `whenCode`: becomes `when(inputs, item, context)`.
- rule `transformCode`: becomes that rule's transform callback.

Expression strings are allowed:

```sh
helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "size": {
      "type": "attribute",
      "attributes": "degree",
      "transformCode": "Math.max(4, inputs[0] * 2)"
    }
  }
}'
```

Function bodies with `return` are also allowed:

```sh
helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "color": {
      "type": "colormap",
      "attributes": ["degree", "community"],
      "transformCode": "const degree = inputs[0] ?? 0; const group = inputs[1] ?? 0; return degree > 10 ? group : 0;",
      "colormap": "CET_L08-NeonBurst"
    }
  }
}'
```

Use code-backed mappers only for trusted local agent workflows. They execute in the browser session.
