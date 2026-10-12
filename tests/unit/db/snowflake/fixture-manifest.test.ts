/**
 * Every Snowflake fixture set is a capture: each `manifest.json` under tests/fixtures/snowflake/ names the cloud, the
 * region, `CURRENT_VERSION()`, the edition, the capture date and the Studio commit the harness ran from, and none is
 * provisional.
 *
 * The first set, `documented-2026-10-12/`, was written from the SQL API reference's documented response shapes before
 * any account existed, and its manifest says so with `"provisional": true`. So this test fails until a capture from
 * the trial account (tests/live/snowflake-evidence.ts) replaces every provisional fixture: by design, the provider is
 * not done while its integration test replays answers no Snowflake account gave.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures", "snowflake");
const REQUIRED = ["cloud", "region", "currentVersion", "edition", "captured", "commit"] as const;

function manifests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return manifests(path);
    return entry.name === "manifest.json" ? [path] : [];
  });
}

describe("the Snowflake fixture manifests", () => {
  const files = manifests(FIXTURES);

  test("there is at least one fixture set", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files.map((file) => [relative(FIXTURES, file), file]))(
    "%s is a capture, not provisional",
    (_name, file) => {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect({ provisional: manifest.provisional ?? false }).toEqual({ provisional: false });
      const missing = REQUIRED.filter((field) => typeof manifest[field] !== "string" || manifest[field] === "");
      expect(missing).toEqual([]);
    },
  );
});
