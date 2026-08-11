import { expect, test, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRootEnv } from "./env";

const made: string[] = [];

function fixture(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "maestro-env-"));
  made.push(root);
  writeFileSync(join(root, ".env"), contents);
  const deep = join(root, "apps", "server", "src");
  mkdirSync(deep, { recursive: true });
  return deep;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ENVTEST_")) delete process.env[key];
  }
});

describe("loadRootEnv", () => {
  test("finds the .env above a nested working directory", () => {
    loadRootEnv(fixture("ENVTEST_A=from-file\n"));
    expect(process.env.ENVTEST_A).toBe("from-file");
  });

  /* A value set by systemd or the shell was set deliberately. A file that
     silently overrode it would make a production override impossible to spot. */
  test("does not override a variable that is already set", () => {
    process.env.ENVTEST_B = "from-shell";
    loadRootEnv(fixture("ENVTEST_B=from-file\n"));
    expect(process.env.ENVTEST_B).toBe("from-shell");
  });

  test("skips comments and blank lines, and strips quotes", () => {
    loadRootEnv(
      fixture(['# a comment', '', 'ENVTEST_C="quoted value"', "ENVTEST_D='single'", "ENVTEST_E=bare"].join("\n")),
    );
    expect(process.env.ENVTEST_C).toBe("quoted value");
    expect(process.env.ENVTEST_D).toBe("single");
    expect(process.env.ENVTEST_E).toBe("bare");
  });

  test("keeps '=' inside a value, which matters for base64 keys", () => {
    loadRootEnv(fixture("ENVTEST_F=abc==\n"));
    expect(process.env.ENVTEST_F).toBe("abc==");
  });

  test("is a no-op when there is no .env anywhere above", () => {
    const orphan = mkdtempSync(join(tmpdir(), "maestro-noenv-"));
    made.push(orphan);
    expect(() => loadRootEnv(orphan)).not.toThrow();
  });
});
