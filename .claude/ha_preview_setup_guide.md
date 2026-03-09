# Home Assistant Frontend Preview for Claude Code

## Action Required

This document contains everything needed to set up HA frontend preview in this project. **Read the full document, then create the files listed in "Setup Instructions".** Write each file directly to disk using the Write tool — do not just display the code. Once all files are in place, start the server with `preview_start` and verify with `preview_screenshot`.

## What This Is

Claude Code has **preview tools** (`preview_start`, `preview_screenshot`, `preview_click`, `preview_inspect`, `preview_eval`, etc.) that start a local dev server, open it in a headless browser, and allow screenshots and interaction. This is normally used for local dev servers (React, Flask, etc.), but it can be made to work with a Home Assistant instance on the local network via a lightweight reverse proxy.

The result: Claude Code can **see the HA dashboard**, take screenshots of it, inspect elements, and help with dashboard YAML/CSS/card layout — all without needing the Claude in Chrome browser extension.

## Prerequisites

- **Python 3** must be available on the system (stdlib only — no pip packages needed)
- The machine running Claude Code must be on the **same local network** as the HA instance

## How It Works

The preview system requires:
1. A **`launch.json`** config in `.claude/` that tells it what command to run and what port to connect to
2. A **process to start** that serves a web page on localhost

Since HA is already running on the network (not a local dev server), we use a tiny Python reverse proxy that:
- Listens on `localhost:8124`
- Forwards all HTTP requests to the HA instance at `http://192.168.4.101:8123`
- Injects a `<script>` into the root HTML page that:
  - Sets up auth tokens in `localStorage` using a long-lived access token (so the dashboard loads without manual login)
  - Patches `WebSocket` to connect directly to the real HA server (the HTTP-only proxy can't handle websocket upgrades, but the headless browser can reach the LAN IP directly)

## Setup Instructions

Create the following three files. Do NOT copy them from the code blocks — write them directly to disk so there are no encoding issues.

### 1. `.gitignore` entry

Add this line to the project's `.gitignore` (the HA config repo's `.gitignore`, not this file):

```
.claude/ha_token
```

This prevents the access token from being committed to git. The proxy script and launch.json are safe to commit.

### 2. `.claude/launch.json`

This tells Claude Code's preview tools how to start the proxy. Create or add to this file:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "ha-frontend",
      "runtimeExecutable": "python",
      "runtimeArgs": [".claude/ha_preview_proxy.py"],
      "port": 8124
    }
  ]
}
```

### 3. `.claude/ha_token`

A plain text file containing a Home Assistant **long-lived access token**. Nothing else in the file — just the token string, no trailing newline.

**If this file already exists** (e.g. copied from a previous setup), skip this step.

To create a new one: HA → Profile (click your name bottom-left) → Security → Long-lived access tokens → Create token. Save the token string to this file.

**This file must be gitignored.** Verify `.claude/ha_token` is in `.gitignore`.

### 4. `.claude/ha_preview_proxy.py`

The reverse proxy script. **The HA IP address (`192.168.4.101:8123`) appears in 3 places** — `HA_URL`, the `Host` header, and the WebSocket redirect regex. If the IP changes, update all three. Full working version:

```python
"""
Minimal reverse proxy: localhost:8124 -> Home Assistant
Used by Claude preview tools to view the HA frontend.
Reads a long-lived access token from .claude/ha_token and injects
auth so the dashboard loads without manual login.
"""
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import urlopen, Request

HA_URL = "http://192.168.4.101:8123"
PORT = 8124

# Load token from file next to this script
TOKEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ha_token')
TOKEN = None
if os.path.exists(TOKEN_PATH):
    with open(TOKEN_PATH, 'r') as f:
        TOKEN = f.read().strip()
    print(f"Loaded HA token from {TOKEN_PATH}")
else:
    print(f"WARNING: No token file at {TOKEN_PATH} — auth will not work")


class ProxyHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self._proxy()

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def _proxy(self):
        target = HA_URL + self.path
        try:
            req = Request(target, method=self.command)
            for key, val in self.headers.items():
                if key.lower() not in ('host', 'connection', 'accept-encoding'):
                    req.add_header(key, val)
            req.add_header('Host', '192.168.4.101:8123')

            # Inject auth token
            if TOKEN:
                req.add_header('Authorization', f'Bearer {TOKEN}')

            if self.command == 'POST':
                length = int(self.headers.get('Content-Length', 0))
                req.data = self.rfile.read(length) if length else b''

            resp = urlopen(req, timeout=10)
            body = resp.read()

            # For the root HTML page, inject a script that sets up auth
            # in localStorage so the HA frontend skips the login screen
            content_type = resp.headers.get('Content-Type', '')
            if self.path in ('/', '') and 'text/html' in content_type and TOKEN:
                body = self._inject_auth(body)

            self.send_response(resp.status)
            for key, val in resp.headers.items():
                if key.lower() not in ('transfer-encoding', 'connection',
                                       'content-encoding', 'content-length'):
                    self.send_header(key, val)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_error(502, f"Proxy error: {e}")

    def _inject_auth(self, body):
        """Inject script into HTML that sets HA auth tokens in localStorage
        and redirects websocket connections to the real HA server."""
        auth_script = f'''
<script>
(function() {{
    // Redirect WebSocket connections directly to the real HA server
    // (the HTTP proxy can't handle websocket upgrades)
    const _WS = window.WebSocket;
    window.WebSocket = function(url, protocols) {{
        url = url.replace(/localhost:8124|127\\.0\\.0\\.1:8124/, '192.168.4.101:8123');
        return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
    }};
    window.WebSocket.prototype = _WS.prototype;
    window.WebSocket.CONNECTING = _WS.CONNECTING;
    window.WebSocket.OPEN = _WS.OPEN;
    window.WebSocket.CLOSING = _WS.CLOSING;
    window.WebSocket.CLOSED = _WS.CLOSED;

    // Set up auth tokens so HA frontend skips login
    // hassUrl must match current origin or the frontend starts a new OAuth flow
    const proxyUrl = window.location.origin;
    const token = "{TOKEN}";
    const existing = localStorage.getItem("hassTokens");
    const needsAuth = !existing || !JSON.parse(existing).access_token;
    if (needsAuth) {{
        const tokenData = {{
            hassUrl: proxyUrl,
            clientId: proxyUrl + "/",
            access_token: token,
            refresh_token: "",
            token_type: "Bearer",
            expires_in: 99999999,
            expires: Date.now() + 99999999000
        }};
        localStorage.setItem("hassTokens", JSON.stringify(tokenData));
        window.location.href = proxyUrl;
    }}
}})();
</script>
'''
        # Insert before </head> or at the start of <body>
        body_str = body.decode('utf-8', errors='replace')
        if '</head>' in body_str:
            body_str = body_str.replace('</head>', auth_script + '</head>', 1)
        elif '<body' in body_str:
            body_str = body_str.replace('<body', auth_script + '<body', 1)
        else:
            body_str = auth_script + body_str
        return body_str.encode('utf-8')

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith('5'):
            print(fmt % args, file=sys.stderr)


print(f"HA preview proxy: localhost:{PORT} -> {HA_URL}")
sys.stdout.flush()
HTTPServer(('127.0.0.1', PORT), ProxyHandler).serve_forever()
```

## How To Use

Once all four files above are in place:

1. **Start the proxy**: Call `preview_start` with `name: "ha-frontend"`
2. **Check logs**: Call `preview_logs` to verify "Loaded HA token" appears (not the WARNING)
3. **First load**: The preview browser loads `localhost:8124`. The proxy serves HA's HTML with an auth script injected. The script sets localStorage tokens and reloads. On the second load the HA frontend finds auth tokens and connects via websocket.
4. **Verify**: Call `preview_screenshot` — you should see the HA dashboard, not a login page
5. **If you see the login page**: The localStorage has stale data. Run `preview_eval` with `localStorage.clear(); window.location.reload();` to reset, then screenshot again.

### Ongoing use

- **Take screenshots**: `preview_screenshot` to see the current dashboard state
- **Navigate**: `preview_eval` with `window.location.href = '/lovelace/your-view'` or `preview_click` on sidebar items
- **Inspect elements**: `preview_inspect` with CSS selectors to check styles, spacing, colours
- **Read page content**: `preview_snapshot` for an accessibility tree, `preview_eval` for JS queries

## What Works

- Full dashboard rendering with live entity data (websocket connects directly to HA)
- Screenshots of any dashboard view
- Clicking cards, opening sidebars, navigating between views
- Inspecting element styles and layout
- Reading page text / accessibility tree

## Limitations

- **HTTP only through proxy** — websockets bypass the proxy and go direct to HA on the LAN. This means the headless browser must be on the same network as the HA instance.
- **No token refresh** — long-lived access tokens don't expire for 10 years by default, but if the token is revoked in HA, you'd need to generate a new one and update `.claude/ha_token`.
- **Initial load can be slow** — the proxy is single-threaded Python stdlib. The HA frontend loads many JS/CSS assets. First screenshot may take a few seconds.
- **Can't handle all HTTP methods** — only GET, POST, HEAD are proxied. PUT, DELETE, PATCH would need adding if you want to use the HA REST API through the proxy (unlikely for dashboard viewing).

## Network Details

- **HA instance**: `http://192.168.4.101:8123` (also reachable as `http://homeassistant.local:8123`)
- **Proxy listens**: `http://127.0.0.1:8124`
- **WebSocket**: Browser connects directly to `ws://192.168.4.101:8123/api/websocket` (bypasses proxy)
- **Auth**: Long-lived access token passed as `Authorization: Bearer <token>` header on HTTP requests, and via localStorage for the frontend's own auth system

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Login page shows | `preview_eval`: `localStorage.clear(); window.location.reload();` |
| "Unable to connect" | WebSocket can't reach HA — check network, ensure `192.168.4.101:8123` is reachable |
| 502 errors in logs | HA instance might be down or IP changed |
| Stale dashboard | Take a fresh screenshot — live data updates via websocket |
| Token expired/revoked | Generate new token in HA Profile → Security, update `.claude/ha_token` |

## Cleanup — Remove From Misc-Scripts

This setup was prototyped in the `Misc-Scripts` repo by accident. The following files in that repo should be deleted once the setup is working in the HA config directory:

- `D:\scripts\Misc Scripts\Misc-Scripts\.claude\ha_preview_proxy.py`
- `D:\scripts\Misc Scripts\Misc-Scripts\.claude\ha_token`
- `D:\scripts\Misc Scripts\Misc-Scripts\.claude\ha_preview_setup_guide.md`
- Remove the `ha-frontend` entry from `D:\scripts\Misc Scripts\Misc-Scripts\.claude\launch.json`
