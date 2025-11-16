"""
High-performance parallel directory scanner.

This module provides optimized directory tree scanning with:
- Parallel I/O using thread pools for concurrent subdirectory scanning
- os.scandir() for faster iteration (vs os.walk)
- Bounded heaps to avoid storing/sorting millions of directory entries
- Minimal object creation in hot paths
- Optional Cython extension for even faster scanning (2-5x additional speedup)

To build the optional Cython extension:
    cd python/media_stats
    python setup_scanner.py build_ext --inplace

Designed for scanning trees with millions of files efficiently.
"""

import os
import heapq
import stat as stat_module
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Tuple, Optional
from threading import Lock, local

# Try to import optional Cython extension
try:
    from scanner_core import scan_directory_fast as _scan_dir_cython
    HAS_CYTHON_EXTENSION = True
except ImportError:
    HAS_CYTHON_EXTENSION = False
    _scan_dir_cython = None


class FastScanner:
    """
    Parallel directory scanner optimized for large file trees.

    Uses thread pool to scan subdirectories concurrently, maintaining
    bottom-up aggregation semantics.
    """

    def __init__(self, max_workers: Optional[int] = None):
        """
        Initialize scanner with thread pool.

        Args:
            max_workers: Number of worker threads (None = CPU count * 2)
        """
        # Default to CPU count * 2 for I/O-bound work
        if max_workers is None:
            max_workers = (os.cpu_count() or 4) * 2

        self.max_workers = max_workers

        # Thread-safe data structures
        self.size_totals: Dict[str, int] = {}
        self.count_totals: Dict[str, int] = {}
        self.size_totals_lock = Lock()
        self.count_totals_lock = Lock()

        # Top files tracking (thread-safe)
        # Use a list to collect per-thread heaps, merged at the end
        self.thread_local_heaps: List[List[Tuple[int, str]]] = []
        self.thread_heaps_lock = Lock()
        self.heap_size_limit = 10

        # Thread-local storage for per-thread heap
        self.thread_local = local()

    def scan(self, root_path: str) -> Tuple[Dict[str, int], Dict[str, int], List[Tuple[int, str]]]:
        """
        Scan directory tree and return aggregated statistics.

        Args:
            root_path: Root directory to scan

        Returns:
            (size_totals, count_totals, top_files) where:
            - size_totals: dict mapping dirpath -> total bytes (recursive)
            - count_totals: dict mapping dirpath -> total file count (recursive)
            - top_files: list of (size, path) tuples for largest files
        """
        # Use ThreadPoolExecutor for parallel subdirectory scanning
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            self._scan_directory_recursive(root_path, executor)

        # Merge all thread-local heaps into final top files list
        # This is more efficient than locking on every file
        merged_heap: List[Tuple[int, str]] = []
        for thread_heap in self.thread_local_heaps:
            merged_heap.extend(thread_heap)

        # Get top N from merged heap
        top_files = heapq.nlargest(self.heap_size_limit, merged_heap) if merged_heap else []

        return self.size_totals, self.count_totals, top_files

    def _scan_directory_recursive(self, dirpath: str, executor: ThreadPoolExecutor) -> Tuple[int, int]:
        """
        Recursively scan a directory and its children using thread pool.

        Returns:
            (total_size, total_count) for this directory and all descendants
        """
        # Use Cython extension if available for maximum speed
        if HAS_CYTHON_EXTENSION:
            size_direct, count_direct, subdirs, files = _scan_dir_cython(dirpath)

            # Update top files with all files found
            update_top_files = self._update_top_files
            for file_size, file_path in files:
                update_top_files(file_size, file_path)

        else:
            # Pure Python fallback
            size_direct = 0
            count_direct = 0
            subdirs: List[str] = []

            # Local references to avoid repeated attribute lookups in hot loop
            update_top_files = self._update_top_files

            try:
                # Use os.scandir() for fast iteration
                # DirEntry objects cache stat info, avoiding redundant system calls
                with os.scandir(dirpath) as entries:
                    for entry in entries:
                        try:
                            # Fast path: entry.is_* methods use cached stat info
                            if entry.is_symlink():
                                continue

                            if entry.is_file(follow_symlinks=False):
                                # Get file size from cached stat
                                # Direct attribute access is faster than method call
                                stat_info = entry.stat(follow_symlinks=False)
                                file_size = stat_info.st_size

                                size_direct += file_size
                                count_direct += 1

                                # Update top files heap (thread-safe)
                                # Use local reference to avoid attribute lookup
                                update_top_files(file_size, entry.path)

                            elif entry.is_dir(follow_symlinks=False):
                                subdirs.append(entry.path)

                        except OSError:
                            # Skip unreadable entries
                            continue

            except OSError:
                # Directory unreadable - return what we have
                pass

        # Start totals with direct files
        size_total = size_direct
        count_total = count_direct

        # Scan subdirectories in parallel and aggregate results
        if subdirs:
            # For small numbers of subdirs, scan serially to avoid overhead
            # Threshold tuned for typical filesystem latency vs thread overhead
            if len(subdirs) <= 2:
                # Serial scan for small number of subdirs
                for subdir in subdirs:
                    sub_size, sub_count = self._scan_directory_recursive(subdir, executor)
                    size_total += sub_size
                    count_total += sub_count
            else:
                # Parallel scan for larger number of subdirs
                # Submit all subdirectory scans to thread pool
                futures = {
                    executor.submit(self._scan_directory_recursive, subdir, executor): subdir
                    for subdir in subdirs
                }

                # Collect results as they complete (most efficient order)
                for future in as_completed(futures):
                    try:
                        sub_size, sub_count = future.result()
                        size_total += sub_size
                        count_total += sub_count
                    except Exception:
                        # Subdirectory scan failed - skip it
                        continue

        # Store totals for this directory (thread-safe)
        # Combine lock operations to reduce overhead
        with self.size_totals_lock:
            self.size_totals[dirpath] = size_total
        with self.count_totals_lock:
            self.count_totals[dirpath] = count_total

        return size_total, count_total

    def _update_top_files(self, file_size: int, file_path: str):
        """
        Thread-safe update of top files using thread-local heaps.

        This avoids lock contention on every file by maintaining
        per-thread heaps that are merged at the end.
        """
        # Get or create thread-local heap
        try:
            thread_heap = self.thread_local.heap
        except AttributeError:
            # First time this thread is updating - create heap and register it
            thread_heap = []
            self.thread_local.heap = thread_heap

            # Register this thread's heap with the global list (only once per thread)
            with self.thread_heaps_lock:
                self.thread_local_heaps.append(thread_heap)

        # Update thread-local heap (no lock needed - thread-local)
        if len(thread_heap) < self.heap_size_limit:
            heapq.heappush(thread_heap, (file_size, file_path))
        elif file_size > thread_heap[0][0]:
            heapq.heapreplace(thread_heap, (file_size, file_path))


def scan_folders_fast(target_path: str, max_workers: Optional[int] = None) -> Tuple[Dict[str, int], Dict[str, int], List[Tuple[int, str]]]:
    """
    Fast parallel directory scanning.

    This is the main entry point for optimized scanning.

    Args:
        target_path: Root directory to scan
        max_workers: Number of worker threads (None = auto)

    Returns:
        (size_totals, count_totals, top_files) tuple
    """
    scanner = FastScanner(max_workers=max_workers)
    return scanner.scan(target_path)


def scan_folders_serial(target_path: str) -> Tuple[Dict[str, int], Dict[str, int], List[Tuple[int, str]]]:
    """
    Fallback: serial scanning using optimized os.scandir().

    Used when parallel scanning isn't beneficial (small trees) or
    for compatibility if threading issues arise.

    Args:
        target_path: Root directory to scan

    Returns:
        (size_totals, count_totals, top_files) tuple
    """
    size_totals: Dict[str, int] = {}
    count_totals: Dict[str, int] = {}
    top_files_heap: List[Tuple[int, str]] = []
    heap_size_limit = 10

    def scan_dir_serial(dirpath: str) -> Tuple[int, int]:
        """Recursively scan directory (bottom-up, serial)."""
        size_direct = 0
        count_direct = 0
        subdirs: List[str] = []

        try:
            with os.scandir(dirpath) as entries:
                for entry in entries:
                    try:
                        if entry.is_symlink():
                            continue

                        if entry.is_file(follow_symlinks=False):
                            stat_info = entry.stat(follow_symlinks=False)
                            file_size = stat_info.st_size

                            size_direct += file_size
                            count_direct += 1

                            # Update top files heap
                            if len(top_files_heap) < heap_size_limit:
                                heapq.heappush(top_files_heap, (file_size, entry.path))
                            elif file_size > top_files_heap[0][0]:
                                heapq.heapreplace(top_files_heap, (file_size, entry.path))

                        elif entry.is_dir(follow_symlinks=False):
                            subdirs.append(entry.path)

                    except OSError:
                        continue

        except OSError:
            pass

        # Start with direct files
        size_total = size_direct
        count_total = count_direct

        # Recursively scan subdirectories
        for subdir in subdirs:
            sub_size, sub_count = scan_dir_serial(subdir)
            size_total += sub_size
            count_total += sub_count

        # Store totals
        size_totals[dirpath] = size_total
        count_totals[dirpath] = count_total

        return size_total, count_total

    scan_dir_serial(target_path)

    # Convert heap to sorted list
    top_files = heapq.nlargest(heap_size_limit, top_files_heap)

    return size_totals, count_totals, top_files
