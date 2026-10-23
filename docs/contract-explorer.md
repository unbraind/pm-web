# Backend contract explorer

Open **Backend contracts** after selecting a project. The table reports the SDK's
live command path, provider and availability for every advertised project action,
including optional package operations. Pages contain 20 rows by default (maximum
50); `total` and `nextOffset` disclose the remainder. Selecting an action retrieves
its SDK input schema, including runtime schema customizations.

```sh
pm web contracts --limit 10 --json
pm web contracts --offset 10 --limit 10
pm web contracts --action delete --input '{"id":"demo-1"}' --json
```

The last command produces a **review-only dry-run form**, with `executed: false`
and `validated: false`. It does not call a mutation handler, run hooks for the
selected operation, acquire writer locks or promise an operation-specific dry-run.
Review its input against the supplied schema and execute separately through an
authorized operation surface. No apply/execute control is present in the explorer.
Inputs are bounded to 12 KiB. Treat preview output as carefully as the input you
provide; it can contain your own project data.

## SDK and backend adapters

`directoryContractAdapter({ pmRoot, cwd, noExtensions })` calls the existing SDK's
`getContracts`, with tracker initialization checks. `exploreContracts(adapter,
{ offset, limit, action })` and `reviewContract(adapter, action, input, permission)`
accept a typed, read-only `ContractAdapter` with `kind: 'directory' | 'postgres' |
'remote'` and `describe(selection): Promise<ContractsResult>`. Database and remote
integrators supply their actual SDK contract resolver. Support is never inferred
from the kind label. A missing, malformed, duplicated or failed availability read
refuses the request; the adapter has no dispatch method.

`ContractExplorerClient(origin, token)` provides authenticated remote `list` and
`review` calls. HTTPS is required except for loopback development origins. Tokens
stay in memory, requests have a 15-second deadline and redirects are refused.

The built-in web project route currently inspects the project's directory tracker;
PostgreSQL stores application membership and permissions. Adapter parity fixtures
are evidence for the normalized inspection contract, not certification of arbitrary
Postgres or remote mutation implementations. pm-ops owns backend read assurance.

## Availability and authorization

`available` requires both SDK `available` and `invocable` declarations. It describes
registration/policy availability, not a live connectivity probe of every downstream
service. `unsupported` means an optional provider is absent. `unavailable` means
inspection failed or the advertised operation cannot currently be invoked.
Raw provider exceptions, configuration and disabled-reason text are never returned.
Typed `ContractExplorerError` carries `code`, HTTP `status` and a safe `remedy`:

| Code | Remedy |
| --- | --- |
| `invalid_input` | Supply integer pagination, a known action and bounded JSON object. |
| `unsupported` | Enable the required package or select an advertised action. |
| `unavailable` | Check backend connectivity, configuration and policy, then refresh. |
| `view_only` | Ask a project editor to review an operation that may change data. |
| `not_found` | Select a project shared with the authenticated account. |

HTTP `GET /api/projects/:id/pm/contracts` and
`POST /api/projects/:id/pm/contracts/review` reauthorize every request and set
`Cache-Control: no-store, private`. A preview refreshes availability before
returning. All package operations are conservatively classified as potentially
mutating; core mutation classification comes from the SDK. UI controls remain
disabled when a provider is missing or the caller cannot edit. Stale inspection
results never authorize execution.

## Without git

SDK, CLI, HTTP inspection and input previews work in a plain initialized tracker.
No Git executable is required. Individual operations advertised by a package may
still require Git when executed elsewhere; inspection does not execute them.

See [the SDK example](../examples/contract-explorer.ts).
