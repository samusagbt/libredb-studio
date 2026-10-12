import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  failureError,
  keyPairName,
  SNOWFLAKE,
  SNOWFLAKE_ERROR_SENTENCES,
  SNOWFLAKE_SERVER_TEXT_MAX_CHARS,
  SnowflakeError,
  type SnowflakeErrorCategory,
  type SnowflakeFailure,
  type SnowflakeFailureContext,
  serverMessage,
  toDatabaseError,
  transportFailureError,
} from "@/lib/db/providers/sql/snowflake/errors";

const PAT = "pat-sentinel-0123456789";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJYIn0.c2lnbmF0dXJl";
const UUID = "019c06a4-0000-df4f-0000-00100006589e";
const WITHHELD = "(the server's text was withheld because it contained the configured credential)";

function context(overrides: Partial<SnowflakeFailureContext> = {}): SnowflakeFailureContext {
  return {
    host: "myorg-myaccount.snowflakecomputing.com",
    user: "studio_svc",
    role: "STUDIO_RO",
    authMethod: "keypair",
    accountClaim: "MYORG-MYACCOUNT",
    userClaim: "STUDIO_SVC",
    fingerprint: "SHA256:abc=",
    fingerprintHex8: "0a1b2c3d",
    publicKeyBody: "MIIBIjANBgkq",
    secretForms: secretForms([PAT, JWT]),
    operativeKeyword: "SELECT",
    attempts: 1,
    timeoutS: 60,
    deadlineBound: "query-timeout",
    submitAccepted: false,
    ...overrides,
  };
}
const failure = (overrides: Partial<SnowflakeFailure>): SnowflakeFailure => ({
  status: 422,
  code: null,
  sqlState: null,
  message: null,
  request: "submit",
  ...overrides,
});

const KEY_PAIR_WITH_UUID =
  "Snowflake refused the key pair (JWT token is invalid, [019c06a4-0000-df4f-0000-00100006589e]). Studio signed as MYORG-MYACCOUNT.STUDIO_SVC with the key whose fingerprint is SHA256:abc=. Signed in as this user (for example in Snowsight): SHOW USER KEY PAIRS lists your keys; register this one with ALTER USER ADD KEY PAIR libredb_studio_0a1b2c3d PUBLIC_KEY = 'MIIBIjANBgkq'. An administrator runs ALTER USER <name> ADD KEY PAIR libredb_studio_0a1b2c3d PUBLIC_KEY = 'MIIBIjANBgkq' (and SHOW USER KEY PAIRS FOR USER <name>), where <name> is the user's NAME, which DESC USER and SHOW USERS show and which can differ from the login name. If the key is listed, check that the account and user are the ones the key was registered on and that this computer's clock is correct; an administrator can see the exact cause with SELECT SYSTEM$GET_LOGIN_FAILURE_DETAILS('019c06a4-0000-df4f-0000-00100006589e').";
const KEY_PAIR_WITHOUT_UUID =
  "Snowflake refused the key pair (JWT token is invalid). Studio signed as MYORG-MYACCOUNT.STUDIO_SVC with the key whose fingerprint is SHA256:abc=. Signed in as this user (for example in Snowsight): SHOW USER KEY PAIRS lists your keys; register this one with ALTER USER ADD KEY PAIR libredb_studio_0a1b2c3d PUBLIC_KEY = 'MIIBIjANBgkq'. An administrator runs ALTER USER <name> ADD KEY PAIR libredb_studio_0a1b2c3d PUBLIC_KEY = 'MIIBIjANBgkq' (and SHOW USER KEY PAIRS FOR USER <name>), where <name> is the user's NAME, which DESC USER and SHOW USERS show and which can differ from the login name. If the key is listed, check that the account and user are the ones the key was registered on and that this computer's clock is correct.";
const FIX = "ALTER USER ADD KEY PAIR libredb_studio_0a1b2c3d PUBLIC_KEY = 'MIIBIjANBgkq'";

/** Splits a statement on `;` outside double-quoted identifiers and single-quoted strings. */
function statements(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ";") {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.filter((part) => part.trim() !== "");
}

describe("failureError: every row of the error table", () => {
  const SERVER = "SQL compilation error: Object 'T' does not exist or not authorized.";
  const cases: readonly {
    readonly name: string;
    readonly failure: SnowflakeFailure;
    readonly context?: Partial<SnowflakeFailureContext>;
    readonly category: SnowflakeErrorCategory;
    readonly house: new (...args: never[]) => DatabaseError;
    readonly sentence: string;
  }[] = [
    {
      name: "role refused, 390189",
      failure: failure({
        status: 401,
        code: "390189",
        message: "Role 'X' specified in the connect string does not exist",
      }),
      category: "auth",
      house: AuthenticationError,
      sentence: SNOWFLAKE_ERROR_SENTENCES.roleRefused("STUDIO_RO", "studio_svc", "STUDIO_RO", "studio_svc"),
    },
    {
      name: "role refused, 3013",
      failure: failure({ status: 422, code: "3013", message: "role not granted" }),
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake refused role STUDIO_RO for user studio_svc: the role does not exist, or it is not granted to this user. Check the Role field; an administrator grants it with GRANT ROLE STUDIO_RO TO USER studio_svc.",
    },
    {
      name: "key pair refused, 390144",
      failure: failure({ status: 401, code: "390144", message: `JWT token is invalid. [${UUID}]` }),
      category: "auth",
      house: AuthenticationError,
      sentence: KEY_PAIR_WITH_UUID,
    },
    {
      name: "token refused under a PAT",
      failure: failure({ status: 401, code: "390303", message: "Invalid OAuth access token." }),
      context: { authMethod: "pat", fingerprint: null, fingerprintHex8: null, publicKeyBody: null },
      category: "auth",
      house: AuthenticationError,
      sentence: SNOWFLAKE_ERROR_SENTENCES.patRefused,
    },
    {
      name: "token refused by PAT_INVALID",
      failure: failure({ status: 401, code: "PAT_INVALID", message: "x" }),
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake did not accept the access token: check that it is complete and has not expired or been revoked. A token also signs in only for a user under a network policy that allows the public address Studio connects from, which on a laptop changes with the network, or under an authentication policy that sets PAT_POLICY NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED. Key-pair sign-in avoids the network-policy requirement.",
    },
    {
      name: "API disabled or network policy, 403",
      failure: failure({ status: 403, message: "Forbidden" }),
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake refused the request (403): the SQL API may not be enabled for this account, or a network policy blocks the address Studio connects from.",
    },
    {
      name: "Snowflake's 408",
      failure: failure({
        status: 408,
        code: "000630",
        message: "Statement reached its statement or warehouse timeout",
      }),
      category: "query",
      house: QueryError,
      sentence:
        "Snowflake did not finish this statement within the connection's query timeout of 60 s, so Studio cancelled it. Raise Query Timeout (ms) on the connection to allow longer statements; saving it ends statements still running on this connection.",
    },
    {
      name: "Snowflake's 408 on a Studio read bounded by its own 30 s",
      failure: failure({ status: 408, code: "000630" }),
      context: { timeoutS: 30, deadlineBound: "surface" },
      category: "query",
      house: QueryError,
      sentence:
        "Snowflake did not finish this Studio read within 30 s, the bound Studio keeps for the statements it sends on its own whatever the connection's query timeout, so Studio cancelled it.",
    },
    {
      name: "rate limit, 429",
      failure: failure({ status: 429, code: "390505" }),
      category: "unavailable",
      house: ConnectionError,
      sentence: "Snowflake is limiting requests from this account (429). Try again in a moment.",
    },
    ...[500, 502, 503, 504].map((status) => ({
      name: `server unavailable, ${status}`,
      failure: failure({ status }),
      context: { attempts: 5 },
      category: "unavailable" as const,
      house: ConnectionError,
      sentence: `Snowflake did not answer this request (HTTP ${status}) after 5 attempts.`,
    })),
    {
      name: "certificate refused by Snowflake, 522",
      failure: failure({ status: 522, message: "Invalid SSL Certificate" }),
      category: "unavailable",
      house: ConnectionError,
      sentence:
        "Snowflake refused the TLS certificate of this request (522). Studio sends no client certificate, so a proxy or gateway between Studio and Snowflake may be presenting one.",
    },
    {
      name: "result gone, 404",
      failure: failure({ status: 404, request: "status" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake no longer holds this statement's result; run it again.",
    },
    {
      name: "invalid payload, 390142",
      failure: failure({ status: 400, code: "390142", message: "Incoming request does not contain a valid payload." }),
      category: "defect",
      house: DatabaseError,
      sentence: "Snowflake could not read the request Studio sent (390142). This is a Studio defect; please report it.",
    },
    {
      name: "no warehouse, 000606",
      failure: failure({ status: 422, code: "000606", sqlState: "57P03", message: "No active warehouse selected" }),
      category: "query",
      house: QueryError,
      sentence:
        "No warehouse is selected for this connection. Enter one in the connection settings, or ask an administrator to set DEFAULT_WAREHOUSE on the user. Browsing works without one; queries do not.",
    },
    {
      name: "object missing or hidden, 002003",
      failure: failure({ status: 422, code: "002003", sqlState: "42S02", message: SERVER }),
      category: "query",
      house: QueryError,
      sentence: `Snowflake says this object does not exist or role STUDIO_RO may not see it. Check the name, the database and schema, and the role; CALL EXPLAIN_PRIVILEGES(statement => '<statement>', missing_only => true) lists what is missing, and an administrator adds for_role => 'STUDIO_RO'. ${SERVER}`,
    },
    {
      name: "insufficient privileges, 003001",
      failure: failure({ status: 422, code: "003001", sqlState: "42501", message: "Insufficient privileges" }),
      category: "query",
      house: QueryError,
      sentence: "Role STUDIO_RO lacks a privilege this statement needs. Insufficient privileges",
    },
    {
      name: "statement failed, 422 with code and SQLSTATE",
      failure: failure({ status: 422, code: "001003", sqlState: "42000", message: "syntax error line 1" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: syntax error line 1 (code 001003, SQLSTATE 42000)",
    },
    {
      name: "statement failed without a SQLSTATE",
      failure: failure({ status: 422, code: "100038", message: "Numeric value 'x' is not recognized" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: Numeric value 'x' is not recognized (code 100038)",
    },
    {
      name: "anything else, without a code",
      failure: failure({ status: 400, message: "Bad request" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: Bad request",
    },
    {
      name: "anything else, another status with a code",
      failure: failure({ status: 409, code: "123456", message: "Conflict" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: Conflict (code 123456)",
    },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const error = failureError(row.failure, context(row.context));
      expect(error).toBeInstanceOf(SnowflakeError);
      expect(error.category).toBe(row.category);
      expect(error.message).toBe(row.sentence);
      const house = toDatabaseError(error, "SELECT 1");
      expect((house as object).constructor).toBe(row.house);
      expect((house as DatabaseError).provider).toBe(SNOWFLAKE);
      expect((house as DatabaseError).message).toBe(row.sentence);
    });
  }

  test("the role mismatch sentence", () => {
    expect(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("PUBLIC", "STUDIO_RO")).toBe(
      "Snowflake ran this connection as role PUBLIC, not STUDIO_RO. Check the Role field; a role-restricted key or token signs in only as its own role.",
    );
  });

  test("the fixed sentences other modules raise", () => {
    expect(SNOWFLAKE_ERROR_SENTENCES.slotsBusy(30)).toBe(
      "Studio's Snowflake statement slots stayed busy for 30 seconds, so nothing was sent. Try again when a running statement finishes.",
    );
    expect(SNOWFLAKE_ERROR_SENTENCES.cancelled).toBe("The query was cancelled.");
  });
});

describe("failureError: the key-pair refusal", () => {
  test("the sentence without a uuid drops the parenthesis' id and the last clause", () => {
    const error = failureError(failure({ status: 401, code: "390144", message: "JWT token is invalid." }), context());
    expect(error.message).toBe(KEY_PAIR_WITHOUT_UUID);
    expect(error.fixStatement).toBe(FIX);
  });

  test("the fix statement is the self-service registration, carried onto the AuthenticationError", () => {
    const error = failureError(
      failure({ status: 401, code: "390144", message: `JWT token is invalid. [${UUID}]` }),
      context(),
    );
    expect(error.fixStatement).toBe(FIX);
    const house = toDatabaseError(error);
    expect(house).toBeInstanceOf(AuthenticationError);
    expect((house as AuthenticationError).fixStatement).toBe(FIX);
  });

  test("an upper-case uuid is accepted, and the last bracketed group is the one read", () => {
    const upper = UUID.toUpperCase();
    const error = failureError(
      failure({ status: 401, code: "390144", message: `JWT [not-this] token is invalid. [${upper}]` }),
      context(),
    );
    expect(error.message).toContain(`SYSTEM$GET_LOGIN_FAILURE_DETAILS('${upper}')`);
    expect(error.message).toContain(`(JWT token is invalid, [${upper}])`);
  });

  test("a hostile bracketed id leaves the login-failure clause out", () => {
    const error = failureError(
      failure({ status: 401, code: "390144", message: "JWT token is invalid. [x'); DROP USER y; --]" }),
      context(),
    );
    expect(error.message).not.toContain("SYSTEM$GET_LOGIN_FAILURE_DETAILS");
    expect(error.message).not.toContain("DROP USER");
    expect(error.message).toBe(KEY_PAIR_WITHOUT_UUID);
  });

  test("a key-pair context without its key is a defect, never a sentence with holes", () => {
    const error = failureError(
      failure({ status: 401, code: "390144", message: `JWT token is invalid. [${UUID}]` }),
      context({ fingerprintHex8: null }),
    );
    expect(error.category).toBe("defect");
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.keyMissing);
    expect(error.fixStatement).toBeUndefined();
  });

  test("a 401 after the submit was accepted, on a status, partition or cancel request, is the mid-run sentence", () => {
    for (const request of ["status", "partition", "cancel"] as const) {
      const error = failureError(failure({ status: 401, code: "390144", request }), context({ submitAccepted: true }));
      expect(error.category).toBe("auth");
      expect(error.message).toBe(
        "Snowflake stopped accepting Studio's key-pair token while this statement ran (390144). The statement may still be running; Studio could not read or cancel it.",
      );
      expect(error.fixStatement).toBeUndefined();
      const pat = failureError(
        failure({ status: 401, request }),
        context({
          submitAccepted: true,
          authMethod: "pat",
          fingerprint: null,
          fingerprintHex8: null,
          publicKeyBody: null,
        }),
      );
      expect(pat.message).toBe(SNOWFLAKE_ERROR_SENTENCES.patRefused);
    }
  });

  test("the mid-run sentence names HTTP 401 without a code, and the submit itself is never mid-run", () => {
    expect(
      failureError(failure({ status: 401, request: "partition" }), context({ submitAccepted: true })).message,
    ).toBe(SNOWFLAKE_ERROR_SENTENCES.keyPairMidRun("HTTP 401"));
    expect(
      failureError(
        failure({ status: 401, request: "submit", message: "JWT token is invalid." }),
        context({ submitAccepted: true }),
      ).message,
    ).toBe(KEY_PAIR_WITHOUT_UUID);
    expect(failureError(failure({ status: 401, request: "status" }), context()).message).toBe(KEY_PAIR_WITHOUT_UUID);
  });
});

describe("failureError: secrets and the server-text cut", () => {
  const sentinels = [PAT, ...JWT.split(".")];
  const hostile = [
    `bad token ${PAT}`,
    `JWT token is invalid: ${JWT} [${UUID}]`,
    `segment only ${JWT.split(".")[1]}`,
    `base64 ${Buffer.from(PAT).toString("base64")}`,
  ];

  test("a 401 and a 422 whose messages echo the PAT or the JWT leave no sentinel in the error", () => {
    for (const message of hostile) {
      for (const status of [401, 422]) {
        for (const authMethod of ["keypair", "pat"] as const) {
          const error = failureError(failure({ status, code: "390144", message }), context({ authMethod }));
          const house = toDatabaseError(error);
          for (const text of [
            error.message,
            String(error),
            String(house),
            JSON.stringify(house),
            error.fixStatement ?? "",
          ]) {
            for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
            expect(text).not.toContain("pat-sentinel");
          }
        }
      }
    }
  });

  test("a code or SQLSTATE that echoes a secret, or is not code-shaped, is left out of the sentence", () => {
    expect(failureError(failure({ status: 422, code: PAT, sqlState: "42000", message: "m" }), context()).message).toBe(
      "Snowflake: m",
    );
    expect(
      failureError(failure({ status: 422, code: "1", sqlState: "a b; DROP", message: "m" }), context()).message,
    ).toBe("Snowflake: m (code 1)");
    expect(
      failureError(
        failure({ status: 401, code: JWT.split(".")[2], request: "cancel" }),
        context({ submitAccepted: true }),
      ).message,
    ).toBe(SNOWFLAKE_ERROR_SENTENCES.keyPairMidRun("HTTP 401"));
  });

  test("a 10,000-character server message is cut to the bound in the sentence", () => {
    const long = "x".repeat(10_000);
    const error = failureError(failure({ status: 422, code: "100038", message: long }), context());
    const part = error.message.slice("Snowflake: ".length, error.message.indexOf(" (code"));
    expect(part.length).toBeLessThanOrEqual(SNOWFLAKE_SERVER_TEXT_MAX_CHARS);
    expect(part).toBe("x".repeat(SNOWFLAKE_SERVER_TEXT_MAX_CHARS));
  });

  test("serverMessage withholds a secret past the cut instead of showing the prefix", () => {
    const forms = secretForms([PAT]);
    const text = `${"y".repeat(3_000)} ${PAT}`;
    expect(serverMessage(text, forms)).toBe(WITHHELD);
    expect(serverMessage("short", forms)).toBe("short");
    expect(serverMessage("z".repeat(2_500), forms)).toHaveLength(SNOWFLAKE_SERVER_TEXT_MAX_CHARS);
  });

  test("the cut never ends on half of a surrogate pair", () => {
    const text = `${"a".repeat(SNOWFLAKE_SERVER_TEXT_MAX_CHARS - 1)}\u{1F600}tail`;
    const cut = serverMessage(text, []);
    expect(cut).toBe("a".repeat(SNOWFLAKE_SERVER_TEXT_MAX_CHARS - 1));
  });
});

describe("failureError: the Scripting hint", () => {
  const syntax = (operativeKeyword: string | null, code: string) =>
    failureError(
      failure({
        status: 422,
        code,
        sqlState: "42000",
        message: "syntax error line 1 at position 0 unexpected 'BEGIN'.",
      }),
      context({ operativeKeyword }),
    ).message;

  test("a BEGIN or DECLARE unit that fails with the syntax error code gets the hint appended", () => {
    const base = "Snowflake: syntax error line 1 at position 0 unexpected 'BEGIN'. (code 001003, SQLSTATE 42000)";
    expect(syntax("BEGIN", "001003")).toBe(`${base} ${SNOWFLAKE_ERROR_SENTENCES.scriptingHint}`);
    expect(syntax("DECLARE", "001003")).toBe(`${base} ${SNOWFLAKE_ERROR_SENTENCES.scriptingHint}`);
    expect(SNOWFLAKE_ERROR_SENTENCES.scriptingHint).toBe(
      "A Snowflake Scripting block runs through the SQL API only inside EXECUTE IMMEDIATE $$ ... $$.",
    );
  });

  test("another keyword, another code or no keyword gets no hint", () => {
    expect(syntax("SELECT", "001003")).not.toContain("Scripting");
    expect(syntax("BEGIN", "002003")).not.toContain("Scripting");
    expect(syntax("BEGIN", "100038")).not.toContain("Scripting");
    expect(syntax(null, "001003")).not.toContain("Scripting");
  });
});

describe("copyable identifiers", () => {
  test("a copyable identifier: bare as is, quoted as typed when well formed, anything else re-quoted", () => {
    /** The role as the role-refused GRANT names it, the one statement that prints an identifier the user typed. */
    const named = (role: string): string => {
      const error = failureError(failure({ status: 401, code: "390189" }), context({ role, user: "studio_svc" }));
      const lead = "an administrator grants it with GRANT ROLE ";
      const statement = error.message.slice(error.message.lastIndexOf(lead) + lead.length, -1);
      return statement.slice(0, statement.lastIndexOf(" TO USER "));
    };
    expect(named("studio_svc")).toBe("studio_svc");
    expect(named("A$1")).toBe("A$1");
    expect(named('a"; GRANT ROLE ACCOUNTADMIN TO USER b; --')).toBe('"a""; GRANT ROLE ACCOUNTADMIN TO USER b; --"');
    expect(named('r" x')).toBe('"r"" x"');
    expect(named('"Mixed Role"')).toBe('"Mixed Role"');
    expect(named('"a""b"')).toBe('"a""b"');
    expect(named('"broken')).toBe('"""broken"');
    expect(named("1st")).toBe('"1st"');
    expect(named("user@example.com")).toBe('"user@example.com"');
  });

  test("the role-refused GRANT is one statement naming exactly the hostile user and role", () => {
    const user = 'a"; GRANT ROLE ACCOUNTADMIN TO USER b; --';
    const role = 'r" x';
    const error = failureError(failure({ status: 401, code: "390189" }), context({ user, role }));
    const lead = "an administrator grants it with ";
    const statement = error.message.slice(error.message.lastIndexOf(lead) + lead.length, -1);
    expect(statements(statement)).toHaveLength(1);
    expect(statement).toBe(`GRANT ROLE "r"" x" TO USER "a""; GRANT ROLE ACCOUNTADMIN TO USER b; --"`);
  });

  test("the object-missing for_role literal doubles a single quote, so the CALL stays one statement", () => {
    const error = failureError(failure({ status: 422, code: "002003", message: "gone" }), context({ role: "o'brien" }));
    expect(error.message).toContain("for_role => 'o''brien'.");
    const call = error.message.slice(error.message.indexOf("CALL "), error.message.indexOf("'. ") + 2);
    expect(statements(call)).toHaveLength(1);
  });

  test("the key name form", () => {
    expect(keyPairName("0a1b2c3d")).toBe("libredb_studio_0a1b2c3d");
  });
});

describe("transportFailureError", () => {
  const host = "myorg-myaccount.snowflakecomputing.com";

  test("an unreachable host, a DNS failure and a refused connection name the host", () => {
    for (const error of [
      new TransportError("unreachable", "No answer from x:443 after 10 s"),
      new TransportError("network", "The request failed before a complete response arrived (ENOTFOUND)"),
      new TransportError("network", "The request failed before a complete response arrived (EAI_AGAIN)"),
      new TransportError("network", "The request failed before a complete response arrived (ECONNREFUSED)"),
      new TransportError("network", "The request failed before a complete response arrived (ConnectionRefused)"),
    ]) {
      const mapped = transportFailureError(error, host);
      expect(mapped).toBeInstanceOf(SnowflakeError);
      expect((mapped as SnowflakeError).category).toBe("unavailable");
      expect((mapped as SnowflakeError).message).toBe(
        "Studio could not reach myorg-myaccount.snowflakecomputing.com. Check the account identifier; a locator outside AWS Oregon needs its region.",
      );
    }
  });

  test("a TLS failure is the certificate mismatch sentence", () => {
    const mapped = transportFailureError(
      new TransportError("tls", "The TLS connection failed (ERR_TLS_CERT_ALTNAME_INVALID)"),
      host,
    );
    expect((mapped as SnowflakeError).category).toBe("unavailable");
    expect((mapped as SnowflakeError).message).toBe(
      "The certificate myorg-myaccount.snowflakecomputing.com presented does not match its name. Check the account identifier, including the region for a locator.",
    );
  });

  test("anything else is returned unchanged", () => {
    for (const error of [
      new TransportError("aborted", "The request was cancelled"),
      new TransportError("network", "The server ended the response before it was complete", { truncated: true }),
      new TransportError("network", "The request failed before a complete response arrived (ECONNRESET)"),
      new TransportError("timeout", "The request did not finish within its time limit"),
      new QueryError("x"),
      new Error("y"),
      "z",
    ]) {
      expect(transportFailureError(error, host)).toBe(error);
    }
  });
});

describe("toDatabaseError", () => {
  test("each category becomes its house class with Snowflake as provider", () => {
    const expected: Record<SnowflakeErrorCategory, new (...args: never[]) => DatabaseError> = {
      config: DatabaseConfigError,
      auth: AuthenticationError,
      query: QueryError,
      cancelled: QueryCancelledError,
      unavailable: ConnectionError,
      defect: DatabaseError,
    };
    for (const [category, house] of Object.entries(expected) as [SnowflakeErrorCategory, typeof DatabaseError][]) {
      const mapped = toDatabaseError(new SnowflakeError(category, `m ${category}`), "SELECT 1") as DatabaseError;
      expect(mapped.constructor).toBe(house);
      expect(mapped.message).toBe(`m ${category}`);
      expect(mapped.provider).toBe(SNOWFLAKE);
    }
  });

  test("a query and a cancel keep the statement; an auth error without a fix statement has none", () => {
    expect((toDatabaseError(new SnowflakeError("query", "q"), "SELECT 2") as QueryError).query).toBe("SELECT 2");
    expect((toDatabaseError(new SnowflakeError("cancelled", "c"), "SELECT 3") as QueryCancelledError).query).toBe(
      "SELECT 3",
    );
    expect(Object.hasOwn(toDatabaseError(new SnowflakeError("auth", "a")) as object, "fixStatement")).toBe(false);
  });

  test("a non-Snowflake error is returned unchanged", () => {
    const e = new Error("x");
    expect(toDatabaseError(e)).toBe(e);
    const house = new QueryError("already mapped");
    expect(toDatabaseError(house)).toBe(house);
  });

  test("SnowflakeError keeps its category and fix statement, and names itself", () => {
    const error = new SnowflakeError("auth", "m", "fix");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SnowflakeError");
    expect(error.category).toBe("auth");
    expect(error.fixStatement).toBe("fix");
    expect(Object.hasOwn(new SnowflakeError("auth", "m"), "fixStatement")).toBe(false);
  });
});
