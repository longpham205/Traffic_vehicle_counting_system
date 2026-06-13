"""
main.py - FastAPI application, REST API, session management,
video streaming, upload, statistics, history.
"""

import os,sys
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "-8"
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "0"
import shutil
import time
from pathlib import Path
from typing import Optional
import cv2
import logging

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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
from ultralytics.utils import SETTINGS, LOGGER

#ROOT_PROJECT
ROOT_PROJECT = Path(__file__).resolve().parent.parent
print("ROOT_PROJECT",ROOT_PROJECT)
sys.path.append(str(ROOT_PROJECT))
SETTINGS.update({ "weights_dir": str(ROOT_PROJECT / "models")})
LOGGER.setLevel(logging.ERROR)

from src.backend.engine import VehicleCountingEngine
from src.backend.utils import ensure_dirs, load_config, load_history, read_json

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

cfg = load_config("src/config.yaml")
OUT_DIR = cfg["system"]["output_dir"]
RES_DIR = cfg["system"]["results_dir"]
UPL_DIR = cfg["system"].get("uploads_dir", "uploads")
ensure_dirs(OUT_DIR, RES_DIR, UPL_DIR)

app = FastAPI(title="Traffic Vehicle Counting System", version="1.0.0")

# Static files & templates
app.mount("/src/frontend/static", StaticFiles(directory="src/frontend/static"), name="static")
app.mount("/data/outputs", StaticFiles(directory=str(OUT_DIR)), name="outputs")
app.mount("/results", StaticFiles(directory=str(RES_DIR)), name="results")
templates = Jinja2Templates(directory="src/frontend/templates")

engine = VehicleCountingEngine(output_dir=OUT_DIR, results_dir=RES_DIR)

#Load api config
@app.get("/config")
async def get_config():
    return {
        "model": cfg["detection"]["default_model"],
        "confidence": cfg["detection"]["confidence"],
        "iou": cfg["detection"]["iou"],
        "tracker": cfg["tracking"]["default_tracker"],
        "roi_mode": cfg["roi"]["default_mode"],
        "classes": cfg["classes"]["coco_vehicle_ids"],
        "labels": cfg["classes"]["labels"]
    }

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class StartRequest(BaseModel):
    mode: str = "upload"                       # upload | camera
    video: Optional[str] = None               # filename in uploads/
    camera_id: Optional[int] = 0
    model: str = "yolo11n.pt"
    tracker: str = "bytetrack.yaml"
    confidence: float = 0.25
    iou: float = 0.70
    classes: list = [2, 3, 5, 7]
    roi_mode: str = "polygon"
    region_points: list = []

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request}
    )

# ------------------------------------------------------------------
# Upload
# ------------------------------------------------------------------
@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    """Upload a video file and return its saved filename."""
    allowed = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported file type.")

    dest = os.path.join(UPL_DIR, file.filename)
    # Avoid collisions
    if os.path.exists(dest):
        stem = Path(file.filename).stem
        dest = os.path.join(UPL_DIR, f"{stem}_{int(time.time())}{ext}")

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Return the first frame as a JPEG for ROI drawing
    import cv2, base64
    cap = cv2.VideoCapture(dest)
    ret, frame = cap.read()
    cap.release()
    frame_b64 = ""
    if ret:
        _, buf = cv2.imencode(".jpg", frame)
        frame_b64 = base64.b64encode(buf).decode()
        
    print("=" * 50)
    print("UPLOAD REQUEST RECEIVED")
    print("Filename:", file.filename)
    print("Content Type:", file.content_type)

    return JSONResponse({
        "filename": os.path.basename(dest),
        "path": dest,
        "first_frame": frame_b64,
    })

# ------------------------------------------------------------------
# Get first frame for ROI drawing (for camera or re-request)
# ------------------------------------------------------------------
@app.get("/first_frame")
async def first_frame(source: str, camera_id: int = 0):
    """
    source: 'upload' | 'camera'
    Returns base64 JPEG of first frame.
    """
    import cv2, base64
    if source == "camera":
        cap = cv2.VideoCapture(camera_id)
    else:
        # source is treated as filename
        path = os.path.join(UPL_DIR, source)
        cap = cv2.VideoCapture(path)

    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise HTTPException(status_code=400, detail="Cannot read frame from source.")

    _, buf = cv2.imencode(".jpg", frame)
    b64 = base64.b64encode(buf).decode()
    return JSONResponse({"frame": b64, "width": frame.shape[1], "height": frame.shape[0]})

# ------------------------------------------------------------------
# Webcam
# ------------------------------------------------------------------
preview_camera_running = False
preview_cap = None
@app.get("/camera_feed")
def camera_feed():
    def gen():
        global preview_camera_running
        global preview_cap
        preview_camera_running = True
        preview_cap = cv2.VideoCapture(0)

        while preview_camera_running:
            success, frame = preview_cap.read()
            if not success:
                break
            _, buffer = cv2.imencode(".jpg", frame)
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + buffer.tobytes()
                + b"\r\n"
            )
        if preview_cap:
            preview_cap.release()
            preview_cap = None
    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )
    
@app.post("/stop_camera")
def stop_camera():
    global preview_camera_running
    preview_camera_running = False
    return {"status": "stopped"}

# ------------------------------------------------------------------
# Start / Stop / Pause / Resume
# ------------------------------------------------------------------

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
    
    print("\n" + "=" * 60)
    print("START SESSION REQUEST")
    print("RAW REQUEST:")
    print(req.dict())
    print("=" * 60)

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


# ------------------------------------------------------------------
# Statistics
# ------------------------------------------------------------------

@app.get("/stats")
async def get_stats():
    return JSONResponse(engine.get_stats())


# ------------------------------------------------------------------
# History
# ------------------------------------------------------------------

@app.get("/history")
async def get_history():
    return JSONResponse(load_history())


@app.get("/session/{session_id}")
async def get_session_detail(session_id: str):
    summary_path = os.path.join(RES_DIR, session_id, "summary.json")
    if not os.path.exists(summary_path):
        raise HTTPException(status_code=404, detail="Session not found.")
    summary = read_json(summary_path)
    return JSONResponse(summary)


# ------------------------------------------------------------------
# Result video download / stream
# ------------------------------------------------------------------

@app.get("/result_video/{session_id}")
async def result_video(session_id: str):
    summary_path = os.path.join(RES_DIR, session_id, "summary.json")
    if not os.path.exists(summary_path):
        raise HTTPException(status_code=404, detail="Session not found.")
    summary = read_json(summary_path)
    video_path = summary.get("output_video", "")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Result video not found.")
    return FileResponse(video_path, media_type="video/mp4")


# ------------------------------------------------------------------
# MJPEG stream
# ------------------------------------------------------------------

def _mjpeg_generator():
    boundary = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
    while True:
        frame = engine.get_latest_frame()
        if frame:
            yield boundary + frame + b"\r\n"
        time.sleep(0.033)   # ~30 fps ceiling


@app.get("/video_feed")
async def video_feed():
    return StreamingResponse(
        _mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ------------------------------------------------------------------
# CSV export download
# ------------------------------------------------------------------

@app.get("/export/statistics/{session_id}")
async def export_statistics(session_id: str):
    path = os.path.join(RES_DIR, session_id, "statistics.csv")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(path, media_type="text/csv", filename="statistics.csv")


@app.get("/export/vehicle_log/{session_id}")
async def export_vehicle_log(session_id: str):
    path = os.path.join(RES_DIR, session_id, "vehicle_log.csv")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(path, media_type="text/csv", filename="vehicle_log.csv")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    host = cfg["system"].get("host", "0.0.0.0")
    port = cfg["system"].get("port", 8000)
    uvicorn.run("main:app", host=host, port=port, reload=False)
