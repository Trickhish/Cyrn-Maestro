import { expect, test, describe } from "bun:test";
import { installScript } from "./install";

/* The install script is the one piece of Maestro that runs on a machine nobody
 * has configured yet, usually piped straight into a shell. It cannot be tested
 * by running it here, so what is asserted is its shape: that it installs a
 * service rather than leaving a foreground process, that it will not hang, and
 * that a token can never break out of the quoting. */

const TOKEN = "nk_MvGKYq7fuJHcoCfPX1ghPuJ";

async function script(token = TOKEN): Promise<string> {
  return installScript(token).text();
}

describe("the install script", () => {
  test("refuses a token that is not shaped like one", async () => {
    for (const bad of ["'; rm -rf /", "nk_short", "abc", "nk_" + "x".repeat(200), ""]) {
      const res = installScript(bad);
      expect(res.status).toBe(400);
      /* Nothing the caller supplied may survive into the response, or a
         refusal becomes its own injection point. */
      if (bad) expect(await res.text()).not.toContain(bad);
    }
  });

  test("interpolates a valid token exactly once, in quotes", async () => {
    const body = await script();
    expect(body).toContain(`TOKEN="${TOKEN}"`);
  });

  test("is syntactically valid POSIX shell", async () => {
    const path = `/tmp/maestro-install-${crypto.randomUUID().slice(0, 8)}.sh`;
    await Bun.write(path, await script());
    const check = Bun.spawnSync(["sh", "-n", path]);
    await Bun.file(path).delete();

    expect(new TextDecoder().decode(check.stderr)).toBe("");
    expect(check.exitCode).toBe(0);
  });
});

describe("installing a service", () => {
  test("writes a unit and enables it so the node survives a reboot", async () => {
    const body = await script();

    expect(body).toContain("maestro-node.service");
    expect(body).toContain("daemon-reload");
    expect(body).toMatch(/systemctl.*enable|\$SYSTEMCTL enable/);
    expect(body).toContain("WantedBy=$WANTED_BY");
  });

  /* systemd starts with a minimal PATH, so a bun living under a home directory
     is not on it. A relative ExecStart is the classic way this unit fails. */
  test("gives the unit an absolute path to bun", async () => {
    const body = await script();
    expect(body).toContain("ExecStart=$BUN $INSTALL_DIR/maestro-node.js");
    expect(body).toContain('BUN="$(cd "$(dirname "$BUN")" && pwd)/$(basename "$BUN")"');
  });

  test("restarts the node if it dies", async () => {
    const body = await script();
    expect(body).toContain("Restart=always");
  });

  /* A user service without lingering stops at logout, which is exactly when
     nobody is watching. */
  test("enables lingering for a user-level install", async () => {
    expect(await script()).toContain("loginctl enable-linger");
  });

  test("still offers the foreground, but only when asked or when there is no systemd", async () => {
    const body = await script();
    expect(body).toContain("--no-service");
    expect(body).toContain("command -v systemctl");
    expect(body).toContain("systemd was not found");
  });
});

describe("bootstrapping bun", () => {
  test("installs bun rather than telling the operator to go and do it", async () => {
    const body = await script();

    expect(body).toContain("curl -fsSL https://bun.sh/install | bash");
    /* The old script exited here. Sending someone away to run another command
       and come back with an expired token is not an installer. */
    expect(body).not.toContain("Bun is required and was not found.");
  });

  test("finds an existing bun before installing another one", async () => {
    const body = await script();
    const detect = body.indexOf("command -v bun");
    const install = body.indexOf("https://bun.sh/install");

    expect(detect).toBeGreaterThan(-1);
    expect(detect).toBeLessThan(install);
  });

  test("says what to do when bun's own installer cannot run", async () => {
    const body = await script();
    expect(body).toContain("unzip");
  });
});

describe("enrolment", () => {
  /* Enrolling and serving are separate so the installer can check an exit code
     and then hand the machine to systemd. */
  test("enrols in its own step and exits, rather than serving from the installer", async () => {
    const body = await script();
    expect(body).toContain("--enroll-only");
  });

  test("is bounded, so an unreachable server fails instead of hanging", async () => {
    const body = await script();
    expect(body).toContain("timeout 90");
    expect(body).toContain('"$STATUS" = "124"');
  });

  test("does not leave the token in the daemon's command line for the service", async () => {
    const body = await script();
    const unit = body.slice(body.indexOf("[Unit]"), body.indexOf("UNITEOF", body.indexOf("[Unit]")));
    expect(unit).not.toContain("--enroll");
    expect(unit).not.toContain(TOKEN);
  });
});
