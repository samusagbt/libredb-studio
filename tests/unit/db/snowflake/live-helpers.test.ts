/**
 * The argument check and the mask of tests/helpers/snowflake-live.ts, which the hand-run Snowflake harness and live
 * check share: a missing or malformed variable is refused with exit code 2 before any socket, naming the variable and
 * never its value, and every line they print has each key, passphrase and PAT, the host and the account replaced.
 * The key files are read through an injected reader, so no key is written to disk here.
 */
import { describe, expect, test } from "bun:test";
import { pkcs8Pem, rsaKey } from "../../../helpers/snowflake-keys";
import {
  type LiveArguments,
  liveSecrets,
  mask,
  readLiveArguments,
  SNOWFLAKE_LIVE_MASK,
} from "../../../helpers/snowflake-live";

const PEM = pkcs8Pem(rsaKey());
const READER_PEM = pkcs8Pem(rsaKey());
const PAT = "sentinel-pat-a7c3e9b1d5f2a8c4e6b0";

const ENV: Readonly<Record<string, string>> = {
  SNOWFLAKE_ACCOUNT: "acmeorg-probeacct",
  SNOWFLAKE_SVC_USER: "studio_svc",
  SNOWFLAKE_SVC_KEY_FILE: "/keys/svc.p8",
  SNOWFLAKE_SVC_KEY_PASSPHRASE: "sentinel-passphrase-svc",
  SNOWFLAKE_READER_USER: "studio_reader",
  SNOWFLAKE_READER_KEY_FILE: "/keys/reader.p8",
  SNOWFLAKE_PAT_USER: "studio_pat",
  SNOWFLAKE_PAT: PAT,
  SNOWFLAKE_WAREHOUSE: "STUDIO_PROBE_WH",
};

const FILES: Readonly<Record<string, string>> = { "/keys/svc.p8": PEM, "/keys/reader.p8": READER_PEM };

/** The injected reader: the two key files, and a refusal for any other path, as a missing file throws. */
function readFile(path: string): string {
  const text = FILES[path];
  if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  return text;
}

const read = (env: Record<string, string | undefined>) => readLiveArguments(env, readFile);

describe("readLiveArguments", () => {
  test("reads every variable into the run's arguments, the host from the account and the keys from their files", () => {
    const args = read(ENV) as LiveArguments;
    expect(args).toEqual({
      account: "acmeorg-probeacct",
      host: "acmeorg-probeacct.snowflakecomputing.com",
      warehouse: "STUDIO_PROBE_WH",
      svc: { user: "studio_svc", keyPem: PEM, passphrase: "sentinel-passphrase-svc" },
      reader: { user: "studio_reader", keyPem: READER_PEM },
      pat: { user: "studio_pat", token: PAT },
    });
  });

  const required = [
    "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_SVC_USER",
    "SNOWFLAKE_SVC_KEY_FILE",
    "SNOWFLAKE_READER_USER",
    "SNOWFLAKE_READER_KEY_FILE",
    "SNOWFLAKE_PAT_USER",
    "SNOWFLAKE_PAT",
    "SNOWFLAKE_WAREHOUSE",
  ];
  test.each(required)("a missing %s exits 2, naming it", (name) => {
    for (const value of [undefined, "", "   "]) {
      const refusal = read({ ...ENV, [name]: value });
      expect(refusal).toEqual({ exitCode: 2, message: expect.stringContaining(name) });
    }
  });

  const malformed: readonly (readonly [string, string])[] = [
    ["SNOWFLAKE_ACCOUNT", "jdbc:snowflake://acmeorg-probeacct.snowflakecomputing.com"],
    ["SNOWFLAKE_ACCOUNT", "acme org"],
    ["SNOWFLAKE_ACCOUNT", "https://acmeorg-probeacct.snowflakecomputing.com:8443/"],
    ["SNOWFLAKE_SVC_USER", "studio svc"],
    ["SNOWFLAKE_READER_USER", "reader;drop"],
    ["SNOWFLAKE_SVC_KEY_FILE", "/keys/missing.p8"],
    ["SNOWFLAKE_READER_KEY_FILE", "/keys/svc.p8.pub"],
    ["SNOWFLAKE_PAT", "short"],
    ["SNOWFLAKE_PAT", `${PAT} trailing`],
    ["SNOWFLAKE_WAREHOUSE", "studio wh"],
  ];
  test.each(malformed)("a malformed %s exits 2, naming it and never its value (%s)", (name, value) => {
    const refusal = read({ ...ENV, [name]: value });
    expect(refusal).toEqual({ exitCode: 2, message: expect.stringContaining(name) });
    expect((refusal as { message: string }).message).not.toContain(value);
  });

  test("a key file that holds no private key exits 2 without repeating its text", () => {
    const refusal = readLiveArguments(ENV, (path) => (path === "/keys/svc.p8" ? "not a key at all" : READER_PEM));
    expect(refusal).toEqual({ exitCode: 2, message: expect.stringContaining("SNOWFLAKE_SVC_KEY_FILE") });
    expect((refusal as { message: string }).message).not.toContain("not a key");
  });

  test("a key's passphrase is read only when its variable is set", () => {
    const args = read({ ...ENV, SNOWFLAKE_SVC_KEY_PASSPHRASE: undefined }) as LiveArguments;
    expect(args.svc).toEqual({ user: "studio_svc", keyPem: PEM });
  });
});

describe("mask", () => {
  const args = read(ENV) as LiveArguments;
  const secrets = liveSecrets(args);

  test("hides the PAT, each passphrase, each key and each line of it, the host and the account, in any case", () => {
    const keyLine = PEM.split("\n")[3] as string;
    const line = [
      `getaddrinfo ENOTFOUND ${args.host.toUpperCase()}`,
      `account ACMEORG-PROBEACCT, token ${PAT}, passphrase sentinel-passphrase-svc`,
      `key ${PEM}`,
      `a line of it: ${keyLine}`,
      `encoded ${encodeURIComponent(PAT)} and ${Buffer.from(PAT).toString("base64")}`,
    ].join("\n");
    const masked = mask(line, secrets);
    for (const value of [PAT, "sentinel-passphrase-svc", keyLine, args.host, "acmeorg-probeacct"]) {
      expect(masked.toLowerCase()).not.toContain(value.toLowerCase());
    }
    expect(masked).not.toContain(Buffer.from(PAT).toString("base64"));
    expect(masked).toContain(`getaddrinfo ENOTFOUND ${SNOWFLAKE_LIVE_MASK}`);
    expect(masked).toContain(`token ${SNOWFLAKE_LIVE_MASK}`);
  });

  test("leaves a line that holds none of them as it is", () => {
    expect(mask("PASS connect by key pair (812 ms)", secrets)).toBe("PASS connect by key pair (812 ms)");
  });
});
