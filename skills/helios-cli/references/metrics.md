# Metrics And Aesthetic Measures

Use `metrics.measure` for graph measurements and `aesthetic.measure` as an alias when the metric is being used as an aesthetic signal for styling.

```sh
helios call "$SESSION" metrics.measure --json '{"metric":"degree"}'
helios call "$SESSION" aesthetic.measure --json '{"metric":"dimension","options":{"maxLevel":8}}'
```

## Supported Metrics

- `degree`
- `strength`
- `localClustering` / `localClusteringCoefficient`
- `coreness`
- `eigenvectorCentrality`
- `betweennessCentrality`
- `connectedComponents`
- `dimension`
- `nodeDimension`
- `leiden` / `leidenModularity`
- `corenessSession`
- `connectedComponentsSession`
- `dimensionSession`

By default, large `valuesByNode` arrays are omitted for node-vector metrics. Add `"includeValuesByNode": true` if the full node-capacity vector is required.

## Write Metric To Attribute

```sh
helios call "$SESSION" metrics.measure --json '{
  "metric": "degree",
  "options": {
    "direction": "both",
    "outNodeAttribute": "degree"
  }
}'
```

Then map it:

```sh
helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "size": {
      "type": "attribute",
      "attributes": "degree",
      "domain": [0, 20],
      "range": [4, 18]
    }
  }
}'
```

## Dimension As Aesthetic Signal

```sh
helios call "$SESSION" aesthetic.measure --json '{
  "metric": "dimensionSession",
  "options": {
    "maxLevel": 8,
    "method": "leastsquares",
    "captureNodeDimensionProfiles": true,
    "outNodeMaxDimensionAttribute": "dim_max"
  },
  "budget": 500,
  "maxSteps": 10000
}'
```

Map the output:

```sh
helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "color": {
      "type": "attribute",
      "attributes": "dim_max",
      "colormap": "CET_L08-NeonBurst"
    }
  }
}'
```
