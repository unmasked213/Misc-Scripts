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
