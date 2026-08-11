# Deploying the demo

## The number you need

**The app listens on port `3000`, bound to `127.0.0.1`.**

```
proxy  →  http://127.0.0.1:3000
```

Both are env vars on the server process:

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | Loopback only — see below if the proxy is not on this machine |

**If your reverse proxy runs on a different host or container**, `127.0.0.1` is
unreachable from it. Start the server with `HOST=0.0.0.0` and firewall port 3000
so only the proxy can reach it. If the proxy is on this box, leave it on
loopback — it cannot be reached from outside at all, which is the safer default.

`GET /healthz` returns `200 ok` and is the endpoint to point an upstream check at.

## Build and run

```bash
bun install
bun run build      # → apps/web/dist
bun run start      # serves dist on 127.0.0.1:3000
```

`bun run serve` does both in one step.

The server reads files from disk per request, so a rebuild is picked up without
a restart. Hashed assets under `/assets/` are sent `immutable`; everything else,
`index.html` included, is `no-cache`, so a redeploy shows up on the next load
rather than the next cache expiry.

## Reverse proxy

`nginx.conf` in this directory is a complete site file for `maestro.cyrn.fr`:

```bash
cp deploy/nginx.conf /etc/nginx/sites-available/maestro.cyrn.fr
ln -s /etc/nginx/sites-available/maestro.cyrn.fr /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d maestro.cyrn.fr     # TLS
```

It already carries the WebSocket upgrade headers, a 1-hour read timeout and
`proxy_buffering off`. None of that matters for the static demo, but all three
are needed the moment the node socket and the UI event stream land at `/ws` —
and each one fails in a way that is annoying to diagnose after the fact
(silent downgrade to a plain request, a stream cut at nginx's 60-second
default, chunks held until the response completes).

Caddy equivalent, if you prefer it — TLS is automatic:

```
maestro.cyrn.fr {
    reverse_proxy 127.0.0.1:3000
}
```

## Running as a service

```bash
cp deploy/maestro.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now maestro
systemctl status maestro
```

The unit hardcodes `/root/.bun/bin/bun` — the path Bun installed to on this
machine. Change `ExecStart` if Bun lives elsewhere for the user the service runs
as. It runs with `ProtectSystem=strict` and a read-only `/home/maestro`, which
is fine while the app only serves static files; the API and its database will
need that relaxed.
