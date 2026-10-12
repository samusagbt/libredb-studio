/**
 * Snowflake provider, end to end over the fixtures.
 *
 * The real provider, account reader, key intake and JWT signer, transport lanes, statements, row reader, decoder,
 * object surface, panels and error table all run; only Snowflake is fake. The fake is the scripted node transport of
 * `tests/helpers/snowflake-node-transport.ts`, handed to the provider through its `deps` in place of the shared
 * `createNodeTransport` and `createNodeByteTransport`, so every request goes through the transport's seam and is
 * answered from a fixture. Time is injected (`testDeps`): the clock moves only when a test moves it, and no deadline
 * fires unless a test fires it. `mock.module()` is not used, no real timer runs and no socket opens.
 *
 * The payloads are PROVISIONAL: `tests/fixtures/snowflake/documented-2026-10-12/` was written from the SQL API
 * reference's documented response shapes before any account existed (its manifest says `"provisional": true`), and
 * `tests/unit/db/snowflake/fixture-manifest.test.ts` fails until a capture from the trial account replaces it. A
 * capture's `CURRENT_VERSION()` and date go here when it does; Snowflake releases weekly, so that version is the
 * capture's, not a pin.
 *
 * Each scenario's requests are checked against the fixture's, in order: the method, the path and its query (a
 * submit's `requestId` is the run's own), and the whole body. The other dashboard panels, the inventory and a view's
 * source are answered in the test itself, from the same documented shapes (`tests/helpers/snowflake-answers.ts`). What
 * is BUILT rather than written from a documented answer: the partition past the result budget (a 16 MiB body cannot be a fixture), the answers that echo a sentinel
 * PAT, passphrase or JWT, the 10,000-character server message, a transport failure, and the extra status GET that
 * hangs so a run is in flight when a test cancels it or disconnects.
 *
 * The private-host case of the address policy (a PrivateLink name resolving to 10.0.0.5 under
 * DB_HTTP_BLOCK_PRIVATE_HOSTS) needs the real transport and a stubbed resolver, so it is in
 * `tests/unit/db/snowflake/security-control.test.ts`, not here.
 *
 * Every provider a test builds is disconnected after it, so no permit of the process-wide engine limiter is left held
 * for the next test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createErrorResponse } from "@/lib/api/errors";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { SNOWFLAKE_KEY_SENTENCES } from "@/lib/db/providers/sql/snowflake/auth";
import { SNOWFLAKE, SNOWFLAKE_ERROR_SENTENCES } from "@/lib/db/providers/sql/snowflake/errors";
import { SnowflakeProvider } from "@/lib/db/providers/sql/snowflake/index";
import { SNOWFLAKE_INTROSPECT_SENTENCES, SNOWFLAKE_KIND_IDS } from "@/lib/db/providers/sql/snowflake/introspect";
import { SNOWFLAKE_MONITORING_SENTENCES } from "@/lib/db/providers/sql/snowflake/monitoring";
import { SNOWFLAKE_ROWS_SENTENCES } from "@/lib/db/providers/sql/snowflake/rows";
import { SNOWFLAKE_STATEMENT_SENTENCES } from "@/lib/db/providers/sql/snowflake/statements";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { historyMaskOf, maskStatementForHistory } from "@/lib/history-mask";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import { handleAnswer, resultAnswer } from "../../helpers/snowflake-answers";
import { KEY_TEST_PASSPHRASE, pbes2Pbkdf2Pem, pkcs8Pem, rsaKey } from "../../helpers/snowflake-keys";
import {
  deferredAnswer,
  fakeClock,
  type RecordedRequest,
  type ScriptedAnswer,
  scriptedTransports,
  testDeps,
} from "../../helpers/snowflake-node-transport";

// ============================================================================
// The fixtures
// ============================================================================

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "snowflake", "documented-2026-10-12");

interface FixtureConnection {
  readonly user: string;
  readonly authMethod: "keypair" | "pat";
  readonly role: string;
  readonly warehouse: string;
  readonly database: string;
  readonly schema: string;
}

interface FixtureExchange {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Record<string, unknown>;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Record<string, unknown>;
  };
}

interface Scenario {
  readonly scenario: string;
  readonly connection: FixtureConnection;
  readonly exchanges: readonly FixtureExchange[];
}

const load = (name: string): Scenario => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Scenario;

/** A fixture's answer as the scripted transport gives it: a partition compressed again, a non-JSON body as text. */
function answerOf(response: FixtureExchange["response"]): ScriptedAnswer {
  const { status, headers, body } = response;
  if (headers["content-encoding"] === "gzip") {
    return { status, bytes: gzipSync(JSON.stringify(body)), contentEncoding: "gzip" };
  }
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "text") return { status, text: String(body.text) };
  return { status, json: body };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Scripts every exchange of the scenario, each answered once, in order, by its method and exact path. */
function replay(entry: Built, scenario: Scenario, exchanges: readonly FixtureExchange[] = scenario.exchanges): void {
  for (const exchange of exchanges) {
    const path = new URL(exchange.request.path, "https://fixture.invalid").pathname;
    entry.transports.answer(
      { method: exchange.request.method, path: new RegExp(`^${escapeRegExp(path)}$`) },
      answerOf(exchange.response),
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the provider sent equals what the fixture records: method, path, query and body, in order. */
function expectRequests(recorded: readonly RecordedRequest[], exchanges: readonly FixtureExchange[]): void {
  expect(recorded.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
    exchanges.map((exchange) => `${exchange.request.method} ${exchange.request.path.split("?")[0]}`),
  );
  recorded.forEach((request, index) => {
    const expected = exchanges[index].request;
    const sent = new URL(request.url);
    const wanted = new URL(expected.path, "https://fixture.invalid");
    if (wanted.searchParams.has("requestId")) {
      expect(sent.searchParams.get("async")).toBe("true");
      expect(sent.searchParams.get("requestId") ?? "").toMatch(UUID);
      expect([...sent.searchParams.keys()]).toEqual([...wanted.searchParams.keys()]);
    } else {
      expect(sent.search).toBe(wanted.search);
    }
    expect(request.headers["x-snowflake-authorization-token-type"]).toBe(
      expected.headers["x-snowflake-authorization-token-type"],
    );
    if (expected.body === undefined) expect(request.body).toBeUndefined();
    else expect(JSON.parse(request.body ?? "null")).toEqual(expected.body);
  });
}

// ============================================================================
// The providers
// ============================================================================

const KEY = rsaKey();
const PEM = pkcs8Pem(KEY);
const ACCOUNT = "acmeorg-probeacct";
const PAT = "sentinel-pat-7f3c9a1e5b2d4c6a8e0f";

function connectionFor(fixture: FixtureConnection, overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "snowflake-integration",
    name: "Snowflake",
    type: SNOWFLAKE,
    host: ACCOUNT,
    user: fixture.user,
    role: fixture.role,
    warehouse: fixture.warehouse,
    database: fixture.database,
    schema: fixture.schema,
    authMethod: fixture.authMethod,
    ...(fixture.authMethod === "keypair" ? { privateKey: PEM } : { password: PAT }),
    createdAt: new Date(0),
    ...overrides,
  } as DatabaseConnection;
}

interface Built {
  readonly provider: SnowflakeProvider;
  readonly transports: ReturnType<typeof scriptedTransports>;
  readonly deps: ReturnType<typeof testDeps>;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly connection: DatabaseConnection;
}

const built: Built[] = [];

function build(connection: DatabaseConnection): Built {
  const transports = scriptedTransports();
  const clock = fakeClock();
  const deps = testDeps(transports, clock);
  const entry = { provider: new SnowflakeProvider(connection, {}, deps), transports, deps, clock, connection };
  built.push(entry);
  return entry;
}

/** A provider for the scenario's connection, with every exchange of the scenario scripted. */
function replayed(name: string, overrides: Record<string, unknown> = {}): { entry: Built; scenario: Scenario } {
  const scenario = load(name);
  const entry = build(connectionFor(scenario.connection, overrides));
  replay(entry, scenario);
  return { entry, scenario };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fires every deadline asked for, again and again, until `promise` settles. */
async function settle(entry: Built, promise: Promise<unknown>): Promise<void> {
  let settled = false;
  const done = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < 50; round += 1) {
    if (settled) break;
    entry.deps.deadlines.requested.forEach((_, index) => entry.deps.deadlines.fire(index));
    // oxlint-disable-next-line no-await-in-loop -- each round lets the runs react before the next fire.
    await tick();
  }
  await done;
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

const bodyOf = (request: RecordedRequest): Record<string, unknown> => JSON.parse(request.body ?? "{}");
const statementsSent = (entry: Built): string[] =>
  entry.transports.requests.filter((request) => request.body !== undefined).map((r) => String(bodyOf(r).statement));
const bearerOf = (request: RecordedRequest): string => (request.headers.authorization ?? "").replace(/^Bearer /, "");

// The logger and the console are watched for every sentinel; nothing is printed while the tests run.
const LOG_METHODS = ["debug", "info", "warn", "error"] as const;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let spies: ReturnType<typeof spyOn>[] = [];

beforeAll(() => {
  spies = [
    ...LOG_METHODS.map((method) => spyOn(logger, method).mockImplementation(() => {})),
    ...CONSOLE_METHODS.map((method) => spyOn(console, method).mockImplementation(() => {})),
  ];
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});
afterEach(async () => {
  for (const entry of built.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- each provider releases its permits before the next.
    await settle(entry, entry.provider.disconnect());
  }
  for (const spy of spies) spy.mockClear();
});

/** Everything printed so far, through the logger or the console, as one text. */
const printed = (): string =>
  spies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");

// ============================================================================
// Connect
// ============================================================================

describe("connect", () => {
  test("by key pair: one SHOW WAREHOUSES LIKE, polled once, signed with a key-pair JWT, and no caution", async () => {
    const { entry, scenario } = replayed("connect-keypair");
    await entry.provider.connect();
    expectRequests(entry.transports.requests, scenario.exchanges);
    for (const request of entry.transports.requests)
      expect(bearerOf(request)).toMatch(/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
    expect(entry.provider.isConnected()).toBe(true);
    expect(entry.provider.connectWarnings()).toEqual([]);
  });

  test("by PAT: the token is the bearer itself, typed as a programmatic access token", async () => {
    const { entry, scenario } = replayed("connect-pat");
    await entry.provider.connect();
    expectRequests(entry.transports.requests, scenario.exchanges);
    for (const request of entry.transports.requests) expect(bearerOf(request)).toBe(PAT);
    expect(entry.provider.connectWarnings()).toEqual([]);
  });
});

// ============================================================================
// The refusals of the error table
// ============================================================================

describe("each refusal the fixtures hold, with its class and its sentence", () => {
  test("390144: the key pair is refused, naming the login-failure id and a statement that registers the key", async () => {
    const { entry, scenario } = replayed("refusal-390144");
    const error = (await caught(entry.provider.connect())) as AuthenticationError;
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(error).toBeInstanceOf(AuthenticationError);
    const uuid = /\[([0-9a-f-]{36})\]/.exec(String(scenario.exchanges[0].response.body.message))?.[1];
    expect(error.message).toStartWith(`Snowflake refused the key pair (JWT token is invalid, [${uuid}]). `);
    expect(error.message).toContain("Studio signed as ACMEORG-PROBEACCT.STUDIO_READER with the key whose fingerprint");
    expect(error.message).toContain(`SYSTEM$GET_LOGIN_FAILURE_DETAILS('${uuid}')`);
    expect(error.fixStatement).toMatch(
      /^ALTER USER ADD KEY PAIR libredb_studio_[0-9a-f]{8} PUBLIC_KEY = '[A-Za-z0-9+/=]+'$/,
    );
    expect(entry.provider.isConnected()).toBe(false);
  });

  test("390189: a role the user does not hold names the Role field and the grant", async () => {
    const { entry, scenario } = replayed("refusal-390189");
    const error = await caught(entry.provider.connect());
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(
      SNOWFLAKE_ERROR_SENTENCES.roleRefused("STUDIO_NOWH", "studio_svc", "STUDIO_NOWH", "studio_svc"),
    );
  });

  test("403: the SQL API or a network policy refused the request, read from the status alone", async () => {
    const { entry, scenario } = replayed("refusal-403");
    const error = await caught(entry.provider.connect());
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.forbidden);
  });

  test("000606: no warehouse for the role, met by the role check, and the user statement never sent", async () => {
    const { entry, scenario } = replayed("refusal-000606");
    await entry.provider.connect();
    expect(entry.provider.connectWarnings()).toEqual([{ message: SNOWFLAKE_INTROSPECT_SENTENCES.emptyWarehouse }]);
    const error = await caught(entry.provider.query("SELECT 1"));
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.noWarehouse);
    expect(statementsSent(entry)).not.toContain("SELECT 1");
  });

  const statementRefusals: readonly (readonly [string, string, (message: string) => string])[] = [
    [
      "refusal-002003",
      "SELECT * FROM STUDIO_DEMO.PROBE.MISSING",
      (message) => SNOWFLAKE_ERROR_SENTENCES.objectMissing("STUDIO_RO", "STUDIO_RO", message),
    ],
    [
      "refusal-003001",
      "INSERT INTO STUDIO_DEMO.PROBE.WIDE (C01) VALUES (1)",
      (message) => SNOWFLAKE_ERROR_SENTENCES.privileges("STUDIO_RO", message),
    ],
    [
      "refusal-422",
      "SELECT * FORM STUDIO_DEMO.PROBE.WIDE",
      (message) => SNOWFLAKE_ERROR_SENTENCES.statementFailed(message, "001003", "42000"),
    ],
    ["refusal-404", "SELECT C01 FROM STUDIO_DEMO.PROBE.WIDE", () => SNOWFLAKE_ERROR_SENTENCES.resultGone],
  ];
  test.each(statementRefusals)(
    "%s: a QueryError with its sentence, after the role check",
    async (name, sql, sentence) => {
      const { entry, scenario } = replayed(name);
      await entry.provider.connect();
      const error = (await caught(entry.provider.query(sql))) as QueryError;
      expectRequests(entry.transports.requests, scenario.exchanges);
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(sentence(String(scenario.exchanges.at(-1)?.response.body.message)));
      expect(error.query).toBe(sql);
    },
  );
});

// ============================================================================
// The tree and describe
// ============================================================================

describe("the tree and describe under the read-only role", () => {
  test("databases, one database's schemas and each kind of one schema, every read a SHOW", async () => {
    const { entry, scenario } = replayed("tree-show");
    await entry.provider.connect();
    const databases = await entry.provider.listContainers([]);
    const schemas = await entry.provider.listContainers(["STUDIO_DEMO"]);
    const listings: Record<string, string[]> = {};
    for (const kind of SNOWFLAKE_KIND_IDS) {
      // oxlint-disable-next-line no-await-in-loop -- the fixture answers the kinds in order.
      listings[kind] = (await entry.provider.listObjects(["STUDIO_DEMO", "PROBE"], kind)).map((object) =>
        object.path.join("."),
      );
    }
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(statementsSent(entry).every((sql) => sql.startsWith("SHOW "))).toBe(true);
    expect(databases.map((database) => [database.name, database.isSessionDefault])).toEqual([
      ["SNOWFLAKE", false],
      ["SNOWFLAKE_SAMPLE_DATA", false],
      ["STUDIO_DEMO", true],
    ]);
    expect(schemas.map((schema) => [schema.path, schema.isSessionDefault])).toEqual([
      [["STUDIO_DEMO", "INFORMATION_SCHEMA"], false],
      [["STUDIO_DEMO", "PROBE"], true],
    ]);
    expect(listings).toEqual({
      table: ["STUDIO_DEMO.PROBE.BIG", "STUDIO_DEMO.PROBE.EVERY_TYPE", "STUDIO_DEMO.PROBE.WIDE"],
      view: ["STUDIO_DEMO.PROBE.EVERY_TYPE_MV", "STUDIO_DEMO.PROBE.EVERY_TYPE_V"],
      stream: [],
      task: [],
      sequence: ["STUDIO_DEMO.PROBE.SEQ1"],
      stage: [],
      "file-format": [],
      pipe: [],
      function: ["STUDIO_DEMO.PROBE.ADD_ONE(NUMBER)"],
      procedure: [],
    });
  });

  test("a table's statuses and row hints, and a materialized view's status", async () => {
    const { entry } = replayed("tree-show");
    await entry.provider.connect();
    await entry.provider.listContainers([]);
    await entry.provider.listContainers(["STUDIO_DEMO"]);
    const tables = await entry.provider.listObjects(["STUDIO_DEMO", "PROBE"], "table");
    const views = await entry.provider.listObjects(["STUDIO_DEMO", "PROBE"], "view");
    expect(tables.map((table) => [table.name, table.status, table.rowCount])).toEqual([
      ["BIG", undefined, 2_000_000],
      ["EVERY_TYPE", undefined, 2],
      ["WIDE", "transient", 10],
    ]);
    expect(views.map((view) => [view.name, view.status])).toEqual([
      ["EVERY_TYPE_MV", "materialized"],
      ["EVERY_TYPE_V", undefined],
    ]);
  });

  test("a table's columns in catalog spelling, its primary key, and no index on a table that is not hybrid", async () => {
    const { entry, scenario } = replayed("describe-columns");
    await entry.provider.connect();
    const detail = await entry.provider.describeObject(["STUDIO_DEMO", "PROBE", "EVERY_TYPE"], "table");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(detail.columns).toEqual([
      { name: "ID", type: "NUMBER(38,0)", nullable: false, isPrimary: true },
      { name: "C_TEXT", type: "VARCHAR(16777216)", nullable: true, isPrimary: false },
      { name: "C_TS_NTZ", type: "TIMESTAMP_NTZ(9)", nullable: true, isPrimary: false },
      { name: "C_VARIANT", type: "VARIANT", nullable: true, isPrimary: false },
    ]);
    expect(detail.indexes).toEqual([]);
    expect(detail.foreignKeys).toEqual([]);
  });
});

// ============================================================================
// Results
// ============================================================================

/** Rows of an ID and a 1,000-character pad, gzipped, decoding to more than the 16 MiB budget. BUILT. */
function pastTheBudget(): ScriptedAnswer {
  const row = (n: number) => `["${n}","${"0".repeat(1_000)}"]`;
  const rows = Array.from({ length: 17_500 }, (_, index) => row(10 + index)).join(",");
  return { status: 200, bytes: gzipSync(Buffer.from(`{"data":[${rows}]}`)), contentEncoding: "gzip" };
}

describe("a result in three partitions", () => {
  test("partition 0 inline, then partitions 1 and 2 fetched one at a time and gunzipped, whole", async () => {
    const { entry, scenario } = replayed("three-partitions-cut");
    await entry.provider.connect();
    const result = await entry.provider.query("SELECT ID, PAD FROM STUDIO_DEMO.PROBE.BIG ORDER BY ID LIMIT 9");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(entry.transports.requests.slice(-2).map((request) => request.lane)).toEqual([-1, -1]);
    expect(result.rows.map((row) => row.ID)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.rows[8].PAD).toBe("pad-0009");
    expect(result.warnings).toBeUndefined();
    expect(result.pagination).toBeUndefined();
  });

  test("a partition past the budget ends as the cut, with its warning and pagination saying it was limited", async () => {
    const scenario = load("three-partitions-cut");
    const entry = build(connectionFor(scenario.connection));
    replay(entry, scenario, scenario.exchanges.slice(0, -1));
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, pastTheBudget());
    await entry.provider.connect();
    const result = await entry.provider.query("SELECT ID, PAD FROM STUDIO_DEMO.PROBE.BIG ORDER BY ID LIMIT 9");
    expect(entry.transports.requests.at(-1)?.url).toEndWith("?partition=2");
    expect(result.rows.length).toBeGreaterThan(6);
    expect(result.rows.length).toBeLessThan(17_506);
    expect(result.warnings).toEqual([{ message: SNOWFLAKE_ROWS_SENTENCES.byteCut(9) }]);
    expect(result.pagination).toEqual({
      limit: MAX_UNLIMITED_ROWS,
      offset: 0,
      hasMore: false,
      totalReturned: result.rows.length,
      wasLimited: true,
    });
  });
});

describe("every type of the type table", () => {
  test("each cell decoded and each column typed in catalog spelling, and a row of NULLs read as NULL", async () => {
    const { entry, scenario } = replayed("every-type");
    await entry.provider.connect();
    const result = await entry.provider.query(
      "SELECT * FROM STUDIO_DEMO.PROBE.EVERY_TYPE ORDER BY C_NUMBER NULLS LAST",
    );
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(result.columnTypes).toEqual({
      C_NUMBER: "NUMBER(38,0)",
      C_BIG: "NUMBER(38,0)",
      C_DECIMAL: "NUMBER(10,2)",
      C_DECFLOAT: "DECFLOAT",
      C_FLOAT: "FLOAT",
      C_NAN: "FLOAT",
      C_TEXT: "VARCHAR(16777216)",
      C_BOOLEAN: "BOOLEAN",
      C_BINARY: "BINARY",
      C_DATE: "DATE",
      C_TIME: "TIME(9)",
      C_TS_NTZ: "TIMESTAMP_NTZ(9)",
      C_TS_LTZ: "TIMESTAMP_LTZ(9)",
      C_TS_TZ: "TIMESTAMP_TZ(9)",
      C_VARIANT: "VARIANT",
      C_OBJECT: "OBJECT",
      C_ARRAY: "ARRAY",
      C_MAP: "MAP",
      C_VECTOR: "VECTOR",
      C_GEOGRAPHY: "GEOGRAPHY",
      C_GEOMETRY: "GEOMETRY",
      C_UUID: "UUID",
      C_FILE: "FILE",
    });
    const [values, nulls] = result.rows;
    const shown: Record<string, unknown> = { ...values, C_BINARY: (values.C_BINARY as Buffer).toString("utf8") };
    expect(shown).toEqual({
      C_NUMBER: 42,
      C_BIG: "9007199254740993",
      C_DECIMAL: "12.50",
      C_DECFLOAT: "1.25E+40",
      C_FLOAT: 1.5,
      C_NAN: "NaN",
      C_TEXT: "text value",
      C_BOOLEAN: true,
      C_BINARY: "Hello",
      C_DATE: "2020-01-01",
      C_TIME: "23:01:59.000000000",
      C_TS_NTZ: "2021-03-19 17:06:59.000000000",
      C_TS_LTZ: "2021-03-19 17:06:59.000000000+00:00",
      C_TS_TZ: "2021-03-19 18:06:59.000000000+01:00",
      C_VARIANT: '{\n  "a": 1\n}',
      C_OBJECT: '{\n  "k": "v"\n}',
      C_ARRAY: "[\n  1,\n  2\n]",
      C_MAP: '{\n  "x": 1\n}',
      C_VECTOR: "[1.100000,2.200000]",
      C_GEOGRAPHY: '{\n  "coordinates": [\n    -122.35,\n    37.55\n  ],\n  "type": "Point"\n}',
      C_GEOMETRY: '{\n  "coordinates": [\n    1,\n    2\n  ],\n  "type": "Point"\n}',
      C_UUID: "00000000-0000-0000-0000-000000000999",
      C_FILE: '{"STAGE":"@STUDIO_DEMO.PROBE.FILES","RELATIVE_PATH":"a.csv","CONTENT_TYPE":"text/csv","SIZE":12}',
    });
    expect(Object.values(nulls).every((cell) => cell === null)).toBe(true);
  });
});

// ============================================================================
// Cancel, the role check, the panels and the role-restricted PAT
// ============================================================================

describe("a cancel", () => {
  test("a running statement cancelled by its id sends one cancel by handle and ends as cancelled", async () => {
    const scenario = load("cancel");
    const entry = build(connectionFor(scenario.connection));
    replay(entry, scenario);
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, { hang: true });
    await entry.provider.connect();
    const outcome = caught(entry.provider.query("SELECT SYSTEM$WAIT(120)", undefined, "q-cancel"));
    await entry.transports.received(scenario.exchanges.length);
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    expect(await entry.provider.cancelQuery("q-cancel")).toBe(true);
    const error = await outcome;
    expect(error).toBeInstanceOf(QueryCancelledError);
    const sent = entry.transports.requests;
    // The fixture's exchanges, with the hanging status GET the cancel interrupted before the cancel itself.
    expectRequests([...sent.slice(0, -2), sent.at(-1) as RecordedRequest], scenario.exchanges);
    expect(sent.filter((request) => request.url.endsWith("/cancel"))).toHaveLength(1);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });
});

describe("the role check", () => {
  test("the configured role answered: the check goes first, once, and the statement follows", async () => {
    const { entry, scenario } = replayed("role-check-match");
    await entry.provider.connect();
    const result = await entry.provider.query("SELECT 1 AS N");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(result.rows).toEqual([{ N: 1 }]);
    expect(result.warnings).toBeUndefined();
  });

  test("another role answered: the statement is refused before it is sent", async () => {
    const { entry, scenario } = replayed("role-check-mismatch");
    await entry.provider.connect();
    const error = await caught(entry.provider.query("SELECT 1 AS N"));
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("STUDIO_RO", "STUDIO_RW"));
    expect(statementsSent(entry)).not.toContain("SELECT 1 AS N");
  });

  test("active secondary roles put their caution on the first result", async () => {
    const { entry, scenario } = replayed("role-check-secondary");
    await entry.provider.connect();
    const result = await entry.provider.query("SELECT 1 AS N");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(result.warnings).toEqual([
      { message: SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles("STUDIO_RO", "STUDIO_RW") },
    ]);
  });
});

describe("the monitoring panels", () => {
  test("on a running warehouse: a fresh state read, then the Information Schema statement", async () => {
    const { entry, scenario } = replayed("monitoring-started");
    await entry.provider.connect();
    const metrics = await entry.provider.getPerformanceMetrics();
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(metrics).toEqual({ queriesPerSecond: 0.1 });
  });

  test("on a suspended warehouse: the state read only, no Information Schema statement, and the panel's sentence", async () => {
    const { entry, scenario } = replayed("monitoring-suspended");
    await entry.provider.connect();
    const error = await caught(entry.provider.getPerformanceMetrics());
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(SNOWFLAKE_MONITORING_SENTENCES.suspended("STUDIO_PROBE_WH"));
    expect(statementsSent(entry).some((sql) => sql.includes("INFORMATION_SCHEMA"))).toBe(false);
  });
});

describe("the dashboard's other panels, the inventory and a view's source", () => {
  /** One statement's two answers in the documented shapes: the 333334 submit, then its rows on the status GET. */
  const statement = (entry: Built, columns: readonly string[], rows: readonly (readonly (string | null)[])[]) => {
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer(
      { method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ },
      resultAnswer({ columns: columns.map((name) => ({ name, type: "text" })), rows }),
    );
  };
  const WAREHOUSE = ["name", "state", "size", "running", "queued"];

  test("each panel sends its statement through the provider, and storage answers its sentence with none", async () => {
    const { entry } = replayed("connect-keypair");
    await entry.provider.connect();
    entry.transports.requests.splice(0);
    statement(entry, WAREHOUSE, [["STUDIO_PROBE_WH", "STARTED", "X-Small", "1", "0"]]);
    statement(entry, ["name"], [["STUDIO_DEMO"]]);
    const overview = await entry.provider.getOverview();
    expect(overview.version).toBe(
      "Snowflake: 1 databases visible to role STUDIO_RW; warehouse STUDIO_PROBE_WH STARTED, X-Small, 1 running, 0 queued",
    );
    statement(entry, WAREHOUSE, [["STUDIO_PROBE_WH", "STARTED", "X-Small", "1", "0"]]);
    statement(
      entry,
      ["QUERY_ID", "QUERY_TEXT", "TOTAL_ELAPSED_TIME", "ROWS_PRODUCED"],
      [["q1", "SELECT 1", "12", "1"]],
    );
    expect((await entry.provider.getSlowQueries({ limit: 5 })).map((row) => [row.queryId, row.totalTime])).toEqual([
      ["q1", 12],
    ]);
    statement(entry, WAREHOUSE, [["STUDIO_PROBE_WH", "STARTED", "X-Small", "1", "0"]]);
    statement(
      entry,
      ["QUERY_ID", "USER_NAME", "DATABASE_NAME", "EXECUTION_STATUS", "QUERY_TEXT", "START_TIME", "MS"],
      [["q2", "STUDIO_SVC", "STUDIO_DEMO", "RUNNING", "SELECT 2", "0", "1500"]],
    );
    expect((await entry.provider.getActiveSessions({ limit: 5 })).map((row) => [row.pid, row.state])).toEqual([
      ["q2", "running"],
    ]);
    statement(entry, ["name", "rows", "bytes"], [["EVERY_TYPE", "2", "4096"]]);
    expect((await entry.provider.getTableStats()).map((row) => [row.tableName, row.rowCount])).toEqual([
      ["EVERY_TYPE", 2],
    ]);
    statement(entry, ["name", "table", "kind", "columns", "is_unique"], []);
    const indexes = await caught(entry.provider.getIndexStats());
    expect(indexes.message).toBe(SNOWFLAKE_MONITORING_SENTENCES.noIndexes);
    const storage = await caught(entry.provider.getStorageStats());
    expect(storage.message).toBe(SNOWFLAKE_MONITORING_SENTENCES.storage);
    const sent = statementsSent(entry);
    expect(sent.filter((sql) => sql.startsWith("SHOW WAREHOUSES"))).toHaveLength(3);
    expect(sent.at(-1)).toBe('SHOW INDEXES IN SCHEMA "STUDIO_DEMO"."PROBE"');
    expect(entry.transports.requests.filter((request) => request.body !== undefined)).toHaveLength(sent.length);
  });

  test("the inventory reads one schema's tables and their columns, and a view's source comes from SHOW VIEWS", async () => {
    const { entry } = replayed("connect-keypair");
    await entry.provider.connect();
    entry.transports.requests.splice(0);
    statement(entry, ["name", "kind"], [["EVERY_TYPE", "TABLE"]]);
    statement(
      entry,
      ["table_name", "column_name", "data_type"],
      [["EVERY_TYPE", "ID", '{"type":"FIXED","precision":38,"scale":0,"nullable":false}']],
    );
    const batch = await entry.provider.describeObjects(["STUDIO_DEMO", "PROBE"], "table", 10);
    expect(batch.details.map((detail) => [detail.path.join("."), detail.columns.map((column) => column.type)])).toEqual(
      [["STUDIO_DEMO.PROBE.EVERY_TYPE", ["NUMBER(38,0)"]]],
    );
    statement(
      entry,
      ["name", "text", "is_secure"],
      [["EVERY_TYPE_V", "CREATE VIEW EVERY_TYPE_V AS SELECT 1", "false"]],
    );
    const source = await entry.provider.readObjectSource(["STUDIO_DEMO", "PROBE", "EVERY_TYPE_V"], "view");
    expect(source.parts[0]).toMatchObject({ text: "CREATE VIEW EVERY_TYPE_V AS SELECT 1" });
    expect(statementsSent(entry).every((sql) => sql.startsWith("SHOW "))).toBe(true);
  });
});

describe("a role-restricted PAT with another configured role", () => {
  test("answered on a SHOW: no role check, the configured role in the body, and the rows as Snowflake sent them", async () => {
    const { entry, scenario } = replayed("role-restricted-pat-show");
    await entry.provider.connect();
    expect(entry.provider.connectWarnings()).toEqual([
      { message: SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow("STUDIO_PROBE_WH", "STUDIO_NOWH") },
    ]);
    const result = await entry.provider.query('SHOW TABLES IN SCHEMA "STUDIO_DEMO"."PROBE"');
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(entry.transports.requests.map((request) => bodyOf(request).role)).toEqual([
      "STUDIO_NOWH",
      undefined,
      "STUDIO_NOWH",
      undefined,
    ]);
    expect(result.rows.map((row) => row.name)).toEqual(["EVERY_TYPE"]);
  });
});

// ============================================================================
// A role is the provider's own
// ============================================================================

describe("two providers, two roles", () => {
  test("each puts its own role, byte for byte, in every recorded body", async () => {
    const scenario = load("monitoring-suspended");
    const roles = ["STUDIO_RW", '"Studio ""Mixed"" Role"'];
    const entries = roles.map((role) => {
      const entry = build(connectionFor(scenario.connection, { role }));
      replay(entry, scenario);
      return entry;
    });
    for (const entry of entries) {
      // oxlint-disable-next-line no-await-in-loop -- each provider runs its own script.
      await entry.provider.connect();
      // oxlint-disable-next-line no-await-in-loop -- the panel's state read is the second statement.
      await caught(entry.provider.getPerformanceMetrics());
    }
    entries.forEach((entry, index) => {
      const bodies = entry.transports.requests.filter((request) => request.body !== undefined);
      expect(bodies).toHaveLength(2);
      for (const request of bodies) {
        expect(bodyOf(request).role).toBe(roles[index]);
        expect(request.body).toContain(`"role":${JSON.stringify(roles[index])}`);
      }
    });
  });
});

// ============================================================================
// No secret in any failure's text
// ============================================================================

interface Leak {
  readonly where: string;
  readonly text: string;
}

/** The error, the route's error body and the history entry the client would store, as texts. */
async function surfaces(error: Error, sql: string, provider: SnowflakeProvider): Promise<Leak[]> {
  const body = (await createErrorResponse(error).json()) as { error: string };
  const mask = historyMaskOf(provider.getCapabilities());
  const history = {
    query: maskStatementForHistory(sql, mask),
    errorMessage: maskStatementForHistory(body.error, mask),
  };
  return [
    { where: "the error", text: JSON.stringify({ ...error, message: error.message, stack: error.stack }) },
    { where: "the route body", text: JSON.stringify(body) },
    { where: "the history entry", text: JSON.stringify(history) },
    { where: "the log", text: printed() },
  ];
}

async function expectNoSentinel(error: Error, sql: string, provider: SnowflakeProvider, sentinels: string[]) {
  expect(sentinels.every((sentinel) => sentinel.length >= 8)).toBe(true);
  for (const { where, text } of await surfaces(error, sql, provider)) {
    for (const sentinel of sentinels)
      expect({ where, holds: text.includes(sentinel) }).toEqual({ where, holds: false });
  }
}

/** The role check answered with the entry's own configured role, from the fixture's role check. */
const ROLE_CHECK_OK = (entry: Built): void => {
  const [submit, status] = load("role-check-match").exchanges.slice(2, 4);
  const body = structuredClone(status.response.body) as { data: string[][] };
  body.data[0][0] = String(entry.connection.role);
  replay(entry, load("role-check-match"), [submit, { ...status, response: { ...status.response, body } }]);
};

/** A 422 failure answer whose message the test writes. BUILT. */
const failed422 = (message: string): ScriptedAnswer => ({
  status: 422,
  json: { code: "001003", sqlState: "42000", message, statementHandle: "00000000-0000-0000-0000-000000000123" },
});

describe("every failure path with sentinel credentials", () => {
  const SVC = load("connect-keypair").connection;
  const PAT_USER = load("connect-pat").connection;
  const PASSPHRASE = "sentinel-passphrase-41b7c2";
  const ENCRYPTED = pbes2Pbkdf2Pem(KEY, KEY_TEST_PASSPHRASE, 1_000);
  const pemBody = (pem: string): string => pem.split("\n")[1] as string;

  test("a key that is not a key: refused before any socket, the key's text in no surface", async () => {
    const body = "U0VOVElORUwta2V5LWJvZHktOWQ0ZTFhN2M=";
    const entry = build(
      connectionFor(SVC, { privateKey: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----` }),
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(entry.transports.requests).toHaveLength(0);
    await expectNoSentinel(error, "", entry.provider, [body]);
  });

  test("a wrong passphrase: its fixed sentence, the passphrase in no surface", async () => {
    const entry = build(connectionFor(SVC, { privateKey: ENCRYPTED, privateKeyPassphrase: PASSPHRASE }));
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(SNOWFLAKE_KEY_SENTENCES.wrongPassphrase);
    expect(entry.transports.requests).toHaveLength(0);
    await expectNoSentinel(error, "", entry.provider, [PASSPHRASE, pemBody(ENCRYPTED)]);
  });

  test("an encrypted key without a passphrase: its fixed sentence, the key in no surface", async () => {
    const entry = build(connectionFor(SVC, { privateKey: ENCRYPTED }));
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(SNOWFLAKE_KEY_SENTENCES.needsPassphrase);
    await expectNoSentinel(error, "", entry.provider, [pemBody(ENCRYPTED)]);
  });

  test("a 401 whose body echoes the PAT", async () => {
    const entry = build(connectionFor(PAT_USER));
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements$/ },
      { status: 401, json: { code: "390303", message: `Invalid OAuth access token. ${PAT}` } },
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.patRefused);
    await expectNoSentinel(error, "", entry.provider, [PAT]);
  });

  test("a 401 whose body echoes the JWT it was sent", async () => {
    const entry = build(connectionFor(SVC));
    const answer = deferredAnswer();
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, answer.answer);
    const outcome = caught(entry.provider.connect());
    await entry.transports.received(1);
    const jwt = bearerOf(entry.transports.requests[0]);
    answer.resolve({ status: 401, json: { code: "390144", message: `JWT token is invalid. ${jwt}` } });
    const error = await outcome;
    expect(error).toBeInstanceOf(AuthenticationError);
    await expectNoSentinel(error, "", entry.provider, [jwt]);
  });

  test("a 422 whose body echoes the PAT", async () => {
    const sql = "SELECT 1 FORM DUAL";
    const scenario = load("connect-pat");
    const entry = build(connectionFor(PAT_USER));
    replay(entry, scenario);
    ROLE_CHECK_OK(entry);
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, failed422(`near ${PAT}`));
    await entry.provider.connect();
    const error = await caught(entry.provider.query(sql));
    expect(error).toBeInstanceOf(QueryError);
    await expectNoSentinel(error, sql, entry.provider, [PAT]);
  });

  test("a 422 whose body echoes the JWT in use", async () => {
    const sql = "SELECT 1 FORM DUAL";
    const entry = build(connectionFor(SVC));
    replay(entry, load("connect-keypair"));
    ROLE_CHECK_OK(entry);
    const answer = deferredAnswer();
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, answer.answer);
    await entry.provider.connect();
    const outcome = caught(entry.provider.query(sql));
    await entry.transports.received(6);
    const jwt = bearerOf(entry.transports.requests[5]);
    answer.resolve(failed422(`near ${jwt}`));
    const error = await outcome;
    expect(error).toBeInstanceOf(QueryError);
    await expectNoSentinel(error, sql, entry.provider, [jwt]);
  });

  test("a transport failure", async () => {
    const entry = build(connectionFor(PAT_USER));
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements$/ },
      { fail: new TransportError("network", "socket hang up") },
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    await expectNoSentinel(error, "", entry.provider, [PAT]);
  });

  test("a 401 answered on the old lane after a renewal, echoing the previous token", async () => {
    const sql = "SELECT 1 AS N";
    const scenario = load("connect-keypair");
    const entry = build(connectionFor(SVC));
    replay(entry, scenario);
    await entry.provider.connect();
    const old = deferredAnswer();
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, old.answer);
    const outcome = caught(entry.provider.query(sql));
    await entry.transports.received(3);
    const previous = bearerOf(entry.transports.requests[2]);
    // Ten minutes and a second later the next request signs a new token, on a new lane.
    entry.clock.advance(601_000);
    const tree = load("tree-show");
    replay(entry, tree, tree.exchanges.slice(2, 4));
    await entry.provider.listContainers([]);
    const [renewed, polled] = entry.transports.requests.slice(3);
    expect(bearerOf(renewed)).not.toBe(previous);
    expect(renewed.lane).not.toBe(entry.transports.requests[2].lane);
    expect(polled.lane).toBe(renewed.lane);
    old.resolve({ status: 401, json: { code: "390144", message: `JWT token is invalid. ${previous}` } });
    const error = await outcome;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(entry.transports.closedLanes).toContain(entry.transports.requests[2].lane);
    await expectNoSentinel(error, sql, entry.provider, [previous, bearerOf(renewed)]);
  });

  test("a 10,000-character server message is cut in the error", async () => {
    const sql = "SELECT 1 FORM DUAL";
    const entry = build(connectionFor(PAT_USER));
    replay(entry, load("connect-pat"));
    ROLE_CHECK_OK(entry);
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, failed422("x".repeat(10_000)));
    await entry.provider.connect();
    const error = await caught(entry.provider.query(sql));
    expect(error.message).toContain("x".repeat(2_000));
    expect(error.message).not.toContain("x".repeat(2_001));
  });
});

// ============================================================================
// disconnect() ends what runs
// ============================================================================

describe("disconnect() with two runs in flight", () => {
  test("sends two cancels, one per handle", async () => {
    const scenario = load("connect-keypair");
    const entry = build(connectionFor(scenario.connection));
    replay(entry, scenario);
    ROLE_CHECK_OK(entry);
    const handles = ["00000000-0000-0000-0000-00000000a001", "00000000-0000-0000-0000-00000000a002"];
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, ...handles.map(handleAnswer));
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, { hang: true }, { hang: true });
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements\/[^/]+\/cancel$/ },
      ...handles.map((handle) => ({ status: 200, json: { code: "000604", statementHandle: handle } })),
    );
    await entry.provider.connect();
    const runs = [
      caught(entry.provider.query("SELECT 1", undefined, "a")),
      caught(entry.provider.query("SELECT 2", undefined, "b")),
    ];
    await entry.transports.received(8);
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    // No deadline is fired: each cancel is answered at once, and every run ends on the lifetime's abort.
    await entry.provider.disconnect();
    for (const error of await Promise.all(runs)) expect(error).toBeInstanceOf(QueryCancelledError);
    const cancelled = entry.transports.requests
      .filter((request) => request.url.endsWith("/cancel"))
      .map((request) => new URL(request.url).pathname);
    expect(cancelled.sort()).toEqual(handles.map((handle) => `/api/v2/statements/${handle}/cancel`));
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });
});
