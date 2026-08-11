import { join } from "node:path";
import { config } from "../config";

/* The daemon is bundled on first request and cached in memory. Bundling keeps
   the install to two fetches and means the node has no dependency to resolve
   on the target machine beyond Bun itself. */
let bundled: string | undefined;

export async function daemonBundle(): Promise<Response> {
  if (!bundled) {
    const entry = join(import.meta.dir, "../../../node/src/index.ts");
    const built = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      minify: false,
    });

    if (!built.success) {
      console.error("[install] failed to bundle the node daemon", built.logs);
      return new Response("// Could not build the node daemon. Check the server logs.\n", {
        status: 500,
        headers: { "content-type": "text/javascript" },
      });
    }

    bundled = await built.outputs[0].text();
  }

  return new Response(bundled, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
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
# Enrolls this machine with ${origin} and starts the node daemon.
# The enrollment token below is single-use and expires in ${Math.round(
    config.enrollmentTtlMs / 60000,
  )} minutes;
# the daemon exchanges it over the socket for a durable token that is never
# written to your shell history.
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
      echo "Options: --name <name> --workspace-root <path> --no-service"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$WORKSPACE_ROOT" ]; then
  if [ "$(id -u)" = "0" ]; then WORKSPACE_ROOT=/srv/maestro; else WORKSPACE_ROOT="$HOME/maestro-workspaces"; fi
fi

echo "Maestro node installer"
echo "  server     $SERVER"
echo "  name       $NAME"
echo "  workspaces $WORKSPACE_ROOT"
echo

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required and was not found." >&2
  echo "Install it with:  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

mkdir -p "$WORKSPACE_ROOT"

echo "Downloading the node daemon..."
INSTALL_DIR="\${MAESTRO_INSTALL_DIR:-$HOME/.maestro}"
mkdir -p "$INSTALL_DIR"
curl -fsSL "${origin}/install/${token}/daemon.js" -o "$INSTALL_DIR/maestro-node.js"

echo "Enrolling..."
MAESTRO_SERVER="$SERVER" \\
MAESTRO_NODE_NAME="$NAME" \\
MAESTRO_WORKSPACE_ROOT="$WORKSPACE_ROOT" \\
  bun "$INSTALL_DIR/maestro-node.js" --enroll "$TOKEN" &

DAEMON_PID=$!
sleep 4

if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo
  echo "Node is running (pid $DAEMON_PID)."
  if [ "$INSTALL_SERVICE" = "1" ] && [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then
    echo "To keep it running across reboots, install the systemd unit:"
    echo "  see deploy/maestro-node.service in the repository"
  fi
  echo "It should now appear in the fleet view at ${origin}."
  wait "$DAEMON_PID"
else
  echo "The daemon exited during enrollment. Check the output above." >&2
  exit 1
fi
`;

  return new Response(script, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
