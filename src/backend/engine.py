#src/backend/engine.py
"""
engine.py - YOLO initialization, ObjectCounter, video processing,
camera processing, statistics collection, session lifecycle.
"""

import os
import threading
import time
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
from ultralytics.solutions import ObjectCounter

# ---------------------------------------------------------------------------
# ProcessingSession
# ---------------------------------------------------------------------------

class ProcessingSession:
    """
    Holds all mutable state for one counting session.
    Thread-safe via a simple lock for stat reads.
    """

    def __init__(self, session_id: str, session_config: dict, app_config: dict):
        self.session_id = session_id

        coco_labels: dict[int, str] = {
            int(k): v
            for k, v in app_config.get("classes", {}).get("labels", {}).items()
        }
        default_class_ids: list[int] = app_config.get("classes", {}).get(
            "coco_vehicle_ids", [2, 3, 5, 7]
        )

        # Status flags
        self.status      = "idle"   # idle | running | paused | stopped | done
        self.stop_event  = threading.Event()
        self.pause_event = threading.Event()
        self._lock       = threading.Lock()

        # Latest JPEG frame for MJPEG stream
        self.latest_frame: Optional[bytes] = None

        # Statistics
        self.in_count:         int = 0
        self.out_count:        int = 0
        self.total_count:      int = 0
        self.current_vehicles: int = 0

        classes = session_config.get("classes", default_class_ids)
        self.vehicle_counts: dict = {
            coco_labels[c]: 0 for c in classes if c in coco_labels
        }
        self.vehicle_log: list = []

        # Progress
        self.progress:          int = 0
        self.total_frames:      int = 0
        self.processed_frames:  int = 0
        self.eta:               int = 0

        # Performance
        self.fps:         float = 0.0
        self.start_time:  Optional[float] = None
        self.end_time:    Optional[float] = None
        self.frame_count: int   = 0
        self.cpu_usage:   float = 0.0
        self.ram_usage:   float = 0.0

        # Session meta
        _det = app_config.get("detection", {})
        _trk = app_config.get("tracking",  {})
        self.model_name:   str = session_config.get("model",   _det.get("default_model",   "yolo11n.pt"))
        self.tracker_name: str = session_config.get("tracker", _trk.get("default_tracker", "bytetrack.yaml"))
        self.output_path:  Optional[str] = None
        self.video_name:   str = ""

        # ROI — saved after _build_counter so frontend can restore ghost ROI
        self.region_points: list = []
        self.roi_mode:      str  = session_config.get("roi_mode", "polygon")

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
                "status":           self.status,
                "in_count":         self.in_count,
                "out_count":        self.out_count,
                "total_count":      self.total_count,
                "current_vehicles": self.current_vehicles,
                "vehicle_counts":   dict(self.vehicle_counts),
                "fps":              round(self.fps, 1),
                "elapsed":          round(elapsed, 1),
                "elapsed_hms":      seconds_to_hms(elapsed),
                "cpu_usage":        self.cpu_usage,
                "ram_usage":        self.ram_usage,
                "model":            self.model_name,
                "tracker":          self.tracker_name,
                "session_id":       self.session_id,
                "output_path":      self.output_path,
                "video_name":       self.video_name,
                "progress":         self.progress,
                "processed_frames": self.processed_frames,
                "total_frames":     self.total_frames,
                "eta":              self.eta,
            }


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class VehicleCountingEngine:
    _FPS_WINDOW   = 30
    _JPEG_QUALITY = 70

    def __init__(self, app_config: dict):
        self.app_config = app_config

        _sys = app_config.get("system", {})
        self.output_dir  = _sys.get("output_dir",  "data/outputs")
        self.results_dir = _sys.get("results_dir", "results")
        Path(self.output_dir).mkdir(parents=True, exist_ok=True)
        Path(self.results_dir).mkdir(parents=True, exist_ok=True)

        self.current_session: Optional[ProcessingSession] = None
        self._thread:         Optional[threading.Thread]  = None

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def start_session(self, config: dict) -> str:
        if self.current_session and self.current_session.status == "running":
            raise RuntimeError("A session is already running.")

        session_id = f"session_{now_ts()}"
        session    = ProcessingSession(session_id, config, self.app_config)
        self.current_session = session

        target = self._run_video if config.get("mode", "upload") == "upload" else self._run_camera
        self._thread = threading.Thread(target=target, args=(session, config), daemon=True)
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
        return self.current_session.get_stats() if self.current_session else {"status": "idle"}

    def get_latest_frame(self) -> Optional[bytes]:
        return self.current_session.latest_frame if self.current_session else None

    # ------------------------------------------------------------------
    # Private – build ObjectCounter
    # ------------------------------------------------------------------

    def _build_counter(
        self, session: ProcessingSession, frame_shape: tuple, config: dict
    ) -> ObjectCounter:
        _det = self.app_config.get("detection", {})
        _trk = self.app_config.get("tracking",  {})
        _roi = self.app_config.get("roi",        {})
        _cls = self.app_config.get("classes",    {})

        model_name    = config.get("model",   _det.get("default_model",   "yolo11n.pt"))
        tracker       = config.get("tracker", _trk.get("default_tracker", "bytetrack.yaml"))
        classes       = config.get("classes", _cls.get("coco_vehicle_ids", [2, 3, 5, 7]))
        region_points = config.get("region_points", [])
        roi_mode      = config.get("roi_mode", _roi.get("default_mode", "polygon"))

        h, w = frame_shape[:2]
        if not region_points:
            if roi_mode == "line":
                region_points = [[0, h // 2], [w, h // 2]]
            else:
                m = 50
                region_points = [[m, m], [w - m, m], [w - m, h - m], [m, h - m]]

        session.model_name    = model_name
        session.tracker_name  = tracker
        session.region_points = region_points   # ← save for ghost ROI
        session.roi_mode      = roi_mode

        return ObjectCounter(
            show=False,
            region=region_points,
            model=model_name,
            classes=classes,
            tracker=tracker,
            verbose=False,
        )

    # ------------------------------------------------------------------
    # Private – shared source initialisation
    # ------------------------------------------------------------------

    def _init_source(
        self,
        session: ProcessingSession,
        config: dict,
        cap: cv2.VideoCapture,
    ) -> tuple[Optional[ObjectCounter], Optional[cv2.VideoWriter]]:
        fps_src = cap.get(cv2.CAP_PROP_FPS) or 25.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))  or 640
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480

        ret, first_frame = cap.read()
        if not ret:
            session.status = "stopped"
            cap.release()
            return None, None
        if config.get("flip", False):
            first_frame = cv2.flip(first_frame, 1)

        try:
            counter = self._build_counter(session, first_frame.shape, config)
        except Exception as e:
            print(f"[engine] Failed to build counter: {e}")
            session.status = "stopped"
            cap.release()
            return None, None

        out_path = os.path.join(self.output_dir, f"result_{now_ts()}.mp4")
        session.output_path = out_path
        fourcc = cv2.VideoWriter_fourcc(*"avc1")
        writer = cv2.VideoWriter(out_path, fourcc, fps_src, (w, h))
        if not writer.isOpened():
            raise RuntimeError("VideoWriter initialization failed. H264 codec may be unavailable.")

        return counter, writer

    # ------------------------------------------------------------------
    # Private – per-frame processing
    # ------------------------------------------------------------------

    def _process_frame(
        self,
        frame,
        counter: ObjectCounter,
        session: ProcessingSession,
        writer: cv2.VideoWriter,
        frame_times: list,
        t0: float,
        is_video: bool = True,
    ) -> None:
        try:
            solution  = counter.process(frame)
            annotated = getattr(solution, "plot_im", None)
            if annotated is None:
                annotated = frame

            session.in_count    = getattr(solution, "in_count",  0)
            session.out_count   = getattr(solution, "out_count", 0)
            session.total_count = session.in_count + session.out_count

            with session._lock:
                session.current_vehicles = getattr(solution, "total_tracks", 0)
                cls_counts = getattr(solution, "classwise_count", {})
                if cls_counts:
                    for label, cnt_data in cls_counts.items():
                        label = str(label).lower()
                        session.vehicle_counts[label] = (
                            cnt_data.get("IN", 0) + cnt_data.get("OUT", 0)
                        )

        except Exception as e:
            print(f"[engine] {'Frame' if is_video else 'Camera frame'} processing error: {e}")
            annotated = frame

        writer.write(annotated)
        _, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, self._JPEG_QUALITY])
        session.latest_frame = buf.tobytes()
        session.frame_count += 1

        if is_video:
            session.processed_frames = session.frame_count
            if session.total_frames > 0:
                session.progress = int(session.processed_frames * 100 / session.total_frames)
            elapsed = time.time() - session.start_time
            if session.processed_frames > 0:
                speed  = session.processed_frames / elapsed
                remain = session.total_frames - session.processed_frames
                session.eta = int(remain / speed)

        frame_times.append(time.time() - t0)
        if len(frame_times) > self._FPS_WINDOW:
            frame_times.pop(0)
        session.fps = 1.0 / (sum(frame_times) / len(frame_times)) if frame_times else 0.0

        session.cpu_usage = round(psutil.cpu_percent(interval=None), 1)
        session.ram_usage = round(psutil.virtual_memory().percent, 1)

    # ------------------------------------------------------------------
    # Private – video processing
    # ------------------------------------------------------------------

    def _run_video(self, session: ProcessingSession, config: dict) -> None:
        video_path = config.get("video_path", "")
        session.video_name  = os.path.basename(video_path)
        session.status      = "running"
        session.start_time  = time.time()

        cap = cv2.VideoCapture(video_path)
        session.total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if not cap.isOpened():
            session.status = "stopped"
            return

        counter, writer = self._init_source(session, config, cap)
        if counter is None:
            return

        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

        frame_times: list = []
        while not session.stop_event.is_set():
            while session.pause_event.is_set() and not session.stop_event.is_set():
                time.sleep(0.1)

            t0 = time.time()
            ret, frame = cap.read()
            if not ret:
                break

            self._process_frame(frame, counter, session, writer, frame_times, t0, is_video=True)

        cap.release()
        writer.release()
        session.end_time = time.time()
        session.status   = "done"
        self._finalize_session(session, config)

    # ------------------------------------------------------------------
    # Private – camera processing
    # ------------------------------------------------------------------

    def _run_camera(self, session: ProcessingSession, config: dict) -> None:
        camera_id = int(config.get("camera_id", 0))
        flip      = bool(config.get("flip", False))

        session.video_name  = f"camera_{camera_id}"
        session.status      = "running"
        session.start_time  = time.time()

        cap = cv2.VideoCapture(camera_id)
        if not cap.isOpened():
            session.status = "stopped"
            return

        counter, writer = self._init_source(session, config, cap)
        if counter is None:
            return

        frame_times: list = []
        while not session.stop_event.is_set():
            while session.pause_event.is_set() and not session.stop_event.is_set():
                time.sleep(0.1)

            t0 = time.time()
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.05)
                continue

            if flip:
                frame = cv2.flip(frame, 1)

            self._process_frame(frame, counter, session, writer, frame_times, t0, is_video=False)

        cap.release()
        writer.release()
        session.end_time = time.time()
        session.status   = "done"
        self._finalize_session(session, config)

    # ------------------------------------------------------------------
    # Private – finalize / save results
    # ------------------------------------------------------------------

    def _finalize_session(self, session: ProcessingSession, config: dict) -> None:
        folder  = create_session_folder(self.results_dir, session.session_id)
        elapsed = (session.end_time or time.time()) - (session.start_time or time.time())

        _det = self.app_config.get("detection", {})
        summary = {
            "session_id":              session.session_id,
            "video_name":              session.video_name,
            "model":                   session.model_name,
            "tracker":                 session.tracker_name,
            "confidence":              config.get("confidence", _det.get("confidence", 0.25)),
            "iou":                     config.get("iou",        _det.get("iou",        0.7)),
            "in_count":                session.in_count,
            "out_count":               session.out_count,
            "total_count":             session.total_count,
            "vehicle_counts":          session.vehicle_counts,
            "region_points":           session.region_points,  
            "roi_mode":                session.roi_mode,       
            "processing_duration":     round(elapsed, 2),
            "processing_duration_hms": seconds_to_hms(elapsed),
            "fps_avg":                 round(session.fps, 1),
            "output_video":            session.output_path,
            "date":                    now_iso(),
        }
        write_summary_json(folder, summary)
        write_statistics_csv(folder, session.vehicle_counts)
        write_vehicle_log_csv(folder, session.vehicle_log)
        append_history(summary)
        print(f"[engine] Session {session.session_id} finalized → {folder}")