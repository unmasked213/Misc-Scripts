# cython: language_level=3
# cython: boundscheck=False
# cython: wraparound=False
# cython: cdivision=True
"""
Cython-optimized core scanning functions for maximum performance.

This module provides compiled versions of the hot-path scanning logic
for order-of-magnitude speedups on very large directory trees.

Compile with: python setup_scanner.py build_ext --inplace
"""

import os
from libc.stdint cimport int64_t
from cpython.ref cimport PyObject


cdef class FastDirScanner:
    """
    Cython-optimized directory scanner.

    Uses C-level operations for maximum speed on file iteration.
    """

    cdef public int64_t total_size
    cdef public int64_t total_count
    cdef public list subdirs
    cdef public list files_found

    def __init__(self):
        self.total_size = 0
        self.total_count = 0
        self.subdirs = []
        self.files_found = []

    cpdef scan_single_dir(self, str dirpath):
        """
        Scan a single directory (non-recursive) and collect stats.

        This is the hot path - heavily optimized with Cython.

        Returns:
            (size_direct, count_direct, subdirs, files)
        """
        cdef int64_t size_direct = 0
        cdef int64_t count_direct = 0
        cdef list subdirs = []
        cdef list files = []

        try:
            # Use os.scandir for fast iteration
            with os.scandir(dirpath) as entries:
                for entry in entries:
                    try:
                        # Skip symlinks
                        if entry.is_symlink():
                            continue

                        if entry.is_file(follow_symlinks=False):
                            # Get file size - stat is cached in DirEntry
                            stat_result = entry.stat(follow_symlinks=False)
                            file_size = stat_result.st_size

                            size_direct += file_size
                            count_direct += 1

                            # Collect file info for top-N tracking
                            files.append((file_size, entry.path))

                        elif entry.is_dir(follow_symlinks=False):
                            subdirs.append(entry.path)

                    except OSError:
                        # Skip unreadable entries
                        continue

        except OSError:
            # Directory unreadable
            pass

        return size_direct, count_direct, subdirs, files


def scan_directory_fast(str dirpath):
    """
    Fast single-directory scan using Cython.

    Args:
        dirpath: Directory to scan

    Returns:
        (size_direct, count_direct, subdirs, files) tuple
    """
    cdef FastDirScanner scanner = FastDirScanner()
    return scanner.scan_single_dir(dirpath)
