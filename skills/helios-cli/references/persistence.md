# Persistence

Helios CLI sessions persist enough state for a browser reload to recover the same network and a close visual state. The browser client stores a full session checkpoint in IndexedDB through Helios Web persistence and also keeps a lightweight visualization-state fallback in localStorage.

The persistence id is derived from the CLI session id:

```text
helios-cli:<sessionId>
```

## Automatic Saves

Mutating RPC calls trigger a save before the response is returned. This includes network replacement or attribute writes, scene mode changes, camera changes, layout changes, mapper changes, behavior changes, positions, filters, labels, legends, density, metrics, and aesthetic measurements.

Runtime events also schedule saves:

- camera movement saves visualization state quickly without rewriting the full network
- behavior, mode, filter, and layout-stop changes schedule full checkpoints
- page unload attempts a final lightweight visualization-state save

## Manual Save

Use `persistence.save` before reloads, screenshots, handoff points, or multi-step workflows where recovering exactly the current state matters:

```sh
helios call <sessionId> persistence.save --json '{"fullSession":true}'
```

`fullSession: true` writes the network plus visualization state. `fullSession: false` writes only the local visualization fallback.

## Reload Recovery

In a managed headed or headless browser session, reload the page and wait for the bridge to reconnect:

```sh
helios call <sessionId> browser.reload
helios call <sessionId> scene.getState
```

On page load, the client first tries to restore the full IndexedDB checkpoint. If that fails or is unavailable, it restores the localStorage visualization fallback against the current network.

## Explicit Restore And Clear

Restore the current checkpoint without reloading:

```sh
helios call <sessionId> persistence.restore
```

Clear the saved checkpoint and fallback:

```sh
helios call <sessionId> persistence.clear
```

Inspect the persistence id and storage key:

```sh
helios call <sessionId> persistence.get
```

## What Persists

Full checkpoints cover the network data, mode, camera, layout and behavior state, mapper descriptors, filters, density, labels, legends, and other Helios Web visualization state exposed by `serializeVisualizationState`.

For function-backed mappers and custom code descriptors, persist the descriptor source that created them. A browser reload can restore function-like mapper descriptors that are serializable, but external closures or runtime-only JavaScript objects cannot be reconstructed from storage.
