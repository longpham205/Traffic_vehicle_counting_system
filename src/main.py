#src/main.py
"""
main.py - FastAPI application, REST API, session management,
video streaming, upload, statistics, history.
"""
import os
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "0"
os.environ["OPENCV_LOG_LEVEL"] = "ERROR"
os.environ["OPENCV_LOG_LEVEL"] = "SILENT"
import asyncio
import sys
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(
        asyncio.WindowsSelectorEventLoopPolicy()
    )
from contextlib import asynccontextmanager
@asynccontextmanager
async def lifespan(app):
    loop = asyncio.get_running_loop()
    def exception_handler(loop, context):
        exc = context.get("exception")
        if isinstance(exc, ConnectionResetError): return
        loop.default_exception_handler(context)
    loop.set_exception_handler(exception_handler)
    yield

import base64
import logging
import shutil
import time
from pathlib import Path
from typing import Optional

import cv2
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from starlette.requests import Request
from ultralytics.utils import LOGGER, SETTINGS

# ---------------------------------------------------------------------------
# Project root
# ---------------------------------------------------------------------------

ROOT_PROJECT = Path(__file__).resolve().parent.parent
sys.path.append(str(ROOT_PROJECT))
SETTINGS.update({"weights_dir": str(ROOT_PROJECT / "models")})
LOGGER.setLevel(logging.ERROR)
logging.getLogger("asyncio").setLevel(logging.CRITICAL)
logging.getLogger("asyncio").setLevel(logging.WARNING)

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("main")

from src.backend.engine import VehicleCountingEngine
from src.backend.utils import ensure_dirs, load_config, load_history, read_json

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

cfg = load_config("src/config.yaml")

_sys = cfg["system"]
OUT_DIR = _sys["output_dir"]
RES_DIR = _sys["results_dir"]
UPL_DIR = _sys.get("uploads_dir", "uploads")
ensure_dirs(OUT_DIR, RES_DIR, UPL_DIR)

_det = cfg.get("detection", {})
_trk = cfg.get("tracking",  {})
_roi = cfg.get("roi",        {})
_cls = cfg.get("classes",    {})

app = FastAPI(title="Traffic Vehicle Counting System", version="1.0.0", lifespan=lifespan)

app.mount("/src/frontend/static", StaticFiles(directory="src/frontend/static"), name="static")
app.mount("/data/outputs",        StaticFiles(directory=str(OUT_DIR)),           name="outputs")
app.mount("/results",             StaticFiles(directory=str(RES_DIR)),           name="results")
templates = Jinja2Templates(directory="src/frontend/templates")

engine = VehicleCountingEngine(cfg)

# Camera preview state on app.state (avoids bare globals)
app.state.preview_running = False
app.state.preview_cap: Optional[cv2.VideoCapture] = None

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class StartRequest(BaseModel):
    mode:          str            = "upload"
    video:         Optional[str]  = None
    camera_id:     int            = 0
    flip:          bool           = False       
    model:         str            = _det.get("default_model",   "yolo11n.pt")
    tracker:       str            = _trk.get("default_tracker", "bytetrack.yaml")
    confidence:    float          = _det.get("confidence", 0.25)
    iou:           float          = _det.get("iou",        0.70)
    classes:       list           = _cls.get("coco_vehicle_ids", [2, 3, 5, 7])
    roi_mode:      str            = _roi.get("default_mode", "polygon")
    region_points: list           = []

# ---------------------------------------------------------------------------
# Routes – pages
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")

@app.get("/config")
async def get_config():
    return cfg

# ---------------------------------------------------------------------------
# Routes – upload
# ---------------------------------------------------------------------------

ALLOWED_VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    """Upload a video file; returns filename + base64 first frame for ROI drawing."""
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_VIDEO_EXTS:
        raise HTTPException(status_code=400, detail="Unsupported file type.")

    dest = Path(UPL_DIR) / file.filename
    if dest.exists():
        dest = Path(UPL_DIR) / f"{dest.stem}_{int(time.time())}{ext}"

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    frame_b64 = _first_frame_b64(str(dest))
    log.info("Uploaded: %s", dest.name)
    return JSONResponse({
        "filename":    dest.name,
        "path":        str(dest),
        "first_frame": frame_b64,
    })


@app.get("/first_frame")
async def first_frame(source: str, camera_id: int = 0, flip: int = 0):
    """Return base64 JPEG of the first frame from a video file or camera."""
    if source == "camera":
        cap = cv2.VideoCapture(camera_id,cv2.CAP_DSHOW)
    else:
        cap = cv2.VideoCapture(os.path.join(UPL_DIR, source))

    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise HTTPException(status_code=400, detail="Cannot read frame from source.")

    if flip:
        frame = cv2.flip(frame, 1)

    _, buf = cv2.imencode(".jpg", frame)
    return JSONResponse({
        "frame":  base64.b64encode(buf).decode(),
        "width":  frame.shape[1],
        "height": frame.shape[0],
    })

# ---------------------------------------------------------------------------
# Routes – camera preview
# ---------------------------------------------------------------------------

@app.get("/camera_feed")
def camera_feed(camera_id: int = 0, flip: int = 0):
    if app.state.preview_cap is not None:
        try:
            app.state.preview_cap.release()
        except:
            pass
        app.state.preview_cap = None
    def gen():
        app.state.preview_running = True
        app.state.preview_cap     = cv2.VideoCapture(camera_id)
        cap = app.state.preview_cap
        try:
            while app.state.preview_running:
                ret, frame = cap.read()
                if not ret:
                    break
                if flip:
                    frame = cv2.flip(frame, 1)
                _, buf = cv2.imencode(".jpg", frame)
                yield (
                    b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                    + buf.tobytes()
                    + b"\r\n"
                )
        finally:
            cap.release()
            app.state.preview_cap = None

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.post("/stop_camera")
def stop_camera():
    app.state.preview_running = False
    if app.state.preview_cap is not None:
        try:
            app.state.preview_cap.release()
        except Exception:
            pass
        app.state.preview_cap = None
    return {"status": "stopped"}

# ---------------------------------------------------------------------------
# Routes – session control
# ---------------------------------------------------------------------------

@app.post("/start")
async def start_session(req: StartRequest):
    config = req.dict()
    if req.mode == "upload":
        if not req.video:
            raise HTTPException(status_code=400, detail="No video specified.")
        config["video_path"] = os.path.join(UPL_DIR, req.video)
        if not os.path.exists(config["video_path"]):
            raise HTTPException(status_code=404, detail="Video file not found.")

    try:
        session_id = engine.start_session(config)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    log.info("Session started: %s (mode=%s, flip=%s)", session_id, req.mode, req.flip)
    return JSONResponse({"session_id": session_id, "status": "started"})


@app.post("/stop")
async def stop_session():
    engine.stop_session()
    return JSONResponse({"status": "stopped"})


@app.post("/pause")
async def pause_session():
    engine.pause_session()
    return JSONResponse({"status": "paused"})


@app.post("/resume")
async def resume_session():
    engine.resume_session()
    return JSONResponse({"status": "running"})

# ---------------------------------------------------------------------------
# Routes – stats & history
# ---------------------------------------------------------------------------

@app.get("/stats")
async def get_stats():
    return JSONResponse(engine.get_stats())


@app.get("/history")
async def get_history():
    return JSONResponse(load_history())


@app.get("/session/{session_id}")
async def get_session_detail(session_id: str):
    summary_path = os.path.join(RES_DIR, session_id, "summary.json")
    if not os.path.exists(summary_path):
        raise HTTPException(status_code=404, detail="Session not found.")
    return JSONResponse(read_json(summary_path))

# ---------------------------------------------------------------------------
# Routes – result video
# ---------------------------------------------------------------------------

@app.get("/result_video/{session_id}")
async def result_video(session_id: str):
    summary_path = os.path.join(RES_DIR, session_id, "summary.json")
    if not os.path.exists(summary_path):
        raise HTTPException(status_code=404, detail="Session not found.")
    video_path = read_json(summary_path).get("output_video", "")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Result video not found.")
    return FileResponse(video_path, media_type="video/mp4")

# ---------------------------------------------------------------------------
# Routes – MJPEG live stream
# ---------------------------------------------------------------------------

@app.get("/video_feed")
async def video_feed():
    def _gen():
        boundary = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
        while True:
            frame = engine.get_latest_frame()
            if frame:
                yield boundary + frame + b"\r\n"
            time.sleep(0.033)

    return StreamingResponse(_gen(), media_type="multipart/x-mixed-replace; boundary=frame")

# ---------------------------------------------------------------------------
# Routes – CSV export
# ---------------------------------------------------------------------------

def _csv_response(session_id: str, filename: str) -> FileResponse:
    path = os.path.join(RES_DIR, session_id, filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(path, media_type="text/csv", filename=filename)


@app.get("/export/statistics/{session_id}")
async def export_statistics(session_id: str):
    return _csv_response(session_id, "statistics.csv")


@app.get("/export/vehicle_log/{session_id}")
async def export_vehicle_log(session_id: str):
    return _csv_response(session_id, "vehicle_log.csv")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _first_frame_b64(video_path: str) -> str:
    cap = cv2.VideoCapture(video_path)
    ret, frame = cap.read()
    cap.release()
    if not ret:
        return ""
    _, buf = cv2.imencode(".jpg", frame)
    return base64.b64encode(buf).decode()

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    host = _sys.get("host", "0.0.0.0")
    port = _sys.get("port", 8000)
    display_host = "127.0.0.1" if host == "0.0.0.0" else host
    log.info("Starting server at http://%s:%d/", display_host, port)
    uvicorn.run("main:app", host=host, port=port, reload=False)