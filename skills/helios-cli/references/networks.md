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
