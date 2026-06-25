# Rendering And Export

## Session Modes

- `--mode headless`: managed bundled Chromium, suitable for automated tests and exports.
- default / `--mode server --open`: serves the client and opens the OS/default browser, suitable for interactive visual inspection.
- `--mode server --no-open`: serves the client and control socket without launching or opening a browser.
- `--mode headed`: managed visible bundled Chromium, intended only for Playwright-managed debugging.

Plain `helios session start` uses the platform browser opener instead of Playwright's bundled "Chrome for Testing". Managed browser sessions use Playwright's bundled Chromium by default. Add `--browser-channel chrome` only when you explicitly need an installed Chrome channel. UI-triggered downloads from managed sessions are copied to `~/Downloads` using the suggested filename.

Initialize the default managed browser once with:

```sh
helios browser install
```

This installs bundled Chromium. On Linux, use `helios browser install --with-deps` if system browser dependencies are missing.

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
