#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Script: ha_dashboard_launcher.py
Purpose: Launches a frameless, borderless Home Assistant dashboard
         in a webview window
         - Displays on the 3rd monitor (or primary if unavailable)
         - Auto-refreshes every 5 minutes to keep data current
         - Creates a draggable top bar for window movement
         - Disables text selection for a cleaner dashboard experience
Usage: python ha_dashboard_launcher.py
       Configure URL and INTERVAL constants as needed
Requirements: pywebview, screeninfo
              Install: pip install pywebview screeninfo
"""

import webview
import threading
import time
import sys

from screeninfo import get_monitors  # pip install screeninfo

URL = 'http://homeassistant.local:8123/dashboard-home/home'
INTERVAL = 300  # 5 minutes


def refresh_loop():
    while True:
        time.sleep(INTERVAL)
        try:
            win.reload()
        except Exception as e:
            print(f"Refresh failed: {e}")


def on_loaded():
    js = """
    const style = document.createElement('style');
    style.innerHTML = `
        html, body {
            overflow: hidden !important;
            -webkit-user-select: none;
        }
        #dragzone {
            position: fixed;
            top: 0; left: 0; right: 0; height: 30px;
            -webkit-app-region: drag;
            z-index: 9999;
        }
    `;
    document.head.appendChild(style);

    const drag = document.createElement('div');
    drag.id = 'dragzone';
    document.body.appendChild(drag);
    """
    win.evaluate_js(js)


if __name__ == '__main__':
    # Try to select the 3rd screen (index 2)
    try:
        monitor = get_monitors()[2]  # 3rd screen (0-based)
    except IndexError:
        print("3rd monitor not found. Using primary screen.")
        monitor = get_monitors()[0]

    win = webview.create_window(
        'Home Assistant',
        URL,
        width=monitor.width,
        height=monitor.height,
        x=monitor.x,
        y=monitor.y,
        frameless=True,
        resizable=True,
        on_top=False
    )

    threading.Thread(target=refresh_loop, daemon=True).start()

    try:
        webview.start(on_loaded, win, private_mode=False)
    except Exception as e:
        print(f"Startup error: {e}")
        sys.exit(1)
