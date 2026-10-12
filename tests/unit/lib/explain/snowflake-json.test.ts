import { describe, expect, test } from "bun:test";
import { getExplainStrategy, resolveExplainPlan } from "@/lib/explain";
import { SNOWFLAKE_EXPLAIN_DECLINE, snowflakeJsonStrategy } from "@/lib/explain/snowflake-json";

const MODES = ["estimate", "analyze"] as const;

/**
 * A plan in the documented shape of `EXPLAIN USING JSON`: `GlobalStats` and `Operations`, an array of steps, each an
 * array of operations linked by `parentOperators`.
 * Provisional until the capture records a real plan.
 */
const PLAN = {
  GlobalStats: { partitionsTotal: 12, partitionsAssigned: 3, bytesAssigned: 4096 },
  Operations: [
    [
      { id: 0, operation: "Result", expressions: ["T.A", "T.B"] },
      { id: 1, parentOperators: [0], operation: "Filter", expressions: ["T.A > 1"] },
      {
        id: 2,
        parentOperators: [1],
        operation: "TableScan",
        objects: ["DB.PUBLIC.T"],
        expressions: ["A", "B"],
        partitionsAssigned: 3,
        partitionsTotal: 12,
        bytesAssigned: 4096,
      },
    ],
  ],
};

describe("the snowflake-json strategy", () => {
  test("is the registry's entry for its format", () => {
    expect(getExplainStrategy("snowflake-json")).toBe(snowflakeJsonStrategy);
    expect(snowflakeJsonStrategy.format).toBe("snowflake-json");
  });

  test("builds no background estimate (off until the warehouse measurement)", () => {
    expect(snowflakeJsonStrategy.buildSql("SELECT 1", "estimate")).toBeNull();
    expect(snowflakeJsonStrategy.declineReason?.("SELECT 1", "estimate")).toBeNull();
  });

  test("builds EXPLAIN USING JSON for the Explain button, never an executing form", () => {
    expect(snowflakeJsonStrategy.buildSql("SELECT 1", "analyze")).toBe("EXPLAIN USING JSON SELECT 1");
    expect(snowflakeJsonStrategy.buildSql("WITH a AS (SELECT 1) SELECT * FROM a", "analyze")).toBe(
      "EXPLAIN USING JSON WITH a AS (SELECT 1) SELECT * FROM a",
    );
    expect(snowflakeJsonStrategy.declineReason?.("SELECT 1", "analyze")).toBeNull();
  });

  test("reads a // comment as Snowflake does, so a //-led SELECT builds", () => {
    expect(snowflakeJsonStrategy.buildSql("// c\nSELECT 1", "analyze")).toBe("EXPLAIN USING JSON // c\nSELECT 1");
  });

  test.each([
    ["CALL p()"],
    ["EXECUTE IMMEDIATE 'x'"],
    ["BEGIN SELECT 1; END"],
    ["DECLARE x INT; BEGIN RETURN 1; END"],
    ["WITH p AS PROCEDURE () RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END $$ CALL p()"],
    ["-- x\ncall p()"],
  ])("declines %s in both modes with the decline sentence", (sql) => {
    for (const mode of MODES) {
      expect(snowflakeJsonStrategy.buildSql(sql, mode)).toBeNull();
      expect(snowflakeJsonStrategy.declineReason?.(sql, mode)).toBe(SNOWFLAKE_EXPLAIN_DECLINE);
    }
  });

  test("the decline sentence", () => {
    expect(SNOWFLAKE_EXPLAIN_DECLINE).toBe(
      "Snowflake explains a query only; this statement calls a procedure, runs dynamic SQL or opens a Scripting block.",
    );
  });

  test("a statement that is not a query declines without a sentence of its own", () => {
    for (const mode of MODES) {
      expect(snowflakeJsonStrategy.buildSql("INSERT INTO t VALUES (1)", mode)).toBeNull();
      expect(snowflakeJsonStrategy.declineReason?.("INSERT INTO t VALUES (1)", mode)).toBeNull();
    }
  });
});

describe("reading the plan", () => {
  test("extractPlan parses the first row's first column", () => {
    const rows = [{ content: JSON.stringify(PLAN) }];
    expect(snowflakeJsonStrategy.extractPlan({ rows })).toEqual(PLAN);
  });

  test("an unreadable plan is null", () => {
    expect(snowflakeJsonStrategy.extractPlan({ rows: [{ content: "not json" }] })).toBeNull();
    expect(snowflakeJsonStrategy.extractPlan({ rows: [{ content: 1 }] })).toBeNull();
    expect(snowflakeJsonStrategy.extractPlan({ rows: [] })).toBeNull();
    expect(snowflakeJsonStrategy.extractPlan({})).toBeNull();
  });

  test("renders the root with the three stats and the operations tree (provisional plan)", () => {
    const model = snowflakeJsonStrategy.toRenderModel(PLAN);
    expect(model).toEqual({
      kind: "tree",
      raw: PLAN,
      root: {
        label: "Snowflake plan",
        detail: "3 of 12 partitions assigned, 4,096 bytes assigned",
        children: [
          {
            label: "Result",
            detail: "T.A | T.B",
            children: [
              {
                label: "Filter",
                detail: "T.A > 1",
                children: [
                  {
                    label: "TableScan DB.PUBLIC.T",
                    detail: "A | B | 3 of 12 partitions, 4,096 bytes",
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  test("resolves through the registry from the stored value", () => {
    expect(resolveExplainPlan({ format: "snowflake-json", raw: PLAN })).toEqual(
      snowflakeJsonStrategy.toRenderModel(PLAN),
    );
  });

  test("several steps are each named under the root", () => {
    const plan = {
      GlobalStats: { partitionsTotal: 1, partitionsAssigned: 1, bytesAssigned: 10 },
      Operations: [[{ id: 0, operation: "Result" }], [{ id: 0, operation: "Insert" }]],
    };
    const model = snowflakeJsonStrategy.toRenderModel(plan);
    expect(model?.kind === "tree" ? model.root.children.map((child) => child.label) : null).toEqual([
      "Step 1",
      "Step 2",
    ]);
  });

  test("a cycle in parentOperators is drawn once and never loops", () => {
    const plan = {
      Operations: [
        [
          { id: 0, operation: "Result" },
          { id: 1, parentOperators: [0, 2], operation: "A" },
          { id: 2, parentOperators: [1], operation: "B" },
        ],
      ],
    };
    const model = snowflakeJsonStrategy.toRenderModel(plan);
    expect(model?.kind).toBe("tree");
    expect(JSON.stringify(model).match(/"label":"B"/g)?.length).toBe(1);
  });

  test("a foreign shape renders nothing", () => {
    expect(snowflakeJsonStrategy.toRenderModel(null)).toBeNull();
    expect(snowflakeJsonStrategy.toRenderModel({})).toBeNull();
    expect(snowflakeJsonStrategy.toRenderModel({ Operations: "x" })).toBeNull();
    expect(snowflakeJsonStrategy.toRenderModel({ Operations: [[{ id: 0 }]] })).toBeNull();
  });

  test("stats missing from GlobalStats are left out of the root", () => {
    const model = snowflakeJsonStrategy.toRenderModel({ Operations: [[{ id: 0, operation: "Result" }]] });
    expect(model?.kind === "tree" ? model.root.detail : "x").toBeUndefined();
  });
});
