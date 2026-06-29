# Density Views

Use this reference when the user asks for density, enrichment,
over-representation, hot spots, or where a subset is concentrated in a Helios
map.

## Over-Representation Pattern

For subset enrichment, do not map the subset only as gray or colored nodes and
call that density. Create a numeric node attribute first, then use the density
layer to compare that subset against the background map density.

Example: papers from the last three years present in the data:

```sh
helios call "$SESSION" network.attributeSet --json '{
  "scope": "node",
  "name": "recent_3y",
  "functionCode": "const year = context.year ??= network.getNodeAttributeBuffer(\"publication_year\").view; return year[id] >= 2021 ? 1 : 0;",
  "options": { "type": "float", "dimension": 1 }
}'
```

Then set density to a log-ratio comparison against the full node distribution:

```sh
helios call "$SESSION" density.set --json '{
  "enabled": true,
  "property": "recent_3y",
  "compareProperty": "Uniform",
  "comparisonMode": "logRatio",
  "qualityScale": 0.6,
  "bandwidth": 18,
  "logRatioRange": 1.0,
  "logRatioColormap": "cmasher:prinsenvlag",
  "logRatioSupportCorrection": true,
  "logRatioZScore": false,
  "maskThreshold": 0.01,
  "scaleWithZoom": false
}'
```

`property` should be the subset indicator or weight. `compareProperty:
"Uniform"` makes the denominator the overall node density, so the result is
relative enrichment rather than raw density.

## Styling With Density

For embedding maps, keep layout edges hidden while density is visible:

```sh
helios state set "$SESSION" appearance.edgeStyle.widthScale 0
```

Mute nodes only if needed to reveal the density surface, and verify that the
density layer itself changed. Do not treat a gray node map as a successful
density view.

```sh
helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "color": { "type": "constant", "value": [0.72, 0.72, 0.72, 0.22] },
    "size": { "type": "constant", "value": 0.75 },
    "outline": { "type": "constant", "value": 0 }
  }
}'
```

## Verification

After setting density:

```sh
helios call "$SESSION" density.get
helios call "$SESSION" scene.getState
helios call "$SESSION" camera.frame --json '{"animate":false,"resetOrientation":true}'
helios call "$SESSION" export.figure --json '{
  "format": "png",
  "preset": "window",
  "includeInterface": true,
  "includeLegends": true,
  "outputPath": "./density-check.png"
}'
```

Inspect the exported PNG. The legend should name the derived property and show
a log-ratio or comparison scale. If `network.attributeSet`, `density.set`, or
`mappers.set` returns an RPC error, stop and fix that step before changing
unrelated appearance settings.
