import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AuthenticationError } from "@/lib/db/errors";
import { SNOWFLAKE_ERROR_SENTENCES, SnowflakeError, toDatabaseError } from "@/lib/db/providers/sql/snowflake/errors";
import {
  SNOWFLAKE_QUERY_TAGS,
  SNOWFLAKE_ROLE_CHECK_SQL,
  SNOWFLAKE_STATEMENT_SENTENCES,
} from "@/lib/db/providers/sql/snowflake/statements";
import { logger } from "@/lib/logger";
import { failureAnswer, handleAnswer } from "../../../helpers/snowflake-answers";
import { deferredAnswer } from "../../../helpers/snowflake-node-transport";
import {
  bodyOf,
  CANCEL,
  CONTEXT,
  caught,
  closeOpened,
  one,
  roleAnswer,
  STATUS,
  SUBMIT,
  setup,
  submits,
  tick,
} from "../../../helpers/snowflake-statements";

let warn: ReturnType<typeof spyOn>;
beforeAll(() => {
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterAll(() => warn.mockRestore());
afterEach(closeOpened);

type Harness = ReturnType<typeof setup>;
const statementsSent = (harness: Harness): string[] => submits(harness).map((r) => bodyOf(r).statement as string);
const checksSent = (harness: Harness): number =>
  statementsSent(harness).filter((sql) => sql === SNOWFLAKE_ROLE_CHECK_SQL).length;
const CAUTION = (roles: string) => ({ message: SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles(roles, CONTEXT.role) });

describe("which statements check the role", () => {
  test("an Explain and a SHOW send no check; the next SELECT sends it first, with the role and warehouse", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, one(), one(), roleAnswer("STUDIO_RO"), one("9"));
    await harness.statements.runUser("EXPLAIN USING JSON SELECT 1", undefined);
    await harness.statements.runUser("SHOW TABLES", undefined);
    expect(checksSent(harness)).toBe(0);
    const result = await harness.statements.runUser("SELECT 1", "q-1");
    expect(result.rows).toEqual([{ N: 9 }]);
    expect(result.warnings).toEqual([]);
    expect(statementsSent(harness)).toEqual([
      "EXPLAIN USING JSON SELECT 1",
      "SHOW TABLES",
      SNOWFLAKE_ROLE_CHECK_SQL,
      "SELECT 1",
    ]);
    const [check, statement] = submits(harness).slice(2).map(bodyOf);
    expect(check).toMatchObject({
      timeout: 30,
      role: "STUDIO_RO",
      warehouse: "STUDIO_WH",
      database: "SALES",
      schema: "PUBLIC",
      parameters: { query_tag: SNOWFLAKE_QUERY_TAGS.roleCheck },
    });
    expect(statement).toMatchObject({ timeout: 60, role: "STUDIO_RO", warehouse: "STUDIO_WH" });
  });

  test("a success is latched: the next statement sends no check", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO"), one(), one());
    await harness.statements.runUser("SELECT 1", undefined);
    await harness.statements.runUser("SELECT 2", undefined);
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL, "SELECT 1", "SELECT 2"]);
  });

  for (const sql of ["DESCRIBE TABLE t", "USE SCHEMA s", "INSERT INTO t VALUES (1)", "CALL p()"]) {
    test(`${JSON.stringify(sql)} triggers the check`, async () => {
      const harness = setup();
      harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO"), one());
      await harness.statements.runUser(sql, undefined);
      expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL, sql]);
    });
  }

  test("a lone BEGIN sends nothing at all", async () => {
    const harness = setup();
    const error = await caught(harness.statements.runUser("BEGIN", undefined));
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_STATEMENT_SENTENCES.noTransactions);
    expect(harness.transports.requests).toHaveLength(0);
  });

  test("a surface read is never checked", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, one());
    await harness.statements.runSurface("SELECT 1", SNOWFLAKE_QUERY_TAGS.monitoring);
    expect(checksSent(harness)).toBe(0);
  });
});

describe("single flight", () => {
  test("two concurrent first SELECTs share one check", async () => {
    const harness = setup();
    const check = deferredAnswer();
    harness.transports.answer(SUBMIT, check.answer, one("1"), one("2"));
    const first = harness.statements.runUser("SELECT 1", undefined);
    const second = harness.statements.runUser("SELECT 2", undefined);
    await harness.transports.received(1);
    await tick();
    expect(harness.transports.requests).toHaveLength(1);
    check.resolve(roleAnswer("STUDIO_RO"));
    await Promise.all([first, second]);
    expect(checksSent(harness)).toBe(1);
    expect(statementsSent(harness).slice(1).sort()).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("a waiter whose check was ended by the other run's cancel checks again itself", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, handleAnswer(), roleAnswer("STUDIO_RO"), one("2"));
    harness.transports.answer(STATUS, { hang: true });
    harness.transports.answer(CANCEL, { status: 200, json: { code: "000604" } });
    const first = harness.statements.runUser("SELECT 1", "q-1").catch((error: unknown) => error);
    const second = harness.statements.runUser("SELECT 2", "q-2");
    await harness.transports.received(2);
    await tick();
    expect(await harness.statements.cancel("q-1")).toBe(true);
    expect(((await first) as SnowflakeError).category).toBe("cancelled");
    expect((await second).rows).toEqual([{ N: 2 }]);
    expect(checksSent(harness)).toBe(2);
    expect(statementsSent(harness)).not.toContain("SELECT 1");
  });

  test("a waiter cancelled while it waits is not sent", async () => {
    const harness = setup();
    const check = deferredAnswer();
    harness.transports.answer(SUBMIT, check.answer, one("1"));
    const first = harness.statements.runUser("SELECT 1", "q-1");
    const second = harness.statements.runUser("SELECT 2", "q-2").catch((error: unknown) => error);
    await harness.transports.received(1);
    await tick();
    const cancelling = harness.statements.cancel("q-2");
    await tick();
    check.resolve(roleAnswer("STUDIO_RO"));
    expect(await cancelling).toBe(true);
    expect(((await second) as SnowflakeError).category).toBe("cancelled");
    await first;
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL, "SELECT 1"]);
  });

  test("a waiter's cancel ends it at once, while the other run's check is still out", async () => {
    const harness = setup();
    const check = deferredAnswer();
    harness.transports.answer(SUBMIT, check.answer, one("1"));
    const first = harness.statements.runUser("SELECT 1", "q-1");
    const second = harness.statements.runUser("SELECT 2", "q-2").catch((error: unknown) => error);
    await harness.transports.received(1);
    await tick();
    const cancelling = harness.statements.cancel("q-2");
    let answered: boolean | undefined;
    void cancelling.then((value) => {
      answered = value;
    });
    await tick();
    expect(answered).toBe(true);
    expect(((await second) as SnowflakeError).category).toBe("cancelled");
    expect(harness.statements.runsInFlight()).toBe(1);
    check.resolve(roleAnswer("STUDIO_RO"));
    expect((await first).rows).toEqual([{ N: 1 }]);
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL, "SELECT 1"]);
  });
});

describe("the effective role", () => {
  test("another role refuses the statement before it is sent, and the next statement checks again", async () => {
    const harness = setup({ context: { ...CONTEXT, role: "studio_ro" } });
    harness.transports.answer(
      SUBMIT,
      roleAnswer("STUDIO_RW"),
      roleAnswer("STUDIO_RW"),
      roleAnswer("STUDIO_RO"),
      one("3"),
      one("4"),
    );
    const error = await caught(harness.statements.runUser("SELECT 1", undefined));
    expect(error).toBeInstanceOf(SnowflakeError);
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("STUDIO_RW", "studio_ro"));
    expect(toDatabaseError(error)).toBeInstanceOf(AuthenticationError);
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL]);

    expect(await caught(harness.statements.runUser("SELECT 1", undefined))).toBeInstanceOf(SnowflakeError);
    expect(checksSent(harness)).toBe(2);

    expect((await harness.statements.runUser("SELECT 3", undefined)).rows).toEqual([{ N: 3 }]);
    expect((await harness.statements.runUser("SELECT 4", undefined)).rows).toEqual([{ N: 4 }]);
    expect(checksSent(harness)).toBe(3);
    expect(statementsSent(harness).filter((sql) => sql !== SNOWFLAKE_ROLE_CHECK_SQL)).toEqual(["SELECT 3", "SELECT 4"]);
  });

  for (const [configured, answered] of [
    ['"Mixed Role"', "Mixed Role"],
    ["studio_ro", "STUDIO_RO"],
    ['"has ""quote"""', 'has "quote"'],
  ] as const) {
    test(`${configured} configured and ${answered} answered is no mismatch`, async () => {
      const harness = setup({ context: { ...CONTEXT, role: configured } });
      harness.transports.answer(SUBMIT, roleAnswer(answered), one());
      await harness.statements.runUser("SELECT 1", undefined);
      expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL, "SELECT 1"]);
      expect(bodyOf(submits(harness)[0]).role).toBe(configured);
    });
  }

  test("a mismatch sentence never echoes a secret the answer holds", async () => {
    const harness = setup({ secrets: ["pat-secret"] });
    harness.transports.answer(SUBMIT, roleAnswer("pat-secret"));
    const error = await caught(harness.statements.runUser("SELECT 1", undefined));
    expect((error as SnowflakeError).message).not.toContain("pat-secret");
  });

  test("an answer with no rows is a mismatch", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, {
      status: 200,
      json: {
        statementHandle: "019c06a4-0000-df4f-0000-00100006589e",
        resultSetMetaData: { rowType: [], partitionInfo: [{}] },
        data: [],
      },
    });
    const error = await caught(harness.statements.runUser("SELECT 1", undefined));
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("", CONTEXT.role));
  });

  test("a check failing with 000606 surfaces the no-warehouse sentence and is not latched", async () => {
    const harness = setup();
    harness.transports.answer(
      SUBMIT,
      failureAnswer(422, "000606", "No active warehouse selected in the current session."),
      roleAnswer("STUDIO_RO"),
      one(),
    );
    const error = await caught(harness.statements.runUser("SELECT 1", undefined));
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.noWarehouse);
    await harness.statements.runUser("SELECT 1", undefined);
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL, SNOWFLAKE_ROLE_CHECK_SQL, "SELECT 1"]);
  });
});

describe("secondary roles", () => {
  test("a non-empty value puts the caution on the first result only", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", '{"roles":"ANALYST,LOADER","value":""}'), one(), one());
    const first = await harness.statements.runUser("SELECT 1", undefined);
    const second = await harness.statements.runUser("SELECT 1", undefined);
    expect(first.warnings).toEqual([CAUTION("ANALYST,LOADER")]);
    expect(second.warnings).toEqual([]);
  });

  test("the caution comes before the statement's own notice", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", '{"roles":"ANALYST","value":""}'), one());
    const result = await harness.statements.runUser("USE SCHEMA s", undefined);
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles("ANALYST", CONTEXT.role),
      SNOWFLAKE_STATEMENT_SENTENCES.useNotCarried,
    ]);
  });

  for (const [label, value, expected] of [
    ["an empty roles string", '{"roles":"","value":""}', null],
    ["an object without roles", '{"value":"ALL"}', null],
    ["a null value", null, null],
    ["blank text", "   ", null],
    ["plain text", " ANALYST ", "ANALYST"],
    ["a JSON value that is not an object", '"ALL"', '"ALL"'],
  ] as const) {
    test(`${label} gives ${expected === null ? "no caution" : "the caution with the text"}`, async () => {
      const harness = setup();
      harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", value), one());
      const result = await harness.statements.runUser("SELECT 1", undefined);
      expect(result.warnings).toEqual(expected === null ? [] : [CAUTION(expected)]);
    });
  }
});
