#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from helios_network import AttributeScope, AttributeType, HeliosUMAP, read_xnet


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a graph-only dynamic UMAP XNET from a parquet embedding table.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--embedding-column", default="embedding")
    parser.add_argument("--label-column", default="title")
    parser.add_argument("--id-column", default="id")
    parser.add_argument("--category-column", default=None)
    parser.add_argument("--limit", type=int, default=None, help="Optional smoke-test row limit. Omit for the full table.")
    parser.add_argument("--n-neighbors", type=int, default=15)
    parser.add_argument("--min-dist", type=float, default=0.08)
    parser.add_argument("--random-state", type=int, default=13)
    return parser.parse_args()


def quote_xnet(value: object) -> str:
    text = "" if value is None else str(value)
    escaped = (
        text.replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
        .replace('"', '\\"')
    )
    return f'"{escaped}"'


def format_number(value: object) -> str:
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float):
        if not math.isfinite(value):
            return "0"
        return format(value, ".9g")
    return str(int(value)) if isinstance(value, (int, np.integer)) else str(value)


def xnet_type_token(info: dict) -> str:
    attr_type = int(info["type"])
    dimension = int(info.get("dimension", 1) or 1)
    token = {
        int(AttributeType.String): "s",
        int(AttributeType.Float): "f",
        int(AttributeType.Double): "f",
        int(AttributeType.Integer): "i",
        int(AttributeType.UnsignedInteger): "u",
        int(AttributeType.Category): "c",
        int(AttributeType.BigInteger): "I",
        int(AttributeType.UnsignedBigInteger): "U",
    }.get(attr_type)
    if token is None:
        raise TypeError(f"Unsupported XNET attribute type id {attr_type}")
    if dimension > 1:
        if attr_type == int(AttributeType.String):
            raise TypeError("XNET does not support vector string attributes")
        return f"{token}{dimension}"
    return token


def format_xnet_value(value: object, info: dict) -> str:
    attr_type = int(info["type"])
    dimension = int(info.get("dimension", 1) or 1)
    if attr_type == int(AttributeType.String):
        return quote_xnet(value)
    if dimension > 1:
        return " ".join(format_number(component) for component in value)
    return format_number(value)


def write_xnet_text(network, path: Path) -> None:
    lines: list[str] = ["#XNET 1.0.0", f"#vertices {int(network.node_count())}"]

    for name in network.list_attributes(AttributeScope.Network):
        info = network.attribute_info(AttributeScope.Network, name)
        lines.append(f"#g {quote_xnet(name)} {xnet_type_token(info)}")
        lines.append(format_xnet_value(network[name], info))

    lines.append(f"#edges {'directed' if bool(network.is_directed) else 'undirected'}")
    for source, target in network.edge_pairs():
        lines.append(f"{int(source)} {int(target)}")

    for name in network.list_attributes(AttributeScope.Node):
        info = network.attribute_info(AttributeScope.Node, name)
        lines.append(f"#v {quote_xnet(name)} {xnet_type_token(info)}")
        for value in network.nodes[name]:
            lines.append(format_xnet_value(value, info))

    if "_original_ids_" not in set(network.list_attributes(AttributeScope.Node)):
        lines.append('#v "_original_ids_" s')
        lines.extend(quote_xnet(index) for index in range(int(network.node_count())))

    for name in network.list_attributes(AttributeScope.Edge):
        info = network.attribute_info(AttributeScope.Edge, name)
        lines.append(f"#e {quote_xnet(name)} {xnet_type_token(info)}")
        for value in network.edges[name]:
            lines.append(format_xnet_value(value, info))

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def clean_text(value: object, limit: int = 160) -> str:
    text = "" if pd.isna(value) else str(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "..."


def add_metadata(network, frame: pd.DataFrame, args: argparse.Namespace) -> None:
    if args.label_column in frame:
        network.define_attribute(AttributeScope.Node, "Label", AttributeType.String, 1)
        network.nodes["Label"] = [clean_text(value) for value in frame[args.label_column]]
    if args.id_column in frame:
        network.define_attribute(AttributeScope.Node, "source_id", AttributeType.String, 1)
        network.nodes["source_id"] = frame[args.id_column].fillna("").astype(str).tolist()
    if args.category_column and args.category_column in frame:
        labels = frame[args.category_column].fillna("Unknown").astype(str)
        category_labels = sorted(labels.unique())
        category_ids = {label: index for index, label in enumerate(category_labels)}
        network.define_attribute(AttributeScope.Node, "category", AttributeType.String, 1)
        network.define_attribute(AttributeScope.Node, "category_id", AttributeType.Integer, 1)
        network.nodes["category"] = labels.tolist()
        network.nodes["category_id"] = [int(category_ids[label]) for label in labels]
        network["category_count"] = int(len(category_labels))
        network["category_id_legend"] = "; ".join(f"{index}:{label}" for label, index in category_ids.items())

    network["dataset_name"] = args.input.stem
    network["source_parquet"] = str(args.input)
    network["dynamic_umap_export"] = "graph-only HeliosUMAP.fit_graph_network; no precomputed positions"


def main() -> int:
    args = parse_args()
    table = pq.read_table(args.input)
    frame = table.to_pandas()
    if args.limit is not None:
        frame = frame.head(args.limit).copy()

    embeddings = np.vstack(frame[args.embedding_column].to_numpy()).astype(np.float32, copy=False)
    exporter = HeliosUMAP(
        n_neighbors=args.n_neighbors,
        min_dist=args.min_dist,
        spread=1.0,
        n_components=2,
        metric="cosine",
        negative_sample_rate=5.0,
        repulsion_strength=1.0,
        init="spectral",
        random_state=args.random_state,
        transform_seed=args.random_state,
        low_memory=True,
        build_knn_network=False,
        prefer_pynndescent=True,
    )
    network = exporter.fit_graph_network(embeddings)
    add_metadata(network, frame, args)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_xnet_text(network, args.output)
    loaded = read_xnet(str(args.output))
    if loaded.node_count() != network.node_count() or loaded.edge_count() != network.edge_count():
        raise RuntimeError("XNET validation failed after round-trip read")
    print(f"Wrote {args.output} with {int(network.node_count())} nodes and {int(network.edge_count())} edges")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
