from __future__ import annotations

import re
import shutil
import subprocess
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROJECT_DIR = PROJECT_ROOT / "upload"
if not PROJECT_DIR.is_dir():
    PROJECT_DIR = PROJECT_ROOT
INDEX_PATH = PROJECT_DIR / "index.html"
SERVER_PATH = PROJECT_DIR / "server.py"


class IdCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.inline_handlers: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name == "id" and value:
                self.ids.append(value)
            if name.lower().startswith("on") and value:
                self.inline_handlers.append((name, value))


class FrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = INDEX_PATH.read_text(encoding="utf-8")
        cls.server = SERVER_PATH.read_text(encoding="utf-8")

    def test_dynamic_values_are_not_inserted_as_html_or_path_attributes(self) -> None:
        forbidden = (
            "innerHTML",
            "outerHTML",
            "insertAdjacentHTML",
            "document.write",
            "dataset.path",
            "thumbnail?path=",
        )
        for text in forbidden:
            self.assertNotIn(text, self.html)
        self.assertIn("function safeDisplayText", self.html)
        self.assertIn("card.dataset.resultId", self.html)
        self.assertIn("node.textContent", self.html)

    def test_no_permanent_delete_or_unload_shutdown_path_remains(self) -> None:
        combined = self.html + "\n" + self.server
        for text in (
            "/api/delete",
            "sendBeacon",
            "os._exit",
            "taskkill",
            "shutil.move",
            "Permanently delete",
            "Delete Marked",
            "Undo Last Deletion",
        ):
            self.assertNotIn(text, combined)

    def test_token_placeholder_is_unique_and_every_ui_route_exists(self) -> None:
        self.assertEqual(self.html.count("__DUPEFINDER_API_TOKEN__"), 1)
        expected_routes = (
            "/api/session",
            "/api/select-folder",
            "/api/scan",
            "/api/scan-control",
            "/api/mark",
            "/api/mark-reset",
            "/api/mark-exact",
            "/api/quarantine/prepare",
            "/api/quarantine/commit",
            "/api/undo",
            "/api/open-file",
            "/api/open-folder",
            "/api/heartbeat",
        )
        for route in expected_routes:
            self.assertIn(route, self.html, route)
            self.assertIn(route, self.server, route)

    def test_mark_request_sends_explicit_target_state(self) -> None:
        toggle = re.search(
            r"async function toggleMark\(resultId\)(.*?)(?:\n}\n)",
            self.html,
            re.DOTALL,
        )
        self.assertIsNotNone(toggle)
        self.assertRegex(toggle.group(1), r"marked\s*:")

    def test_session_is_kept_alive_and_restored_after_reload(self) -> None:
        self.assertIn("sessionStorage.setItem(SESSION_STORAGE_KEY", self.html)
        self.assertIn("async function restoreRememberedSession()", self.html)
        self.assertIn("/api/clusters/${encodeURIComponent(storedSession)}", self.html)
        heartbeat = re.search(
            r"window\.setInterval\(\(\)\s*=>\s*\{(.*?)\},\s*5000\);",
            self.html,
            re.DOTALL,
        )
        self.assertIsNotNone(heartbeat)
        self.assertIn("session_id: sessionId", heartbeat.group(1))
        self.assertRegex(heartbeat.group(1), r"/api/heartbeat.*body")
        restore = re.search(
            r"async function restoreRememberedSession\(\)(.*?)(?:\n}\n)",
            self.html,
            re.DOTALL,
        )
        self.assertIsNotNone(restore)
        self.assertLess(
            restore.group(1).index("rememberSession(storedSession)"),
            restore.group(1).index("/api/clusters/${encodeURIComponent(storedSession)}"),
        )
        self.assertIn("sessionRestoreBlocked = true", restore.group(1))
        self.assertIn(
            "elements.browseFolderBtn.disabled = recoveryRequired || sessionRestoreBlocked",
            restore.group(1),
        )
        self.assertIn("The remembered session is retained", self.html)

    def test_html_ids_are_unique_and_javascript_references_exist(self) -> None:
        parser = IdCollector()
        parser.feed(self.html)
        counts = Counter(parser.ids)
        duplicates = sorted(identifier for identifier, count in counts.items() if count > 1)
        self.assertEqual(duplicates, [])
        self.assertEqual(parser.inline_handlers, [])
        referenced = set(re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", self.html))
        missing = sorted(referenced - set(parser.ids))
        self.assertEqual(missing, [])

    @unittest.skipUnless(shutil.which("node"), "Node.js is unavailable")
    def test_inline_javascript_parses(self) -> None:
        scripts = re.findall(
            r"<script(?:\s[^>]*)?>(.*?)</script>", self.html, flags=re.DOTALL | re.IGNORECASE
        )
        self.assertTrue(scripts)
        for index, script in enumerate(scripts):
            checked = subprocess.run(
                ["node", "--check", "-"],
                input=script,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(checked.returncode, 0, f"script {index}: {checked.stderr}")


if __name__ == "__main__":
    unittest.main()
