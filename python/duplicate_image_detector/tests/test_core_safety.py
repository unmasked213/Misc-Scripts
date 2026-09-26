from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageOps


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROJECT_DIR = PROJECT_ROOT / "upload"
if not PROJECT_DIR.is_dir():
    PROJECT_DIR = PROJECT_ROOT
sys.path.insert(0, str(PROJECT_DIR))

import dupefinder as core  # noqa: E402


class CoreSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.cfg = copy.deepcopy(core.DEFAULT_CFG)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def _save_palette_png(path: Path, *, transparent: bool) -> None:
        image = Image.new("P", (12, 12), 0)
        palette = [255, 0, 0] + [0, 0, 0] * 255
        image.putpalette(palette)
        kwargs = {"transparency": 0} if transparent else {}
        image.save(path, format="PNG", **kwargs)

    def test_palette_transparency_changes_content_identity(self) -> None:
        opaque = self.root / "opaque.png"
        transparent = self.root / "transparent.png"
        self._save_palette_png(opaque, transparent=False)
        self._save_palette_png(transparent, transparent=True)

        opaque_sig = core.compute_content_signature(opaque, self.cfg)
        transparent_sig = core.compute_content_signature(transparent, self.cfg)

        self.assertNotEqual(opaque_sig.digest, transparent_sig.digest)
        self.assertFalse(opaque_sig.has_alpha)
        self.assertTrue(transparent_sig.has_alpha)

    def test_later_gif_frame_and_timing_are_part_of_identity(self) -> None:
        first = Image.new("RGBA", (16, 16), "red")
        second_blue = Image.new("RGBA", (16, 16), "blue")
        second_green = Image.new("RGBA", (16, 16), "green")
        gif_a = self.root / "a.gif"
        gif_b = self.root / "b.gif"
        gif_c = self.root / "c.gif"
        first.save(gif_a, save_all=True, append_images=[second_blue], duration=[80, 120], loop=0)
        first.save(gif_b, save_all=True, append_images=[second_green], duration=[80, 120], loop=0)
        first.save(gif_c, save_all=True, append_images=[second_blue], duration=[80, 160], loop=0)

        sig_a = core.compute_content_signature(gif_a, self.cfg)
        sig_b = core.compute_content_signature(gif_b, self.cfg)
        sig_c = core.compute_content_signature(gif_c, self.cfg)

        self.assertEqual(sig_a.frame_count, 2)
        self.assertNotEqual(sig_a.digest, sig_b.digest)
        self.assertNotEqual(sig_a.digest, sig_c.digest)

    def test_later_tiff_page_is_part_of_identity(self) -> None:
        first = Image.new("RGB", (10, 10), "white")
        tiff_a = self.root / "a.tiff"
        tiff_b = self.root / "b.tiff"
        first.save(tiff_a, save_all=True, append_images=[Image.new("RGB", (10, 10), "black")])
        first.save(tiff_b, save_all=True, append_images=[Image.new("RGB", (10, 10), "yellow")])
        self.assertNotEqual(
            core.compute_content_signature(tiff_a, self.cfg).digest,
            core.compute_content_signature(tiff_b, self.cfg).digest,
        )

    def test_same_decoded_pixels_can_match_across_encodings(self) -> None:
        image = Image.new("RGBA", (13, 9), (25, 80, 170, 255))
        png = self.root / "same.png"
        tiff = self.root / "same.tiff"
        image.save(png)
        image.save(tiff)
        self.assertNotEqual(core.compute_file_sha256(png), core.compute_file_sha256(tiff))
        self.assertEqual(
            core.compute_content_signature(png, self.cfg).digest,
            core.compute_content_signature(tiff, self.cfg).digest,
        )
        cluster = core.Cluster(
            id="cluster_pixel",
            members=[png, tiff],
            representative=png,
            member_similarities={str(png): -1.0, str(tiff): 1.0},
            member_match_kinds={str(png): "reference", str(tiff): "pixel_exact"},
        )
        report = core.write_html_report(
            self.root / "pixel-report",
            [cluster],
            self.cfg,
            detector=None,
        )
        report_text = report.read_text(encoding="utf-8")
        self.assertIn("METADATA/ENCODING MAY DIFFER", report_text)
        self.assertIn("MANUAL REVIEW", report_text)

    def test_opaque_rgb_and_alpha_capable_sources_stay_review_distinct(self) -> None:
        rgb = self.root / "rgb.png"
        rgba = self.root / "rgba.png"
        Image.new("RGB", (15, 11), (20, 40, 60)).save(rgb)
        Image.new("RGBA", (15, 11), (20, 40, 60, 255)).save(rgba)
        rgb_signature = core.compute_content_signature(rgb, self.cfg)
        rgba_signature = core.compute_content_signature(rgba, self.cfg)
        self.assertEqual(rgb_signature.digest, rgba_signature.digest)
        self.assertFalse(rgb_signature.has_alpha)
        self.assertTrue(rgba_signature.has_alpha)

        json_path, _csv_path, _html_path = core.process_directory(
            self.root,
            self.root / "alpha-report",
            copy.deepcopy(self.cfg),
            quick=True,
        )
        report = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(report["pairs"], [])
        self.assertEqual(report["clusters"], [])

    def test_colour_profile_difference_gates_pixel_identity(self) -> None:
        image = Image.new("RGB", (8, 8), "purple")
        first = self.root / "profile-a.png"
        second = self.root / "profile-b.png"
        image.save(first, icc_profile=b"profile-a")
        image.save(second, icc_profile=b"profile-b")
        self.assertNotEqual(
            core.compute_content_signature(first, self.cfg).digest,
            core.compute_content_signature(second, self.cfg).digest,
        )

    def test_exif_orientation_5_and_7_match_pillow_reference(self) -> None:
        source = Image.new("RGB", (19, 11), "black")
        pixels = source.load()
        for y in range(source.height):
            for x in range(source.width):
                pixels[x, y] = ((x * 13) % 256, (y * 23) % 256, ((x + y) * 17) % 256)

        for orientation in (5, 7):
            path = self.root / f"orientation-{orientation}.jpg"
            exif = Image.Exif()
            exif[0x0112] = orientation
            source.save(path, format="JPEG", quality=95, exif=exif)
            with Image.open(path) as reopened:
                expected = np.array(ImageOps.exif_transpose(reopened).convert("RGB"))
            actual = core.load_image_normalized(path, self.cfg)
            np.testing.assert_array_equal(actual, expected)

    def test_phash_only_cannot_be_positive_or_score_one(self) -> None:
        metrics = core.PairMetrics(
            phash_similarity=1.0,
            inliers=0,
            coverage_a=0.0,
            coverage_b=0.0,
            residual_median_px=float("inf"),
            model="phash_only",
            verification="none",
        )
        fingerprint = core.Fingerprint(phash64_8x=[0], keypoint_count=500)

        self.assertEqual(core.decide_label(metrics, fingerprint, fingerprint, self.cfg), "different")
        self.assertLess(
            core.compute_composite_similarity(
                metrics, fingerprint, fingerprint, self.cfg, (1000, 1000), (1000, 1000)
            ),
            1.0,
        )

    def test_flat_different_colours_do_not_bypass_geometry(self) -> None:
        red = np.full((64, 64, 3), (255, 0, 0), dtype=np.uint8)
        blue = np.full((64, 64, 3), (0, 0, 255), dtype=np.uint8)
        red_hash = core.compute_phash64(red)
        blue_hash = core.compute_phash64(blue)
        self.assertEqual(red_hash, blue_hash, "fixture must exercise the pHash collision")

        metrics = core.PairMetrics(
            phash_similarity=1.0,
            inliers=0,
            coverage_a=0.0,
            coverage_b=0.0,
            residual_median_px=float("inf"),
            model="none",
            verification="none",
        )
        low_texture = core.Fingerprint(phash64_8x=[red_hash], keypoint_count=0)
        self.assertEqual(core.decide_label(metrics, low_texture, low_texture, self.cfg), "different")

    def test_real_orb_ransac_resize_is_variant_never_identity(self) -> None:
        """Exercise the installed OpenCV path, not just synthetic metrics."""
        rng = np.random.default_rng(20260811)
        pixels = rng.integers(0, 256, (720, 960, 3), dtype=np.uint8)
        pixels = core.cv2.GaussianBlur(pixels, (5, 5), 0)
        for _ in range(80):
            centre = (
                int(rng.integers(20, pixels.shape[1] - 20)),
                int(rng.integers(20, pixels.shape[0] - 20)),
            )
            colour = tuple(int(value) for value in rng.integers(0, 256, 3))
            core.cv2.circle(
                pixels,
                centre,
                int(rng.integers(5, 25)),
                colour,
                -1,
            )

        original = self.root / "geometry-original.png"
        resized = self.root / "geometry-resized.png"
        Image.fromarray(pixels).save(original)
        Image.fromarray(pixels).resize((480, 360), Image.Resampling.LANCZOS).save(resized)

        detector = core.get_feature_detector(self.cfg)
        cache = core.FingerprintCache(self.root / "geometry-cache.sqlite")
        try:
            fingerprint_a = core.compute_fingerprint(original, self.cfg, detector, cache)
            fingerprint_b = core.compute_fingerprint(resized, self.cfg, detector, cache)
        finally:
            cache.close()
        self.assertIsNotNone(fingerprint_a)
        self.assertIsNotNone(fingerprint_b)

        keypoints_a = core.reconstruct_keypoints(fingerprint_a.keypoints_data or [])
        keypoints_b = core.reconstruct_keypoints(fingerprint_b.keypoints_data or [])
        matches = core.match_descriptors(
            fingerprint_a.descriptors,
            fingerprint_b.descriptors,
            self.cfg,
        )
        _model, metrics = core.estimate_transform_and_metrics(
            keypoints_a,
            keypoints_b,
            matches,
            self.cfg,
        )
        metrics.phash_similarity, _ = core.phash_similarity_scores(
            fingerprint_a.phash64_8x,
            fingerprint_b.phash64_8x,
        )

        self.assertEqual(metrics.verification, "geometry")
        self.assertEqual(
            core.decide_label(metrics, fingerprint_a, fingerprint_b, self.cfg),
            "variant",
        )
        self.assertLess(
            core.compute_composite_similarity(
                metrics,
                fingerprint_a,
                fingerprint_b,
                self.cfg,
                (960, 720),
                (480, 360),
            ),
            1.0,
        )

    def test_changed_decode_cannot_poison_persistent_fingerprint_cache(self) -> None:
        rng = np.random.default_rng(41)
        target = self.root / "cached.png"
        replacement = self.root / "replacement.png"
        Image.fromarray(
            rng.integers(0, 256, (96, 128, 3), dtype=np.uint8)
        ).save(target)
        Image.fromarray(
            rng.integers(0, 256, (96, 128, 3), dtype=np.uint8)
        ).save(replacement)
        original_bytes = target.read_bytes()
        replacement_bytes = replacement.read_bytes()

        detector = core.get_feature_detector(self.cfg)
        cache = core.FingerprintCache(self.root / "persistent-cache.sqlite")
        original_id = core.file_id_from_path(target, self.cfg)
        real_loader = core.load_image_normalized

        def replace_during_decode(path, cfg):
            target.write_bytes(replacement_bytes)
            return real_loader(path, cfg)

        try:
            with patch.object(
                core,
                "load_image_normalized",
                side_effect=replace_during_decode,
            ):
                with self.assertRaisesRegex(ValueError, "file changed"):
                    core.compute_fingerprint(
                        target,
                        self.cfg,
                        detector,
                        cache,
                        fid=original_id,
                    )

            self.assertIsNone(
                cache.get(original_id),
                "a changed decode must not leave a row under the old SHA key",
            )
            target.write_bytes(original_bytes)
            restored_id = core.file_id_from_path(target, self.cfg)
            restored = core.compute_fingerprint(
                target,
                self.cfg,
                detector,
                cache,
                fid=restored_id,
            )
            self.assertIsNotNone(restored)
            self.assertIsNotNone(cache.get(restored_id))
        finally:
            cache.close()

    def test_resizes_and_rotations_share_candidate_bucket(self) -> None:
        paths = [self.root / name for name in ("original.jpg", "resize.jpg", "rotation.jpg")]
        stats = {
            paths[0]: (4000, 3000),
            paths[1]: (2000, 1500),
            paths[2]: (3000, 4000),
        }
        buckets = core.assign_buckets(paths, stats, self.cfg)
        self.assertEqual(len(buckets), 1)
        self.assertEqual(set(next(iter(buckets.values()))), set(paths))

    def test_threshold_below_seventy_five_percent_is_honoured(self) -> None:
        self.assertGreaterEqual(core.hamming_radius_for_similarity(0.50), 32)
        self.assertEqual(core.hamming_radius_for_similarity(1.0), 0)

    def test_chain_component_retains_every_positive_node(self) -> None:
        a, b, c = (self.root / name for name in ("a.png", "b.png", "c.png"))
        for path in (a, b, c):
            Image.new("RGB", (8, 8), "white").save(path)
        fingerprint = core.Fingerprint(phash64_8x=[0], keypoint_count=0)
        fingerprints = {a: fingerprint, b: fingerprint, c: fingerprint}
        stats = {a: (8, 8), b: (8, 8), c: (8, 8)}

        identity = core.PairMetrics(
            phash_similarity=1.0,
            inliers=0,
            coverage_a=0.0,
            coverage_b=0.0,
            residual_median_px=0.0,
            model="identity",
            verification="byte_exact",
        )
        pairs = [
            core.PairDecision(a, b, "duplicate", identity, "exact"),
            core.PairDecision(b, c, "duplicate", identity, "exact"),
        ]

        clusters = core.build_clusters(pairs, self.cfg, fingerprints, stats)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(set(clusters[0].members), {a, b, c})

    def test_legacy_and_quarantine_directories_are_not_scanned(self) -> None:
        visible = self.root / "visible.png"
        Image.new("RGB", (8, 8), "white").save(visible)
        hidden_dirs = [self.root / "_dupes", self.root / "photos.dupefinder_quarantine"]
        for directory in hidden_dirs:
            directory.mkdir()
            Image.new("RGB", (8, 8), "white").save(directory / "hidden.png")

        listed = core.list_image_files(self.root, self.cfg)
        self.assertEqual(listed, [visible])

    @unittest.skipUnless(hasattr(os, "symlink"), "symbolic links unavailable")
    def test_symlinked_image_is_not_scanned(self) -> None:
        target = self.root / "target.png"
        link = self.root / "link.png"
        Image.new("RGB", (8, 8), "white").save(target)
        try:
            link.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links unavailable to this user")
        self.assertEqual(core.list_image_files(self.root, self.cfg), [target])

    @unittest.skipUnless(hasattr(os, "symlink"), "symbolic links unavailable")
    def test_cli_rejects_a_link_swapped_in_after_enumeration_without_reading_it(self) -> None:
        with tempfile.TemporaryDirectory() as outside_name:
            outside = Path(outside_name) / "outside.png"
            Image.new("RGB", (10, 10), "red").save(outside)
            link = self.root / "late-link.png"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links unavailable to this user")
            output = self.root / "reports"

            with patch.object(core, "list_image_files", return_value=[link]), patch.object(
                core,
                "compute_content_signature",
                wraps=core.compute_content_signature,
            ) as content_reader:
                json_path, _csv_path, _html_path = core.process_directory(
                    self.root,
                    output,
                    copy.deepcopy(self.cfg),
                    quick=True,
                )

            content_reader.assert_not_called()
            report = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(report["pairs"], [])
            self.assertEqual(report["clusters"], [])
            self.assertTrue(
                any(item["path"] == str(link) for item in report["errors"]),
                report,
            )

    def test_report_thumbnails_do_not_collide_on_equal_basenames(self) -> None:
        first_dir = self.root / "originals"
        second_dir = self.root / "exports"
        first_dir.mkdir()
        second_dir.mkdir()
        first = first_dir / "photo.png"
        second = second_dir / "photo.png"
        Image.new("RGBA", (8, 8), "red").save(first)
        Image.new("RGBA", (8, 8), "blue").save(second)
        cluster = core.Cluster(
            id="cluster_0000",
            members=[first, second],
            representative=first,
            member_similarities={str(first): -1.0, str(second): 1.0},
            member_match_kinds={str(first): "reference", str(second): "byte_exact"},
        )
        output = self.root / "report"
        report = core.write_html_report(output, [cluster], self.cfg, detector=None)
        thumbnails = sorted((output / "html" / "thumbnails").glob("*.png"))
        self.assertEqual(len(thumbnails), 2)
        self.assertNotEqual(thumbnails[0].name, thumbnails[1].name)
        html_text = report.read_text(encoding="utf-8")
        self.assertIn("takes no file action", html_text)
        self.assertNotIn("markedPaths", html_text)
        self.assertIn("dupefinderReview:", html_text)
        self.assertIn("DUPEFINDER_REPORT", html_text)
        self.assertIn("data-result-id=", html_text)
        self.assertNotIn("data-path=", html_text)
        self.assertEqual(sorted((output / "html").glob("*.html")), [report])

    def test_report_visibly_escapes_bidi_and_control_filename_characters(self) -> None:
        first = self.root / "normal.png"
        spoofed = self.root / "invoice\u202egnp.exe.png"
        Image.new("RGB", (8, 8), "white").save(first)
        Image.new("RGB", (8, 8), "white").save(spoofed)
        cluster = core.Cluster(
            id="cluster_controls",
            members=[first, spoofed],
            representative=first,
            member_similarities={str(first): -1.0, str(spoofed): 1.0},
            member_match_kinds={str(first): "reference", str(spoofed): "byte_exact"},
        )
        report = core.write_html_report(
            self.root / "control-report",
            [cluster],
            self.cfg,
            detector=None,
        )
        html_text = report.read_text(encoding="utf-8")
        self.assertNotIn("\u202e", html_text)
        self.assertIn("\\u202e", html_text)

    def test_dry_run_writes_no_report_directory(self) -> None:
        scan_root = self.root / "scan"
        scan_root.mkdir()
        first = scan_root / "first.png"
        second = scan_root / "second.png"
        Image.new("RGB", (12, 12), "white").save(first)
        second.write_bytes(first.read_bytes())
        output = self.root / "must-not-exist"
        result = core.process_directory(
            scan_root,
            output,
            copy.deepcopy(self.cfg),
            quick=True,
            dry_run=True,
        )
        self.assertEqual(result, (None, None, None))
        self.assertFalse(output.exists())

    def test_cli_drops_an_early_file_changed_before_report_publish(self) -> None:
        first = self.root / "first.png"
        second = self.root / "second.png"
        original = Image.new("RGB", (20, 20), "orange")
        original.save(first)
        second.write_bytes(first.read_bytes())
        output = self.root / "report"
        real_content_signature = core.compute_content_signature

        def mutate_after_second_decode(path, cfg=None):
            signature = real_content_signature(path, cfg)
            if Path(path) == second:
                Image.new("RGB", (20, 20), "purple").save(first)
            return signature

        with patch.object(
            core,
            "compute_content_signature",
            side_effect=mutate_after_second_decode,
        ):
            json_path, _csv_path, _html_path = core.process_directory(
                self.root,
                output,
                copy.deepcopy(self.cfg),
                quick=True,
            )

        report = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(report["clusters"], [])
        self.assertEqual(report["pairs"], [])
        self.assertTrue(
            any(
                item["path"] == str(first)
                and item["error"] == "changed_before_publish"
                for item in report["errors"]
            ),
            report,
        )

    def test_cli_couples_content_signature_to_full_sha_despite_restored_metadata(self) -> None:
        target = self.root / "target.bmp"
        replacement = self.root / "replacement.bmp"
        Image.new("RGB", (24, 24), "orange").save(target)
        Image.new("RGB", (24, 24), "purple").save(replacement)
        replacement_bytes = replacement.read_bytes()
        before = target.stat()
        self.assertEqual(len(target.read_bytes()), len(replacement_bytes))
        output = self.root / "coupled-report"
        real_content_signature = core.compute_content_signature

        def mutate_after_signature(path, cfg=None):
            signature = real_content_signature(path, cfg)
            if Path(path) == target:
                target.write_bytes(replacement_bytes)
                os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
            return signature

        with patch.object(
            core,
            "compute_content_signature",
            side_effect=mutate_after_signature,
        ):
            json_path, _csv_path, _html_path = core.process_directory(
                self.root,
                output,
                copy.deepcopy(self.cfg),
                quick=True,
            )

        report = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(report["pairs"], [])
        self.assertEqual(report["clusters"], [])
        self.assertTrue(
            any(
                item["path"] == str(target)
                and item["error"] == "changed_during_scan"
                for item in report["errors"]
            ),
            report,
        )

    def test_cli_reports_are_isolated_per_run(self) -> None:
        scan_root = self.root / "scan"
        scan_root.mkdir()
        first = scan_root / "first.png"
        second = scan_root / "second.png"
        Image.new("RGB", (16, 16), "teal").save(first)
        second.write_bytes(first.read_bytes())
        output = self.root / "reports"

        first_paths = core.process_directory(
            scan_root,
            output,
            copy.deepcopy(self.cfg),
            quick=True,
        )
        second_paths = core.process_directory(
            scan_root,
            output,
            copy.deepcopy(self.cfg),
            quick=True,
        )

        self.assertNotEqual(first_paths[0].parent, second_paths[0].parent)
        for path in (*first_paths, *second_paths):
            if path is not None:
                self.assertTrue(path.exists(), path)
        run_directories = sorted(output.glob("report-*"))
        self.assertEqual(len(run_directories), 2)

    def test_generated_report_thumbnails_are_not_rescanned_when_output_is_input(self) -> None:
        first = self.root / "first.png"
        second = self.root / "second.png"
        Image.new("RGB", (16, 16), "navy").save(first)
        second.write_bytes(first.read_bytes())
        core.process_directory(
            self.root,
            self.root,
            copy.deepcopy(self.cfg),
            quick=True,
        )
        self.assertEqual(core.list_image_files(self.root, self.cfg), [first, second])

    def test_legacy_in_place_html_thumbnails_are_not_rescanned(self) -> None:
        first = self.root / "first.png"
        second = self.root / "second.png"
        Image.new("RGB", (16, 16), "navy").save(first)
        second.write_bytes(first.read_bytes())
        legacy_thumbnails = self.root / "html" / "thumbnails"
        legacy_thumbnails.mkdir(parents=True)
        legacy = legacy_thumbnails / "old-report-copy.png"
        legacy.write_bytes(first.read_bytes())

        json_path, _csv_path, _html_path = core.process_directory(
            self.root,
            self.root,
            copy.deepcopy(self.cfg),
            quick=True,
        )
        report = json.loads(json_path.read_text(encoding="utf-8"))
        published_paths = {
            path
            for cluster in report["clusters"]
            for path in cluster["members"]
        }
        self.assertNotIn(str(legacy), published_paths)
        self.assertEqual(published_paths, {str(first), str(second)})

    def test_cli_publishes_nothing_if_source_changes_during_thumbnails(self) -> None:
        scan_root = self.root / "scan"
        scan_root.mkdir()
        first = scan_root / "first.png"
        second = scan_root / "second.png"
        Image.new("RGB", (24, 24), "orange").save(first)
        second.write_bytes(first.read_bytes())
        output = self.root / "reports"
        real_loader = core.load_image_rgba
        changed = False

        def mutate_after_thumbnail_read(path, frame_index=0):
            nonlocal changed
            preview = real_loader(path, frame_index)
            if not changed:
                changed = True
                Image.new("RGB", (24, 24), "purple").save(first)
            return preview

        with patch.object(
            core,
            "load_image_rgba",
            side_effect=mutate_after_thumbnail_read,
        ):
            with self.assertRaisesRegex(RuntimeError, "no report was published"):
                core.process_directory(
                    scan_root,
                    output,
                    copy.deepcopy(self.cfg),
                    quick=True,
                )

        self.assertEqual(list(output.glob("report-*")), [])
        self.assertEqual(list(output.glob(".dupefinder-incomplete-*")), [])


if __name__ == "__main__":
    unittest.main()
