import { join } from "node:path";
import { NODE_VERSION } from "@maestro/protocol";
import { config } from "../config";

/* The daemon is bundled once and cached in memory. Bundling keeps the install
   to two fetches and means the node has no dependency to resolve on the target
   machine beyond Bun itself.
 *
   Built once, eagerly, rather than lazily on first request: two requests
   arriving together would otherwise each start a build, and a node deciding
   whether to update needs the answer to be the same every time it asks. */
let bundled: string | undefined;
let digest: string | undefined;
let building: Promise<void> | undefined;

async function build(): Promise<void> {
  const entry = join(import.meta.dir, "../../../node/src/index.ts");

  /* Bun.build throws on a resolution failure rather than reporting it, and a
     server that cannot bundle the daemon should still serve everything else —
     it just has no update to offer. Swallowing it here is what keeps a build
     problem from turning the fleet page into a 500. */
  let built;
  try {
    built = await Bun.build({ entrypoints: [entry], target: "bun", minify: false });
  } catch (err) {
    console.error("[install] could not bundle the node daemon:", err);
    return;
  }

  if (!built.success) {
    console.error("[install] failed to bundle the node daemon", built.logs);
    return;
  }

  bundled = await built.outputs[0].text();
  /* Integrity only — the version is what identifies a build. A node checks
     this to know its download arrived intact, not to decide whether to
     update. */
  digest = new Bun.CryptoHasher("sha256").update(bundled).digest("hex");
}

export function buildDaemonBundle(): Promise<void> {
  building ??= build();
  return building;
}

/* What the server would hand a node right now. Undefined when the build
   failed, which is a reason to offer no update at all rather than to advertise
   something that cannot be served. */
export async function daemonDigest(): Promise<string | undefined> {
  await buildDaemonBundle();
  return digest;
}

export async function daemonBundle(): Promise<Response> {
  await buildDaemonBundle();

  if (!bundled) {
    return new Response("// Could not build the node daemon. Check the server logs.\n", {
      status: 500,
      headers: { "content-type": "text/javascript" },
    });
  }

  return new Response(bundled, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      /* So a node can check what it got matches what it was promised. */
      "x-maestro-node-version": NODE_VERSION,
      ...(digest ? { "x-maestro-node-sha256": digest } : {}),
    },
  });
}

/* The install script.
 *
 * Deliberately readable: anyone piping a URL into a shell should be able to
 * download it first and understand every line. Nothing here is minified,
 * obfuscated, or fetched from a third party.
 *
 * The token is not validated at this point — it is validated when the daemon
 * presents it over the socket. Checking here would leak which tokens exist to
 * anyone who can guess a URL. */

export function installScript(token: string): Response {
  /* The token is interpolated into a shell script, so anything that could end
     the quoted string has to be impossible. Tokens are base64url with an nk_
     prefix; refusing everything else is simpler than escaping. */
  if (!/^nk_[A-Za-z0-9_-]{8,64}$/.test(token)) {
    return new Response("#!/bin/sh\necho 'Invalid enrollment token.' >&2\nexit 1\n", {
      status: 400,
      headers: { "content-type": "text/x-shellscript; charset=utf-8" },
    });
  }

  const origin = config.publicUrl.replace(/\/+$/, "");
  const wsUrl = `${origin.replace(/^http/, "ws")}/api/node/socket`;

  const script = `#!/bin/sh
# Maestro node installer.
#
# Enrolls this machine with ${origin} and installs the node as a service that
# starts at boot. The enrollment token below is single-use and expires in
# ${Math.round(config.enrollmentTtlMs / 60000)} minutes; the daemon exchanges it over the socket for a durable
# token that is never written to your shell history.
set -eu

TOKEN="${token}"
SERVER="${wsUrl}"
NAME="$(hostname)"
WORKSPACE_ROOT=""
INSTALL_SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --help)
      echo "Installs the Maestro node as a service and starts it."
      echo
      echo "Options:"
      echo "  --name <name>            Node name (default: this machine's hostname)"
      echo "  --workspace-root <path>  Where project checkouts live"
      echo "  --no-service             Run in the foreground instead of installing a service"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

IS_ROOT=0
[ "$(id -u)" = "0" ] && IS_ROOT=1

if [ -z "$WORKSPACE_ROOT" ]; then
  if [ "$IS_ROOT" = "1" ]; then WORKSPACE_ROOT=/srv/maestro; else WORKSPACE_ROOT="$HOME/maestro-workspaces"; fi
fi

echo "Maestro node installer"
echo "  server     $SERVER"
echo "  name       $NAME"
echo "  workspaces $WORKSPACE_ROOT"
echo

# --- Bun ---------------------------------------------------------------------
# Installed rather than demanded. Telling someone to go and run a different
# command, then come back and re-run this one with a token that may have expired
# in the meantime, is not an install script.
if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "Bun is not installed. Installing it from https://bun.sh ..."
  if ! command -v unzip >/dev/null 2>&1; then
    echo "  (bun's installer needs unzip, which is missing)" >&2
    echo "  Install it with your package manager, then run this command again." >&2
    exit 1
  fi
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || {
    echo "Bun could not be installed automatically." >&2
    echo "Install it by hand with:  curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  }
  BUN="$HOME/.bun/bin/bun"
  if [ ! -x "$BUN" ]; then
    echo "Bun installed but was not found at $BUN." >&2
    exit 1
  fi
  echo "  installed $("$BUN" --version)"
fi

# The service file needs an absolute path: systemd starts with a bare PATH and
# would not find a bun living under a home directory.
case "$BUN" in
  /*) ;;
  *) BUN="$(cd "$(dirname "$BUN")" && pwd)/$(basename "$BUN")" ;;
esac

mkdir -p "$WORKSPACE_ROOT"

echo "Downloading the node daemon..."
INSTALL_DIR="\${MAESTRO_INSTALL_DIR:-$HOME/.maestro}"
mkdir -p "$INSTALL_DIR"
curl -fsSL "${origin}/install/${token}/daemon.js" -o "$INSTALL_DIR/maestro-node.js"

# --- enrolment ---------------------------------------------------------------
# Done as its own foreground step so its exit code means something. It stores
# the durable token and returns; serving is the service's job.
# A server that is unreachable makes the daemon retry with backoff forever, so
# the step is bounded. An installer that hangs is worse than one that fails.
LIMIT=""
command -v timeout >/dev/null 2>&1 && LIMIT="timeout 90"

echo "Enrolling..."
MAESTRO_SERVER="$SERVER" \\
MAESTRO_NODE_NAME="$NAME" \\
MAESTRO_WORKSPACE_ROOT="$WORKSPACE_ROOT" \\
  $LIMIT "$BUN" "$INSTALL_DIR/maestro-node.js" --enroll "$TOKEN" --enroll-only || {
    STATUS=$?
    if [ "$STATUS" = "124" ]; then
      echo "Enrolment timed out. Is ${origin} reachable from this machine?" >&2
    else
      echo "Enrolment failed. The token may have expired or already been used." >&2
    fi
    exit 1
  }

# --- service -----------------------------------------------------------------
if [ "$INSTALL_SERVICE" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$IS_ROOT" = "1" ]; then
    UNIT=/etc/systemd/system/maestro-node.service
    SYSTEMCTL="systemctl"
    JOURNAL="journalctl"
    WANTED_BY=multi-user.target
  else
    UNIT="$HOME/.config/systemd/user/maestro-node.service"
    SYSTEMCTL="systemctl --user"
    JOURNAL="journalctl --user"
    WANTED_BY=default.target
    mkdir -p "$HOME/.config/systemd/user"
  fi

  echo "Installing the service at $UNIT ..."
  cat > "$UNIT" <<UNITEOF
[Unit]
Description=Maestro node
Documentation=${origin}
After=network-online.target
Wants=network-online.target
# The node dials out and can be restarted at any time, so a slow crash loop is
# better than a fast one against a server that is briefly down.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$BUN $INSTALL_DIR/maestro-node.js
WorkingDirectory=$WORKSPACE_ROOT
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=$WANTED_BY
UNITEOF

  $SYSTEMCTL daemon-reload
  $SYSTEMCTL enable maestro-node.service >/dev/null 2>&1 || true
  $SYSTEMCTL restart maestro-node.service

  # Without lingering, a user service stops the moment you log out — which is
  # exactly when you stop watching it.
  if [ "$IS_ROOT" != "1" ] && command -v loginctl >/dev/null 2>&1; then
    WHO="$(id -un 2>/dev/null || id -u)"
    loginctl enable-linger "$WHO" >/dev/null 2>&1 ||
      echo "  note: could not enable lingering, so the node will stop when you log out."
  fi

  sleep 2
  if $SYSTEMCTL is-active --quiet maestro-node.service; then
    echo
    echo "The node is enrolled and running as a service. It will start at boot."
    echo "  status  $SYSTEMCTL status maestro-node"
    echo "  logs    $JOURNAL -u maestro-node -f"
  else
    echo
    echo "The service was installed but is not running. Its logs:" >&2
    $JOURNAL -u maestro-node -n 20 --no-pager >&2 || true
    exit 1
  fi
else
  if [ "$INSTALL_SERVICE" = "1" ]; then
    echo "systemd was not found, so the node will run here in the foreground."
    echo "Keep this shell open, or supervise it with whatever this machine uses."
  fi
  echo
  MAESTRO_SERVER="$SERVER" \\
  MAESTRO_NODE_NAME="$NAME" \\
  MAESTRO_WORKSPACE_ROOT="$WORKSPACE_ROOT" \\
    exec "$BUN" "$INSTALL_DIR/maestro-node.js"
fi

echo "It should now appear under Connections → Nodes at ${origin}."
`;

  return new Response(script, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
