# 🚗 Traffic Vehicle Counting System

> A real-time, web-based traffic analysis system powered by YOLO11 and Ultralytics ObjectCounter — built for vehicle detection, tracking, and directional counting via an interactive browser dashboard.

---
## 📌 Table of Contents

- [0. ⚡ Quick Start](#-quick-start)
- [1. 📌 Project Overview](#-project-overview)
- [2. ✨ Features](#-features)
- [3. 🧠 How It Works](#-how-it-works)
- [4. 🏗 System Architecture](#-system-architecture)
- [5. 📁 Project Structure](#-project-structure)
- [6. ⚙️ Installation](#️-installation)
- [7. 🚀 Run Project](#-run-project)
- [8. 🎮 Usage Guide](#-usage-guide)
- [9. ⚙️ Configuration](#️-configuration)
- [10. 📊 Output Files](#-output-files)
- [11. 🧠 Core Algorithm](#-core-algorithm)
- [12. ⚠️ Limitations](#️-limitations)
- [13. 🔮 Future Improvements](#-future-improvements)
- [14. 👨‍💻 Author](#-author)

---

## 0. ⚡ Quick Start

### 🚀 Option 1 — Run with script (RECOMMENDED)
```bash
# 1. Clone the repository
git clone https://github.com/longpham205/Traffic_vehicle_counting_system.git
cd traffic_vehicle_system

# Windows
run.bat

# macOS / Linux
bash run.sh
```
### 🛠️ Option 2 — Manual setup (for development)
```bash
# 1. Clone the repository
git clone https://github.com/your-username/traffic_vehicle_system.git
cd traffic_vehicle_system

# 2. Create and activate virtual environment
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

# 3. Install dependencies
pip install fastapi uvicorn ultralytics opencv-python psutil pyyaml python-multipart

# 4. Run the server
python main.py

# 5. Open your browser
http://localhost:8000
```

> **Note:** YOLO model weights (`yolo11n.pt`, `yolo11s.pt`, `yolo11m.pt`) are downloaded automatically by Ultralytics on first run. An internet connection is required for the initial download only.

---

## 1.📌 Project Overview

This system solves the problem of manual traffic monitoring by providing an automated, AI-powered vehicle counting platform accessible from any browser.

**Input:** A video file or live camera stream, with a user-defined Region of Interest (ROI).

**Output:** A processed video with visual overlays, real-time IN/OUT directional counts, per-vehicle-type statistics, and exportable reports.

The system requires no database. All session data is persisted as JSON and CSV files, making it portable, lightweight, and easy to review without external dependencies.

---

## 2. ✨ Features

### 📁 Video Upload Mode
- Upload `.mp4`, `.avi`, `.mov`, `.mkv`, or `.webm` files
- First frame is extracted immediately for ROI drawing
- Full video is processed and a result video is generated

### 📷 Real-Time Camera Mode
- Connect to any system camera by index
- Live preview before starting
- Process and count vehicles in real time from the camera stream

### 🖊️ ROI System
- Draw ROI directly on the video frame in the browser
- Two modes: **Line** (2-point crossing line) and **Polygon** (freeform region)
- ROI coordinates are sent to the backend and passed directly into ObjectCounter
- No hardcoded regions — fully dynamic per session

### 🔍 Detection & Tracking
- YOLO11 models: Nano, Small, or Medium
- Trackers: ByteTrack or BoTSORT
- Configurable confidence threshold and IoU threshold
- Class filtering: Car, Motorcycle, Bus, Truck, Bicycle, Person

### 📊 Statistics Dashboard
- Live IN / OUT / TOTAL / CURRENT counters
- Per-vehicle-type bar chart (Chart.js)
- Session info panel: model, tracker, duration, average FPS
- CPU and RAM usage bars updated in real time

### 📋 History System
- Every completed session is logged automatically
- History panel lists all past sessions with date, model, tracker, and total count
- Click any session to open a detail modal with result video, summary, and distribution chart

### 📤 Export System
- Processed result video downloadable as `.mp4`
- `statistics.csv` — per-type vehicle counts
- `vehicle_log.csv` — per-track log with ID, type, direction, and timestamp
- `summary.json` — full session metadata

---

## 3. ⚙️ How It Works

### Processing Pipeline

```
User (Browser)
    │
    ├─► Upload video / Select camera
    ├─► Draw ROI on frame canvas
    ├─► Configure model, tracker, classes
    │
    ▼
Frontend (JS) ──POST /start──► FastAPI (main.py)
                                    │
                                    ▼
                              Engine (engine.py)
                                    │
                                    ▼
                               ObjectCounter
                        ┌────────────────────────────┐   
                        │ detection    ROI crossing  │
                        │ tracking   IN/OUT counting │               
                        └───────────┬────────────────┘
                                    ▼
                          Annotated frames → MJPEG stream
                          Statistics → GET /stats (polled every 800ms)
                          Result video → outputs/
                          Reports → results/session_*/
```

### ROI Role
The user-drawn ROI is converted from canvas coordinates to actual video pixel coordinates before being sent to the backend. ObjectCounter uses this region to determine when a tracked object crosses the boundary, assigning a direction (IN or OUT) based on which side the object came from.

### Detection Flow
Each frame is passed through the YOLO11 model using `ObjectCounter()`, which runs detection and associates detections to existing tracks using the selected tracker (ByteTrack or BoTSORT). Only the configured class IDs are detected.

### Tracking Flow
ByteTrack and BoTSORT maintain a unique `track_id` for each object across frames using motion prediction and re-identification. This ensures that each vehicle is counted only once even if it temporarily disappears from view.

### IN/OUT Counting Logic
Ultralytics `ObjectCounter` monitors the centroid trajectory of each tracked object relative to the defined ROI. When a centroid crosses the ROI boundary, the direction of movement determines whether it is counted as IN or OUT.

---

## 4. 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        BROWSER                          │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Dashboard   │  │  ROI Canvas  │  │  History     │   │
│  │  (stats,     │  │  (draw line/ │  │  (modal,     │   │
│  │   charts)    │  │   polygon)   │  │   export)    │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│          HTML + CSS + Vanilla JS + Chart.js             │
└────────────────────────┬────────────────────────────────┘
                         │  REST API / MJPEG Stream
┌────────────────────────▼────────────────────────────────┐
│                    FastAPI (main.py)                    │
│                                                         │
│  POST /upload   POST /start    GET /stats               │
│  POST /stop     POST /pause    GET /history             │
│  POST /resume   GET /video_feed  GET /session/{id}      │
│  GET /export/statistics/{id}  GET /export/vehicle_log   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                 Engine (engine.py)                      │
│                                                         │
│   VehicleCountingEngine                                 │
│   ├── Ultralytics ObjectCounter                         │
│   ├── ProcessingSession (thread-safe state)             │
│   └── Background thread (video / camera loop)           │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                   Storage (File-based)                  │
│                                                         │
│   uploads/          ← input videos                      │
│   outputs/          ← processed result videos           │
│   results/          ← per-session reports               │
│   history.json      ← session index                     │
└─────────────────────────────────────────────────────────┘
```

---

## 5. 📂 Project Structure

```
traffic_vehicle_system
├── data
│   ├── outputs          # Contains the processed video output (video output with bounding boxes and counting).
│   └── uploads          # Save user-uploaded videos before processing.
│
├── models               # Contains YOLO model weights (yolo11n/s/m.pt hoặc tự download lần đầu)
│
├── results              # Save all results by session.
│                        # Each session includes: summary.json, statistics.csv, vehicle_log.csv
│
├── src
│   ├── backend
│   │   ├── engine.py    # Core AI engine:
│   │   │                # - YOLO detection
│   │   │                # - Object tracking (ByteTrack / BoT-SORT)
│   │   │                # - Vehicle counting logic (IN / OUT)
│   │   │                # - ROI processing
│   │   │                # - Real-time frame processing
│   │   │
│   │   └── utils.py     # Utility functions:
│   │                    # - File handling (save/load JSON, CSV)
│   │                    # - Session folder creation
│   │                    # - Timestamp helpers
│   │                    # - History management
│   ├── frontend
│   │   ├── static
│   │   │   ├── app.js   # Frontend logic:
│   │   │   │            # - API calls (fetch /upload, /start, /stats)
│   │   │   │            # - ROI drawing interaction
│   │   │   │            # - UI state management (start/stop/pause)
│   │   │   │            # - Chart.js statistics rendering
│   │   │   │
│   │   │   └── style.css # UI styling:
│   │   │                 # - Dark dashboard theme
│   │   │                 # - Layout (left video panel, right stats panel)
│   │   │                 # - Responsive UI components
│   │   │
│   │   └── templates
│   │       └── index.html # Main dashboard UI:
│   │                        # - Video preview
│   │                        # - ROI tools
│   │                        # - Statistics dashboard
│   │                        # - History panel
│   │
│   ├── main.py      # FastAPI application layer:
│   │                # - REST API endpoints (/upload, /start, /stop, /stats, /history)
│   │                # - MJPEG video streaming (/video_feed)
│   │                # - Session management (start/stop lifecycle)
│   │                # - NO AI logic (delegates to engine.py)
│   │
│   ├── config.yaml      # System configuration:
│   │                    # - YOLO model selection
│   │                    # - Tracker settings
│   │                    # - Confidence / IoU thresholds
│   │                    # - ROI default mode
│   │
│   └── history.json     # Stores session history metadata (for UI history panel)
│
├── requirements.txt     # Python dependencies list
│
├── run.bat              # Windows startup script (auto run server + environment setup optional)
│
└── run.sh               # Linux/Mac startup script (bash launcher for server)
```

---

## 6. 🛠️ Installation

### Requirements
- Python **3.10** or higher
- pip
- A working webcam (optional, for camera mode only)
- Internet connection (first run only, for YOLO weight download)

### Step-by-step Setup

**1. Create a virtual environment**
```bash
python -m venv venv
```

**2. Activate it**
```bash
# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate
```

**3. Install all dependencies**
```bash
pip install fastapi uvicorn ultralytics opencv-python psutil pyyaml python-multipart
```

> If you are on a machine **without a GPU**, the system runs on CPU automatically. No additional configuration is required.

> If you have a CUDA-enabled GPU and want GPU acceleration, install the matching PyTorch version before installing Ultralytics:
> ```bash
> pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118
> ```

---

## 7. ▶️ Run Project

**Standard run:**
```bash
python main.py
```

**Using uvicorn directly (with auto-reload for development):**
```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The server starts on:
```
http://localhost:8000
```

To change the default host or port, edit `config.yaml`:
```yaml
system:
  host: 0.0.0.0
  port: 8000
```

---

## 8. 📖 Usage Guide

### Mode 1 — Upload Video

| Step | Action |
|------|--------|
| 1 | Select **Upload Video** mode |
| 2 | Click the upload area or drag-and-drop a video file |
| 3 | Wait for the first frame to appear in the preview area |
| 4 | Click **Draw ROI** and click on the frame to place points |
| 5 | Double-click to finish a polygon, or place 2 points for a line |
| 6 | Click **Save ROI** to confirm your region |
| 7 | Open **Config** to adjust model, tracker, confidence, IoU, and classes |
| 8 | Click **Start** — all controls lock during processing |
| 9 | Watch the live MJPEG stream and real-time stats update |
| 10 | Processing ends automatically; result video appears below the preview |

### Mode 2 — Real-Time Camera

| Step | Action |
|------|--------|
| 1 | Select **Live Camera** mode |
| 2 | Enter the camera index (usually `0` for the built-in webcam) |
| 3 | Click **Preview** to verify the camera is accessible |
| 4 | Draw and save your ROI on the preview frame |
| 5 | Configure detection settings via **Config** |
| 6 | Click **Start** to begin live counting |
| 7 | Click **Stop** when finished — results are saved automatically |

### Viewing History

- The **History** panel on the right lists all past sessions
- Click any session row to open a detail modal
- The modal shows the result video, a distribution chart (switchable between count and percentage), and full session metadata
- Download the result video, statistics CSV, or vehicle log CSV from within the modal

---

## 9. 🔧 Configuration

All defaults are stored in `config.yaml`. Runtime configuration is done through the **Config drawer** in the UI.

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| **Model** | `yolo11n.pt`, `yolo11s.pt`, `yolo11m.pt` | `yolo11n.pt` | YOLO11 variant. Nano is fastest; Medium is most accurate |
| **Tracker** | `bytetrack.yaml`, `botsort.yaml` | `bytetrack.yaml` | Tracking algorithm. ByteTrack is faster; BoTSORT is more robust in crowded scenes |
| **Confidence** | 0.1 – 0.9 | `0.25` | Minimum detection confidence. Lower = more detections, more false positives |
| **IoU** | 0.1 – 0.9 | `0.70` | Intersection over Union threshold for NMS. Higher = stricter duplicate filtering |
| **Classes** | Car, Motorcycle, Bus, Truck, Bicycle, Person | Car, Motorcycle, Bus, Truck | COCO class IDs to detect. Uncheck to exclude a type |
| **ROI Mode** | `line`, `polygon` | `polygon` | Line requires 2 points; Polygon requires 3+ points (double-click to close) |

---

## 10. 📁 Output Files

Every completed session creates a folder under `results/`:

```
results/session_20260611_230145/
├── summary.json
├── statistics.csv
└── vehicle_log.csv
```

Processed videos are saved in `outputs/`:
```
outputs/result_20260611_230145.mp4
```

### `summary.json`
Full session record including video name, model, tracker, confidence, IoU, IN count, OUT count, total count, processing duration, and average FPS.

```json
{
  "session_id": "session_20260611_230145",
  "video_name": "highway.mp4",
  "model": "yolo11n.pt",
  "tracker": "bytetrack.yaml",
  "confidence": 0.25,
  "iou": 0.7,
  "in_count": 142,
  "out_count": 98,
  "total_count": 240,
  "processing_duration": 87.4,
  "processing_duration_hms": "00:01:27"
}
```

### `statistics.csv`
Aggregate count per vehicle type.

```
vehicle_type,count
car,160
motorcycle,55
bus,12
truck,13
```

### `vehicle_log.csv`
Per-track event log. One row per counted crossing.

```
track_id,type,direction,time
15,car,IN,00:01:12
16,motorcycle,OUT,00:01:15
23,truck,IN,00:01:41
```

---

## 11. 🧠 Core Algorithm

### YOLO Detection
Each video frame is passed to a YOLO11 model, which outputs bounding boxes, class labels, and confidence scores for all detected objects. Only objects matching the configured class IDs and above the confidence threshold are kept.

### Object Tracking
The tracking algorithm (ByteTrack or BoTSORT) receives the per-frame detections and maintains a persistent identity (`track_id`) for each object across frames. ByteTrack associates detections using IoU-based matching and a Kalman filter for motion prediction. BoTSORT adds appearance-based re-identification, making it more robust when objects briefly disappear or overlap.

### ROI Crossing Logic
The user-drawn ROI is passed as a list of pixel coordinates to Ultralytics `ObjectCounter`. On each frame, ObjectCounter checks whether the centroid of each tracked object has crossed the defined boundary since the last frame. A state machine per track prevents double-counting.

### Directional Counting
When a centroid crosses the ROI, the direction of movement relative to the ROI normal determines whether it is an IN or OUT event. The system increments the corresponding counter and logs the event with the track ID, vehicle type, direction, and timestamp.

---

## 12. ⚠️ Limitations

- **CPU performance:** Processing speed is significantly slower on CPU-only machines. High-resolution videos or complex scenes may run below real-time speed. YOLO11n is recommended for CPU use.
- **Tracking errors under occlusion:** When vehicles overlap for extended periods, trackers may lose or swap identities, leading to occasional double-counting or missed counts.
- **Real-time lag:** The MJPEG stream displayed in the browser may lag several frames behind the actual processing, especially on slower machines.
- **Single session constraint:** Only one processing session can run at a time. Starting a new session requires stopping the current one.
- **No GPU auto-detection UI:** GPU vs CPU selection is handled automatically by PyTorch; there is no manual toggle in the interface.
- **File-based storage only:** All data is stored as flat files. Large numbers of sessions (hundreds+) may slow down history loading.

---

## 13. 🔮 Future Improvements

- **Multi-camera support** — run simultaneous sessions from multiple camera sources, each with its own ROI and counter
- **Database integration** — replace JSON/CSV file storage with SQLite or PostgreSQL for scalable session querying and filtering
- **Speed estimation** — use perspective transformation and known real-world distances to estimate vehicle speed from tracked trajectories
- **Vehicle density heatmap** — generate spatial heatmaps showing where vehicles spend the most time within the frame
- **Alert system** — trigger notifications when vehicle count exceeds a configurable threshold
- **Cloud deployment** — containerize with Docker and deploy to AWS / GCP / Azure with object storage for result files
- **Mobile-responsive UI** — adapt the dashboard layout for tablet and mobile monitoring
- **Export to PDF report** — auto-generate a formatted PDF summary for each session

---

## 14. 👤 Author

| Field | Detail |
|-------|--------|
| **Name** | Long Pham |
| **University** | HaUI - Hanoi University of Industry |
| **Institution** | SICT - SCHOOL OF INFORMATION & COMMUNICATIONS TECHNOLOGY |
| **Program** | Computer Science / Software Engineering |
| **Year** | 2026 |
| **Contact** | longtailieu304@gmail.com |

---

## 📄 License

This project is developed for academic and educational purposes.
Feel free to use, modify, and extend it with attribution.

---

*Built with [FastAPI](https://fastapi.tiangolo.com/) · [Ultralytics YOLO](https://docs.ultralytics.com/) · [OpenCV](https://opencv.org/) · [Chart.js](https://www.chartjs.org/)*
