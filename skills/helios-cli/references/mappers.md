# Mappers

Mapper descriptors configure Helios Web visual channels from attributes, constants, or rules.

Use:

```sh
helios call <sessionId> mappers.set --json '<payload>'
```

## Shape

The CLI accepts `nodeMapper` and `edgeMapper` descriptors. Each descriptor can be either:

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
  "color": { "type": "attribute", "attribute": "community" },
  "size": { "type": "constant", "value": 8 }
}
```

## Node Example

```sh
helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "color": {
      "type": "attribute",
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

After setting mappers, call:

```sh
helios call "$SESSION" mappers.get
helios call "$SESSION" scene.getState
```

Use `mappers.reset` when you need to return to Helios defaults.

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
      "type": "attribute",
      "attributes": ["degree", "community"],
      "transformCode": "const degree = inputs[0] ?? 0; const group = inputs[1] ?? 0; return degree > 10 ? group : 0;",
      "colormap": "CET_L08-NeonBurst"
    }
  }
}'
```

Use code-backed mappers only for trusted local agent workflows. They execute in the browser session.
