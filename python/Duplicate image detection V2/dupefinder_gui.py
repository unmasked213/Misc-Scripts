#!/usr/bin/env python3
"""
Duplicate Image Finder - GUI Application

A user-friendly graphical interface for finding and managing duplicate images.
This application guides users through the entire process from scanning to deletion
with an intuitive, modern dark-themed interface.

Features:
- Beautiful dark theme with smooth animations
- Responsive image scaling with zoom controls (Ctrl+Scroll)
- Keyboard shortcuts for quick navigation
- Real-time scanning progress with detailed status
- Visual comparison of duplicates with thumbnails
- Easy selection/deselection of files to keep or delete
- Batch operations for 100% matches
- Safe deletion to _dupes folder with undo capability
- No command line or technical knowledge required

Usage: python dupefinder_gui.py
       or double-click the file

Requirements: opencv-python-headless, numpy, pillow
              Install: pip install opencv-python-headless numpy pillow
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from tkinter.scrolledtext import ScrolledText
import threading
import json
import shutil
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from datetime import datetime
import sys
import os
import math
import subprocess
import platform

# Import dupefinder functions
try:
    from dupefinder import (
        DEFAULT_CFG, load_config, list_image_files, FingerprintCache,
        get_feature_detector, compute_fingerprint, file_id_from_path,
        load_image_normalized, build_thumbnail, assign_buckets, build_lsh_map,
        phash_similarity_scores, extract_keypoints, match_descriptors,
        estimate_transform_and_metrics, decide_label, build_clusters,
        PairDecision, PairMetrics, Cluster
    )
    import numpy as np
    from PIL import Image, ImageTk, ImageDraw
except ImportError as e:
    print(f"\n{'='*70}")
    print("ERROR: Missing required dependency")
    print(f"{'='*70}")
    print(f"\n{e}\n")
    print("Please install required packages:")
    print("  pip install opencv-python-headless numpy pillow")
    print(f"\n{'='*70}")
    input("\nPress Enter to exit...")
    sys.exit(1)


# Dark Theme Color Palette
class Colors:
    PRIMARY_BG = "#0B0E17"
    SECONDARY_BG = "#171923"
    BUTTON_BG = "#004152"
    SUCCESS = "#00A267"
    INFO = "#009ED3"
    ACCENT = "#1EABD0"
    DANGER = "#FF7164"
    WARNING = "#E8B100"
    PRIMARY_TEXT = "#E4E4F2"
    SECONDARY_TEXT = "#91939F"
    DISABLED_BG = "#2E3038"
    DISABLED_TEXT = "#FFFFFF"
    DIVIDER = "#454752"
    INPUT_BG = "#23252F"
    LOADER = "#E41695"


class AnimatedButton(tk.Canvas):
    """A rounded button with smooth hover animations."""

    def __init__(self, parent, text, command, bg=None, fg=None,
                 hover_bg=None, width=200, height=50, **kwargs):
        super().__init__(parent, width=width, height=height,
                        highlightthickness=0, bg=Colors.PRIMARY_BG, **kwargs)

        self.command = command
        self.bg = bg or Colors.BUTTON_BG
        self.fg = fg or Colors.PRIMARY_TEXT
        self.hover_bg = hover_bg or Colors.ACCENT
        self.text = text
        self.width = width
        self.height = height
        self.is_disabled = False
        self.hover_animation_id = None
        self.current_color = self.bg

        # Create pill-shaped button (fully rounded ends)
        corner_radius = height // 2  # Perfect pill shape
        self.rect = self._create_rounded_rect(0, 0, width, height, corner_radius, fill=self.bg)
        self.text_id = self.create_text(width//2, height//2, text=text, fill=fg,
                                       font=("Segoe UI", 11, "bold"))

        self.bind("<Enter>", self.on_enter)
        self.bind("<Leave>", self.on_leave)
        self.bind("<Button-1>", self.on_click)

    def _create_rounded_rect(self, x1, y1, x2, y2, radius, **kwargs):
        """Create a rounded rectangle."""
        points = [
            x1 + radius, y1,
            x2 - radius, y1,
            x2, y1,
            x2, y1 + radius,
            x2, y2 - radius,
            x2, y2,
            x2 - radius, y2,
            x1 + radius, y2,
            x1, y2,
            x1, y2 - radius,
            x1, y1 + radius,
            x1, y1
        ]
        return self.create_polygon(points, smooth=True, **kwargs)

    def _animate_color(self, start_color, end_color, step=0, steps=10):
        """Smoothly animate color transition."""
        if step > steps:
            return

        start_rgb = self._hex_to_rgb(start_color)
        end_rgb = self._hex_to_rgb(end_color)

        factor = step / steps
        current_rgb = tuple(
            int(start_rgb[i] + (end_rgb[i] - start_rgb[i]) * factor)
            for i in range(3)
        )
        current_hex = self._rgb_to_hex(current_rgb)

        self.itemconfig(self.rect, fill=current_hex)
        self.current_color = current_hex

        self.hover_animation_id = self.after(
            20, self._animate_color, start_color, end_color, step + 1, steps
        )

    def _hex_to_rgb(self, hex_color):
        hex_color = hex_color.lstrip('#')
        return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))

    def _rgb_to_hex(self, rgb):
        return '#{:02x}{:02x}{:02x}'.format(*rgb)

    def on_enter(self, e):
        if not self.is_disabled:
            if self.hover_animation_id:
                self.after_cancel(self.hover_animation_id)
            self._animate_color(self.current_color, self.hover_bg)
            self.config(cursor="hand2")

    def on_leave(self, e):
        if not self.is_disabled:
            if self.hover_animation_id:
                self.after_cancel(self.hover_animation_id)
            self._animate_color(self.current_color, self.bg)
            self.config(cursor="")

    def on_click(self, e):
        if not self.is_disabled and self.command:
            self.command()

    def set_state(self, state):
        """Set button state (normal or disabled)."""
        if state == "disabled":
            self.is_disabled = True
            self.itemconfig(self.rect, fill=Colors.DISABLED_BG)
            self.itemconfig(self.text_id, fill=Colors.DISABLED_TEXT)
            self.config(cursor="")
        else:
            self.is_disabled = False
            self.itemconfig(self.rect, fill=self.bg)
            self.itemconfig(self.text_id, fill=self.fg)


class WelcomeScreen(tk.Frame):
    """Initial welcome screen with folder selection."""

    def __init__(self, parent, controller):
        super().__init__(parent, bg=Colors.PRIMARY_BG)
        self.controller = controller

        container = tk.Frame(self, bg=Colors.PRIMARY_BG)
        container.place(relx=0.5, rely=0.5, anchor="center")

        header = tk.Label(container, text="Duplicate Image Finder",
                         font=("Segoe UI", 32, "bold"),
                         bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT)
        header.pack(pady=(0, 10))

        subtitle = tk.Label(container, text="Find and remove duplicate images with ease",
                           font=("Segoe UI", 13),
                           bg=Colors.PRIMARY_BG, fg=Colors.SECONDARY_TEXT)
        subtitle.pack(pady=(0, 60))

        folder_frame = tk.Frame(container, bg=Colors.PRIMARY_BG)
        folder_frame.pack(pady=20)

        tk.Label(folder_frame, text="Select folder to scan:",
                font=("Segoe UI", 12),
                bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT).pack(pady=(0, 15))

        input_container = tk.Canvas(folder_frame, width=500, height=60,
                                   bg=Colors.PRIMARY_BG, highlightthickness=0)
        input_container.pack()

        self._draw_rounded_rect(input_container, 0, 0, 500, 60, 30, Colors.INPUT_BG)

        self.path_var = tk.StringVar(value="No folder selected")
        path_label = tk.Label(input_container, textvariable=self.path_var,
                             font=("Segoe UI", 11),
                             bg=Colors.INPUT_BG, fg=Colors.SECONDARY_TEXT,
                             anchor="w")
        input_container.create_window(15, 30, window=path_label, anchor="w", width=350)

        browse_btn = AnimatedButton(input_container, "Browse...",
                                    command=self.browse_folder,
                                    bg=Colors.BUTTON_BG, hover_bg=Colors.ACCENT,
                                    width=110, height=40)
        input_container.create_window(485, 30, window=browse_btn, anchor="e")

        options_frame = tk.Frame(container, bg=Colors.PRIMARY_BG)
        options_frame.pack(pady=35)

        self.quick_mode_var = tk.BooleanVar(value=False)

        check_frame = tk.Frame(options_frame, bg=Colors.PRIMARY_BG)
        check_frame.pack()

        self.check_canvas = tk.Canvas(check_frame, width=24, height=24,
                                     bg=Colors.PRIMARY_BG, highlightthickness=0)
        self.check_canvas.pack(side=tk.LEFT, padx=(0, 10))
        self._draw_rounded_rect(self.check_canvas, 0, 0, 24, 24, 12, Colors.INPUT_BG)  # Half height for pill
        self.check_mark = None

        check_label = tk.Label(check_frame,
                              text="Quick mode (faster, less thorough)",
                              font=("Segoe UI", 11),
                              bg=Colors.PRIMARY_BG, fg=Colors.SECONDARY_TEXT,
                              cursor="hand2")
        check_label.pack(side=tk.LEFT)

        self.check_canvas.bind("<Button-1>", lambda e: self.toggle_quick_mode())
        check_label.bind("<Button-1>", lambda e: self.toggle_quick_mode())

        # Similarity threshold slider
        threshold_frame = tk.Frame(container, bg=Colors.PRIMARY_BG)
        threshold_frame.pack(pady=(30, 0))

        threshold_label = tk.Label(threshold_frame,
                                   text="Similarity threshold:",
                                   font=("Segoe UI", 11),
                                   bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT)
        threshold_label.pack(side=tk.LEFT, padx=(0, 15))

        self.threshold_var = tk.DoubleVar(value=0.85)  # Default 85%

        slider_container = tk.Frame(threshold_frame, bg=Colors.PRIMARY_BG)
        slider_container.pack(side=tk.LEFT)

        self.threshold_slider = tk.Scale(slider_container,
                                        from_=0.5, to=1.0,
                                        resolution=0.05,
                                        orient=tk.HORIZONTAL,
                                        variable=self.threshold_var,
                                        length=250,
                                        bg=Colors.INPUT_BG,
                                        fg=Colors.PRIMARY_TEXT,
                                        highlightthickness=0,
                                        troughcolor=Colors.SECONDARY_BG,
                                        activebackground=Colors.ACCENT,
                                        showvalue=0,
                                        command=self.update_threshold_label)
        self.threshold_slider.pack(side=tk.LEFT, padx=(0, 15))

        self.threshold_value_label = tk.Label(slider_container,
                                              text="85%",
                                              font=("Segoe UI", 11, "bold"),
                                              bg=Colors.PRIMARY_BG, fg=Colors.ACCENT,
                                              width=6)
        self.threshold_value_label.pack(side=tk.LEFT)

        hint_label = tk.Label(container,
                             text="Lower = more matches (may include false positives) • Higher = fewer matches (only very similar images)",
                             font=("Segoe UI", 9),
                             bg=Colors.PRIMARY_BG, fg=Colors.SECONDARY_TEXT)
        hint_label.pack(pady=(5, 0))

        self.start_btn = AnimatedButton(container, "Start Scanning",
                                       command=self.start_scan,
                                       bg=Colors.INFO, hover_bg=Colors.ACCENT,
                                       width=280, height=60)
        self.start_btn.pack(pady=40)
        self.start_btn.set_state("disabled")

        info = tk.Label(container,
                       text="This tool will find exact duplicates and similar images\n"
                            "Files are never deleted automatically - you choose what to remove",
                       font=("Segoe UI", 10),
                       bg=Colors.PRIMARY_BG, fg=Colors.SECONDARY_TEXT,
                       justify=tk.CENTER)
        info.pack(pady=20)

    def _draw_rounded_rect(self, canvas, x1, y1, x2, y2, radius, fill):
        points = [
            x1 + radius, y1,
            x2 - radius, y1,
            x2, y1,
            x2, y1 + radius,
            x2, y2 - radius,
            x2, y2,
            x2 - radius, y2,
            x1 + radius, y2,
            x1, y2,
            x1, y2 - radius,
            x1, y1 + radius,
            x1, y1
        ]
        canvas.create_polygon(points, smooth=True, fill=fill, outline="")

    def update_threshold_label(self, value):
        """Update the threshold percentage label."""
        percentage = int(float(value) * 100)
        self.threshold_value_label.config(text=f"{percentage}%")

    def toggle_quick_mode(self):
        current = self.quick_mode_var.get()
        self.quick_mode_var.set(not current)

        if self.check_mark:
            self.check_canvas.delete(self.check_mark)
            self.check_mark = None

        if not current:
            self.check_canvas.itemconfig(1, fill=Colors.INFO)
            self.check_mark = self.check_canvas.create_text(12, 12,
                                                           text="✓",
                                                           fill=Colors.PRIMARY_TEXT,
                                                           font=("Segoe UI", 14, "bold"))
        else:
            self.check_canvas.itemconfig(1, fill=Colors.INPUT_BG)

    def browse_folder(self):
        folder = filedialog.askdirectory(title="Select folder to scan for duplicates")
        if folder:
            self.path_var.set(folder)
            self.controller.input_folder = Path(folder)
            self.start_btn.set_state("normal")

    def start_scan(self):
        if self.controller.input_folder:
            self.controller.quick_mode = self.quick_mode_var.get()
            self.controller.similarity_threshold = self.threshold_var.get()
            self.controller.show_frame("ScanningScreen")
            threading.Thread(target=self.controller.run_scan, daemon=True).start()


class LoadingDots(tk.Canvas):
    """Animated loading dots indicator."""

    def __init__(self, parent, **kwargs):
        super().__init__(parent, width=100, height=24,
                        bg=Colors.PRIMARY_BG, highlightthickness=0, **kwargs)

        self.dots = []
        for i in range(4):
            x = 10 + i * 25
            dot = self.create_oval(x-6, 9, x+6, 21, fill=Colors.LOADER, outline="")
            self.dots.append((dot, x, 0))

        self.animating = False

    def start(self):
        self.animating = True
        self._animate(0)

    def stop(self):
        self.animating = False

    def _animate(self, step):
        if not self.animating:
            return

        for idx, (dot, x, phase) in enumerate(self.dots):
            # Calculate scale based on animation phase
            t = (step + idx * 5) % 30
            if t < 15:
                scale = 0.3 + (t / 15) * 0.7  # Grow
            else:
                scale = 1.0 - ((t - 15) / 15) * 0.7  # Shrink

            r = 3 + scale * 3
            self.coords(dot, x - r, 12 - r, x + r, 12 + r)

        self.after(50, self._animate, step + 1)


class ScanningScreen(tk.Frame):
    """Progress screen showing scanning status with animations."""

    def __init__(self, parent, controller):
        super().__init__(parent, bg=Colors.PRIMARY_BG)
        self.controller = controller

        container = tk.Frame(self, bg=Colors.PRIMARY_BG)
        container.place(relx=0.5, rely=0.5, anchor="center")

        header = tk.Label(container, text="Scanning for duplicates...",
                         font=("Segoe UI", 28, "bold"),
                         bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT)
        header.pack(pady=(0, 30))

        # Animated loading dots
        self.loading_dots = LoadingDots(container)
        self.loading_dots.pack(pady=20)

        self.status_var = tk.StringVar(value="Initializing...")
        status_label = tk.Label(container, textvariable=self.status_var,
                               font=("Segoe UI", 12),
                               bg=Colors.PRIMARY_BG, fg=Colors.SECONDARY_TEXT)
        status_label.pack(pady=15)

        detail_container = tk.Frame(container, bg=Colors.PRIMARY_BG)
        detail_container.pack(pady=30, fill=tk.BOTH, expand=True)

        tk.Label(detail_container, text="Progress Details:",
                font=("Segoe UI", 11, "bold"),
                bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT,
                anchor="w").pack(fill=tk.X, pady=(0, 10))

        text_frame = tk.Frame(detail_container, bg=Colors.SECONDARY_BG)
        text_frame.pack(fill=tk.BOTH, expand=True)

        self.details_text = ScrolledText(text_frame, height=12, width=75,
                                        font=("Consolas", 10),
                                        bg=Colors.SECONDARY_BG,
                                        fg=Colors.PRIMARY_TEXT,
                                        insertbackground=Colors.PRIMARY_TEXT,
                                        relief=tk.FLAT, borderwidth=10,
                                        selectbackground=Colors.BUTTON_BG,
                                        selectforeground=Colors.PRIMARY_TEXT)
        self.details_text.pack(fill=tk.BOTH, expand=True)

        # Add a Back button
        button_frame = tk.Frame(container, bg=Colors.PRIMARY_BG)
        button_frame.pack(pady=20)

        self.back_btn = AnimatedButton(button_frame, "← Back to Start",
                                       command=self.go_back,
                                       bg=Colors.BUTTON_BG, hover_bg=Colors.ACCENT,
                                       width=180, height=50)
        self.back_btn.pack()

    def go_back(self):
        """Return to welcome screen."""
        self.controller.show_frame("WelcomeScreen")

    def start_progress(self):
        self.loading_dots.start()

    def stop_progress(self):
        self.loading_dots.stop()

    def update_status(self, message):
        self.status_var.set(message)

    def add_detail(self, message):
        self.details_text.insert(tk.END, message + "\n")
        self.details_text.see(tk.END)
        self.details_text.update()


class ResultsScreen(tk.Frame):
    """Main results screen showing duplicate clusters with responsive scaling."""

    def __init__(self, parent, controller):
        super().__init__(parent, bg=Colors.PRIMARY_BG)
        self.controller = controller
        self.current_cluster_idx = 0
        self.marked_for_deletion = set()
        self.thumbnail_cache = {}
        self.image_widgets = []
        self.text_widgets = []  # Track text widgets for zoom
        self.zoom_level = 1.0

        # Header bar
        header_frame = tk.Frame(self, bg=Colors.INFO, height=80)
        header_frame.pack(fill=tk.X)
        header_frame.pack_propagate(False)

        title = tk.Label(header_frame, text="Review Duplicates",
                        font=("Segoe UI", 24, "bold"),
                        bg=Colors.INFO, fg=Colors.PRIMARY_TEXT)
        title.pack(side=tk.LEFT, padx=40, pady=20)

        stats_container = tk.Canvas(header_frame, width=320, height=50,
                                   bg=Colors.INFO, highlightthickness=0)
        stats_container.pack(side=tk.RIGHT, padx=40, pady=15)

        self._draw_rounded_rect(stats_container, 0, 0, 320, 50, 25, Colors.ACCENT)  # Pill shaped

        self.stats_var = tk.StringVar(value="0 clusters | 0 files marked")
        stats_label = tk.Label(stats_container, textvariable=self.stats_var,
                              font=("Segoe UI", 10, "bold"),
                              bg=Colors.ACCENT, fg=Colors.PRIMARY_TEXT)
        stats_container.create_window(160, 25, window=stats_label)

        # Main content area
        content_frame = tk.Frame(self, bg=Colors.PRIMARY_BG)
        content_frame.pack(fill=tk.BOTH, expand=True, padx=30, pady=20)

        # Navigation and actions in one row
        controls_frame = tk.Frame(content_frame, bg=Colors.PRIMARY_BG)
        controls_frame.pack(fill=tk.X, pady=(0, 25))

        # Left side: Navigation
        nav_frame = tk.Frame(controls_frame, bg=Colors.PRIMARY_BG)
        nav_frame.pack(side=tk.LEFT)

        self.prev_btn = AnimatedButton(nav_frame, "← Previous",
                                       command=self.prev_cluster,
                                       bg=Colors.BUTTON_BG, hover_bg=Colors.ACCENT,
                                       width=130, height=45)
        self.prev_btn.pack(side=tk.LEFT, padx=(0, 15))

        self.cluster_label_var = tk.StringVar(value="Cluster 1 of 0")
        tk.Label(nav_frame, textvariable=self.cluster_label_var,
                font=("Segoe UI", 13, "bold"),
                bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT).pack(side=tk.LEFT, padx=(0, 15))

        self.next_btn = AnimatedButton(nav_frame, "Next →",
                                       command=self.next_cluster,
                                       bg=Colors.BUTTON_BG, hover_bg=Colors.ACCENT,
                                       width=130, height=45)
        self.next_btn.pack(side=tk.LEFT)

        # Right side: Action buttons
        action_frame = tk.Frame(controls_frame, bg=Colors.PRIMARY_BG)
        action_frame.pack(side=tk.RIGHT)

        AnimatedButton(action_frame, "Keep Largest",
                      command=self.auto_select_keep_largest,
                      bg=Colors.SUCCESS, hover_bg="#00C278",
                      width=140, height=45).pack(side=tk.LEFT, padx=5)

        AnimatedButton(action_frame, "Keep Largest (All 100%)",
                      command=self.batch_keep_largest_perfect,
                      bg=Colors.ACCENT, hover_bg="#3BC5E8",
                      width=200, height=45).pack(side=tk.LEFT, padx=5)

        AnimatedButton(action_frame, "Clear All",
                      command=self.clear_selections,
                      bg=Colors.DISABLED_BG, hover_bg=Colors.DIVIDER,
                      width=120, height=45).pack(side=tk.LEFT, padx=5)

        AnimatedButton(action_frame, "Delete Selected",
                      command=self.delete_marked,
                      bg=Colors.DANGER, hover_bg="#FF8A7F",
                      width=160, height=45).pack(side=tk.LEFT, padx=5)

        # Instructions
        instructions = tk.Label(content_frame,
                               text="Click images to mark • Arrow keys to navigate • Ctrl+Scroll to zoom • Undo available after deletion",
                               font=("Segoe UI", 10),
                               bg=Colors.PRIMARY_BG, fg=Colors.SECONDARY_TEXT)
        instructions.pack(pady=(0, 15))

        # Scrollable image grid
        canvas_frame = tk.Frame(content_frame, bg=Colors.PRIMARY_BG)
        canvas_frame.pack(fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(canvas_frame, bg=Colors.PRIMARY_BG, highlightthickness=0)
        scrollbar_frame = tk.Frame(canvas_frame, bg=Colors.DIVIDER, width=12)

        self.image_frame = tk.Frame(self.canvas, bg=Colors.PRIMARY_BG)
        self.canvas_window = self.canvas.create_window((0, 0), window=self.image_frame, anchor="nw")

        style = ttk.Style()
        style.theme_use('default')
        style.configure("Vertical.TScrollbar",
                       background=Colors.SECONDARY_BG,
                       troughcolor=Colors.PRIMARY_BG,
                       bordercolor=Colors.PRIMARY_BG,
                       arrowcolor=Colors.PRIMARY_TEXT,
                       relief=tk.FLAT)

        scrollbar = ttk.Scrollbar(scrollbar_frame, orient=tk.VERTICAL,
                                 command=self.canvas.yview, style="Vertical.TScrollbar")

        self.canvas.configure(yscrollcommand=scrollbar.set)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar_frame.pack(side=tk.RIGHT, fill=tk.Y)
        scrollbar.pack(fill=tk.Y, expand=True)

        # Bind events
        self.canvas.bind("<Configure>", self.on_canvas_resize)
        self.image_frame.bind("<Configure>",
                             lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))

        # Keyboard shortcuts
        self.bind_all("<Left>", lambda e: self.prev_cluster())
        self.bind_all("<Right>", lambda e: self.next_cluster())
        self.bind_all("<Control-MouseWheel>", self.on_zoom)
        self.canvas.bind_all("<MouseWheel>", self._on_mousewheel)

        # Bottom bar
        bottom_frame = tk.Frame(self, bg=Colors.SECONDARY_BG, height=70)
        bottom_frame.pack(fill=tk.X, side=tk.BOTTOM)
        bottom_frame.pack_propagate(False)

        btn_container = tk.Frame(bottom_frame, bg=Colors.SECONDARY_BG)
        btn_container.pack(expand=True, pady=15)

        self.undo_btn = AnimatedButton(btn_container, "Undo Last Deletion",
                                       command=self.undo_deletion,
                                       bg=Colors.INFO, hover_bg=Colors.ACCENT,
                                       width=180, height=45)
        self.undo_btn.pack(side=tk.LEFT, padx=10)
        self.undo_btn.set_state("disabled")

        AnimatedButton(btn_container, "Start Over",
                      command=self.start_over,
                      bg=Colors.WARNING, hover_bg="#F0C020",
                      width=150, height=45).pack(side=tk.LEFT, padx=10)

    def _draw_rounded_rect(self, canvas, x1, y1, x2, y2, radius, fill):
        points = [
            x1 + radius, y1,
            x2 - radius, y1,
            x2, y1,
            x2, y1 + radius,
            x2, y2 - radius,
            x2, y2,
            x2 - radius, y2,
            x1 + radius, y2,
            x1, y2,
            x1, y2 - radius,
            x1, y1 + radius,
            x1, y1
        ]
        return canvas.create_polygon(points, smooth=True, fill=fill, outline="")

    def on_canvas_resize(self, event):
        if hasattr(self, 'clusters') and self.clusters:
            self.show_current_cluster()

    def on_zoom(self, event):
        """Handle Ctrl+MouseWheel zoom."""
        if event.delta > 0:
            self.zoom_level = min(2.0, self.zoom_level * 1.1)
        else:
            self.zoom_level = max(0.5, self.zoom_level / 1.1)
        self.show_current_cluster()

    def _on_mousewheel(self, event):
        self.canvas.yview_scroll(int(-1*(event.delta/120)), "units")

    def _calculate_thumbnail_size(self):
        canvas_width = self.canvas.winfo_width()
        if canvas_width < 100:
            return int(300 * self.zoom_level)

        padding = 60
        size = (canvas_width - padding) // 3 - 40
        size = max(200, min(500, size))

        return int(size * self.zoom_level)

    def _format_date(self, timestamp):
        """Format timestamp to natural shorthand."""
        dt = datetime.fromtimestamp(timestamp)
        now = datetime.now()
        delta = now - dt

        if delta.days == 0:
            return "Today"
        elif delta.days == 1:
            return "Yesterday"
        elif delta.days < 7:
            return f"{delta.days}d ago"
        elif delta.days < 30:
            weeks = delta.days // 7
            return f"{weeks}w ago"
        elif delta.days < 365:
            months = delta.days // 30
            return f"{months}mo ago"
        else:
            years = delta.days // 365
            return f"{years}y ago"

    def load_results(self, clusters):
        self.clusters = clusters
        self.current_cluster_idx = 0
        self.marked_for_deletion = set()
        self.update_stats()
        self.show_current_cluster()

    def show_current_cluster(self):
        if not self.clusters:
            return

        for widget in self.image_frame.winfo_children():
            widget.destroy()
        self.image_widgets = []
        self.text_widgets = []

        cluster = self.clusters[self.current_cluster_idx]
        self.cluster_label_var.set(
            f"Cluster {self.current_cluster_idx + 1} of {len(self.clusters)}"
        )

        thumb_size = self._calculate_thumbnail_size()

        col = 0
        row = 0
        max_cols = 3

        for idx, img_path in enumerate(cluster.members):
            if not img_path.exists():
                continue

            try:
                img = Image.open(img_path)
                original_size = img.size
                img.thumbnail((thumb_size, thumb_size), Image.Resampling.LANCZOS)
                photo = ImageTk.PhotoImage(img)
                cache_key = f"{img_path}_{thumb_size}"
                self.thumbnail_cache[cache_key] = photo
            except Exception as e:
                print(f"Error loading {img_path}: {e}")
                continue

            container = tk.Frame(self.image_frame, bg=Colors.PRIMARY_BG,
                               padx=15, pady=15)
            container.grid(row=row, column=col, sticky="nsew")

            is_rep = (img_path == cluster.representative)
            is_marked = (img_path in self.marked_for_deletion)

            if is_marked:
                border_color = Colors.DANGER
                border_width = 5
            elif is_rep:
                border_color = Colors.INFO
                border_width = 4
            else:
                border_color = Colors.DIVIDER
                border_width = 2

            img_canvas = tk.Canvas(container, width=thumb_size + border_width*2,
                                 height=thumb_size + border_width*2,
                                 bg=Colors.PRIMARY_BG, highlightthickness=0,
                                 cursor="hand2")
            img_canvas.pack()

            # Very rounded corners for modern look
            corner_radius = 30
            self._draw_rounded_rect(img_canvas, 0, 0,
                                   thumb_size + border_width*2,
                                   thumb_size + border_width*2,
                                   corner_radius, border_color)

            self._draw_rounded_rect(img_canvas, border_width, border_width,
                                   thumb_size + border_width,
                                   thumb_size + border_width,
                                   corner_radius - border_width, Colors.SECONDARY_BG)

            img_id = img_canvas.create_image(
                border_width + thumb_size//2,
                border_width + thumb_size//2,
                image=photo
            )

            img_canvas.tag_bind(img_id, "<Button-1>",
                              lambda e, p=img_path: self.toggle_mark(p))
            img_canvas.bind("<Button-1>",
                          lambda e, p=img_path: self.toggle_mark(p))

            # Right-click context menu
            img_canvas.tag_bind(img_id, "<Button-3>",
                              lambda e, p=img_path, c=img_canvas: self.show_context_menu(e, p, c))
            img_canvas.bind("<Button-3>",
                          lambda e, p=img_path, c=img_canvas: self.show_context_menu(e, p, c))

            self.image_widgets.append((img_canvas, img_path, photo))

            # Info labels
            info_frame = tk.Frame(container, bg=Colors.PRIMARY_BG)
            info_frame.pack(fill=tk.X, pady=(10, 0))

            name_label = tk.Label(info_frame, text=img_path.name,
                                 font=("Segoe UI", int(9 * self.zoom_level)),
                                 bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT,
                                 wraplength=thumb_size)
            name_label.pack()
            self.text_widgets.append((name_label, 9))  # Track with base size

            try:
                stat = img_path.stat()
                size_mb = stat.st_size / (1024 * 1024)
                sim = cluster.member_similarities.get(str(img_path), 1.0) * 100
                modified = self._format_date(stat.st_mtime)

                details = f"{original_size[0]}×{original_size[1]} | {size_mb:.2f} MB | {int(sim)}% match"
                if is_rep:
                    details += " | REFERENCE"

                detail_color = Colors.INFO if is_rep else Colors.SECONDARY_TEXT
                detail_label = tk.Label(info_frame, text=details,
                                       font=("Segoe UI", int(8 * self.zoom_level)),
                                       bg=Colors.PRIMARY_BG,
                                       fg=detail_color)
                detail_label.pack()
                self.text_widgets.append((detail_label, 8))  # Track with base size

                # Date label
                date_label = tk.Label(info_frame, text=f"Modified: {modified}",
                                     font=("Segoe UI", int(8 * self.zoom_level)),
                                     bg=Colors.PRIMARY_BG,
                                     fg=Colors.SECONDARY_TEXT)
                date_label.pack()
                self.text_widgets.append((date_label, 8))  # Track with base size
            except:
                pass

            col += 1
            if col >= max_cols:
                col = 0
                row += 1

        self.image_frame.update_idletasks()
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        self.canvas.yview_moveto(0)

    def toggle_mark(self, path):
        if path in self.marked_for_deletion:
            self.marked_for_deletion.remove(path)
        else:
            self.marked_for_deletion.add(path)
        self.update_stats()
        self.show_current_cluster()

    def show_context_menu(self, event, img_path, canvas):
        """Show right-click context menu for an image."""
        menu = tk.Menu(self, tearoff=0, bg=Colors.SECONDARY_BG, fg=Colors.PRIMARY_TEXT,
                      activebackground=Colors.ACCENT, activeforeground=Colors.PRIMARY_TEXT,
                      font=("Segoe UI", 10))

        menu.add_command(label="Delete this image only",
                        command=lambda: self.delete_single_image(img_path))
        menu.add_separator()
        menu.add_command(label="Open containing folder",
                        command=lambda: self.open_containing_folder(img_path))
        menu.add_command(label="Edit with default application",
                        command=lambda: self.edit_with_default_app(img_path))
        menu.add_separator()
        menu.add_command(label="Copy image to clipboard",
                        command=lambda: self.copy_to_clipboard(img_path))

        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def delete_single_image(self, img_path):
        """Delete a single image immediately."""
        response = messagebox.askyesno(
            "Delete Single Image",
            f"Move this file to _dupes folder?\n\n{img_path.name}",
            parent=self
        )

        if response:
            # Create _dupes folder in the scanned directory
            if self.controller.input_folder:
                dupes_dir = self.controller.input_folder / "_dupes"
            else:
                dupes_dir = Path("_dupes")

            dupes_dir.mkdir(exist_ok=True)

            try:
                # Generate unique destination filename
                dest = dupes_dir / img_path.name
                if dest.exists():
                    stem = img_path.stem
                    suffix = img_path.suffix
                    counter = 1
                    dest = dupes_dir / f"{stem}_{counter}{suffix}"
                    while dest.exists():
                        counter += 1
                        dest = dupes_dir / f"{stem}_{counter}{suffix}"

                # Move the file
                shutil.move(str(img_path), str(dest))

                # Track for undo
                deletion_record = [(img_path, dest)]
                self.controller.deletion_history.append(deletion_record)
                self.undo_btn.set_state("normal")

                # Remove from marked list if present
                if img_path in self.marked_for_deletion:
                    self.marked_for_deletion.remove(img_path)

                # Refresh display
                self.update_stats()
                self.show_current_cluster()

                messagebox.showinfo("Success", f"Moved to {dupes_dir}", parent=self)

            except Exception as e:
                messagebox.showerror("Error", f"Failed to move file:\n{e}", parent=self)

    def open_containing_folder(self, img_path):
        """Open the folder containing the image in file explorer."""
        try:
            folder = img_path.parent
            if platform.system() == "Windows":
                # Open and select the file
                subprocess.run(['explorer', '/select,', str(img_path)])
            elif platform.system() == "Darwin":  # macOS
                subprocess.run(['open', '-R', str(img_path)])
            else:  # Linux
                subprocess.run(['xdg-open', str(folder)])
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open folder:\n{e}", parent=self)

    def edit_with_default_app(self, img_path):
        """Open the image with its default application."""
        try:
            if platform.system() == "Windows":
                os.startfile(str(img_path))
            elif platform.system() == "Darwin":  # macOS
                subprocess.run(['open', str(img_path)])
            else:  # Linux
                subprocess.run(['xdg-open', str(img_path)])
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open image:\n{e}", parent=self)

    def copy_to_clipboard(self, img_path):
        """Copy the image to clipboard."""
        try:
            from PIL import Image
            import io

            # Load the image
            img = Image.open(img_path)

            # On Windows, use win32clipboard
            if platform.system() == "Windows":
                try:
                    import win32clipboard
                    from io import BytesIO

                    # Convert to BMP for clipboard
                    output = BytesIO()
                    img.convert("RGB").save(output, "BMP")
                    data = output.getvalue()[14:]  # Remove BMP header
                    output.close()

                    win32clipboard.OpenClipboard()
                    win32clipboard.EmptyClipboard()
                    win32clipboard.SetClipboardData(win32clipboard.CF_DIB, data)
                    win32clipboard.CloseClipboard()

                    messagebox.showinfo("Success", "Image copied to clipboard!", parent=self)
                except ImportError:
                    messagebox.showwarning(
                        "Feature Unavailable",
                        "Clipboard copy requires 'pywin32' package.\n\n"
                        "Install with: pip install pywin32",
                        parent=self
                    )
            else:
                messagebox.showwarning(
                    "Feature Unavailable",
                    "Clipboard copy is currently only supported on Windows.",
                    parent=self
                )

        except Exception as e:
            messagebox.showerror("Error", f"Failed to copy image:\n{e}", parent=self)

    def update_stats(self):
        total_clusters = len(self.clusters) if self.clusters else 0
        marked_count = len(self.marked_for_deletion)
        self.stats_var.set(f"{total_clusters} clusters | {marked_count} files marked")

    def next_cluster(self):
        if self.clusters and self.current_cluster_idx < len(self.clusters) - 1:
            self.current_cluster_idx += 1
            self.show_current_cluster()

    def prev_cluster(self):
        if self.clusters and self.current_cluster_idx > 0:
            self.current_cluster_idx -= 1
            self.show_current_cluster()

    def clear_selections(self):
        self.marked_for_deletion.clear()
        self.update_stats()
        self.show_current_cluster()

    def auto_select_keep_largest(self):
        """Keep largest in current cluster."""
        if not self.clusters:
            return

        cluster = self.clusters[self.current_cluster_idx]

        largest = None
        largest_size = 0
        for path in cluster.members:
            try:
                size = path.stat().st_size
                if size > largest_size:
                    largest_size = size
                    largest = path
            except:
                continue

        for path in cluster.members:
            if path != largest and path not in self.marked_for_deletion:
                self.marked_for_deletion.add(path)

        self.update_stats()
        self.show_current_cluster()

    def batch_keep_largest_perfect(self):
        """Keep largest for all clusters with 100% matches."""
        if not self.clusters:
            return

        count = 0
        for cluster in self.clusters:
            # Check if cluster has 100% matches
            has_perfect = any(
                cluster.member_similarities.get(str(p), 0.0) >= 0.995
                for p in cluster.members
            )

            if has_perfect:
                largest = None
                largest_size = 0
                for path in cluster.members:
                    try:
                        size = path.stat().st_size
                        if size > largest_size:
                            largest_size = size
                            largest = path
                    except:
                        continue

                for path in cluster.members:
                    if path != largest and path not in self.marked_for_deletion:
                        self.marked_for_deletion.add(path)
                        count += 1

        self.update_stats()
        self.show_current_cluster()

    def delete_marked(self):
        if not self.marked_for_deletion:
            messagebox.showinfo("No Files Selected",
                              "Please mark files for deletion first by clicking on them.",
                              parent=self)
            return

        count = len(self.marked_for_deletion)
        response = messagebox.askyesno(
            "Confirm Deletion",
            f"Move {count} file(s) to _dupes folder?\n\n"
            "Files will be moved to '_dupes' folder and can be recovered if needed.",
            parent=self
        )

        if response:
            self.controller.show_frame("DeletionScreen")
            threading.Thread(target=self.controller.delete_files,
                           args=(list(self.marked_for_deletion),),
                           daemon=True).start()

    def undo_deletion(self):
        """Undo the last deletion operation."""
        if not self.controller.deletion_history:
            messagebox.showinfo("Nothing to Undo",
                              "No recent deletions to undo.",
                              parent=self)
            return

        last_deletion = self.controller.deletion_history[-1]
        restored = 0
        failed = []

        for original_path, dupes_path in last_deletion:
            try:
                if dupes_path.exists():
                    # Move file back from _dupes to original location
                    shutil.move(str(dupes_path), str(original_path))
                    restored += 1
                else:
                    failed.append((original_path, "File not found in _dupes folder"))
            except Exception as e:
                failed.append((original_path, str(e)))

        # Remove this deletion from history
        self.controller.deletion_history.pop()

        # Update undo button state
        if not self.controller.deletion_history:
            self.undo_btn.set_state("disabled")

        # Refresh the current view
        self.show_current_cluster()

        # Show results
        if failed:
            messagebox.showwarning(
                "Undo Complete with Errors",
                f"Restored {restored} files.\n\n"
                f"Failed to restore {len(failed)} files.",
                parent=self
            )
        else:
            messagebox.showinfo(
                "Undo Complete",
                f"Successfully restored {restored} files to their original locations.",
                parent=self
            )

    def start_over(self):
        response = messagebox.askyesno(
            "Start Over",
            "Return to the welcome screen?\n\nAny unsaved selections will be lost.",
            parent=self
        )
        if response:
            self.marked_for_deletion.clear()
            self.clusters = []
            self.controller.show_frame("WelcomeScreen")


class DeletionScreen(tk.Frame):
    """Screen showing deletion progress with smooth animations."""

    def __init__(self, parent, controller):
        super().__init__(parent, bg=Colors.PRIMARY_BG)
        self.controller = controller

        container = tk.Frame(self, bg=Colors.PRIMARY_BG)
        container.place(relx=0.5, rely=0.5, anchor="center")

        header = tk.Label(container, text="Moving files to _dupes folder...",
                         font=("Segoe UI", 28, "bold"),
                         bg=Colors.PRIMARY_BG, fg=Colors.PRIMARY_TEXT)
        header.pack(pady=(0, 50))

        progress_container = tk.Frame(container, bg=Colors.PRIMARY_BG)
        progress_container.pack(pady=20)

        self.progress_canvas = tk.Canvas(progress_container, width=600, height=16,
                                        bg=Colors.PRIMARY_BG, highlightthickness=0)
        self.progress_canvas.pack()

        self._draw_rounded_rect(self.progress_canvas, 0, 0, 600, 16, 8, Colors.INPUT_BG)  # Pill shaped

        self.progress_fill = self._draw_rounded_rect(
            self.progress_canvas, 0, 0, 1, 16, 8, Colors.SUCCESS  # Pill shaped
        )

        self.progress_text = self.progress_canvas.create_text(
            300, 8, text="0%", fill=Colors.PRIMARY_TEXT,
            font=("Segoe UI", 10, "bold")
        )

        self.status_var = tk.StringVar(value="Starting...")
        status_label = tk.Label(container, textvariable=self.status_var,
                               font=("Segoe UI", 12),
                               bg=Colors.PRIMARY_BG, fg=Colors.SECONDARY_TEXT)
        status_label.pack(pady=20)

        # Button container for Done and Undo buttons
        self.button_frame = tk.Frame(container, bg=Colors.PRIMARY_BG)
        self.button_frame.pack(pady=30)
        self.button_frame.pack_forget()

        self.undo_btn = AnimatedButton(self.button_frame, "Undo",
                                       command=self.undo_deletion,
                                       bg=Colors.INFO, hover_bg=Colors.ACCENT,
                                       width=140, height=55)
        self.undo_btn.pack(side=tk.LEFT, padx=10)

        self.done_btn = AnimatedButton(self.button_frame, "Done",
                                       command=self.finish,
                                       bg=Colors.SUCCESS, hover_bg="#00C278",
                                       width=140, height=55)
        self.done_btn.pack(side=tk.LEFT, padx=10)

    def _draw_rounded_rect(self, canvas, x1, y1, x2, y2, radius, fill):
        points = [
            x1 + radius, y1,
            x2 - radius, y1,
            x2, y1,
            x2, y1 + radius,
            x2, y2 - radius,
            x2, y2,
            x2 - radius, y2,
            x1 + radius, y2,
            x1, y2,
            x1, y2 - radius,
            x1, y1 + radius,
            x1, y1
        ]
        return canvas.create_polygon(points, smooth=True, fill=fill, outline="")

    def update_progress(self, current, total, filename):
        progress_pct = (current / total) * 100 if total > 0 else 0

        new_width = int((600 * progress_pct) / 100)
        self.progress_canvas.coords(self.progress_fill, 0, 0, new_width, 16)
        self.progress_canvas.itemconfig(self.progress_text,
                                       text=f"{int(progress_pct)}%")

        display_name = filename if len(filename) < 50 else filename[:47] + "..."
        self.status_var.set(f"Moving {current}/{total}: {display_name}")
        self.update()

    def show_complete(self, moved_count, dupes_dir):
        self.status_var.set(f"✓ Complete! Moved {moved_count} files to {dupes_dir}")
        self.button_frame.pack(pady=30)

    def undo_deletion(self):
        """Undo the deletion that just occurred."""
        # Hide the buttons
        self.button_frame.pack_forget()

        # Call the results screen's undo method
        results_screen = self.controller.frames["ResultsScreen"]
        results_screen.undo_deletion()

        # Go back to results screen
        self.controller.show_frame("ResultsScreen")

    def finish(self):
        self.button_frame.pack_forget()
        self.controller.show_frame("WelcomeScreen")


class DupeFinderApp(tk.Tk):
    """Main application controller with dark theme."""

    def __init__(self):
        super().__init__()

        self.title("Duplicate Image Finder")
        self.geometry("1200x800")
        self.configure(bg=Colors.PRIMARY_BG)
        self.minsize(900, 600)

        self.option_add('*Dialog.msg.font', 'Segoe UI 10')

        self.input_folder = None
        self.quick_mode = False
        self.similarity_threshold = 0.85  # Default threshold
        self.clusters = []
        self.deletion_history = []  # Track deletions for undo

        container = tk.Frame(self, bg=Colors.PRIMARY_BG)
        container.pack(fill=tk.BOTH, expand=True)

        self.frames = {}
        for F in (WelcomeScreen, ScanningScreen, ResultsScreen, DeletionScreen):
            frame = F(container, self)
            self.frames[F.__name__] = frame
            frame.place(relx=0, rely=0, relwidth=1, relheight=1)

        self.show_frame("WelcomeScreen")

    def show_frame(self, frame_name):
        frame = self.frames[frame_name]
        frame.tkraise()

    def run_scan(self):
        """Run the duplicate detection scan in background."""
        print(f"\n{'='*70}")
        print("STARTING SCAN")
        print(f"{'='*70}")
        print(f"Input folder: {self.input_folder}")
        print(f"Quick mode: {self.quick_mode}")
        print(f"Similarity threshold: {self.similarity_threshold}")
        print(f"{'='*70}\n")

        scanning_screen = self.frames["ScanningScreen"]
        scanning_screen.start_progress()

        try:
            scanning_screen.update_status("Loading configuration...")
            scanning_screen.add_detail("Initializing duplicate detection engine...")
            scanning_screen.add_detail(f"Input folder: {self.input_folder}")
            scanning_screen.add_detail(f"Quick mode: {self.quick_mode}")
            scanning_screen.add_detail(f"Similarity threshold: {self.similarity_threshold * 100:.0f}%")

            cfg = json.loads(json.dumps(DEFAULT_CFG))

            # Apply user's similarity threshold
            cfg["similarity"]["phash_duplicate"] = self.similarity_threshold
            cfg["similarity"]["phash_variant"] = self.similarity_threshold * 0.9  # Slightly lower for variants

            # Use in-memory cache that doesn't persist between runs
            import tempfile
            import os
            temp_cache = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
            cache_path = Path(temp_cache.name)
            temp_cache.close()
            cache = FingerprintCache(cache_path)

            scanning_screen.update_status("Scanning for image files...")
            scanning_screen.add_detail(f"Scanning directory: {self.input_folder}")

            files = list_image_files(self.input_folder, cfg)
            scanning_screen.add_detail(f"Found {len(files)} image files")

            if len(files) == 0:
                scanning_screen.stop_progress()
                scanning_screen.update_status("No images found")
                self.after(100, lambda: messagebox.showerror(
                    "No Images",
                    "No image files found in the selected folder.",
                    parent=self
                ))
                self.show_frame("WelcomeScreen")
                return

            scanning_screen.update_status("Analyzing images...")
            scanning_screen.add_detail("Computing fingerprints for each image...")

            stats = {}
            fingerprints = {}
            detector = get_feature_detector(cfg)

            for idx, p in enumerate(files):
                if idx % 10 == 0:
                    scanning_screen.add_detail(f"  Processed {idx}/{len(files)} images...")

                fp = compute_fingerprint(p, cfg, detector, cache)
                if fp is None:
                    continue

                img = load_image_normalized(p, cfg)
                if img is None:
                    continue

                h, w = img.shape[:2]
                fingerprints[p] = fp
                stats[p] = (w, h)

            scanning_screen.add_detail(f"Successfully processed {len(fingerprints)} images")

            scanning_screen.update_status("Finding duplicates...")
            scanning_screen.add_detail("Comparing images to find matches...")

            buckets = assign_buckets(list(stats.keys()), stats, cfg)
            pairs = []

            for bucket_key, paths in buckets.items():
                if len(paths) < 2:
                    continue

                phash_map = {p: fingerprints[p].phash64_8x for p in paths}
                lsh_map = build_lsh_map(phash_map, cfg["blocking"]["lsh_hamming_radius"])

                for i, p in enumerate(paths):
                    for q in lsh_map[p]:
                        if p >= q:
                            continue

                        fp_a = fingerprints[p]
                        fp_b = fingerprints[q]

                        sim, _ = phash_similarity_scores(fp_a.phash64_8x, fp_b.phash64_8x)

                        if self.quick_mode:
                            metrics = PairMetrics(phash_similarity=sim, inliers=0,
                                                coverage_a=0.0, coverage_b=0.0,
                                                residual_median_px=float("inf"), model="none")
                            label = "duplicate" if sim >= cfg["similarity"]["phash_duplicate"] else \
                                   "variant" if sim >= cfg["similarity"]["phash_variant"] else "different"
                            pairs.append(PairDecision(a=p, b=q, label=label, metrics=metrics))
                        else:
                            img_a = load_image_normalized(p, cfg)
                            img_b = load_image_normalized(q, cfg)

                            if img_a is None or img_b is None:
                                continue

                            kps_a, desc_a = extract_keypoints(img_a, detector)
                            kps_b, desc_b = extract_keypoints(img_b, detector)
                            matches = match_descriptors(desc_a, desc_b, cfg)

                            model_name, geo_metrics = estimate_transform_and_metrics(
                                kps_a, kps_b, matches, cfg)
                            geo_metrics.phash_similarity = sim

                            if model_name is None:
                                label = "different"
                            else:
                                label = decide_label(geo_metrics, fp_a, fp_b, cfg)

                            pairs.append(PairDecision(a=p, b=q, label=label, metrics=geo_metrics))

            scanning_screen.add_detail(f"Completed {len(pairs)} comparisons")

            scanning_screen.update_status("Grouping duplicates...")
            scanning_screen.add_detail("Creating clusters of similar images...")

            self.clusters = build_clusters(pairs, cfg, fingerprints, stats)

            scanning_screen.add_detail(f"Found {len(self.clusters)} duplicate clusters")
            scanning_screen.stop_progress()

            cache.close()

            # Clean up temporary cache file
            try:
                cache_path.unlink()
            except:
                pass

            if len(self.clusters) == 0:
                self.after(100, lambda: messagebox.showinfo(
                    "No Duplicates",
                    "No duplicate or similar images found!",
                    parent=self
                ))
                self.show_frame("WelcomeScreen")
            else:
                scanning_screen.update_status(
                    f"Complete! Found {len(self.clusters)} groups of duplicates"
                )
                self.after(1000, self.show_results)

        except Exception as e:
            import traceback
            error_details = traceback.format_exc()
            scanning_screen.stop_progress()
            scanning_screen.update_status("Error occurred")
            scanning_screen.add_detail(f"ERROR: {str(e)}")
            scanning_screen.add_detail("\n" + "="*60)
            scanning_screen.add_detail("Full error traceback:")
            scanning_screen.add_detail(error_details)
            scanning_screen.add_detail("="*60)

            # Also print to console for debugging
            print(f"\n{'='*70}")
            print("ERROR DURING SCANNING")
            print(f"{'='*70}")
            print(error_details)
            print(f"{'='*70}\n")

            error_msg = str(e)
            self.after(100, lambda msg=error_msg: messagebox.showerror(
                "Error",
                f"An error occurred during scanning:\n\n{msg}\n\n"
                "Check the progress details box for full error information.",
                parent=self
            ))
            # Don't automatically return to welcome screen - let user see the error
            # self.show_frame("WelcomeScreen")

    def show_results(self):
        results_screen = self.frames["ResultsScreen"]
        results_screen.load_results(self.clusters)
        self.show_frame("ResultsScreen")

    def delete_files(self, file_list):
        """Move marked files to dupes folder."""
        deletion_screen = self.frames["DeletionScreen"]

        # Create _dupes folder in the scanned directory (not current directory)
        if self.input_folder:
            dupes_dir = self.input_folder / "_dupes"
        else:
            dupes_dir = Path("_dupes")

        dupes_dir.mkdir(exist_ok=True)

        moved = 0
        failed = []
        deletion_record = []  # Track this deletion for undo

        for idx, file_path in enumerate(file_list, 1):
            try:
                if not file_path.exists():
                    failed.append((file_path, "File not found"))
                    continue

                # Generate unique destination filename
                dest = dupes_dir / file_path.name
                if dest.exists():
                    stem = file_path.stem
                    suffix = file_path.suffix
                    counter = 1
                    dest = dupes_dir / f"{stem}_{counter}{suffix}"
                    while dest.exists():
                        counter += 1
                        dest = dupes_dir / f"{stem}_{counter}{suffix}"

                # Move the file
                shutil.move(str(file_path), str(dest))
                moved += 1

                # Record the move for undo (original path, dupes path)
                deletion_record.append((file_path, dest))

                deletion_screen.update_progress(idx, len(file_list), file_path.name)

            except Exception as e:
                failed.append((file_path, str(e)))
                print(f"Failed to move {file_path}: {e}")

        # Add to deletion history for undo (only if something was moved)
        if deletion_record:
            self.deletion_history.append(deletion_record)

            # Enable undo button
            results_screen = self.frames["ResultsScreen"]
            results_screen.undo_btn.set_state("normal")

        # Show results with any failures
        if failed:
            self.after(100, lambda: messagebox.showwarning(
                "Deletion Complete with Errors",
                f"Moved {moved} files to {dupes_dir}\n\n"
                f"Failed to move {len(failed)} files. Check console for details.",
                parent=self
            ))

        deletion_screen.show_complete(moved, dupes_dir)


def main():
    """Main entry point."""
    app = DupeFinderApp()
    app.mainloop()


if __name__ == "__main__":
    main()
