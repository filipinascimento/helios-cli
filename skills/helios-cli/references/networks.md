# Networks

The CLI works with Helios portable network formats:

- `.bxnet`
- `.zxnet`
- `.xnet`

The daemon infers format from file extension when `format` is omitted.

## Start With A File

```sh
helios session start --renderer webgpu --network ./graph.bxnet
```

## Load Or Replace In A Running Session

```sh
helios call "$SESSION" network.load --json '{"path":"./graph.xnet"}'
```

or:

```sh
helios call "$SESSION" network.replace --json '{"path":"./graph.bxnet","options":{"keepCamera":false}}'
```

## Embedding And Dynamic UMAP XNETs

Prebuilt embedding networks can be loaded directly; no Python packages are needed at visualization time:

```sh
helios session start --mode headless --renderer webgpu --layout gpu-force --network ./ukraine_tweets_dynamic_umap.xnet
helios call "$SESSION" network.stats
helios call "$SESSION" layout.get
```

For graph-only UMAP exports, confirm `layout.get` reports the UMAP force model. The XNET should carry graph metadata such as `umap=true`, `umap_edge_weight_attr`, and `umap_node_mass_attr`, plus the referenced edge/node attributes. If those attributes are missing, Helios Web will fall back to the linear GPU-force model.

To regenerate the Ukraine tweets demo XNET, use the `helios-embedding-example` Python pipeline. `helios-network>=0.10.3` provides `HeliosUMAP` and XNET validation, while `sentence-transformers`, `torch`, `umap-learn`, `pynndescent`, and `scikit-learn` are required for embedding, graph construction, and cluster naming.

## Synthetic Network

Synthetic networks are useful for smoke tests when no dataset is available:

```sh
helios call "$SESSION" network.replace --json '{
  "synthetic": {
    "nodeCount": 1000,
    "mode": "2d",
    "layout": "gpu-force"
  }
}'
```

## Save

```sh
helios call "$SESSION" network.save --json '{"format":"bxnet","outputPath":"./out.bxnet"}'
```

When `outputPath` is omitted, the response contains a base64 payload.

## WASM Buffer Rule

When writing code that creates Helios networks before loading them into the CLI, allocate first and take WASM-backed typed-array views second. Use `withBufferAccess(...)` for direct buffer writes so allocation-prone calls cannot silently invalidate views.
