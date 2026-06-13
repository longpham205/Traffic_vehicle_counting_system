"""
utils.py - JSON helpers, CSV export, history management,
session folder creation, timestamp generation.
"""

import csv
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any
import tempfile

import yaml

# ---------------------------------------------------------------------------
# Config loader
# ---------------------------------------------------------------------------

def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Timestamp helpers
# ---------------------------------------------------------------------------

def now_ts() -> str:
    """Return current timestamp string: YYYYMMDD_HHMMSS"""
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    """Return ISO-8601 datetime string."""
    return datetime.now().isoformat()


def seconds_to_hms(seconds: float) -> str:
    """Convert seconds to HH:MM:SS string."""
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


# ---------------------------------------------------------------------------
# Session folder helpers
# ---------------------------------------------------------------------------

def create_session_folder(results_dir: str, session_id: str) -> str:
    """Create and return the path to a new session result folder."""
    folder = os.path.join(results_dir, session_id)
    Path(folder).mkdir(parents=True, exist_ok=True)
    return folder


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------

def read_json(path: str) -> Any:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return None
            return json.loads(content)
    except json.JSONDecodeError:
        return None

def write_json(path: str, data: Any) -> None:
    directory = os.path.dirname(path) or "."
    fd, temp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())

        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# History management
# ---------------------------------------------------------------------------

HISTORY_FILE = "src/history.json"


def load_history() -> list:
    data = read_json(HISTORY_FILE)
    if data is None:
        return []
    return data if isinstance(data, list) else []


def save_history(entries: list) -> None:
    write_json(HISTORY_FILE, entries)


def append_history(entry: dict) -> None:
    history = load_history()
    history.insert(0, entry)        # newest first
    save_history(history)


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------

def write_statistics_csv(folder: str, vehicle_counts: dict) -> str:
    path = os.path.join(folder, "statistics.csv")
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["vehicle_type", "count"])
        for vtype, count in vehicle_counts.items():
            writer.writerow([vtype, count])
    return path


def write_vehicle_log_csv(folder: str, vehicle_log: list) -> str:
    """
    vehicle_log: list of dicts with keys:
        track_id, type, direction, time
    """
    path = os.path.join(folder, "vehicle_log.csv")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["track_id", "type", "direction", "time"])
        writer.writeheader()
        for row in vehicle_log:
            writer.writerow(row)
    return path


# ---------------------------------------------------------------------------
# Summary JSON
# ---------------------------------------------------------------------------

def write_summary_json(folder: str, summary: dict) -> str:
    path = os.path.join(folder, "summary.json")
    write_json(path, summary)
    return path


# ---------------------------------------------------------------------------
# Ensure dirs exist
# ---------------------------------------------------------------------------

def ensure_dirs(*dirs: str) -> None:
    for d in dirs:
        Path(d).mkdir(parents=True, exist_ok=True)
