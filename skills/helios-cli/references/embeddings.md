# Embedding Workflows

Use this reference whenever the user asks to visualize text, document, image,
paper, or other vector embeddings with Helios CLI.

## Default Route

For embeddings, the preferred Helios artifact is a graph-only dynamic UMAP XNET.
Build it with `helios_network.HeliosUMAP.fit_graph_network(...)`, not with
`umap.UMAP(...).fit_transform(...)`.

The output XNET must let Helios Web run the UMAP layout itself. It should carry:

- graph attribute `umap` set to `true`
- graph attribute `umap_graph_kind` set to `fuzzy_simplicial_set`
- graph attribute `umap_edge_weight_attr` set to `umap_weight`
- graph attribute `umap_node_mass_attr` set to `umap_mass`
- edge attribute `umap_weight`
- node attribute `umap_mass`
- node attributes `umap_index` and `umap_is_query`
- optional node metadata such as labels, titles, categories, years, and source ids

The graph-only dynamic UMAP XNET should intentionally omit:

- `_helios_visuals_position`
- `umap_embedding`
- precomputed 2D UMAP coordinates

Only precompute and apply static UMAP positions when the user explicitly asks
for a fixed coordinate export, a static layout, or an external UMAP figure.

## Reference Implementation

Use `helios-embedding-example/create_tweet_umap_xnet.py` as the source-of-truth
example. The important part is:

```python
from helios_network import HeliosUMAP

exporter = HeliosUMAP(
    n_neighbors=15,
    min_dist=0.08,
    spread=1.0,
    n_components=2,
    metric="cosine",
    negative_sample_rate=5.0,
    repulsion_strength=1.0,
    init="spectral",
    random_state=13,
    transform_seed=13,
    low_memory=True,
    build_knn_network=False,
    prefer_pynndescent=True,
)
network = exporter.fit_graph_network(embeddings)
```

After `fit_graph_network`, attach metadata attributes to `network`; do not add
positions. Save as XNET/BXNET/ZXNET using the available writer for the current
environment.

## Template

This skill includes a copyable template at:

```text
examples/parquet_dynamic_umap_xnet.py
```

Use it for parquet files with one embedding-vector column plus metadata columns.
Adapt only the input column names and metadata assignments.

## Loading And Verifying

Start or replace a session with the generated XNET:

```sh
helios session start --renderer webgpu --layout gpu-force --network ./embedding-dynamic-umap.xnet
helios call "$SESSION" network.stats
helios call "$SESSION" layout.get
```

The layout check must report `UMAP Force (GPU)`, not just `Force (GPU)`.
Expected evidence:

- `network.stats` shows nonzero node and edge counts.
- `layout.get` label is `UMAP Force (GPU)`.
- `layout.get` exposes UMAP parameters such as `umapNegativeSampleRate`,
  `umapA`, `umapB`, or `umapEpochCurrent`.
- `positions.get` does not list a source embedding-position attribute except
  current runtime positions.

After every visual change, verify the rendered result directly. Bring the
browser forward for interactive sessions, or export a PNG and inspect it for
headless sessions:

```sh
helios call "$SESSION" camera.frame --json '{"animate":false,"resetOrientation":true}'
helios call "$SESSION" export.figure --json '{
  "format": "png",
  "preset": "window",
  "includeLegends": true,
  "outputPath": "./embedding-check.png"
}'
```

For simple requests, do the requested change and check the image; do not stop
at describing commands or validating only `scene.getState`.

Tune through UMAP parameters:

```sh
helios call "$SESSION" layout.setParameters --json '{
  "outputScale": 30,
  "umapNegativeSampleRate": 7,
  "sampleChurn": 0.02
}'
```

Do not use component-layout controls as the primary fix for embedding UMAP
files. If component-related controls appear, treat them as secondary visual
feedback knobs only after confirming the layout is `UMAP Force (GPU)`.

## Styling

Map metadata attributes after loading. For embedding maps, the default visual
preference is to render nodes only: UMAP edges are required for layout but
should not be drawn unless the user explicitly asks to inspect neighborhood
links. The CLI automatically sets edge width scale to `0` when a loaded network
has dynamic UMAP metadata. Verify that state before export or live handoff, and
set it manually only when repairing an older session:

```sh
helios state set "$SESSION" appearance.edgeStyle.widthScale 0
```

Then map node metadata:

```sh
helios call "$SESSION" network.categorizeAttribute --json '{
  "scope": "node",
  "attribute": "nsf_category"
}'

helios call "$SESSION" mappers.set --json '{
  "nodeMapper": {
    "color": {
      "type": "categorical",
      "attribute": "nsf_category"
    },
    "size": { "type": "constant", "value": 1.8 }
  }
}'
```

For classification labels such as NSF category, discipline, source, language,
or cluster label, prefer categorical attributes and categorical mappers. Do not
map string labels through a continuous colormap, and do not use numeric id
columns as a substitute when a human-readable label attribute is available.
Categorizing the label attribute preserves the category dictionary for legends
and lets the mapper domain use category ids internally.

Use the Mappers panel categorical defaults unless the user asks otherwise:
frequency ordering, `category18`, a maximum of 18 colored categories, and
overflow to the mapper default value shown as `Others`. Do not repeat the
palette or generate extra colors for additional classes.

Do not add an edge width mapper for the default embedding view. Edge mapping can
force edge visual-attribute updates even when the user's goal is a node map.

For labels, attach a short `Label` node attribute and let hover/selection show
details. Avoid enabling many always-visible labels on large embedding maps.

## Common Mistakes

- Wrong: run `umap.UMAP(...).fit_transform(X)`, then export coordinates as
  `map_position`. This creates a static UMAP map and bypasses Helios Web's UMAP
  layout implementation.
- Wrong: call `HeliosUMAP.fit_network(...)` when the user wants Helios Web to
  lay out from scratch. `fit_network` exports embedding/position attributes.
- Wrong: build kNN edges manually from embeddings and call that "UMAP".
  The dynamic UMAP path needs the fuzzy simplicial-set graph and `umap_weight`.
- Wrong: assume large embedding counts require sampling. Helios Web is intended
  to render large graphs; sampling is only for a fast smoke test or when the
  user explicitly asks for a sample.
- Wrong: load a dynamic UMAP XNET and then immediately call
  `positions.fromAttribute`. That converts the workflow back to static
  positions.

## Dependency Notes

The Python side needs `helios-network` with UMAP extras plus a parquet reader
when reading parquet:

```sh
python -m pip install "helios-network[umap]" pyarrow pandas
```

In a monorepo checkout, prefer the local `helios-network-v2/python` editable
install when changing the graph-export contract. For local CLI verification
against a sibling `helios-web` checkout, use `npm link`; do not commit `file:`
or relative dependency paths just to test local integration.
