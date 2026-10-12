import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { findCodeWord } from "@/lib/sql/words";
import { classifySelectPrefix } from "./select-prefix";
import type { ExplainMode, ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * This strategy's dialect, resolved once. Reached only through `explainFormat: "snowflake-json"`, which only the
 * Snowflake provider declares, so the module's identity IS the dialect. It reads a `//` comment as Snowflake does.
 */
const SNOWFLAKE_GRAMMAR = resolveSqlGrammar("snowflake");

/**
 * The prefix, and the decision behind it.
 *
 * `EXPLAIN USING JSON` compiles a statement and returns its plan without running it; Snowflake has no executing
 * EXPLAIN, so the Explain button, which always asks for "analyze" and skips the confirmation gate, gets this form.
 * The background estimate the editor sends beside each SELECT is off: an EXPLAIN bills cloud services, and whether it
 * resumes a suspended warehouse is not yet measured, so "estimate" builds nothing and no plan is sent beside a run.
 */
const EXPLAIN_PREFIX = "EXPLAIN USING JSON ";

/** The operative keywords whose statement is a procedure call, dynamic SQL or a Scripting block, not a query. */
const SCRIPTING_KEYWORDS: ReadonlySet<string> = new Set(["CALL", "EXECUTE", "BEGIN", "DECLARE"]);

/** What the Explain button says for a statement `SCRIPTING_KEYWORDS` or an anonymous procedure declines. */
export const SNOWFLAKE_EXPLAIN_DECLINE =
  "Snowflake explains a query only; this statement calls a procedure, runs dynamic SQL or opens a Scripting block.";

/** How deep the operation tree may go before it stops, far past any plan a compiler writes. */
const MAX_PLAN_DEPTH = 64;

/**
 * Whether the statement is a call, dynamic SQL or a Scripting block.
 *
 * A `WITH` that declares an anonymous procedure (`WITH p AS PROCEDURE () ... CALL p()`) is one too: the operative
 * keyword reader cannot read past the procedure's body, so the code word `PROCEDURE` after the `WITH` names it.
 */
function isScripting(sql: string): boolean {
  const operative = readOperativeKeyword(sql, SNOWFLAKE_GRAMMAR);
  if (operative !== null && SCRIPTING_KEYWORDS.has(operative.keyword)) return true;
  return (
    classifySelectPrefix(sql, SNOWFLAKE_GRAMMAR) === "with" &&
    findCodeWord(sql, "PROCEDURE", 0, SNOWFLAKE_GRAMMAR) !== null
  );
}

/** Whether the statement is a query this strategy wraps: a SELECT, or a WITH whose operative keyword is SELECT. */
function isQuery(sql: string): boolean {
  const prefix = classifySelectPrefix(sql, SNOWFLAKE_GRAMMAR);
  if (prefix === "select") return true;
  return prefix === "with" && readOperativeKeyword(sql, SNOWFLAKE_GRAMMAR)?.keyword === "SELECT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** One operation of a step; `id` and `operation` are what make it one. */
interface SnowflakeOperation {
  id: number;
  operation: string;
  [key: string]: unknown;
}

function isOperation(value: unknown): value is SnowflakeOperation {
  return isRecord(value) && isFiniteNumber(value.id) && typeof value.operation === "string";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `3 of 12 partitions, 4,096 bytes`, from the fields present, or undefined when none is. */
function partitionText(record: Record<string, unknown>, noun: string, suffix: string): string | undefined {
  const parts: string[] = [];
  if (isFiniteNumber(record.partitionsAssigned) && isFiniteNumber(record.partitionsTotal)) {
    parts.push(
      `${record.partitionsAssigned.toLocaleString("en-US")} of ${record.partitionsTotal.toLocaleString("en-US")} ${noun}${suffix}`,
    );
  }
  if (isFiniteNumber(record.bytesAssigned))
    parts.push(`${record.bytesAssigned.toLocaleString("en-US")} bytes${suffix}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function operationNode(
  operation: SnowflakeOperation,
  byParent: ReadonlyMap<number, SnowflakeOperation[]>,
  drawn: Set<number>,
  depth: number,
): ExplainTreeNode {
  drawn.add(operation.id);
  const objects = strings(operation.objects);
  const details = [...strings(operation.expressions)];
  const partitions = partitionText(operation, "partitions", "");
  if (partitions !== undefined) details.push(partitions);
  const node: ExplainTreeNode = {
    label: objects.length > 0 ? `${operation.operation} ${objects.join(", ")}` : operation.operation,
    children: [],
  };
  if (details.length > 0) node.detail = details.join(" | ");
  if (depth < MAX_PLAN_DEPTH) {
    for (const child of byParent.get(operation.id) ?? []) {
      // A plan is a tree; an operation drawn already is never drawn again, so a cycle cannot loop.
      if (!drawn.has(child.id)) node.children.push(operationNode(child, byParent, drawn, depth + 1));
    }
  }
  return node;
}

/** The roots of one step: its operations with no parent, each with the operations that name it as a parent. */
function stepRoots(step: readonly SnowflakeOperation[]): ExplainTreeNode[] {
  const byParent = new Map<number, SnowflakeOperation[]>();
  for (const operation of step) {
    for (const parent of Array.isArray(operation.parentOperators) ? operation.parentOperators : []) {
      if (!isFiniteNumber(parent)) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), operation]);
    }
  }
  const drawn = new Set<number>();
  return step
    .filter(
      (operation) =>
        !Array.isArray(operation.parentOperators) ||
        !operation.parentOperators.some((parent) => isFiniteNumber(parent)),
    )
    .map((operation) => operationNode(operation, byParent, drawn, 0));
}

function readSteps(raw: unknown): SnowflakeOperation[][] | null {
  if (!isRecord(raw) || !Array.isArray(raw.Operations)) return null;
  const steps = raw.Operations.filter(Array.isArray).map((step: unknown[]) => step.filter(isOperation));
  return steps.some((step) => step.length > 0) ? steps.filter((step) => step.length > 0) : null;
}

export const snowflakeJsonStrategy: ExplainStrategy = {
  format: "snowflake-json",
  buildSql(sql: string, mode: ExplainMode) {
    if (mode === "estimate") return null;
    if (isScripting(sql) || !isQuery(sql)) return null;
    return `${EXPLAIN_PREFIX}${sql}`;
  },
  declineReason(sql: string) {
    return isScripting(sql) ? SNOWFLAKE_EXPLAIN_DECLINE : null;
  },
  // The plan arrives as one row whose first column is the JSON text; an unreadable plan is null.
  extractPlan(result) {
    const first = result.rows?.[0];
    const cell = first === undefined ? undefined : Object.values(first)[0];
    if (typeof cell !== "string") return null;
    try {
      return JSON.parse(cell) as unknown;
    } catch {
      return null;
    }
  },
  toRenderModel(raw) {
    const steps = readSteps(raw);
    if (steps === null || !isRecord(raw)) return null;
    const children =
      steps.length === 1
        ? stepRoots(steps[0])
        : steps.map((step, index) => ({ label: `Step ${index + 1}`, children: stepRoots(step) }));
    const root: ExplainTreeNode = { label: "Snowflake plan", children };
    const stats = isRecord(raw.GlobalStats) ? partitionText(raw.GlobalStats, "partitions", " assigned") : undefined;
    if (stats !== undefined) root.detail = stats;
    return { kind: "tree", root, raw };
  },
};
