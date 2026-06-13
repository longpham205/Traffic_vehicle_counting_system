"""
engine.py - YOLO initialization, ObjectCounter, video processing,
camera processing, statistics collection, session lifecycle.
"""

import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import cv2
import psutil

from src.backend.utils import (
    append_history,
    create_session_folder,
    now_ts,
    now_iso,
    seconds_to_hms,
    write_statistics_csv,
    write_summary_json,
    write_vehicle_log_csv,
)
from ultralytics import YOLO
from ultralytics.solutions import ObjectCounter

# ---------------------------------------------------------------------------
# COCO class-id → label
# ---------------------------------------------------------------------------
COCO_LABELS = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

# ---------------------------------------------------------------------------
# ProcessingSession
# ---------------------------------------------------------------------------

class ProcessingSession:
    """
    Holds all mutable state for one counting session.
    Thread-safe via a simple lock for stat reads.
    """

    def __init__(self, session_id: str, config: dict):
        self.session_id = session_id
        self.config = config

        # Status flags
        self.status = "idle"          # idle | running | paused | stopped | done
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self._lock = threading.Lock()

        # Latest JPEG frame for MJPEG stream
        self.latest_frame: Optional[bytes] = None

        # Statistics
        self.in_count: int = 0
        self.out_count: int = 0
        self.total_count: int = 0
        self.current_vehicles: int = 0
        self.vehicle_counts: dict = {v: 0 for v in COCO_LABELS.values()}
        self.vehicle_log: list = []   # list of dicts
        
        # Progress
        self.progress = 0
        self.total_frames = 0
        self.processed_frames = 0
        self.eta = 0

        # Performance
        self.fps: float = 0.0
        self.start_time: Optional[float] = None
        self.end_time: Optional[float] = None
        self.frame_count: int = 0
        self.cpu_usage: float = 0.0
        self.ram_usage: float = 0.0

        # Session meta
        self.model_name: str = config.get("model", "yolo11n.pt")
        self.tracker_name: str = config.get("tracker", "bytetrack.yaml")
        self.output_path: Optional[str] = None
        self.video_name: str = ""

    # ------------------------------------------------------------------
    # Public stat snapshot (thread-safe)
    # ------------------------------------------------------------------

    def get_stats(self) -> dict:
        with self._lock:
            elapsed = 0.0
            if self.start_time:
                end = self.end_time if self.end_time else time.time()
                elapsed = end - self.start_time
            return {
                "status": self.status,
                "in_count": self.in_count,
                "out_count": self.out_count,
                "total_count": self.total_count,
                "current_vehicles": self.current_vehicles,
                "vehicle_counts": dict(self.vehicle_counts),
                "fps": round(self.fps, 1),
                "elapsed": round(elapsed, 1),
                "elapsed_hms": seconds_to_hms(elapsed),
                "cpu_usage": self.cpu_usage,
                "ram_usage": self.ram_usage,
                "model": self.model_name,
                "tracker": self.tracker_name,
                "session_id": self.session_id,
                "output_path": self.output_path,
                "video_name": self.video_name,
                "progress": self.progress,
                "processed_frames": self.processed_frames,
                "total_frames": self.total_frames,
                "eta": self.eta,
            }

    # ------------------------------------------------------------------
    # Internal stat updater
    # ------------------------------------------------------------------

    def _update_from_counter(self, counter) -> None:
        """Pull counts from an Ultralytics ObjectCounter instance."""
        with self._lock:
            try:
                in_count = getattr(counter, "in_count", 0)
                out_count = getattr(counter, "out_count", 0)
                self.in_count = int(in_count)
                self.out_count = int(out_count)
                self.total_count = self.in_count + self.out_count
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Engine singleton
# ---------------------------------------------------------------------------

class VehicleCountingEngine:
    def __init__(self, output_dir: str = "outputs", results_dir: str = "results"):
        self.output_dir = output_dir
        self.results_dir = results_dir
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        Path(results_dir).mkdir(parents=True, exist_ok=True)

        self.current_session: Optional[ProcessingSession] = None
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def start_session(self, config: dict) -> str:
        """Start a new processing session. Returns session_id."""
        if self.current_session and self.current_session.status == "running":
            raise RuntimeError("A session is already running.")

        session_id = f"session_{now_ts()}"
        session = ProcessingSession(session_id, config)
        self.current_session = session

        mode = config.get("mode", "upload")
        if mode == "upload":
            self._thread = threading.Thread(
                target=self._run_video, args=(session, config), daemon=True
            )
        else:
            self._thread = threading.Thread(
                target=self._run_camera, args=(session, config), daemon=True
            )
        self._thread.start()
        return session_id

    def stop_session(self) -> None:
        if self.current_session:
            self.current_session.stop_event.set()
            self.current_session.status = "stopped"

    def pause_session(self) -> None:
        if self.current_session and self.current_session.status == "running":
            self.current_session.pause_event.set()
            self.current_session.status = "paused"

    def resume_session(self) -> None:
        if self.current_session and self.current_session.status == "paused":
            self.current_session.pause_event.clear()
            self.current_session.status = "running"

    def get_stats(self) -> dict:
        if self.current_session:
            return self.current_session.get_stats()
        return {"status": "idle"}

    def get_latest_frame(self) -> Optional[bytes]:
        if self.current_session:
            return self.current_session.latest_frame
        return None

    # ------------------------------------------------------------------
    # Private – build YOLO + ObjectCounter
    # ------------------------------------------------------------------

    @staticmethod
    def _build_counter(session: ProcessingSession, frame_shape: tuple, config: dict):
        """Lazy import and build ObjectCounter to avoid startup cost."""

        model_name = config.get("model", "yolo11n.pt")
        tracker = config.get("tracker", "bytetrack.yaml")
        conf = float(config.get("confidence", 0.25))
        iou = float(config.get("iou", 0.7))
        classes = config.get("classes", [2, 3, 5, 7])
        region_points = config.get("region_points", [])
        roi_mode = config.get("roi_mode", "polygon")

        h, w = frame_shape[:2]

        # Default ROI if none provided
        if not region_points:
            if roi_mode == "line":
                region_points = [[0, h // 2], [w, h // 2]]
            else:
                margin = 50
                region_points = [
                    [margin, margin],
                    [w - margin, margin],
                    [w - margin, h - margin],
                    [margin, h - margin],
                ]

        model = YOLO(model_name)
        session.model_name = model_name
        session.tracker_name = tracker

        counter = ObjectCounter(
            show=False,
            region=region_points,
            model=model_name,
            classes=classes,
            tracker=config.get("tracker", "bytetrack.yaml"),
            verbose=False,
        )
        return model, counter, conf, iou, classes, region_points

    # ------------------------------------------------------------------
    # Private – video processing
    # ------------------------------------------------------------------

    def _run_video(self, session: ProcessingSession, config: dict) -> None:
        video_path = config.get("video_path", "")
        session.video_name = os.path.basename(video_path)
        session.status = "running"
        session.start_time = time.time()

        cap = cv2.VideoCapture(video_path)
        
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        session.total_frames = total_frames
        
        if not cap.isOpened():
            session.status = "stopped"
            return

        fps_src = cap.get(cv2.CAP_PROP_FPS) or 25.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        ret, first_frame = cap.read()
        if not ret:
            session.status = "stopped"
            cap.release()
            return

        try:
            model, counter, conf, iou, classes, region_points = self._build_counter(
                session, first_frame.shape, config
            )
        except Exception as e:
            print(f"[engine] Failed to build counter: {e}")
            session.status = "stopped"
            cap.release()
            return

        # Output video
        ts = now_ts()
        out_path = os.path.join(self.output_dir, f"result_{ts}.mp4")
        session.output_path = out_path
        fourcc = cv2.VideoWriter_fourcc(*"avc1")
        writer = cv2.VideoWriter(out_path, fourcc, fps_src, (w, h))
        if not writer.isOpened():
            raise RuntimeError(
                "VideoWriter initialization failed. H264 codec may be unavailable."
            )

        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # rewind

        frame_times = []
        while not session.stop_event.is_set():
            # Pause support
            while session.pause_event.is_set() and not session.stop_event.is_set():
                time.sleep(0.1)

            t0 = time.time()
            ret, frame = cap.read()
            if not ret:
                break

            # Run ObjectCounter
            try:
                # ObjectCounter tự detect + track + count
                solution = counter.process(frame)
                annotated = getattr(solution, "plot_im", None)
                if annotated is None:
                    annotated = frame
                # Update counts
                session.in_count = getattr(solution, "in_count", 0)
                session.out_count = getattr(solution, "out_count", 0)
                session.total_count = (
                    session.in_count +
                    session.out_count
                )
                with session._lock:
                    session.current_vehicles = getattr(solution,"total_tracks",0)
                    cls_counts = getattr(solution,"classwise_count", {})
                    if cls_counts:
                        for label, cnt_data in cls_counts.items():
                            label = str(label).lower()
                            session.vehicle_counts[label] = (
                                cnt_data.get("IN", 0)
                                + cnt_data.get("OUT", 0)
                            )

            except Exception as e:
                print(f"[engine] Frame processing error: {e}")
                annotated = frame

            writer.write(annotated)

            # Encode for MJPEG stream
            _, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 70])
            session.latest_frame = buf.tobytes()
            session.frame_count += 1
            
            # Update progress every frame
            session.processed_frames = session.frame_count
            if session.total_frames > 0:
                session.progress = int(
                    session.processed_frames * 100
                    / session.total_frames
                )
            
            #ETA
            elapsed = time.time() - session.start_time
            if session.processed_frames > 0:
                speed = session.processed_frames / elapsed
                remain = (
                    session.total_frames
                    - session.processed_frames
                )
                session.eta = int(remain / speed)

            # FPS calc
            frame_times.append(time.time() - t0)
            if len(frame_times) > 30:
                frame_times.pop(0)
            session.fps = 1.0 / (sum(frame_times) / len(frame_times)) if frame_times else 0.0

            # Resource usage
            session.cpu_usage = round(psutil.cpu_percent(interval=None), 1)
            session.ram_usage = round(psutil.virtual_memory().percent, 1)

        cap.release()
        writer.release()
        session.end_time = time.time()
        session.status = "done"
        self._finalize_session(session, config)

    # ------------------------------------------------------------------
    # Private – camera processing
    # ------------------------------------------------------------------

    def _run_camera(self, session: ProcessingSession, config: dict) -> None:
        camera_id = int(config.get("camera_id", 0))
        session.video_name = f"camera_{camera_id}"
        session.status = "running"
        session.start_time = time.time()

        cap = cv2.VideoCapture(camera_id)
        if not cap.isOpened():
            session.status = "stopped"
            return

        fps_src = cap.get(cv2.CAP_PROP_FPS) or 25.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480

        ret, first_frame = cap.read()
        if not ret:
            session.status = "stopped"
            cap.release()
            return

        try:
            model, counter, conf, iou, classes, region_points = self._build_counter(
                session, first_frame.shape, config
            )
        except Exception as e:
            print(f"[engine] Failed to build counter: {e}")
            session.status = "stopped"
            cap.release()
            return

        ts = now_ts()
        out_path = os.path.join(self.output_dir, f"result_{ts}.mp4")
        session.output_path = out_path
        fourcc = cv2.VideoWriter_fourcc(*"avc1")
        writer = cv2.VideoWriter(out_path, fourcc, fps_src, (w, h))
        if not writer.isOpened():
            raise RuntimeError(
                "VideoWriter initialization failed. H264 codec may be unavailable."
            )

        frame_times = []
        while not session.stop_event.is_set():
            while session.pause_event.is_set() and not session.stop_event.is_set():
                time.sleep(0.1)

            t0 = time.time()
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.05)
                continue

            # Run ObjectCounter
            try:
                # ObjectCounter tự detect + track + count
                solution = counter.process(frame)
                annotated = getattr(solution, "plot_im", None)
                if annotated is None:
                    annotated = frame
                # Update counts
                session.in_count = getattr(solution, "in_count", 0)
                session.out_count = getattr(solution, "out_count", 0)
                session.total_count = (
                    session.in_count +
                    session.out_count
                )
                with session._lock:
                    session.current_vehicles = getattr(solution,"total_tracks",0)
                    cls_counts = getattr(solution,"classwise_count", {})
                    if cls_counts:
                        for label, cnt_data in cls_counts.items():
                            label = str(label).lower()
                            session.vehicle_counts[label] = (
                                cnt_data.get("IN", 0)
                                + cnt_data.get("OUT", 0)
                            )

            except Exception as e:
                print(f"[engine] Camera frame error: {e}")
                annotated = frame

            writer.write(annotated)
            _, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 70])
            session.latest_frame = buf.tobytes()
            session.frame_count += 1

            frame_times.append(time.time() - t0)
            if len(frame_times) > 30:
                frame_times.pop(0)
            session.fps = 1.0 / (sum(frame_times) / len(frame_times)) if frame_times else 0.0
            session.cpu_usage = round(psutil.cpu_percent(interval=None), 1)
            session.ram_usage = round(psutil.virtual_memory().percent, 1)

        cap.release()
        writer.release()
        session.end_time = time.time()
        session.status = "done"
        self._finalize_session(session, config)

    # ------------------------------------------------------------------
    # Private – finalize / save results
    # ------------------------------------------------------------------

    def _finalize_session(self, session: ProcessingSession, config: dict) -> None:
        folder = create_session_folder(self.results_dir, session.session_id)
        elapsed = (session.end_time or time.time()) - (session.start_time or time.time())

        summary = {
            "session_id": session.session_id,
            "video_name": session.video_name,
            "model": session.model_name,
            "tracker": session.tracker_name,
            "confidence": config.get("confidence", 0.25),
            "iou": config.get("iou", 0.7),
            "in_count": session.in_count,
            "out_count": session.out_count,
            "total_count": session.total_count,
            "vehicle_counts": session.vehicle_counts,
            "processing_duration": round(elapsed, 2),
            "processing_duration_hms": seconds_to_hms(elapsed),
            "fps_avg": round(session.fps, 1),
            "output_video": session.output_path,
            "date": now_iso(),
        }
        write_summary_json(folder, summary)
        write_statistics_csv(folder, session.vehicle_counts)
        write_vehicle_log_csv(folder, session.vehicle_log)
        append_history(summary)
        print(f"[engine] Session {session.session_id} finalized → {folder}")
