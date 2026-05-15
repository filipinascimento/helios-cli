# Behaviors

Behaviors expose the same interaction and UI-backed control layer used by Helios Web.

Inspect current behavior state:

```sh
helios call "$SESSION" behaviors.get
```

Update a built-in behavior:

```sh
helios call "$SESSION" behaviors.update --json '{
  "id": "hover",
  "options": {
    "hoverConnectedEdges": false,
    "hoverAffectsOtherElements": true
  }
}'
```

Enable or disable a behavior that exposes `enabled(...)`:

```sh
helios call "$SESSION" behaviors.setEnabled --json '{"id":"legends","enabled":false}'
helios call "$SESSION" behaviors.setEnabled --json '{"id":"legends","enabled":true}'
```

Detach and reattach a behavior:

```sh
helios call "$SESSION" behaviors.detach --json '{"id":"selection"}'
helios call "$SESSION" behaviors.use --json '{"id":"selection","options":{"nodeClick":true}}'
```

Call an advanced behavior method directly:

```sh
helios call "$SESSION" behaviors.call --json '{
  "id": "selection",
  "method": "selectNodes",
  "args": [[0, 2, 4], {"mode": "replace"}]
}'
```

Use `behaviors.restore` with a snapshot from `behaviors.get.serialized` when replaying a saved behavior state.
