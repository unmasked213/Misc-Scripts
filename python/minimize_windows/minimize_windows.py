"""
Script: minimize_windows.py
Purpose: Selectively minimizes Windows-based windows based on configurable criteria
         - Minimizes windows matching specified keywords (media viewers, image files, etc.)
         - Minimizes browser windows (Brave, Firefox) except those with whitelisted content
         - Minimizes all File Explorer windows
         - Supports exception lists to preserve specific windows
Usage: python minimize_windows.py
       Customize keywords_to_minimize, exceptions, and browser_whitelist lists as needed
Requirements: pygetwindow, pywin32
              Install: pip install pygetwindow pywin32
"""

import pygetwindow as gw
import win32gui
import win32con
from urllib.parse import urlparse

# Function to check if a window belongs to File Explorer
def is_file_explorer_window(hwnd):
    class_name = win32gui.GetClassName(hwnd)
    return class_name == "CabinetWClass" or class_name == "ExplorerWClass"

# Function to check if a window title contains any whitelisted term
def is_whitelisted_content(title, whitelist):
    title_lower = title.lower()
    for term in whitelist:
        if term.lower() in title_lower:
            return True
    return False

# Function to minimize windows based on keywords or class type
def minimize_windows(keywords, exceptions, browser_whitelist):
    # Cache all window titles and windows
    all_windows = gw.getAllWindows()
    titles = [win.title for win in all_windows]

    # Minimize windows matching keywords
    for keyword in keywords:
        for title in titles:
            if keyword.lower() in title.lower() and title not in exceptions:
                try:
                    hwnd = next(win._hWnd for win in all_windows if win.title == title)
                    win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
                    print(f"Window titled '{title}' minimized.")
                except Exception as e:
                    print(f"Error minimizing window titled '{title}': {e}")
    
    # Handle browser windows (Brave and Firefox)
    browser_keywords = ["Brave", "Firefox"]
    for browser in browser_keywords:
        for window in all_windows:
            if browser.lower() in window.title.lower() and not is_whitelisted_content(window.title, browser_whitelist):
                try:
                    win32gui.ShowWindow(window._hWnd, win32con.SW_MINIMIZE)
                    print(f"Browser window '{window.title}' minimized.")
                except Exception as e:
                    print(f"Error minimizing browser window '{window.title}': {e}")

    # Minimize File Explorer windows
    for window in all_windows:
        if is_file_explorer_window(window._hWnd):
            try:
                win32gui.ShowWindow(window._hWnd, win32con.SW_MINIMIZE)
                print("File Explorer window minimized.")
            except Exception as e:
                print(f"Error minimizing File Explorer window: {e}")

# Keywords to minimize
keywords_to_minimize = [
    "Reolink", "IrfanView", "MPV", "VLC", 
    ".jpg", ".jpeg", ".png", ".gif", 
    ".bmp", ".tiff", ".tif", ".pdf", 
    ".webp", ".heic", ".heif"
]

# Windows to exclude from minimization
exceptions = ["work cover.jpg"]

# Terms to whitelist (browser tabs containing these terms won't be minimized)
browser_whitelist = [
    "Olympus",
    "Home Assistant",
    "CSS",
    "Github",
    "violentmonkey",
    "CodePen",
    "ChatGPT"
    # Add more terms here
]

# Call the function
minimize_windows(keywords_to_minimize, exceptions, browser_whitelist)
