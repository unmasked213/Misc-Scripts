r"""
rotate-display.py (double-click friendly)

What it does
- Toggles a chosen monitor between landscape and portrait (flipped).
- Bypasses AMD Adrenalin's display-rotation interference by calling
  ChangeDisplaySettingsEx directly via Win32.
- Identifies the target monitor by its stable EDID-derived DeviceID, not
  by the \\.\DISPLAYn slot (which drifts across driver state changes).

How it picks the target
- On first run (or --pick), shows a picker of active monitors and saves
  the chosen monitor's DeviceID to rotate-display.config.json beside this
  script. Subsequent runs auto-target that physical monitor wherever it
  has landed in the device namespace.
- If the saved monitor is not currently present, falls back to the picker.

Usage
- Double-click to toggle the configured monitor.
- python rotate-display.py --pick      Re-run the picker, save selection.
- python rotate-display.py --diagnose  Print all displays, no rotation.
- python rotate-display.py --reset     Delete the saved config.
"""

from __future__ import annotations

import os
import re
import sys
import json
import ctypes
from ctypes import wintypes
from pathlib import Path

# Windows-safe UTF-8 console
os.environ["PYTHONUTF8"] = "1"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------------------------------------------------------------------
# ANSI colours (same palette as folder_stats.py)
# ---------------------------------------------------------------------------

def _enable_ansi() -> bool:
    try:
        k32 = ctypes.windll.kernel32
        handle = k32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if k32.GetConsoleMode(handle, ctypes.byref(mode)):
            k32.SetConsoleMode(handle, mode.value | 0x0004)
            return True
    except Exception:
        pass
    return False


_ANSI = _enable_ansi()

if _ANSI:
    DIM     = "\033[2m"
    BOLD    = "\033[1m"
    RESET   = "\033[0m"
    CYAN    = "\033[36m"
    GREEN   = "\033[32m"
    YELLOW  = "\033[33m"
    RED     = "\033[31m"
    WHITE   = "\033[37m"
    GREY    = "\033[90m"
    MAGENTA = "\033[95m"
    ORANGE  = "\033[38;5;208m"
    BLUE_ACCENT = "\033[38;2;0;157;217m"
    PINK_ACCENT = "\033[38;2;255;46;146m"
    BOX_DARK    = "\033[38;2;41;42;53m"
else:
    DIM = BOLD = RESET = CYAN = GREEN = YELLOW = RED = WHITE = ""
    GREY = MAGENTA = ORANGE = BLUE_ACCENT = PINK_ACCENT = BOX_DARK = ""


# ---------------------------------------------------------------------------
# Box-drawing characters
# ---------------------------------------------------------------------------

PIPE      = "\u2502"
TEE       = "\u251c"
ELBOW     = "\u2570"
DASH      = "\u2500"
BOX_TL    = "\u256d"
BOX_TR    = "\u256e"
BOX_BL    = "\u2570"
BOX_BR    = "\u256f"
BOX_R_TEE = "\u2524"

_ANSI_RE = re.compile(r"\033\[[0-9;]*m")


# ---------------------------------------------------------------------------
# Console chrome
# ---------------------------------------------------------------------------

def _visible_len(s: str) -> int:
    return len(_ANSI_RE.sub("", s))


def _con_box(lines: list[str], *, colour: str = CYAN) -> None:
    width = max(_visible_len(line) for line in lines) + 2
    bar = DASH * width
    print(f"  {colour}{BOX_TL}{bar}{BOX_TR}{RESET}")
    for line in lines:
        pad = width - 1 - _visible_len(line)
        print(f"  {colour}{PIPE}{RESET} {line}{' ' * pad}{colour}{PIPE}{RESET}")
    print(f"  {colour}{BOX_BL}{bar}{BOX_BR}{RESET}")


def _con_table(title: str, rows: list[str], *, colour: str = CYAN) -> None:
    all_lines = [title, ""] + rows
    width = max(_visible_len(line) for line in all_lines) + 2
    bar = DASH * width
    print(f"  {colour}{BOX_TL}{bar}{BOX_TR}{RESET}")
    pad = width - 1 - _visible_len(all_lines[0])
    print(f"  {colour}{PIPE}{RESET} {all_lines[0]}{' ' * pad}{colour}{PIPE}{RESET}")
    print(f"  {colour}{TEE}{bar}{BOX_R_TEE}{RESET}")
    for i, line in enumerate(all_lines[2:]):
        pad = width - 1 - _visible_len(line)
        print(f"  {colour}{PIPE}{RESET} {line}{' ' * pad}{colour}{PIPE}{RESET}")
        if i == 0 and len(all_lines) > 3:
            print(f"  {colour}{PIPE}{RESET}{' ' * width}{colour}{PIPE}{RESET}")
    print(f"  {colour}{BOX_BL}{bar}{BOX_BR}{RESET}")


def _con_ok(msg: str) -> None:
    print(f"  {GREEN}{PIPE}{RESET} {msg}")


def _con_warn(msg: str) -> None:
    print(f"  {RED}{PIPE}{RESET} {msg}")


def _con_info(msg: str) -> None:
    print(f"  {CYAN}{PIPE}{RESET} {msg}")


def _wait_any_key(label: str = "Press any key to exit...") -> None:
    import msvcrt
    sys.stdout.write(f"  {CYAN}{PIPE}{RESET} {DIM}{label}{RESET}")
    sys.stdout.flush()
    msvcrt.getwch()
    print()


# ---------------------------------------------------------------------------
# Win32 display API (ctypes)
# ---------------------------------------------------------------------------

class DEVMODE(ctypes.Structure):
    _fields_ = [
        ("dmDeviceName",          ctypes.c_char * 32),
        ("dmSpecVersion",         ctypes.c_ushort),
        ("dmDriverVersion",       ctypes.c_ushort),
        ("dmSize",                ctypes.c_ushort),
        ("dmDriverExtra",         ctypes.c_ushort),
        ("dmFields",              ctypes.c_uint32),
        ("dmPositionX",           ctypes.c_int32),
        ("dmPositionY",           ctypes.c_int32),
        ("dmDisplayOrientation",  ctypes.c_uint32),
        ("dmDisplayFixedOutput",  ctypes.c_uint32),
        ("dmColor",               ctypes.c_ushort),
        ("dmDuplex",              ctypes.c_ushort),
        ("dmYResolution",         ctypes.c_ushort),
        ("dmTTOption",            ctypes.c_ushort),
        ("dmCollate",             ctypes.c_ushort),
        ("dmFormName",            ctypes.c_char * 32),
        ("dmLogPixels",           ctypes.c_ushort),
        ("dmBitsPerPel",          ctypes.c_uint32),
        ("dmPelsWidth",           ctypes.c_uint32),
        ("dmPelsHeight",          ctypes.c_uint32),
        ("dmDisplayFlags",        ctypes.c_uint32),
        ("dmDisplayFrequency",    ctypes.c_uint32),
        ("dmICMMethod",           ctypes.c_uint32),
        ("dmICMIntent",           ctypes.c_uint32),
        ("dmMediaType",           ctypes.c_uint32),
        ("dmDitherType",          ctypes.c_uint32),
        ("dmReserved1",           ctypes.c_uint32),
        ("dmReserved2",           ctypes.c_uint32),
        ("dmPanningWidth",        ctypes.c_uint32),
        ("dmPanningHeight",       ctypes.c_uint32),
    ]


class DISPLAY_DEVICE(ctypes.Structure):
    _fields_ = [
        ("cb",            ctypes.c_uint32),
        ("DeviceName",    ctypes.c_char * 32),
        ("DeviceString",  ctypes.c_char * 128),
        ("StateFlags",    ctypes.c_uint32),
        ("DeviceID",      ctypes.c_char * 128),
        ("DeviceKey",     ctypes.c_char * 128),
    ]


_user32 = ctypes.windll.user32
_user32.EnumDisplaySettingsA.argtypes  = [ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(DEVMODE)]
_user32.EnumDisplaySettingsA.restype   = ctypes.c_int
_user32.EnumDisplayDevicesA.argtypes   = [ctypes.c_char_p, ctypes.c_uint32, ctypes.POINTER(DISPLAY_DEVICE), ctypes.c_uint32]
_user32.EnumDisplayDevicesA.restype    = ctypes.c_int
_user32.ChangeDisplaySettingsExA.argtypes = [ctypes.c_char_p, ctypes.POINTER(DEVMODE), ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]
_user32.ChangeDisplaySettingsExA.restype  = ctypes.c_int

ENUM_CURRENT_SETTINGS    = -1
DM_DISPLAYORIENTATION    = 0x80
DM_PELSWIDTH             = 0x80000
DM_PELSHEIGHT            = 0x100000
CDS_UPDATEREGISTRY       = 1
DISPLAY_DEVICE_ACTIVE    = 0x1
DISPLAY_DEVICE_PRIMARY   = 0x4

ORIENT_NAMES = ["Landscape", "Portrait", "Landscape flipped", "Portrait flipped"]

# DISP_CHANGE_* return codes from ChangeDisplaySettingsEx
DISP_CHANGE = {
    0:  "SUCCESS",
    1:  "RESTART required",
    -1: "FAILED (driver refused the mode)",
    -2: "BADMODE (requested mode not supported)",
    -3: "NOTUPDATED (registry write failed)",
    -4: "BADFLAGS (invalid flag combination)",
    -5: "BADPARAM (invalid parameter)",
    -6: "BADDUALVIEW (DualView restriction)",
}


def _decode_result(code: int) -> str:
    return f"{code} ({DISP_CHANGE.get(code, 'unknown')})"


def enum_displays() -> list[dict]:
    """Return one dict per adapter slot, with attached-monitor info and mode."""
    results = []
    for i in range(16):
        d = DISPLAY_DEVICE()
        d.cb = ctypes.sizeof(DISPLAY_DEVICE)
        if not _user32.EnumDisplayDevicesA(None, i, ctypes.byref(d), 0):
            break
        device_name = d.DeviceName.decode("mbcs", errors="replace")
        adapter     = d.DeviceString.decode("mbcs", errors="replace")
        active      = bool(d.StateFlags & DISPLAY_DEVICE_ACTIVE)
        primary     = bool(d.StateFlags & DISPLAY_DEVICE_PRIMARY)

        m = DISPLAY_DEVICE()
        m.cb = ctypes.sizeof(DISPLAY_DEVICE)
        monitor = None
        monitor_id = None
        if _user32.EnumDisplayDevicesA(d.DeviceName, 0, ctypes.byref(m), 0):
            monitor    = m.DeviceString.decode("mbcs", errors="replace")
            monitor_id = m.DeviceID.decode("mbcs", errors="replace")

        dm = DEVMODE()
        dm.dmSize = ctypes.sizeof(DEVMODE)
        mode = None
        if _user32.EnumDisplaySettingsA(d.DeviceName, ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
            mode = {
                "width":  dm.dmPelsWidth,
                "height": dm.dmPelsHeight,
                "freq":   dm.dmDisplayFrequency,
                "orient": dm.dmDisplayOrientation,
            }

        results.append({
            "device_name": device_name,
            "adapter":     adapter,
            "monitor":     monitor,
            "monitor_id":  monitor_id,
            "active":      active,
            "primary":     primary,
            "mode":        mode,
        })
    return results


def rotate(device_name: str, target_orient: int) -> int:
    """Apply rotation to the given device. Returns 0 on success."""
    dm = DEVMODE()
    dm.dmSize = ctypes.sizeof(DEVMODE)
    dev = device_name.encode("mbcs")
    if not _user32.EnumDisplaySettingsA(dev, ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
        return -1
    if (dm.dmDisplayOrientation % 2) != (target_orient % 2):
        dm.dmPelsWidth, dm.dmPelsHeight = dm.dmPelsHeight, dm.dmPelsWidth
    dm.dmDisplayOrientation = target_orient
    dm.dmFields = DM_DISPLAYORIENTATION | DM_PELSWIDTH | DM_PELSHEIGHT
    return _user32.ChangeDisplaySettingsExA(dev, ctypes.byref(dm), None, CDS_UPDATEREGISTRY, None)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_PATH = Path(__file__).parent / "rotate-display.config.json"


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _short_id(monitor_id: str | None) -> str:
    if not monitor_id:
        return "—"
    # Pull the model bit out of "MONITOR\GSM7705\{...}\0001"
    parts = monitor_id.split("\\")
    if len(parts) >= 2:
        return parts[1]
    return monitor_id[:12]


def render_table(displays: list[dict], include_inactive: bool = True) -> list[str]:
    rows: list[str] = []
    header = (
        f"{DIM}#   DEVICE     MONITOR ID    RESOLUTION         ORIENTATION         STATE{RESET}"
    )
    rows.append(header)

    shown = displays if include_inactive else [d for d in displays if d["active"]]
    for i, d in enumerate(shown, 1):
        idx = f"{i}.".ljust(4)
        dev = d["device_name"].replace("\\\\.\\", "").ljust(10)
        mid = _short_id(d.get("monitor_id")).ljust(13)
        if d["mode"]:
            res = f"{d['mode']['width']}x{d['mode']['height']} @ {d['mode']['freq']}Hz".ljust(18)
            ori = ORIENT_NAMES[d['mode']['orient']].ljust(19)
        else:
            res = "—".ljust(18)
            ori = "—".ljust(19)

        flags = []
        if d["active"]:  flags.append(f"{GREEN}ACTIVE{RESET}")
        else:            flags.append(f"{DIM}inactive{RESET}")
        if d["primary"]: flags.append(f"{ORANGE}PRIMARY{RESET}")
        state = " ".join(flags)

        rows.append(
            f"{DIM}{idx}{RESET}{WHITE}{dev}{RESET} {DIM}{mid}{RESET} "
            f"{WHITE}{res}{RESET} {ori} {state}"
        )
    return rows


# ---------------------------------------------------------------------------
# Picker
# ---------------------------------------------------------------------------

def pick_target(displays: list[dict]) -> dict | None:
    active = [d for d in displays if d["active"]]
    if not active:
        # Caller is responsible for printing a "no displays" message;
        # this function only returns None for "no usable target".
        return None

    print()
    _con_box(["rotate-display   pick a target monitor"], colour=BOX_DARK)
    print()
    rows = render_table(active, include_inactive=False)
    _con_table("Active displays", rows, colour=BLUE_ACCENT)
    print()

    while True:
        try:
            choice = input(f"  {YELLOW}{PIPE}{RESET} Pick the rotatable monitor: ").strip()
        except (EOFError, KeyboardInterrupt):
            return None
        if not choice:
            return None
        try:
            n = int(choice)
            if 1 <= n <= len(active):
                return active[n - 1]
        except ValueError:
            pass
        _con_warn(f"Pick a number between 1 and {len(active)}.")


def find_target(displays: list[dict], monitor_id: str | None) -> dict | None:
    if not monitor_id:
        return None
    for d in displays:
        if d["active"] and d.get("monitor_id") == monitor_id:
            return d
    return None


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_diagnose() -> None:
    print()
    _con_box(["rotate-display   diagnostic"], colour=BOX_DARK)
    print()
    displays = enum_displays()
    rows = render_table(displays, include_inactive=True)
    _con_table("All display adapters", rows, colour=BLUE_ACCENT)
    print()
    cfg = load_config()
    if cfg.get("monitor_id"):
        name = cfg.get("monitor_name") or "?"
        match = find_target(displays, cfg["monitor_id"])
        if match:
            _con_ok(
                f"Configured target: {WHITE}{name}{RESET} "
                f"{DIM}→ currently {match['device_name']}{RESET}"
            )
        else:
            _con_warn(
                f"Configured target {WHITE}{name}{RESET} "
                f"is not currently present."
            )
    else:
        _con_info("No target configured. Run with --pick to choose one.")
    print()
    _wait_any_key()


def cmd_pick() -> None:
    displays = enum_displays()
    if not any(d["active"] for d in displays):
        _con_warn("No active displays found.")
        _wait_any_key()
        return
    target = pick_target(displays)
    if not target:
        _con_warn("Cancelled.")
        _wait_any_key()
        return
    if not target.get("monitor_id"):
        _con_warn("Selected display has no monitor DeviceID; cannot save.")
        _wait_any_key()
        return
    save_config({
        "monitor_id":   target["monitor_id"],
        "monitor_name": target.get("monitor"),
    })
    print()
    _con_ok(
        f"Saved: {WHITE}{target['monitor'] or '?'}{RESET}  "
        f"{DIM}({_short_id(target['monitor_id'])}){RESET}"
    )
    print()


def cmd_reset() -> None:
    print()
    if CONFIG_PATH.exists():
        CONFIG_PATH.unlink()
        _con_ok("Config cleared.")
    else:
        _con_info("No config to clear.")
    print()
    _wait_any_key()


def cmd_toggle() -> None:
    cfg = load_config()
    displays = enum_displays()
    if not any(d["active"] for d in displays):
        print()
        _con_warn("No active displays found.")
        _wait_any_key()
        return
    target = find_target(displays, cfg.get("monitor_id"))

    if not target:
        print()
        if cfg:
            name = cfg.get("monitor_name") or "?"
            _con_warn(
                f"Configured monitor {WHITE}{name}{RESET} "
                f"not currently present."
            )
        else:
            _con_info("No target configured yet.")
        target = pick_target(displays)
        if not target:
            _con_warn("Cancelled.")
            _wait_any_key()
            return
        if target.get("monitor_id"):
            save_config({
                "monitor_id":   target["monitor_id"],
                "monitor_name": target.get("monitor"),
            })

    if not target.get("mode"):
        print()
        _con_warn(
            f"Cannot read current mode for {WHITE}{target['device_name']}{RESET}. "
            f"The driver may be in a bad state."
        )
        _con_info(
            f"Try {WHITE}Win+Ctrl+Shift+B{RESET} to reset the GPU driver, "
            f"then run again."
        )
        _wait_any_key()
        return

    cur = target["mode"]["orient"]
    new = 3 if cur == 0 else 0

    print()
    _con_box(
        [
            f"{WHITE}{target['monitor'] or '?'}{RESET}  "
            f"{DIM}({target['device_name']}, {_short_id(target.get('monitor_id'))}){RESET}",
            "",
            f"  {DIM}From{RESET}  {ORIENT_NAMES[cur]}",
            f"  {DIM}To  {RESET}  {WHITE}{ORIENT_NAMES[new]}{RESET}",
        ],
        colour=BOX_DARK,
    )

    result = rotate(target["device_name"], new)
    print()
    if result == 0:
        _con_ok(f"Rotated to {WHITE}{ORIENT_NAMES[new]}{RESET}.")
    elif result == 1:
        _con_warn(
            f"Settings saved but a restart is required to apply "
            f"({_decode_result(result)})."
        )
        _wait_any_key()
    else:
        _con_warn(f"ChangeDisplaySettingsEx returned {_decode_result(result)}.")
        _con_info(
            f"If this persists, try {WHITE}Win+Ctrl+Shift+B{RESET} "
            f"to reset the GPU driver, then run again."
        )
        _wait_any_key()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = sys.argv[1:]
    if any(a in args for a in ("-h", "--help")):
        print(__doc__)
        return
    if any(a in args for a in ("-d", "--diagnose")):
        cmd_diagnose()
    elif any(a in args for a in ("-p", "--pick")):
        cmd_pick()
    elif any(a in args for a in ("-r", "--reset")):
        cmd_reset()
    else:
        cmd_toggle()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n  {DIM}Cancelled.{RESET}\n")
    except Exception:
        import traceback
        traceback.print_exc()
        _wait_any_key()
