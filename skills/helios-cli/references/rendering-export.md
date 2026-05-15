# Rendering And Export

## Session Modes

- `--mode headless`: managed Chromium, suitable for automated tests and exports.
- `--mode headed`: managed visible Chromium, suitable for visual inspection.
- `--mode server`: serves the client and control socket without launching a managed browser.

## Renderer

Use:

```sh
helios session start --mode headless --renderer webgpu
```

Renderer options:

- `webgpu`: require hardware WebGPU, except headless sessions may fall back to hardware WebGL2 when WebGPU is unavailable.
- `webgl`: require hardware WebGL2.
- `auto`: accept the initialized hardware backend.

By default, software-only rendering is rejected. Use `--no-gpu` only when explicitly acceptable for the task.

## Figure Export

```sh
helios call "$SESSION" export.figure --json '{
  "format": "png",
  "preset": "window",
  "outputPath": "./figure.png"
}'
```

Call `scene.getState` first to confirm renderer, camera, layout, filters, density, labels, legends, and mappers before exporting.

## Events

Stream events while another process manipulates a session:

```sh
helios events "$SESSION"
```

Useful event types include `browser.console`, `browser.pageerror`, `browser.gpu`, `helios.layoutStart`, `helios.layoutStop`, `helios.cameraMove`, and `helios.networkReplaced`.
