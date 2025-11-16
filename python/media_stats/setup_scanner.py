"""
Setup script for building the optional Cython extension.

Usage:
    python setup_scanner.py build_ext --inplace

This compiles scanner_core.pyx into a C extension for maximum performance.
The extension is optional - folder_stats.py works fine without it.
"""

import os
from setuptools import setup, Extension
try:
    from Cython.Build import cythonize
    HAS_CYTHON = True
except ImportError:
    HAS_CYTHON = False
    print("Cython not installed - skipping extension build")
    print("Install with: pip install cython")

if HAS_CYTHON:
    extensions = [
        Extension(
            "scanner_core",
            ["scanner_core.pyx"],
            extra_compile_args=["-O3", "-march=native"] if os.name != 'nt' else ["/O2"],
        )
    ]

    setup(
        name="folder_scanner_fast",
        ext_modules=cythonize(
            extensions,
            compiler_directives={
                'language_level': "3",
                'boundscheck': False,
                'wraparound': False,
                'cdivision': True,
            }
        ),
    )
else:
    setup(name="folder_scanner_fast")
