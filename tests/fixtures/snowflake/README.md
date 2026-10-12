# Snowflake fixtures

What the Snowflake SQL API v2 answers, one scenario per file, replayed by `tests/integration/db/snowflake-provider.test.ts` through the provider's `deps` seam.
No test here reaches a Snowflake account.

## These fixtures are provisional

`documented-2026-10-12/` was written before any account existed, from the response shapes the SQL API reference documents: the asynchronous `333334` answer, a result's `resultSetMetaData` and partition 0, a later partition's `{"data": ...}` body, a failure's `code`, `sqlState` and `message`, and a cancel's status.
Its `manifest.json` says so with `"provisional": true`, and names no cloud, region, version or edition, since none is known until a capture.
`tests/unit/db/snowflake/fixture-manifest.test.ts` fails on every provisional manifest, so it fails until a capture replaces this set: by design, the provider is not done while its integration test replays answers no account gave.
Snowflake releases weekly, so a capture's `CURRENT_VERSION()` is the version that capture saw, not a pin.

Each file has the capture's form, because each was written through the capture's own scrub: `scenario`, the `connection` it was answered for (user, sign-in method, role, warehouse, database and schema, never a credential), and `exchanges` in order, each the request the provider is expected to build (method, path with its query, allow-listed headers, body) and the answer (status, allow-listed headers, body), with the field names the scrub dropped.
A body that is not JSON, such as a gateway's HTML page, is kept as `{"text": ...}`.
A partition answer is kept decoded, with the `content-encoding` it was sent with; the replay compresses it again.

## The scenarios

| Scenario | What it shows |
|---|---|
| `connect-keypair` | `connect()` signed in with a key-pair JWT: `SHOW WAREHOUSES LIKE` answered `333334`, then its rows on the status GET |
| `connect-pat` | The same over a programmatic access token |
| `refusal-390144` | A key pair Snowflake refuses: HTTP 401 with `390144` and a login-failure id |
| `refusal-390189` | A role not granted to the user, refused at connect |
| `refusal-403` | A 403 whose body is a gateway page, not JSON |
| `refusal-000606` | No warehouse for the connection's role, met by the role check |
| `refusal-002003` | An object that does not exist or the role may not see |
| `refusal-003001` | A privilege the role lacks |
| `refusal-422` | A syntax error, the generic 422 |
| `refusal-404` | A status GET whose statement Snowflake no longer holds |
| `tree-show` | The tree under the read-only role: databases, one database's schemas, and each kind's `SHOW` in one schema |
| `describe-columns` | A table's `SHOW COLUMNS`, `SHOW PRIMARY KEYS` and its `SHOW TABLES LIKE` row |
| `three-partitions-cut` | A result in three partitions, partitions 1 and 2 fetched gzipped |
| `every-type` | One column per row of the provider's type table, and a row of NULLs |
| `cancel` | A running statement, its status still `333334`, and its cancel answered `000604` |
| `role-check-match` | The role check answering the configured role, then the statement |
| `role-check-mismatch` | The role check answering another role, so the statement is never sent |
| `role-check-secondary` | The role check answering active secondary roles |
| `monitoring-started` | A monitoring panel on a running warehouse: the fresh state read, then the Information Schema statement |
| `monitoring-suspended` | The same panel on a suspended warehouse: the state read only |
| `role-restricted-pat-show` | A PAT restricted to one role on a connection configured with another, answered on a `SHOW` |

What an account cannot be asked for, such as a decompression bomb, a partition past the result budget or a link to another host, is built by the test that needs it, labelled BUILT in that test's header, and is never a fixture.

## The capture that replaces them

`tests/live/snowflake-evidence.ts` runs the measurement list of `tests/live/snowflake-evidence-plan.ts` and the scenarios above against the trial account, over raw `node:https` with no provider code, and writes `trial-<date>-v<CURRENT_VERSION>/<scenario>.json` and a full `manifest.json`: the cloud, the region, `CURRENT_VERSION()`, the edition, the capture date and the Studio commit.
Its inputs come from the environment only: `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_SVC_USER` and `SNOWFLAKE_SVC_KEY_FILE` with an optional `SNOWFLAKE_SVC_KEY_PASSPHRASE`, `SNOWFLAKE_READER_USER` and `SNOWFLAKE_READER_KEY_FILE` with an optional `SNOWFLAKE_READER_KEY_PASSPHRASE`, `SNOWFLAKE_PAT_USER` and `SNOWFLAKE_PAT`, and `SNOWFLAKE_WAREHOUSE`.
The harness also reads `SNOWFLAKE_EDITION`, which the manifest records, and, when the operator knows it, `SNOWFLAKE_EGRESS_IP`, which the scrub looks for.
A missing or malformed one stops the run with exit code 2 before any socket.
The account is set up once as ACCOUNTADMIN with the names the scenarios use: a resource monitor `studio_probe_rm`, an X-Small Gen1 warehouse `studio_probe_wh` with `AUTO_SUSPEND = 60`, the database `studio_demo` with schema `probe`, the roles `studio_ro`, `studio_rw` and `studio_nowh`, a network policy on the users for `<operator egress IPv4>`, and the users `studio_svc` (key pair, `studio_rw`), `studio_reader` (key pair, `studio_ro` and `studio_nowh`) and `studio_pat` (a PAT restricted to `STUDIO_RO`).
Keys and the PAT live in the operator's env file, never in this repository.
The trial account is named here only as `<account>`.

Every exchange passes through `tests/helpers/snowflake-evidence-scrub.ts` before it is written.
Only the named headers and body fields are kept, and the rest are listed in `dropped`.
Every bearer token becomes `<token-N>`, so the Authorization header reads `Bearer <token-N>` and a token signed later in a run reads as another one; every UUID (statement handles, query ids, request ids, login-failure ids) becomes `00000000-0000-0000-0000-00000000000N`, the same placeholder for the same id across every file of a run, still UUID-shaped so the replay passes the provider's handle check; the host, the account locator, the organisation and the account name become `<host>`, `<account-locator>`, `<organization>` and `<account>`; user names become `<user-N>`, in any case; IP addresses become `<ip-N>`.
Nothing is written while any file still holds a PAT or a passphrase in any spelling, a JWT-shaped string, a private key's armour, a Snowflake host, the account's names, the egress IP or an email address.
`tests/unit/db/snowflake/evidence-scrub.test.ts` renders every committed fixture again through the scrub, so a fixture the scrub would refuse, or would write differently, fails the suite.

Credits used per session, read from `WAREHOUSE_METERING_HISTORY` and `METERING_HISTORY` after it, are recorded here once a session has run.
