#!/usr/bin/env python3
"""
Duplicate Image Finder - Web Backend API

A Flask-based REST API that wraps the dupefinder detection engine.
Provides endpoints for scanning folders, streaming progress, and managing duplicates.

Usage:
    python server.py

Then open http://localhost:5000 in your browser.
"""

import json
import shutil
import queue
import threading
import tempfile
import uuid
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Any
from dataclasses import asdict

from flask import Flask, request, jsonify, Response, send_file, send_from_directory
from flask_cors import CORS

# Import dupefinder functions
from dupefinder import (
    DEFAULT_CFG, load_config, list_image_files, FingerprintCache,
    get_feature_detector, compute_fingerprint, file_id_from_path,
    load_image_normalized, build_thumbnail, assign_buckets, build_lsh_map,
    phash_similarity_scores, extract_keypoints, match_descriptors,
    estimate_transform_and_metrics, decide_label, build_clusters,
    reconstruct_keypoints, resize_for_features, PairDecision, PairMetrics, Cluster
)

app = Flask(__name__, static_folder='.')
CORS(app)

# Global state for scan sessions
scan_sessions: Dict[str, dict] = {}

# Heartbeat tracking for auto-shutdown
import time
import atexit
import signal
import sys

last_heartbeat = time.time()
HEARTBEAT_TIMEOUT = 15  # Shutdown if no heartbeat for 15 seconds (reduced from 30)
server_should_shutdown = False


def create_session() -> str:
    """Create a new scan session."""
    session_id = str(uuid.uuid4())[:8]
    scan_sessions[session_id] = {
        'status': 'idle',
        'progress': 0,
        'message': '',
        'clusters': [],
        'marked': set(),
        'input_folder': None,
        'deletion_history': [],
        'event_queue': queue.Queue(),
    }
    return session_id


def get_session(session_id: str) -> Optional[dict]:
    """Get session by ID."""
    return scan_sessions.get(session_id)


@app.route('/')
def index():
    """Serve the main HTML page."""
    return send_file('index.html')


@app.route('/api/session', methods=['POST'])
def create_scan_session():
    """Create a new scan session."""
    session_id = create_session()
    return jsonify({'session_id': session_id})


@app.route('/api/scan', methods=['POST'])
def start_scan():
    """Start a duplicate scan."""
    data = request.json
    session_id = data.get('session_id')
    folder_path = data.get('folder')
    quick_mode = data.get('quick_mode', False)
    threshold = data.get('threshold', 0.85)

    session = get_session(session_id)
    if not session:
        return jsonify({'error': 'Invalid session'}), 400

    folder = Path(folder_path)
    if not folder.exists() or not folder.is_dir():
        return jsonify({'error': 'Invalid folder path'}), 400

    session['input_folder'] = folder
    session['status'] = 'scanning'
    session['progress'] = 0
    session['message'] = 'Starting scan...'

    # Start scan in background thread
    thread = threading.Thread(
        target=run_scan_thread,
        args=(session_id, folder, quick_mode, threshold),
        daemon=True
    )
    thread.start()

    return jsonify({'status': 'started'})


def run_scan_thread(session_id: str, folder: Path, quick_mode: bool, threshold: float):
    """Run the duplicate scan in a background thread."""
    session = get_session(session_id)
    if not session:
        return

    def emit(event_type: str, data: dict):
        """Send an event to the client."""
        session['event_queue'].put({'type': event_type, 'data': data})

    try:
        emit('status', {'message': 'Loading configuration...'})

        cfg = json.loads(json.dumps(DEFAULT_CFG))
        cfg['similarity']['phash_duplicate'] = threshold
        cfg['similarity']['phash_variant'] = threshold * 0.9

        # Use temporary cache
        temp_cache = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
        cache_path = Path(temp_cache.name)
        temp_cache.close()
        cache = FingerprintCache(cache_path)

        emit('status', {'message': 'Scanning for image files...'})
        files = list_image_files(folder, cfg)
        total_files = len(files)

        emit('status', {'message': f'Found {total_files} images', 'total': total_files})

        if total_files == 0:
            emit('complete', {'clusters': [], 'message': 'No images found'})
            session['status'] = 'complete'
            return

        # Compute fingerprints
        emit('status', {'message': 'Analyzing images...'})
        stats = {}
        fingerprints = {}
        detector = get_feature_detector(cfg)

        for idx, p in enumerate(files):
            progress = int((idx / total_files) * 50)  # First 50% for fingerprinting
            session['progress'] = progress

            if idx % 5 == 0:
                emit('progress', {
                    'current': idx,
                    'total': total_files,
                    'percent': progress,
                    'message': f'Analyzing {idx}/{total_files}...'
                })

            fp = compute_fingerprint(p, cfg, detector, cache)
            if fp is None:
                continue

            img = load_image_normalized(p, cfg)
            if img is None:
                continue

            h, w = img.shape[:2]
            fingerprints[p] = fp
            stats[p] = (w, h)

        emit('status', {'message': f'Processed {len(fingerprints)} images'})

        # Find duplicates
        emit('status', {'message': 'Finding duplicates...'})
        buckets = assign_buckets(list(stats.keys()), stats, cfg)
        pairs = []

        # Pre-calculate total comparisons for accurate progress
        total_comparisons = 0
        bucket_comparison_counts = {}
        for bucket_key, paths in buckets.items():
            if len(paths) < 2:
                continue
            phash_map = {p: fingerprints[p].phash64_8x for p in paths}
            lsh_map = build_lsh_map(phash_map, cfg['blocking']['lsh_hamming_radius'])
            bucket_pairs = 0
            for p in paths:
                for q in lsh_map[p]:
                    if p < q:
                        bucket_pairs += 1
            bucket_comparison_counts[bucket_key] = (paths, phash_map, lsh_map, bucket_pairs)
            total_comparisons += bucket_pairs

        if total_comparisons == 0:
            total_comparisons = 1  # Avoid division by zero

        comparison_count = 0
        for bucket_key, (paths, phash_map, lsh_map, _) in bucket_comparison_counts.items():
            for i, p in enumerate(paths):
                for q in lsh_map[p]:
                    if p >= q:
                        continue

                    fp_a = fingerprints[p]
                    fp_b = fingerprints[q]
                    sim, _ = phash_similarity_scores(fp_a.phash64_8x, fp_b.phash64_8x)

                    # Skip geometric verification for very high pHash matches
                    skip_geometric_thresh = cfg['similarity'].get('phash_skip_geometric', 0.97)

                    if quick_mode or sim >= skip_geometric_thresh:
                        # Quick mode OR high-confidence match - skip expensive geometric verification
                        metrics = PairMetrics(
                            phash_similarity=sim, inliers=0,
                            coverage_a=0.0, coverage_b=0.0,
                            residual_median_px=float('inf'), model='phash_only'
                        )
                        label = 'duplicate' if sim >= cfg['similarity']['phash_duplicate'] else \
                               'variant' if sim >= cfg['similarity']['phash_variant'] else 'different'
                        pairs.append(PairDecision(a=p, b=q, label=label, metrics=metrics))
                    else:
                        # Use cached descriptors and keypoints if available
                        desc_a = fp_a.descriptors
                        desc_b = fp_b.descriptors
                        kps_a = reconstruct_keypoints(fp_a.keypoints_data) if fp_a.keypoints_data else []
                        kps_b = reconstruct_keypoints(fp_b.keypoints_data) if fp_b.keypoints_data else []

                        # Fallback to image loading if cache doesn't have descriptors
                        if desc_a is None or desc_b is None:
                            img_a = load_image_normalized(p, cfg)
                            img_b = load_image_normalized(q, cfg)

                            if img_a is None or img_b is None:
                                continue

                            # Resize for faster feature extraction
                            max_dim = cfg['features'].get('max_dimension', 1024)
                            img_a = resize_for_features(img_a, max_dim)
                            img_b = resize_for_features(img_b, max_dim)

                            kps_a, desc_a = extract_keypoints(img_a, detector)
                            kps_b, desc_b = extract_keypoints(img_b, detector)

                        matches = match_descriptors(desc_a, desc_b, cfg)

                        model_name, geo_metrics = estimate_transform_and_metrics(
                            kps_a, kps_b, matches, cfg)
                        geo_metrics.phash_similarity = sim

                        if model_name is None:
                            label = 'different'
                        else:
                            label = decide_label(geo_metrics, fp_a, fp_b, cfg)

                        pairs.append(PairDecision(a=p, b=q, label=label, metrics=geo_metrics))

                    comparison_count += 1
                    if comparison_count % 20 == 0:
                        # Progress: 50-90% for comparison phase
                        progress = 50 + int((comparison_count / total_comparisons) * 40)
                        emit('progress', {
                            'current': comparison_count,
                            'total': total_comparisons,
                            'percent': min(90, progress),
                            'message': f'Comparing {comparison_count}/{total_comparisons}...'
                        })

        # Build clusters
        emit('status', {'message': 'Grouping duplicates...'})
        clusters = build_clusters(pairs, cfg, fingerprints, stats)

        # Convert clusters to serializable format
        cluster_data = []
        for cluster in clusters:
            members = []
            for member_path in cluster.members:
                try:
                    stat = member_path.stat()
                    img = load_image_normalized(member_path, cfg)
                    if img is not None:
                        h, w = img.shape[:2]
                    else:
                        w, h = 0, 0

                    members.append({
                        'path': str(member_path),
                        'name': member_path.name,
                        'size': stat.st_size,
                        'width': w,
                        'height': h,
                        'modified': stat.st_mtime,
                        'similarity': None if member_path == cluster.representative else cluster.member_similarities.get(str(member_path), 0.0),
                        'is_representative': member_path == cluster.representative
                    })
                except Exception:
                    continue

            if len(members) > 1:
                cluster_data.append({
                    'id': cluster.id,
                    'members': members,
                    'representative': str(cluster.representative)
                })

        session['clusters'] = cluster_data
        session['status'] = 'complete'
        session['progress'] = 100

        cache.close()
        try:
            cache_path.unlink()
        except:
            pass

        emit('complete', {
            'clusters': cluster_data,
            'total_clusters': len(cluster_data),
            'message': f'Found {len(cluster_data)} duplicate groups'
        })

    except Exception as e:
        import traceback
        error_msg = str(e)
        session['status'] = 'error'
        session['message'] = error_msg
        emit('error', {'message': error_msg, 'traceback': traceback.format_exc()})


@app.route('/api/events/<session_id>')
def stream_events(session_id: str):
    """Server-Sent Events endpoint for scan progress."""
    session = get_session(session_id)
    if not session:
        return jsonify({'error': 'Invalid session'}), 400

    def generate():
        while True:
            try:
                event = session['event_queue'].get(timeout=30)
                yield f"data: {json.dumps(event)}\n\n"

                if event['type'] in ('complete', 'error'):
                    break
            except queue.Empty:
                # Send keepalive
                yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"

    return Response(generate(), mimetype='text/event-stream')


@app.route('/api/clusters/<session_id>')
def get_clusters(session_id: str):
    """Get clusters for a session."""
    session = get_session(session_id)
    if not session:
        return jsonify({'error': 'Invalid session'}), 400

    return jsonify({
        'status': session['status'],
        'clusters': session['clusters'],
        'marked': list(session['marked'])
    })


@app.route('/api/thumbnail')
def get_thumbnail():
    """Get a thumbnail for an image."""
    path = request.args.get('path')
    size = int(request.args.get('size', 300))

    if not path:
        return jsonify({'error': 'No path provided'}), 400

    file_path = Path(path)
    if not file_path.exists():
        return jsonify({'error': 'File not found'}), 404

    try:
        cfg = DEFAULT_CFG
        img = load_image_normalized(file_path, cfg)
        if img is None:
            return jsonify({'error': 'Could not load image'}), 500

        thumb = build_thumbnail(img, size)

        # Save to temporary file and serve
        import io
        img_io = io.BytesIO()
        thumb.save(img_io, format='JPEG', quality=85)
        img_io.seek(0)

        return Response(img_io.getvalue(), mimetype='image/jpeg')
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/mark', methods=['POST'])
def toggle_mark():
    """Toggle mark status for a file."""
    data = request.json
    session_id = data.get('session_id')
    path = data.get('path')

    session = get_session(session_id)
    if not session:
        return jsonify({'error': 'Invalid session'}), 400

    if path in session['marked']:
        session['marked'].remove(path)
        marked = False
    else:
        session['marked'].add(path)
        marked = True

    return jsonify({'marked': marked, 'total_marked': len(session['marked'])})


@app.route('/api/mark-batch', methods=['POST'])
def mark_batch():
    """Mark multiple files at once."""
    data = request.json
    session_id = data.get('session_id')
    paths = data.get('paths', [])
    action = data.get('action', 'add')  # 'add', 'remove', or 'clear'

    session = get_session(session_id)
    if not session:
        return jsonify({'error': 'Invalid session'}), 400

    if action == 'clear':
        session['marked'].clear()
    elif action == 'add':
        session['marked'].update(paths)
    elif action == 'remove':
        session['marked'].difference_update(paths)

    return jsonify({'total_marked': len(session['marked']), 'marked': list(session['marked'])})


@app.route('/api/delete', methods=['POST'])
def delete_marked():
    """Delete files specified in request body.
    
    Frontend sends the exact paths to delete, eliminating sync issues between
    frontend marking state and backend session state. What you see marked in
    the UI is exactly what gets deleted.
    """
    data = request.json
    session_id = data.get('session_id')
    permanent = data.get('permanent', False)
    paths = data.get('paths', [])

    session = get_session(session_id)
    if not session:
        return jsonify({'error': 'Invalid session'}), 400

    if not paths:
        return jsonify({'error': 'No files specified'}), 400

    input_folder = session.get('input_folder')
    if not input_folder:
        return jsonify({'error': 'No input folder set'}), 400

    # Security: Validate all paths are within the scanned folder
    input_folder_resolved = Path(input_folder).resolve()
    validated_paths = []
    rejected_paths = []

    for path_str in paths:
        try:
            path = Path(path_str).resolve()
            if input_folder_resolved in path.parents or path.parent == input_folder_resolved:
                validated_paths.append(path_str)
            else:
                rejected_paths.append({'path': path_str, 'error': 'Outside scan folder'})
        except Exception:
            rejected_paths.append({'path': path_str, 'error': 'Invalid path'})

    moved = []
    deleted = []
    failed = list(rejected_paths)
    deletion_record = []
    dupes_dir = None

    if not permanent:
        # Create _dupes folder for move operation
        dupes_dir = input_folder_resolved / '_dupes'
        dupes_dir.mkdir(exist_ok=True)

    for path_str in validated_paths:
        file_path = Path(path_str)

        try:
            if not file_path.exists():
                failed.append({'path': path_str, 'error': 'File not found'})
                continue

            if permanent:
                # Permanently delete the file
                file_path.unlink()
                deleted.append({'path': path_str})
            else:
                # Move to _dupes folder
                # Generate unique destination
                dest = dupes_dir / file_path.name
                if dest.exists():
                    stem = file_path.stem
                    suffix = file_path.suffix
                    counter = 1
                    dest = dupes_dir / f'{stem}_{counter}{suffix}'
                    while dest.exists():
                        counter += 1
                        dest = dupes_dir / f'{stem}_{counter}{suffix}'

                shutil.move(str(file_path), str(dest))
                moved.append({'original': path_str, 'destination': str(dest)})
                deletion_record.append((path_str, str(dest)))

        except Exception as e:
            failed.append({'path': path_str, 'error': str(e)})

    # Record history for undo (move operations only)
    if deletion_record and not permanent:
        session['deletion_history'].append(deletion_record)

    # Sync session state with what was actually deleted (for consistency)
    for item in moved:
        session['marked'].discard(item['original'])
    for item in deleted:
        session['marked'].discard(item['path'])

    response_data = {
        'failed': len(failed),
        'details': {'failed': failed}
    }

    if permanent:
        response_data['deleted'] = len(deleted)
        response_data['details']['deleted'] = deleted
    else:
        response_data['moved'] = len(moved)
        response_data['details']['moved'] = moved
        response_data['dupes_folder'] = str(dupes_dir)

    return jsonify(response_data)


@app.route('/api/undo', methods=['POST'])
def undo_deletion():
    """Undo the last deletion operation."""
    data = request.json
    session_id = data.get('session_id')

    session = get_session(session_id)
    if not session:
        return jsonify({'error': 'Invalid session'}), 400

    if not session['deletion_history']:
        return jsonify({'error': 'Nothing to undo'}), 400

    last_deletion = session['deletion_history'].pop()
    restored = []
    failed = []

    for original_path, dupes_path in last_deletion:
        try:
            dupes_file = Path(dupes_path)
            original_file = Path(original_path)

            if dupes_file.exists():
                shutil.move(str(dupes_file), str(original_file))
                restored.append(original_path)
            else:
                failed.append({'path': original_path, 'error': 'File not found in _dupes'})
        except Exception as e:
            failed.append({'path': original_path, 'error': str(e)})

    return jsonify({
        'restored': len(restored),
        'failed': len(failed),
        'can_undo': len(session['deletion_history']) > 0
    })


@app.route('/api/select-folder', methods=['POST'])
def select_folder():
    """Open a native folder picker dialog."""
    try:
        import tkinter as tk
        from tkinter import filedialog
        import sys
        import io

        # Suppress tkinter stderr/stdout to prevent JSON corruption
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()

        try:
            # Create root window but hide it
            root = tk.Tk()
            root.withdraw()

            # Platform-specific setup
            try:
                root.wm_attributes('-topmost', 1)
            except:
                pass  # Not available on all platforms

            # Open folder picker
            folder_path = filedialog.askdirectory(
                title='Select folder to scan for duplicates',
                mustexist=True
            )

            root.destroy()
        finally:
            # Restore stdout/stderr
            sys.stdout = old_stdout
            sys.stderr = old_stderr

        if folder_path:
            return jsonify({'success': True, 'path': folder_path})
        else:
            return jsonify({'success': False, 'cancelled': True})

    except Exception as e:
        import traceback
        error_msg = str(e)
        trace = traceback.format_exc()
        return jsonify({'error': error_msg, 'trace': trace}), 500


@app.route('/api/open-folder', methods=['POST'])
def open_folder():
    """Open a folder in the system file explorer."""
    import subprocess
    import platform

    data = request.json
    path = data.get('path')

    if not path:
        return jsonify({'error': 'No path provided'}), 400

    file_path = Path(path)
    folder = file_path.parent if file_path.is_file() else file_path

    try:
        if platform.system() == 'Windows':
            if file_path.is_file():
                subprocess.run(['explorer', '/select,', str(file_path)])
            else:
                subprocess.run(['explorer', str(folder)])
        elif platform.system() == 'Darwin':
            subprocess.run(['open', '-R' if file_path.is_file() else '', str(file_path)])
        else:
            subprocess.run(['xdg-open', str(folder)])

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/open-file', methods=['POST'])
def open_file():
    """Open a file with the system's default application."""
    import subprocess
    import platform
    import os

    data = request.json
    path = data.get('path')

    if not path:
        return jsonify({'error': 'No path provided'}), 400

    file_path = Path(path)

    if not file_path.is_file():
        return jsonify({'error': 'File not found'}), 404

    try:
        if platform.system() == 'Windows':
            os.startfile(str(file_path))
        elif platform.system() == 'Darwin':
            subprocess.run(['open', str(file_path)])
        else:
            subprocess.run(['xdg-open', str(file_path)])

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    """Receive heartbeat from browser to keep server alive."""
    global last_heartbeat
    last_heartbeat = time.time()
    return jsonify({'status': 'ok'})


@app.route('/api/shutdown', methods=['POST', 'GET'])  # Accept GET too for testing
def shutdown():
    """Immediate shutdown when browser tab closes."""
    import os

    # Schedule shutdown after response is sent
    def delayed_shutdown():
        time.sleep(0.5)  # Give time for response to be sent

        # Try forceful termination
        try:
            force_terminate()
        except:
            pass

        os._exit(0)  # Fallback to os._exit

    threading.Thread(target=delayed_shutdown, daemon=True).start()
    return '', 204  # No content response


def force_terminate():
    """Forcefully terminate the process using multiple methods."""
    import subprocess
    import os

    pid = os.getpid()

    # Method 1: Use taskkill command (most reliable on Windows)
    try:
        subprocess.Popen(['taskkill', '/F', '/PID', str(pid)],
                        creationflags=subprocess.CREATE_NO_WINDOW)
        time.sleep(0.5)
    except:
        pass

    # Method 2: Windows API (fallback)
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(1, False, pid)
        kernel32.TerminateProcess(handle, 0)
    except:
        pass


def check_heartbeat():
    """Background thread to check for heartbeat timeout and shutdown."""
    global last_heartbeat, server_should_shutdown
    import os
    while True:
        time.sleep(3)  # Check every 3 seconds
        elapsed = time.time() - last_heartbeat
        if elapsed > HEARTBEAT_TIMEOUT:
            server_should_shutdown = True

            # Try multiple termination methods
            try:
                force_terminate()
            except:
                pass

            os._exit(0)  # Force immediate termination


if __name__ == '__main__':
    import webbrowser
    import os

    # Start heartbeat checker thread
    heartbeat_thread = threading.Thread(target=check_heartbeat, daemon=True)
    heartbeat_thread.start()

    # Auto-open browser
    webbrowser.open('http://localhost:5000')

    # Run Flask server
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True, use_reloader=False)