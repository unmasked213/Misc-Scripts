from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from threading import Event, Thread
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROJECT_DIR = PROJECT_ROOT / "upload"
if not PROJECT_DIR.is_dir():
    PROJECT_DIR = PROJECT_ROOT
sys.path.insert(0, str(PROJECT_DIR))

import server  # noqa: E402


BASE_URL = "http://127.0.0.1:5000"


class ServerSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        with server.server_state_lock:
            server.shutdown_requested = False
            server.active_file_operations = 0
            server.last_server_activity = time.time()
        with server.registry_lock:
            server.scan_sessions.clear()
            server.folder_tokens.clear()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.scan_root = self.temp_path / "photos"
        self.scan_root.mkdir()
        self.client = server.app.test_client()

    def tearDown(self) -> None:
        with server.registry_lock:
            sessions = list(server.scan_sessions.values())
        for session in sessions:
            session["cancel_event"].set()
            session["pause_event"].set()
            thread = session.get("thread")
            if thread is not None:
                thread.join(timeout=5)
        with server.registry_lock:
            server.scan_sessions.clear()
            server.folder_tokens.clear()
        self.temp_dir.cleanup()

    @property
    def auth_headers(self) -> dict:
        return {"X-DupeFinder-Token": server.API_TOKEN}

    def request(self, method: str, path: str, *, json=None, headers=None, query_string=None):
        merged_headers = dict(self.auth_headers)
        if headers:
            merged_headers.update(headers)
        return self.client.open(
            path,
            method=method,
            json=json,
            headers=merged_headers,
            query_string=query_string,
            base_url=BASE_URL,
        )

    def create_identity_fixture(self) -> None:
        image = Image.new("RGBA", (18, 12), (35, 90, 170, 255))
        first = self.scan_root / "a.png"
        exact = self.scan_root / "b.png"
        pixel = self.scan_root / "c.tiff"
        image.save(first)
        shutil.copyfile(first, exact)
        image.save(pixel)
        self.original_sha = hashlib.sha256(first.read_bytes()).hexdigest()

    def create_exact_triplet(self) -> None:
        first = self.scan_root / "a.png"
        Image.new("RGB", (18, 18), (80, 40, 170)).save(first)
        shutil.copyfile(first, self.scan_root / "b.png")
        shutil.copyfile(first, self.scan_root / "c.png")

    def start_scan(self, *, quick_mode: bool, threshold: float) -> tuple[str, dict]:
        registration = server._register_folder_path(str(self.scan_root))
        folder_token = registration["folder_token"]
        created = self.request("POST", "/api/session", json={})
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        session_id = created.get_json()["session_id"]
        started = self.request(
            "POST",
            "/api/scan",
            json={
                "session_id": session_id,
                "folder_token": folder_token,
                "quick_mode": quick_mode,
                "threshold": threshold,
            },
        )
        self.assertEqual(started.status_code, 200, started.get_data(as_text=True))
        deadline = time.monotonic() + 15
        payload = None
        while time.monotonic() < deadline:
            response = self.request("GET", f"/api/clusters/{session_id}")
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            payload = response.get_json()
            if payload["status"] in {"complete", "cancelled", "error"}:
                break
            time.sleep(0.02)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["status"], "complete", payload)
        return session_id, payload

    def start_quick_scan(self) -> tuple[str, dict]:
        return self.start_scan(quick_mode=True, threshold=1.0)

    @staticmethod
    def members_by_path(payload: dict) -> dict:
        return {
            member["relative_path"]: member
            for cluster in payload["clusters"]
            for member in cluster["members"]
        }

    def mark(self, session_id: str, result_id: str, marked: bool = True):
        response = self.request(
            "POST",
            "/api/mark",
            json={"session_id": session_id, "result_id": result_id, "marked": marked},
        )
        return response

    def prepare_named_results(
        self, session_id: str, payload: dict, names: tuple[str, ...]
    ) -> tuple[dict, str]:
        members = self.members_by_path(payload)
        selected_ids = []
        for name in names:
            result_id = members[name]["id"]
            selected_ids.append(result_id)
            self.assertEqual(self.mark(session_id, result_id, True).status_code, 200)
        prepared = self.request(
            "POST",
            "/api/quarantine/prepare",
            json={"session_id": session_id, "result_ids": selected_ids},
        )
        self.assertEqual(prepared.status_code, 200, prepared.get_data(as_text=True))
        return members, prepared.get_json()["selection_token"]

    @staticmethod
    def response_member_ids(payload: dict) -> set[str]:
        return {
            member["id"]
            for cluster in payload["clusters"]
            for member in cluster["members"]
        }

    def test_authentication_host_and_cross_origin_fail_closed(self) -> None:
        no_token = self.client.post("/api/session", json={}, base_url=BASE_URL)
        self.assertEqual(no_token.status_code, 401)

        cross_site = self.client.post(
            "/api/session",
            json={},
            headers={**self.auth_headers, "Sec-Fetch-Site": "cross-site"},
            base_url=BASE_URL,
        )
        self.assertEqual(cross_site.status_code, 403)

        hostile_host = self.client.post(
            "/api/session",
            json={},
            headers=self.auth_headers,
            base_url="http://attacker.example:5000",
        )
        self.assertEqual(hostile_host.status_code, 400)

        valid = self.request("POST", "/api/session", json={})
        self.assertEqual(valid.status_code, 200)
        self.assertNotIn("Access-Control-Allow-Origin", valid.headers)

        index = self.client.get("/", base_url=BASE_URL)
        self.assertEqual(index.status_code, 200)
        served = index.get_data(as_text=True)
        self.assertIn(server.API_TOKEN, served)
        self.assertNotIn("__DUPEFINDER_API_TOKEN__", served)
        self.assertEqual(index.headers.get("X-Frame-Options"), "DENY")

    def test_quick_scan_distinguishes_exact_and_pixel_identity(self) -> None:
        self.create_identity_fixture()
        _session_id, payload = self.start_quick_scan()
        self.assertEqual(len(payload["clusters"]), 1)
        members = self.members_by_path(payload)
        self.assertEqual(set(members), {"a.png", "b.png", "c.tiff"})
        self.assertTrue(any(member["match_kind"] == "exact" for member in members.values()))
        self.assertTrue(
            any(member["match_kind"] == "pixel_duplicate" for member in members.values())
        )
        self.assertEqual(members["a.png"]["file_sha256"], members["b.png"]["file_sha256"])
        self.assertNotEqual(members["a.png"]["file_sha256"], members["c.tiff"]["file_sha256"])

    def test_pixel_peer_badges_use_the_full_conservative_content_key(self) -> None:
        rng = np.random.default_rng(2201)
        pixels = rng.integers(0, 256, size=(320, 320, 3), dtype=np.uint8)
        rgb = Image.fromarray(pixels)
        rgb.save(self.scan_root / "a.png")
        shutil.copyfile(self.scan_root / "a.png", self.scan_root / "b.png")
        rgb.convert("RGBA").save(self.scan_root / "c.png")

        _session_id, payload = self.start_scan(quick_mode=False, threshold=0.5)
        members = self.members_by_path(payload)
        self.assertEqual(set(members), {"a.png", "b.png", "c.png"}, payload)
        self.assertFalse(members["a.png"]["has_alpha"])
        self.assertTrue(members["c.png"]["has_alpha"])
        self.assertTrue(
            any(member["match_kind"] == "variant" for member in members.values()),
            payload,
        )
        self.assertTrue(
            all(member["pixel_peer_count"] == 0 for member in members.values()),
            payload,
        )

    def test_actions_reject_raw_paths_and_permanent_delete_route_is_absent(self) -> None:
        self.create_identity_fixture()
        session_id, _payload = self.start_quick_scan()
        raw_mark = self.request(
            "POST",
            "/api/mark",
            json={"session_id": session_id, "path": str(self.scan_root / "a.png")},
        )
        self.assertEqual(raw_mark.status_code, 400)
        raw_open = self.request(
            "POST",
            "/api/open-file",
            json={"session_id": session_id, "path": str(self.scan_root / "a.png")},
        )
        self.assertEqual(raw_open.status_code, 400)
        deleted = self.request(
            "POST",
            "/api/delete",
            json={"session_id": session_id, "paths": [str(self.scan_root / "a.png")]},
        )
        self.assertEqual(deleted.status_code, 404)
        raw_folder_registration = self.request(
            "POST",
            "/api/register-folder",
            json={"path": str(self.scan_root)},
        )
        self.assertEqual(raw_folder_registration.status_code, 404)

    def test_exact_automark_preserves_manual_mark_and_never_marks_every_member(self) -> None:
        self.create_identity_fixture()
        session_id, payload = self.start_quick_scan()
        members = self.members_by_path(payload)
        pixel_id = members["c.tiff"]["id"]
        first_exact_id = members["a.png"]["id"]
        marked_pixel = self.mark(session_id, pixel_id, True)
        self.assertEqual(marked_pixel.status_code, 200)
        marked_exact = self.mark(session_id, first_exact_id, True)
        self.assertEqual(marked_exact.status_code, 200)

        automark = self.request("POST", "/api/mark-exact", json={"session_id": session_id})
        self.assertEqual(automark.status_code, 200, automark.get_data(as_text=True))
        marked_ids = set(automark.get_json()["marked_ids"])
        self.assertIn(pixel_id, marked_ids)
        self.assertIn(first_exact_id, marked_ids)
        self.assertEqual(len(marked_ids), 2)

        remaining = next(member["id"] for member in members.values() if member["id"] not in marked_ids)
        reject_all = self.mark(session_id, remaining, True)
        self.assertEqual(reject_all.status_code, 409)
        refreshed = self.request("GET", f"/api/clusters/{session_id}").get_json()
        self.assertEqual(set(refreshed["marked_ids"]), marked_ids)

    def test_snapshot_quarantine_and_undo_never_overwrite(self) -> None:
        self.create_identity_fixture()
        session_id, payload = self.start_quick_scan()
        members = self.members_by_path(payload)
        target = members["b.png"]
        target_path = self.scan_root / "b.png"
        expected_bytes = target_path.read_bytes()

        self.assertEqual(self.mark(session_id, target["id"], True).status_code, 200)
        prepared = self.request(
            "POST",
            "/api/quarantine/prepare",
            json={"session_id": session_id, "result_ids": [target["id"]]},
        )
        self.assertEqual(prepared.status_code, 200, prepared.get_data(as_text=True))
        prepared_data = prepared.get_json()
        self.assertEqual([item["relative_path"] for item in prepared_data["items"]], ["b.png"])
        selection_token = prepared_data["selection_token"]

        self.assertEqual(self.mark(session_id, target["id"], False).status_code, 200)
        changed_selection = self.request(
            "POST",
            "/api/quarantine/commit",
            json={"session_id": session_id, "selection_token": selection_token},
        )
        self.assertEqual(changed_selection.status_code, 409)
        self.assertTrue(target_path.exists())

        self.assertEqual(self.mark(session_id, target["id"], True).status_code, 200)
        committed = self.request(
            "POST",
            "/api/quarantine/commit",
            json={"session_id": session_id, "selection_token": selection_token},
        )
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        commit_data = committed.get_json()
        self.assertFalse(target_path.exists())
        self.assertTrue(commit_data["can_undo"])
        quarantine_dir = Path(commit_data["quarantine_location"])
        self.assertNotEqual(quarantine_dir.parent, self.scan_root)
        self.assertTrue((quarantine_dir / "b.png").is_file())
        self.assertTrue(Path(commit_data["manifest_path"]).is_file())

        replacement = b"unrelated replacement"
        target_path.write_bytes(replacement)
        blocked_undo = self.request("POST", "/api/undo", json={"session_id": session_id})
        self.assertEqual(blocked_undo.status_code, 409)
        self.assertEqual(target_path.read_bytes(), replacement)
        self.assertTrue((quarantine_dir / "b.png").exists())

        target_path.unlink()
        restored = self.request("POST", "/api/undo", json={"session_id": session_id})
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        self.assertEqual(target_path.read_bytes(), expected_bytes)
        self.assertFalse(restored.get_json()["can_undo"])

    def test_changed_content_is_rejected_even_if_size_and_mtime_are_restored(self) -> None:
        self.create_identity_fixture()
        session_id, payload = self.start_quick_scan()
        target = self.members_by_path(payload)["b.png"]
        target_path = self.scan_root / "b.png"
        self.assertEqual(self.mark(session_id, target["id"], True).status_code, 200)
        prepared = self.request(
            "POST",
            "/api/quarantine/prepare",
            json={"session_id": session_id, "result_ids": [target["id"]]},
        ).get_json()

        before = target_path.stat()
        data = bytearray(target_path.read_bytes())
        data[len(data) // 2] ^= 0x01
        target_path.write_bytes(data)
        os.utime(target_path, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(target_path.stat().st_size, before.st_size)
        self.assertEqual(target_path.stat().st_mtime_ns, before.st_mtime_ns)

        commit = self.request(
            "POST",
            "/api/quarantine/commit",
            json={"session_id": session_id, "selection_token": prepared["selection_token"]},
        )
        self.assertEqual(commit.status_code, 409)
        self.assertTrue(target_path.exists())
        self.assertIn("no files were moved", commit.get_json()["error"].lower())

    def test_quarantine_revalidates_the_unselected_keeper(self) -> None:
        first = self.scan_root / "a.png"
        selected = self.scan_root / "b.png"
        Image.new("RGB", (14, 14), "orange").save(first)
        shutil.copyfile(first, selected)
        session_id, payload = self.start_quick_scan()
        members = self.members_by_path(payload)
        selected_id = members["b.png"]["id"]
        self.assertEqual(self.mark(session_id, selected_id, True).status_code, 200)
        prepared = self.request(
            "POST",
            "/api/quarantine/prepare",
            json={"session_id": session_id, "result_ids": [selected_id]},
        )
        self.assertEqual(prepared.status_code, 200)

        first.unlink()
        commit = self.request(
            "POST",
            "/api/quarantine/commit",
            json={
                "session_id": session_id,
                "selection_token": prepared.get_json()["selection_token"],
            },
        )
        self.assertEqual(commit.status_code, 409)
        self.assertTrue(selected.exists(), "selected file must remain when its reviewed keeper vanished")
        self.assertIn("survivor", commit.get_data(as_text=True).lower())

    def test_scan_revalidates_early_files_before_publishing_results(self) -> None:
        first = self.scan_root / "a.png"
        second = self.scan_root / "b.png"
        Image.new("RGB", (14, 14), "orange").save(first)
        shutil.copyfile(first, second)
        captured_first = Event()
        continue_scan = Event()
        original_capture = server._capture_record

        def delayed_capture(path, *args, **kwargs):
            record = original_capture(path, *args, **kwargs)
            if Path(path).name == "a.png":
                captured_first.set()
                if not continue_scan.wait(timeout=5):
                    raise RuntimeError("test scan was not released")
            return record

        registration = server._register_folder_path(str(self.scan_root))
        session_id = self.request("POST", "/api/session", json={}).get_json()["session_id"]
        with patch.object(server, "_capture_record", side_effect=delayed_capture):
            started = self.request(
                "POST",
                "/api/scan",
                json={
                    "session_id": session_id,
                    "folder_token": registration["folder_token"],
                    "quick_mode": True,
                    "threshold": 1.0,
                },
            )
            self.assertEqual(started.status_code, 200)
            self.assertTrue(captured_first.wait(timeout=5))
            Image.new("RGB", (14, 14), "purple").save(first)
            continue_scan.set()

            deadline = time.monotonic() + 10
            payload = None
            while time.monotonic() < deadline:
                payload = self.request("GET", f"/api/clusters/{session_id}").get_json()
                if payload["status"] in {"complete", "cancelled", "error"}:
                    break
                time.sleep(0.02)

        self.assertIsNotNone(payload)
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["clusters"], [])
        self.assertTrue(
            any(item.get("stage") == "changed_before_publish" for item in payload["errors"]),
            payload,
        )

    def test_full_mode_uses_geometry_composite_and_threshold_one_is_identity_only(self) -> None:
        rng = np.random.default_rng(1234)
        pixels = rng.integers(0, 256, size=(420, 420, 3), dtype=np.uint8)
        image = Image.fromarray(pixels)
        draw = ImageDraw.Draw(image)
        for index in range(20):
            x = 15 + index * 18
            draw.rectangle(
                (x, 20 + (index % 4) * 55, x + 12, 390 - (index % 3) * 30),
                outline=(255, 255, 255),
                width=3,
            )
        image.save(self.scan_root / "a.png")
        shutil.copyfile(self.scan_root / "a.png", self.scan_root / "b.png")
        image.resize((294, 294), server.RESAMPLE_LANCZOS).save(
            self.scan_root / "c.png"
        )

        _session_id, permissive = self.start_scan(quick_mode=False, threshold=0.5)
        self.assertTrue(
            any("variant" in cluster["kinds"] for cluster in permissive["clusters"]),
            permissive,
        )
        variant_scores = [
            member["similarity"]
            for cluster in permissive["clusters"]
            for member in cluster["members"]
            if member["match_kind"] == "variant"
        ]
        self.assertTrue(variant_scores, permissive)
        self.assertTrue(all(0.5 <= score < 1.0 for score in variant_scores))

        _strict_session, strict = self.start_scan(quick_mode=False, threshold=1.0)
        self.assertEqual(len(strict["clusters"]), 1, strict)
        self.assertEqual(strict["clusters"][0]["kinds"], ["exact"])
        self.assertEqual(
            {member["relative_path"] for member in strict["clusters"][0]["members"]},
            {"a.png", "b.png"},
        )

    def test_folder_token_rejects_directory_recreated_at_same_path(self) -> None:
        registration = server._register_folder_path(str(self.scan_root))
        folder_token = registration["folder_token"]
        original_identity = server.folder_tokens[folder_token]["identity"]
        relocated = self.temp_path / "photos-original"
        self.scan_root.rename(relocated)
        self.scan_root.mkdir()
        self.assertNotEqual(server._directory_identity(self.scan_root), original_identity)

        with self.assertRaises(server.ApiProblem) as raised:
            server._resolve_folder_token(folder_token)
        self.assertEqual(raised.exception.status, 409)

    def test_quarantine_rejects_replaced_session_scan_root(self) -> None:
        first = self.scan_root / "a.png"
        Image.new("RGB", (12, 12), "red").save(first)
        shutil.copyfile(first, self.scan_root / "b.png")
        session_id, payload = self.start_quick_scan()
        members, selection_token = self.prepare_named_results(
            session_id, payload, ("b.png",)
        )

        relocated = self.temp_path / "photos-original"
        self.scan_root.rename(relocated)
        self.scan_root.mkdir()
        committed = self.request(
            "POST",
            "/api/quarantine/commit",
            json={"session_id": session_id, "selection_token": selection_token},
        )
        self.assertEqual(committed.status_code, 409, committed.get_data(as_text=True))
        self.assertTrue(
            any(failure.get("role") == "scan_root" for failure in committed.get_json()["failures"])
        )
        self.assertTrue((relocated / "b.png").exists())
        self.assertFalse((self.temp_path / "photos.dupefinder_quarantine").exists())
        self.assertIn(members["b.png"]["id"], self.response_member_ids(payload))

    def test_shutdown_cancellation_releases_a_paused_worker(self) -> None:
        session_id, session = server._new_session()
        session["status"] = "paused"
        session["pause_event"].clear()

        def paused_worker() -> None:
            try:
                server._worker_checkpoint(session)
            except server.ScanCancelled:
                with session["lock"]:
                    session["status"] = "cancelled"

        worker = Thread(target=paused_worker, name="paused-shutdown-test")
        session["thread"] = worker
        with server.registry_lock:
            server.scan_sessions[session_id] = session
        worker.start()
        self.assertTrue(server._server_has_active_work())

        self.assertEqual(server._cancel_active_scans_for_shutdown(), 1)
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(session["cancel_event"].is_set())
        self.assertTrue(session["pause_event"].is_set())
        self.assertEqual(session["status"], "cancelled")
        self.assertEqual(server._cancel_active_scans_for_shutdown(), 0)
        self.assertFalse(server._server_has_active_work())

    def test_commit_and_rollback_failure_reconciles_and_retains_undo(self) -> None:
        self.create_exact_triplet()
        session_id, payload = self.start_quick_scan()
        members, selection_token = self.prepare_named_results(
            session_id, payload, ("b.png", "c.png")
        )
        original_move = server._move_file_no_overwrite

        def injected_move(source, destination):
            source = Path(source)
            in_quarantine = any(
                part.endswith(".dupefinder_quarantine") for part in source.parts
            )
            if not in_quarantine and source.name == "c.png":
                raise OSError("injected primary failure")
            if in_quarantine and source.name == "b.png":
                raise OSError("injected rollback failure")
            return original_move(source, Path(destination))

        with patch.object(server, "_move_file_no_overwrite", side_effect=injected_move), patch.object(
            server, "_log_local_exception"
        ):
            failed = self.request(
                "POST",
                "/api/quarantine/commit",
                json={"session_id": session_id, "selection_token": selection_token},
            )
        self.assertEqual(failed.status_code, 409, failed.get_data(as_text=True))
        failure_data = failed.get_json()
        self.assertTrue(failure_data["can_undo"])
        self.assertTrue(failure_data["recovery_available"])
        self.assertFalse(failure_data["recovery_required"])
        self.assertEqual(failure_data["marked_ids"], [])
        self.assertFalse((self.scan_root / "b.png").exists())
        self.assertTrue((self.scan_root / "c.png").exists())
        active_ids = self.response_member_ids(failure_data)
        self.assertNotIn(members["b.png"]["id"], active_ids)
        self.assertIn(members["c.png"]["id"], active_ids)
        manifest = json.loads(Path(failure_data["manifest_path"]).read_text(encoding="utf-8"))
        self.assertEqual(manifest["state"], "partial_failed_recoverable")

        restored = self.request("POST", "/api/undo", json={"session_id": session_id})
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        self.assertTrue((self.scan_root / "b.png").exists())
        self.assertTrue((self.scan_root / "c.png").exists())
        self.assertEqual(
            sum(len(cluster["members"]) for cluster in restored.get_json()["clusters"]),
            3,
        )

    def test_undo_and_rollback_failure_reconciles_and_remains_retryable(self) -> None:
        self.create_exact_triplet()
        session_id, payload = self.start_quick_scan()
        members, selection_token = self.prepare_named_results(
            session_id, payload, ("b.png", "c.png")
        )
        committed = self.request(
            "POST",
            "/api/quarantine/commit",
            json={"session_id": session_id, "selection_token": selection_token},
        )
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        original_move = server._move_file_no_overwrite

        def injected_move(source, destination):
            source = Path(source)
            destination = Path(destination)
            source_is_quarantine = any(
                part.endswith(".dupefinder_quarantine") for part in source.parts
            )
            destination_is_quarantine = any(
                part.endswith(".dupefinder_quarantine") for part in destination.parts
            )
            if source_is_quarantine and source.name == "c.png":
                raise OSError("injected restore failure")
            if destination_is_quarantine and source.name == "b.png":
                raise OSError("injected undo rollback failure")
            return original_move(source, destination)

        with patch.object(server, "_move_file_no_overwrite", side_effect=injected_move), patch.object(
            server, "_log_local_exception"
        ):
            failed = self.request("POST", "/api/undo", json={"session_id": session_id})
        self.assertEqual(failed.status_code, 409, failed.get_data(as_text=True))
        failure_data = failed.get_json()
        self.assertTrue(failure_data["can_undo"])
        self.assertTrue(failure_data["recovery_available"])
        self.assertFalse(failure_data["recovery_required"])
        self.assertEqual(failure_data["marked_ids"], [])
        self.assertTrue((self.scan_root / "b.png").exists())
        self.assertFalse((self.scan_root / "c.png").exists())
        active_ids = self.response_member_ids(failure_data)
        self.assertIn(members["b.png"]["id"], active_ids)
        self.assertNotIn(members["c.png"]["id"], active_ids)

        restored = self.request("POST", "/api/undo", json={"session_id": session_id})
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        self.assertTrue((self.scan_root / "b.png").exists())
        self.assertTrue((self.scan_root / "c.png").exists())
        self.assertEqual(
            sum(len(cluster["members"]) for cluster in restored.get_json()["clusters"]),
            3,
        )

    def test_missing_quarantine_source_requires_manifest_recovery_and_blocks_sessions(self) -> None:
        first = self.scan_root / "a.png"
        Image.new("RGB", (12, 12), "blue").save(first)
        shutil.copyfile(first, self.scan_root / "b.png")
        session_id, payload = self.start_quick_scan()
        _members, selection_token = self.prepare_named_results(
            session_id, payload, ("b.png",)
        )
        committed = self.request(
            "POST",
            "/api/quarantine/commit",
            json={"session_id": session_id, "selection_token": selection_token},
        )
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        commit_data = committed.get_json()
        quarantined = Path(commit_data["quarantine_location"]) / "b.png"
        quarantined.unlink()  # Simulate external loss after a successful commit.

        failed = self.request("POST", "/api/undo", json={"session_id": session_id})
        self.assertEqual(failed.status_code, 409, failed.get_data(as_text=True))
        failure_data = failed.get_json()
        self.assertTrue(failure_data["recovery_required"])
        self.assertFalse(failure_data["can_undo"])
        self.assertTrue(failure_data["recovery_manifest_path"])
        self.assertLessEqual(len(failure_data["recovery_manifest_path"]), 32_767)
        self.assertTrue(Path(failure_data["recovery_manifest_path"]).is_file())
        self.assertIn("durable manifest", failure_data["recovery_summary"])

        authoritative = self.request("GET", f"/api/clusters/{session_id}").get_json()
        self.assertTrue(authoritative["recovery_required"])
        self.assertEqual(
            authoritative["recovery_manifest_path"],
            failure_data["recovery_manifest_path"],
        )
        blocked_mark = self.request(
            "POST", "/api/mark-reset", json={"session_id": session_id}
        )
        self.assertEqual(blocked_mark.status_code, 409)
        self.assertTrue(blocked_mark.get_json()["recovery_required"])
        blocked_session = self.request("POST", "/api/session", json={})
        self.assertEqual(blocked_session.status_code, 409)
        self.assertTrue(blocked_session.get_json()["recovery_required"])

    def test_ambiguous_original_and_quarantine_locations_require_recovery(self) -> None:
        first = self.scan_root / "a.png"
        Image.new("RGB", (12, 12), "green").save(first)
        shutil.copyfile(first, self.scan_root / "b.png")
        session_id, payload = self.start_quick_scan()
        _members, selection_token = self.prepare_named_results(
            session_id, payload, ("b.png",)
        )
        committed = self.request(
            "POST",
            "/api/quarantine/commit",
            json={"session_id": session_id, "selection_token": selection_token},
        )
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        quarantined = Path(committed.get_json()["quarantine_location"]) / "b.png"
        try:
            os.link(quarantined, self.scan_root / "b.png")
        except OSError as exc:
            self.skipTest(f"hard links unavailable for ambiguity test: {exc}")

        failed = self.request("POST", "/api/undo", json={"session_id": session_id})
        self.assertEqual(failed.status_code, 409, failed.get_data(as_text=True))
        failure_data = failed.get_json()
        self.assertTrue(failure_data["recovery_required"])
        self.assertFalse(failure_data["can_undo"])
        locations = {item["location"] for item in failure_data["reconciliation"]}
        self.assertIn("ambiguous_both", locations)
        self.assertTrue(Path(failure_data["recovery_manifest_path"]).is_file())

    def test_control_and_mark_contract_routes_exist(self) -> None:
        created = self.request("POST", "/api/session", json={}).get_json()
        session_id = created["session_id"]
        invalid_control = self.request(
            "POST", "/api/scan-control", json={"session_id": session_id, "action": "invalid"}
        )
        self.assertEqual(invalid_control.status_code, 400)
        reset = self.request("POST", "/api/mark-reset", json={"session_id": session_id})
        self.assertNotEqual(reset.status_code, 404)
        exact = self.request("POST", "/api/mark-exact", json={"session_id": session_id})
        self.assertNotEqual(exact.status_code, 404)

    def test_heartbeat_keeps_completed_session_alive(self) -> None:
        created = self.request("POST", "/api/session", json={}).get_json()
        session_id = created["session_id"]
        with server.registry_lock:
            session = server.scan_sessions[session_id]
        with session["lock"]:
            session["status"] = "complete"
            session["last_access"] = 100.0

        heartbeat_time = 100.0 + server.SESSION_TTL_SECONDS + 10.0
        with patch.object(server.time, "time", return_value=heartbeat_time):
            response = self.request(
                "POST", "/api/heartbeat", json={"session_id": session_id}
            )
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            self.assertEqual(response.get_json()["session_status"], "complete")
            with session["lock"]:
                self.assertEqual(session["last_access"], heartbeat_time)
            server._expire_registries()

        with server.registry_lock:
            self.assertIn(session_id, server.scan_sessions)

        anonymous = self.request("POST", "/api/heartbeat", json={})
        self.assertEqual(anonymous.status_code, 200)
        self.assertIsNone(anonymous.get_json()["session_status"])

    def test_clusters_snapshot_waits_for_file_operation_to_settle(self) -> None:
        created = self.request("POST", "/api/session", json={}).get_json()
        session_id = created["session_id"]
        with server.registry_lock:
            session = server.scan_sessions[session_id]

        request_started = Event()
        request_finished = Event()
        result = {}

        def fetch_clusters() -> None:
            client = server.app.test_client()
            request_started.set()
            response = client.get(
                f"/api/clusters/{session_id}",
                headers=self.auth_headers,
                base_url=BASE_URL,
            )
            result["status_code"] = response.status_code
            result["payload"] = response.get_json()
            request_finished.set()

        with session["action_lock"]:
            thread = Thread(target=fetch_clusters)
            thread.start()
            self.assertTrue(request_started.wait(timeout=1))
            self.assertFalse(request_finished.wait(timeout=0.1))
            with session["lock"]:
                session["message"] = "settled authoritative state"

        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(request_finished.is_set())
        self.assertEqual(result["status_code"], 200)
        self.assertEqual(result["payload"]["message"], "settled authoritative state")


if __name__ == "__main__":
    unittest.main()
