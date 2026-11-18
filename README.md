# SBF Core Framework

A standalone Node.js framework snapshot extracted from a live interaction project. It covers request scheduling, access control, media fragment validation, playback clocks, slow-client isolation, and an optional state model for paid interactions.

This repository contains framework source code and a local interface demo. A generation worker, avatar video, live stream, and payment configuration are not bundled, so an offline worker and a player waiting for input are expected on first launch. This keeps the public snapshot readable and testable without including private infrastructure or production data.

## Run locally

Use Node.js 22 or later, as the source relies on native ES modules, the Node.js test runner, and recent Node.js APIs. Run these commands from the repository root:

```sh
npm install
npm run build
npm start
```

Open <http://127.0.0.1:8080> to view the local interface. `GET /healthz` returns a health check, and `GET /api/status` returns the framework status. The build step bundles frontend dependencies so the static server can serve the browser's package imports.

Run the tests in another terminal. They check scheduling, authentication, media, and state contracts without connecting to private servers:

```sh
npm test
```

By default, the server listens locally and external integrations remain disabled. This lets you explore the interface, inspect HTTP responses, and run tests without private accounts. Before changing configuration, review how options are read in `web/server/config.js` and `web/server/module-c/policies.js`.

## What's included

| Component | Focus |
| --- | --- |
| HTTP / WebSocket entry points | Separate viewer sessions, worker identity, and origin checks; bound input sizes and connections |
| Broker and interaction queue | Schedule by interaction type, preserve order within each priority, and manage job and playback lifecycles |
| Media validation and scheduling | Validate fragment formats, tracks, and timestamps; separate preparation from playback |
| Browser player | Coordinate buffering, playback clocks, visibility, and reconnection |
| Backpressure and diagnostics | Isolate slow clients; collect playback reports with bounded fields, capacity, and retention |
| Module C | An optional model for orders, payment verification, persistence, entitlements, and interaction delivery; disabled by default |

See the [architecture guide](docs/architecture.md) for module relationships, source entry points, and extension interfaces.

## Scope

This snapshot excludes GPU generation implementations and service configuration, live GPU APIs, SSH connections and keys, deployment scripts and history, production environment variables, private credentials, real orders and logs, and avatar and background media. The original project's full working directory and operational records are not included.

Entry points such as `/ws/worker` retain generic protocol contracts without a bundled generation service, private endpoints, or credentials. When implementing your own worker, follow the message handling and validation code in this repository: an endpoint alone does not generate content, and media must satisfy the validation contract before playback.

Module C retains public blockchain protocols and network constants, with recipient identities unset and payment collection disabled by default. Use isolated test data when exploring extensions, because this local framework demo neither requires real payments nor provides a ready-to-use payment service.
