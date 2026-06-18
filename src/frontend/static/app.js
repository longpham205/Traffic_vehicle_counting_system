/* =========================================================
   Traffic Vehicle Counting System — app.js
   Vanilla JS, no dependencies beyond Chart.js (CDN)
   ========================================================= */

'use strict';

// =========================================================
// CONSTANTS
// =========================================================
const MODE = { UPLOAD: 'upload', CAMERA: 'camera' };
const ROI  = { LINE: 'line', POLYGON: 'polygon' };

// =========================================================
// STATE
// =========================================================
const state = {
  mode:             MODE.UPLOAD,
  uploadedFilename: null,
  uploadedFilePath: null,
  sessionRunning:   false,
  sessionId:        null,
  roiMode:          ROI.POLYGON,
  roiDrawing:       false,
  roiPoints:        [],
  roiSaved:         false,
  statsInterval:    null,
  streamActive:     false,
  config:           {},
  frameSize:        { w: 640, h: 360 },
  firstFrameBase64: null,
  cameraFlip:       false,
  ghostRoiPoints:   null,
  ghostRoiMode:     null,
};

// =========================================================
// CONFIG
// =========================================================
async function loadConfig() {
  try {
    const res = await fetch('/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();

    state.config = {
      model:      cfg.detection.default_model,
      tracker:    cfg.tracking.default_tracker,
      confidence: cfg.detection.confidence,
      iou:        cfg.detection.iou,
      classes:    cfg.ui.default_selected_classes || cfg.classes.coco_vehicle_ids,
      labels:     cfg.classes.labels,
      display:    cfg.classes.display || {},
      roi_mode:   cfg.roi.default_mode,
      models:     cfg.models   || [],
      trackers:   cfg.trackers || [],

      // UI timing / text — fallbacks kept in case config.yaml hasn't been updated yet
      statsPollIntervalMs:  cfg.ui.stats_poll_interval_ms   ?? 800,
      toastDurationMs:      cfg.ui.toast_duration_ms        ?? 3000,
      cameraRestartDelayMs: cfg.ui.camera_restart_delay_ms  ?? 300,
      cameraStopDelayMs:    cfg.ui.camera_stop_delay_ms     ?? 800,
      resultShowDelayMs:    cfg.ui.result_show_delay_ms     ?? 1500,
      statusLabels:         cfg.ui.status_labels            ?? {
        idle: 'IDLE', running: 'RUNNING', paused: 'PAUSED', stopped: 'STOPPED', done: 'DONE'
      },
    };
    state.roiMode = cfg.roi.default_mode;

    _populateSelect('cfg-model',   state.config.models,   state.config.model);
    _populateSelect('cfg-tracker', state.config.trackers, state.config.tracker);
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

function _populateSelect(id, items, selectedValue) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = items.map(item =>
    `<option value="${item.value}"${item.value === selectedValue ? ' selected' : ''}>${item.name}</option>`
  ).join('');
}

function applyConfigToUI() {
  $('cfg-model').value      = state.config.model;
  $('cfg-tracker').value    = state.config.tracker;
  $('cfg-confidence').value = state.config.confidence;
  $('conf-val').textContent = state.config.confidence;
  $('cfg-iou').value        = state.config.iou;
  $('iou-val').textContent  = state.config.iou.toFixed(2);
  document.querySelectorAll('.cls-check').forEach(cb => {
    cb.checked = state.config.classes.includes(Number(cb.value));
  });
  $(state.config.roi_mode === ROI.LINE ? 'roi-line' : 'roi-polygon').checked = true;
}

// =========================================================
// DOM REFERENCES
// =========================================================
const $ = id => document.getElementById(id);

// Header
const hdrModel   = $('hdr-model');
const hdrTracker = $('hdr-tracker');
const hdrStatus  = $('hdr-status');
const hdrFps     = $('hdr-fps');

// Video
const videoWrapper     = $('video-wrapper');
const videoPlaceholder = $('video-placeholder');
const videoStream      = $('video-stream');
const roiCanvas        = $('roi-canvas');
const roiStatus        = $('roi-status');
const roiModeLabel     = $('roi-mode-label');
const roiPointCount    = $('roi-point-count');

// Video Progress
const processingBar     = $('processing-bar');
const processingPercent = $('processing-percent');
const processingFrame   = $('processing-frame');
const processingEta     = $('processing-eta');

// Controls
const modeUploadRadio = $('mode-upload');
const modeCameraRadio = $('mode-camera');
const uploadSection   = $('upload-section');
const cameraSection   = $('camera-section');
const uploadLabel     = $('upload-label');
const fileInput       = $('file-input');
const uploadText      = $('upload-text');
const uploadProgress  = $('upload-progress');
const progressBar     = $('progress-bar');
const progressText    = $('progress-text');
const cameraId        = $('camera-id');

const btnDrawRoi    = $('btn-draw-roi');
const btnClearRoi   = $('btn-clear-roi');
const btnSaveRoi    = $('btn-save-roi');
const btnConfig     = $('btn-config');
const btnStart      = $('btn-start');
const btnPause      = $('btn-pause');
const btnResume     = $('btn-resume');
const btnStop       = $('btn-stop');
const btnPreviewCam = $('btn-preview-camera');
const btnFlipCam    = $('btn-flip-cam');

// Stats
const statIn       = $('stat-in');
const statOut      = $('stat-out');
const statTotal    = $('stat-total');
const statCurrent  = $('stat-current');
const infoModel    = $('info-model');
const infoTracker  = $('info-tracker');
const infoDuration = $('info-duration');
const infoFps      = $('info-fps');
const infoSession  = $('info-session');
const cpuBar = $('cpu-bar');  const cpuPct = $('cpu-pct');
const ramBar = $('ram-bar');  const ramPct = $('ram-pct');

// History
const historyList    = $('history-list');
const btnRefreshHist = $('btn-refresh-history');

// Drawer
const drawerOverlay  = $('drawer-overlay');
const configDrawer   = $('config-drawer');
const btnCloseDrawer = $('btn-close-drawer');
const btnApplyConfig = $('btn-apply-config');
const cfgModel       = $('cfg-model');
const cfgTracker     = $('cfg-tracker');
const cfgConf        = $('cfg-confidence');
const cfgIou         = $('cfg-iou');
const confVal        = $('conf-val');
const iouVal         = $('iou-val');

// Modal
const modalOverlay  = $('modal-overlay');
const btnCloseModal = $('btn-close-modal');
const modalTitle    = $('modal-title');
const modalVideo    = $('modal-video');
const modalDlVideo  = $('modal-dl-video');
const modalDlStats  = $('modal-dl-stats');
const modalDlLog    = $('modal-dl-log');
const modalInfoGrid = $('modal-info-grid');

// Result section
const resultSection    = $('result-section');
const resultVideo      = $('result-video');
const btnDownloadVideo = $('btn-download-video');
const btnExportCsv     = $('btn-export-csv');

let vehicleChart = null;

// =========================================================
// TOAST
// =========================================================
function toast(msg, type = 'info', duration = null) {
  const el = $('toast');
  el.textContent = msg;
  el.className   = `toast show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast'; }, duration ?? state.config.toastDurationMs);
}

// =========================================================
// LABEL HELPERS
// =========================================================
function modelLabel(val) {
  return state.config.models?.find(m => m.value === val)?.name ?? (val || state.config.model);
}
function trackerLabel(val) {
  return state.config.trackers?.find(t => t.value === val)?.name ?? (val || state.config.tracker);
}

// =========================================================
// CLASS DISPLAY HELPERS (driven by config.yaml -> classes.display)
// =========================================================

/** Classes currently selected (state.config.classes), enriched with display info, for the live chart. */
function getSelectedChartClasses() {
  return state.config.classes.map(id => {
    const key = state.config.labels[id];
    const d   = state.config.display[id] || {};
    return {
      id,
      key,
      label:  d.label  || titleCase(key || ''),
      color:  d.color  || 'rgba(120,120,120,0.7)',
      border: d.border || '#888888',
      icon:   d.icon   || '📦',
    };
  });
}

/** All classes known to the system, enriched with display info, for checkboxes / modal cards / modal chart. */
function getAllDisplayClasses() {
  return Object.entries(state.config.labels).map(([id, key]) => {
    const d = state.config.display[id] || {};
    return {
      id: Number(id),
      key,
      label: d.label || titleCase(key),
      icon:  d.icon  || '📦',
      color: d.color || '#888888',
    };
  });
}

// =========================================================
// CHART INIT
// =========================================================
function initChart() {
  const selected = getSelectedChartClasses();
  const ctx = $('vehicle-chart').getContext('2d');
  vehicleChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: selected.map(x => x.label),
      datasets: [{
        label: 'Count',
        data: selected.map(() => 0),
        backgroundColor: selected.map(x => x.color),
        borderColor: selected.map(x => x.border),
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {legend: { display: false },tooltip: { enabled: true }}
    }
  });
}

function updateChart(counts) {
  if (!vehicleChart) return;
  const selected = getSelectedChartClasses();
  vehicleChart.data.labels                      = selected.map(x => x.label);
  vehicleChart.data.datasets[0].data            = selected.map(x => counts[x.key] || 0);
  vehicleChart.data.datasets[0].backgroundColor = selected.map(x => x.color);
  vehicleChart.data.datasets[0].borderColor     = selected.map(x => x.border);
  vehicleChart.update('none');
}

// =========================================================
// ROI CANVAS
// =========================================================
const ctx2d = roiCanvas.getContext('2d');

function resizeCanvas() {
  const rect = videoWrapper.getBoundingClientRect();
  roiCanvas.width  = rect.width;
  roiCanvas.height = rect.height;
  drawRoi();
}

function drawRoi() {
  ctx2d.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
  const ghost = state.ghostRoiPoints;
  if (ghost?.length >= 2) {
    ctx2d.save();
    ctx2d.globalAlpha = 0.3;
    ctx2d.strokeStyle = '#f5550b';
    ctx2d.fillStyle   = 'rgba(245,158,11,0.08)';
    ctx2d.lineWidth   = 2;
    ctx2d.setLineDash([6, 4]);
    ctx2d.beginPath();
    ctx2d.moveTo(ghost[0][0], ghost[0][1]);
    for (let i = 1; i < ghost.length; i++) ctx2d.lineTo(ghost[i][0], ghost[i][1]);
    if (state.ghostRoiMode === ROI.POLYGON && ghost.length > 2) ctx2d.closePath();
    ctx2d.stroke();
    if (state.ghostRoiMode === ROI.POLYGON && ghost.length > 2) ctx2d.fill();
    ghost.forEach(([x, y]) => {
      ctx2d.beginPath();
      ctx2d.arc(x, y, 3, 0, Math.PI * 2);
      ctx2d.fillStyle = '#f53e0b';
      ctx2d.fill();
    
    });
    ctx2d.setLineDash([]);
    ctx2d.restore();
  }
  const pts = state.roiPoints;
  if (pts.length === 0) return;

  ctx2d.strokeStyle = '#2563eb';
  ctx2d.fillStyle   = 'rgba(37,99,235,0.12)';
  ctx2d.lineWidth   = 2;
  ctx2d.setLineDash([5, 3]);
  ctx2d.beginPath();
  ctx2d.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx2d.lineTo(pts[i][0], pts[i][1]);
  if (state.roiMode === ROI.POLYGON && pts.length > 2) ctx2d.closePath();
  ctx2d.stroke();
  if (state.roiMode === ROI.POLYGON && pts.length > 2) ctx2d.fill();
  ctx2d.setLineDash([]);

  pts.forEach(([x, y], i) => {
    ctx2d.beginPath();
    ctx2d.arc(x, y, 5, 0, Math.PI * 2);
    ctx2d.fillStyle   = i === 0 ? '#22c55e' : '#2563eb';
    ctx2d.fill();
    ctx2d.strokeStyle = '#fff';
    ctx2d.lineWidth   = 1.5;
    ctx2d.stroke();
  });
}

function canvasClick(e) {
  if (!state.roiDrawing) return;
  const rect = roiCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { displayW, displayH, offsetX, offsetY } = getVideoDisplayRect();
  if (x < offsetX || x > offsetX + displayW || y < offsetY || y > offsetY + displayH) return;

  state.roiPoints.push([x, y]);
  if (state.roiMode === ROI.LINE && state.roiPoints.length >= 2) {
    finishRoi();
  } else {
    roiPointCount.textContent = `Points: ${state.roiPoints.length}`;
  }
  drawRoi();
}

function canvasDblClick() {
  if (!state.roiDrawing) return;
  if (state.roiMode === ROI.POLYGON && state.roiPoints.length >= 3) finishRoi();
}

function finishRoi() {
  state.roiDrawing = false;
  state.roiSaved   = false;
  roiCanvas.classList.replace('drawing', 'idle');
  roiStatus.style.display = 'none';
  toast('ROI drawn. Click "Save ROI" to confirm.', 'info');
  drawRoi();
}

function clearRoi() {
  state.roiPoints  = [];
  state.roiDrawing = false;
  state.roiSaved   = false;
  roiCanvas.classList.replace('drawing', 'idle');
  roiStatus.style.display   = 'none';
  roiPointCount.textContent = 'Points: 0';
  drawRoi();
}

function getVideoDisplayRect() {
  const vw = state.frameSize.w, vh = state.frameSize.h;
  const cw = roiCanvas.width,   ch = roiCanvas.height;
  const videoAspect  = vw / vh;
  const canvasAspect = cw / ch;
  let displayW, displayH, offsetX, offsetY;
  if (videoAspect > canvasAspect) {
    displayW = cw; displayH = cw / videoAspect; offsetX = 0; offsetY = (ch - displayH) / 2;
  } else {
    displayH = ch; displayW = ch * videoAspect; offsetY = 0; offsetX = (cw - displayW) / 2;
  }
  return { displayW, displayH, offsetX, offsetY };
}

function getRoiInVideoCoords() {
  const { displayW, displayH, offsetX, offsetY } = getVideoDisplayRect();
  const { w: vw, h: vh } = state.frameSize;
  return state.roiPoints.map(([x, y]) => [
    Math.round(((x - offsetX) / displayW) * vw),
    Math.round(((y - offsetY) / displayH) * vh),
  ]);
}

/** Convert video pixel coords → canvas display coords (ngược lại getRoiInVideoCoords) */
function videoToCanvasCoords(videoPoints) {
  const { displayW, displayH, offsetX, offsetY } = getVideoDisplayRect();
  const { w: vw, h: vh } = state.frameSize;
  return videoPoints.map(([x, y]) => [
    (x / vw) * displayW + offsetX,
    (y / vh) * displayH + offsetY,
  ]);
}

// =========================================================
// MODE SWITCHING
// =========================================================
async function switchMode(mode) {
  state.mode = mode;

  if (btnFlipCam) btnFlipCam.style.display = mode === MODE.CAMERA ? 'inline-flex' : 'none';

  if (mode === MODE.UPLOAD) {
    state.ghostRoiPoints = null;
    state.ghostRoiMode   = null;
    try {
        await fetch('/stop_camera', { method: 'POST' });
    } catch (_) {}
    uploadSection.style.display = 'block';
    cameraSection.style.display = 'none';
    hideStream();
    clearRoi();
    return;
}
  if (mode === MODE.UPLOAD) {
    state.ghostRoiPoints = null;
    state.ghostRoiMode   = null;
  }

  uploadSection.style.display = 'none';
  cameraSection.style.display = 'flex';
  clearRoi();
  startCameraStream();
}

// =========================================================
// UPLOAD
// =========================================================
async function uploadVideo(file) {
  const formData = new FormData();
  formData.append('file', file);
  uploadProgress.style.display = 'block';
  progressBar.style.width  = '0%';
  progressText.textContent = '0%';

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width  = pct + '%';
        progressText.textContent = pct + '%';
      }
    };
    xhr.onload = () => {
      uploadProgress.style.display = 'none';
      xhr.status === 200
        ? resolve(JSON.parse(xhr.responseText))
        : reject(new Error(xhr.responseText));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(formData);
  });
}

async function handleFileSelect(file) {
  if (!file) return;
  uploadText.textContent = file.name;
  try {
    const data = await uploadVideo(file);
    state.uploadedFilename = data.filename;
    state.uploadedFilePath = data.path;
    if (data.first_frame) showFrameOnCanvas(data.first_frame);
    toast(`✅ Uploaded: ${data.filename}`, 'success');
  } catch (err) {
    toast(`Upload failed: ${err.message}`, 'error');
  }
}

function showFrameOnCanvas(b64) {
  state.firstFrameBase64 = b64;
  const img = new Image();
  img.onload = () => {
    state.frameSize = { w: img.naturalWidth, h: img.naturalHeight };
    videoPlaceholder.style.display = 'none';
    videoStream.style.display      = 'block';
    videoStream.src = 'data:image/jpeg;base64,' + b64;
    resizeCanvas();
  };
  img.src = 'data:image/jpeg;base64,' + b64;
}

function restoreFirstFrame() {
  videoPlaceholder.style.display = 'none';
  videoStream.style.display      = 'block';
  roiCanvas.style.pointerEvents  = 'auto';

  if (state.mode === MODE.CAMERA) {
    startCameraStream();
  } else {
    if (!state.firstFrameBase64) return;
    videoStream.src = 'data:image/jpeg;base64,' + state.firstFrameBase64;
  }
}

// =========================================================
// CAMERA PREVIEW
// =========================================================
async function previewCamera() {
  const id   = parseInt(cameraId.value) || 0;
  const flip = state.cameraFlip ? 1 : 0;
  try {
    const res = await fetch(`/first_frame?source=camera&camera_id=${id}&flip=${flip}`);
    if (!res.ok) throw new Error('Cannot access camera');
    const data = await res.json();
    state.frameSize = { w: data.width, h: data.height };
    showFrameOnCanvas(data.frame);
    toast('Camera preview loaded', 'success');
  } catch (err) {
    toast(`Camera error: ${err.message}`, 'error');
  }
}

function startCameraStream() {
  const id   = parseInt(cameraId?.value) || 0;
  const flip = state.cameraFlip ? 1 : 0;
  videoStream.src                = `/camera_feed?camera_id=${id}&flip=${flip}`;
  videoStream.style.display      = 'block';
  videoPlaceholder.style.display = 'none';
}

// =========================================================
// STREAM
// =========================================================
function startStream() {
  videoStream.src                = '/video_feed';
  videoStream.style.display      = 'block';
  videoPlaceholder.style.display = 'none';
  state.streamActive             = true;
  roiCanvas.style.pointerEvents  = 'none';
}

function hideStream() {
  videoStream.src                = '';
  videoStream.style.display      = 'none';
  videoPlaceholder.style.display = 'flex';
  state.streamActive             = false;
  roiCanvas.style.pointerEvents  = 'auto';
}

// =========================================================
// SESSION CONTROL
// =========================================================
async function startSession() {
  const classes = Array.from(document.querySelectorAll('.cls-check:checked'))
    .map(cb => parseInt(cb.value));

  const payload = {
    mode:          state.mode,
    model:         state.config.model,
    tracker:       state.config.tracker,
    confidence:    state.config.confidence,
    iou:           state.config.iou,
    classes,
    roi_mode:      state.config.roi_mode,
    region_points: state.roiSaved ? getRoiInVideoCoords() : [],
    flip:          state.cameraFlip,
  };

  if (state.mode === MODE.UPLOAD) {
    if (!state.uploadedFilename) { toast('Please upload a video first', 'error'); return; }
    payload.video = state.uploadedFilename;
  } else {
    payload.camera_id = parseInt(cameraId.value) || 0;
  }

  try {
    if (state.mode === MODE.CAMERA) {
      await fetch('/stop_camera', { method: 'POST' });
      await new Promise(r => setTimeout(r, state.config.cameraRestartDelayMs));
    }
    const res  = await fetch('/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Start failed');

    state.sessionId      = data.session_id;
    state.sessionRunning = true;
    state.ghostRoiPoints = null;
    state.ghostRoiMode   = null;
    lockUI(true);
    startStream();
    clearRoi()
    startStatsPolling();
    setStatus('running');
    const progressSection = $('processing-section');
    if (progressSection) progressSection.style.display = state.mode === MODE.UPLOAD ? '' : 'none';
    toast('🚀 Session started', 'success');
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  }
}

async function stopSession() {
  await fetch('/stop', { method: 'POST' });
  state.sessionRunning = false;
  stopStatsPolling();
  await _loadGhostRoi(state.sessionId);
  lockUI(false);
  setStatus('stopped');
  const progressSection = $('processing-section');
  if (progressSection) progressSection.style.display = 'none';
  toast('⏹ Session stopped', 'warning');

  if (state.mode === MODE.CAMERA) {
    await new Promise(r => setTimeout(r, state.config.cameraStopDelayMs));
  }
  restoreFirstFrame();
  setTimeout(() => showResultSection(), state.config.resultShowDelayMs);
}

async function pauseSession() {
  await fetch('/pause', { method: 'POST' });
  setStatus('paused');
  btnPause.disabled  = true;
  btnResume.disabled = false;
  toast('⏸ Paused', 'warning');
}

async function resumeSession() {
  await fetch('/resume', { method: 'POST' });
  setStatus('running');
  btnPause.disabled  = false;
  btnResume.disabled = true;
  toast('▶ Resumed', 'success');
}

// =========================================================
// GHOST ROI HELPER
// =========================================================
async function _loadGhostRoi(sessionId) {
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`/session/${sessionId}`);
      if (!res.ok) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      const data = await res.json();
      if (data.region_points?.length) {
        state.ghostRoiPoints = videoToCanvasCoords(data.region_points);
        state.ghostRoiMode = data.roi_mode || ROI.POLYGON;
        drawRoi();
      }
      return;
    } catch (_) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
}
// =========================================================
// STATS POLLING
// =========================================================
function startStatsPolling() {
  state.statsInterval = setInterval(fetchStats, state.config.statsPollIntervalMs);
}

function stopStatsPolling() {
  clearInterval(state.statsInterval);
  state.statsInterval = null;
}

async function fetchStats() {
  try {
    const res  = await fetch('/stats');
    const data = await res.json();
    applyStats(data);

    if (data.status === 'done' && state.sessionRunning) {
      state.sessionRunning = false;
      stopStatsPolling();
      await _loadGhostRoi(state.sessionId);
      lockUI(false);
      setStatus('done');
      clearRoi();
      processingBar.style.width     = '100%';
      processingPercent.textContent = '100%';
      processingEta.textContent     = 'Completed';
      toast('✅ Processing complete!', 'success');
      setTimeout(() => {
        const progressSection = $('processing-section');
        if (progressSection) progressSection.style.display = 'none';
      }, state.config.resultShowDelayMs);

      if (state.mode === MODE.CAMERA) {
        await new Promise(r => setTimeout(r, state.config.cameraStopDelayMs));
      }
      restoreFirstFrame();
      setTimeout(() => showResultSection(), state.config.resultShowDelayMs);
    }
  } catch (_) {}
}

function applyStats(data) {
  statIn.textContent      = data.in_count         ?? 0;
  statOut.textContent     = data.out_count        ?? 0;
  statTotal.textContent   = data.total_count      ?? 0;
  statCurrent.textContent = data.current_vehicles ?? 0;

  infoModel.textContent    = data.model       || '—';
  infoTracker.textContent  = data.tracker     || '—';
  infoDuration.textContent = data.elapsed_hms || '—';
  infoFps.textContent      = data.fps ? `${data.fps} fps` : '—';
  infoSession.textContent  = data.session_id  || '—';

  hdrFps.textContent     = data.fps || '—';
  hdrModel.textContent   = modelLabel(data.model);
  hdrTracker.textContent = trackerLabel(data.tracker);

  const cpu = data.cpu_usage || 0;
  const ram = data.ram_usage || 0;
  cpuBar.style.width = cpu + '%';  cpuPct.textContent = cpu + '%';
  ramBar.style.width = ram + '%';  ramPct.textContent = ram + '%';

  if (data.vehicle_counts) updateChart(data.vehicle_counts);

  const progress = data.progress || 0;
  processingBar.style.width     = `${progress}%`;
  processingPercent.textContent = `${progress}%`;
  processingFrame.textContent   = `${data.processed_frames || 0} / ${data.total_frames || 0} frames`;
  processingEta.textContent     = `ETA: ${data.eta || 0}s`;
}

// =========================================================
// RESULT SECTION
// =========================================================
async function showResultSection() {
  if (!state.sessionId) return;
  try {
    const res = await fetch(`/session/${state.sessionId}`);
    if (!res.ok) return;
    const videoUrl = `/result_video/${state.sessionId}`;
    resultVideo.src           = videoUrl;
    btnDownloadVideo.href     = videoUrl;
    btnDownloadVideo.download = `result_${state.sessionId}.mp4`;
    btnExportCsv.href         = `/export/statistics/${state.sessionId}`;
    resultSection.style.display = 'block';
  } catch (_) {}
}

// =========================================================
// UI LOCK
// =========================================================
function lockUI(locked) {
  [
    uploadLabel, uploadSection,
    btnDrawRoi, btnClearRoi, btnSaveRoi,
    cfgModel, cfgTracker, cfgConf, cfgIou,
    ...document.querySelectorAll('.cls-check'),
    ...document.querySelectorAll('input[name="roi-mode"]'),
    modeUploadRadio, modeCameraRadio,
  ].forEach(el => { if (el) el.disabled = locked; });

  btnStart.disabled  = locked;
  btnPause.disabled  = !locked;
  btnResume.disabled = true;
  btnStop.disabled   = !locked;
  btnConfig.disabled = locked;
}

function titleCase(text) {
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function renderClassCheckboxes() {
  const container = $('class-checkboxes');
  if (!container) return;

  container.innerHTML = getAllDisplayClasses()
    .map(c => {
      const checked = state.config.classes.includes(c.id) ? 'checked' : '';
      return `
        <label class="checkbox-item">
          <input
            type="checkbox"
            value="${c.id}"
            class="cls-check"
            ${checked}
          />
          <span>${c.icon} ${c.label}</span>
        </label>
      `;
    })
    .join('');
}

// =========================================================
// STATUS
// =========================================================
function setStatus(status) {
  const labels = state.config.statusLabels;
  hdrStatus.textContent = labels[status] || status.toUpperCase();
  hdrStatus.className   = `badge-value status-text ${status}`;
  hdrStatus.classList.toggle('pulse', status === 'running');
}

// =========================================================
// CONFIG DRAWER
// =========================================================
function openDrawer()  { configDrawer.classList.add('open');    drawerOverlay.classList.add('open'); }
function closeDrawer() { configDrawer.classList.remove('open'); drawerOverlay.classList.remove('open'); }

function applyConfig() {
  state.config.model      = cfgModel.value;
  state.config.tracker    = cfgTracker.value;
  state.config.confidence = parseFloat(cfgConf.value);
  state.config.iou        = parseFloat(cfgIou.value);
  state.config.roi_mode   = document.querySelector('input[name="roi-mode"]:checked')?.value || ROI.POLYGON;
  state.config.classes    = Array.from(document.querySelectorAll('.cls-check:checked'))
    .map(cb => parseInt(cb.value));

  hdrModel.textContent   = modelLabel(state.config.model);
  hdrTracker.textContent = trackerLabel(state.config.tracker);
  vehicleChart.destroy();
  initChart();
  closeDrawer();
  toast('✅ Configuration applied', 'success');
}

// =========================================================
// HISTORY
// =========================================================
async function loadHistory() {
  try {
    const res  = await fetch('/history');
    const data = await res.json();
    renderHistory(data);
  } catch (_) {
    historyList.innerHTML = '<div class="empty-state">Failed to load history</div>';
  }
}

function renderHistory(entries) {
  if (!entries?.length) {
    historyList.innerHTML = '<div class="empty-state">No sessions yet</div>';
    return;
  }
  historyList.innerHTML = entries.map(e => `
    <div class="history-item" data-session="${e.session_id}" onclick="openSessionModal('${e.session_id}')">
      <div class="history-thumb">🎬</div>
      <div class="history-info">
        <div class="history-name">${e.video_name || 'session'}</div>
        <div class="history-meta">${formatDate(e.date)} &bull; ${modelLabel(e.model)} &bull; ${trackerLabel(e.tracker)}</div>
      </div>
      <div class="history-count">${e.total_count || 0}</div>
    </div>
  `).join('');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

// =========================================================
// SESSION MODAL
// =========================================================
let modalChartInst = null;

async function openSessionModal(sessionId) {
  try {
    const res = await fetch(`/session/${sessionId}`);
    if (!res.ok) { toast('Session data not found', 'error'); return; }
    const data = await res.json();

    modalTitle.textContent = data.video_name || sessionId;
    modalVideo.src         = `/result_video/${sessionId}`;
    modalDlVideo.href      = `/result_video/${sessionId}`;
    modalDlVideo.download  = `result_${sessionId}.mp4`;
    modalDlStats.href      = `/export/statistics/${sessionId}`;
    modalDlStats.download  = 'statistics.csv';
    modalDlLog.href        = `/export/vehicle_log/${sessionId}`;
    modalDlLog.download    = 'vehicle_log.csv';

    const fields = [
      ['Model',      modelLabel(data.model)],
      ['Tracker',    trackerLabel(data.tracker)],
      ['Confidence', data.confidence],
      ['IoU',        data.iou],
      ['IN',         data.in_count],
      ['OUT',        data.out_count],
      ['Duration',   data.processing_duration_hms || `${data.processing_duration}s`],
      ['Avg FPS',    data.fps_avg || '—'],
      ['Date',       formatDate(data.date)],
    ];
    modalInfoGrid.innerHTML = fields.map(([k, v]) => `
      <div class="info-row">
        <span class="info-label">${k}</span>
        <span class="info-value">${v ?? '—'}</span>
      </div>
    `).join('');

    const counts = data.vehicle_counts || {};
    _renderVehicleCards(counts);
    _buildModalChart(counts);

    modalOverlay.style.display = 'flex';
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  }
}

function _renderVehicleCards(counts) {
  const items = getAllDisplayClasses();
  $('vehicle-cards').innerHTML = items.map(v => `
    <div class="vehicle-card">
      <div class="vehicle-card-icon">${v.icon}</div>
      <div class="vehicle-card-name">${v.label}</div>
      <div class="vehicle-card-value">${counts[v.key] || 0}</div>
    </div>
  `).join('');
}

function _buildModalChart(counts) {
  const ALL = getAllDisplayClasses();
  const filtered = ALL.map(x => ({ ...x, value: counts[x.key] || 0 })).filter(x => x.value > 0);

  if (modalChartInst) modalChartInst.destroy();

  let donutCenterMode = 'total';

  const centerTextPlugin = {
    id: 'centerText',
    beforeDraw(chart) {
      const { ctx }  = chart;
      const values   = chart.data.datasets[0].data;
      const labels   = chart.data.labels;
      const total    = values.reduce((a, b) => a + b, 0);
      const cx = (chart.chartArea.left + chart.chartArea.right)  / 2;
      const cy = (chart.chartArea.top  + chart.chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      if (donutCenterMode === 'total') {
        ctx.fillStyle = '#fff';
        ctx.font      = 'bold 28px Inter';
        ctx.fillText(total, cx, cy - 10);
        ctx.fillStyle = '#8b949e';
        ctx.font      = '12px Inter';
        ctx.fillText('Vehicles', cx, cy + 15);
      } else {
        const maxVal = Math.max(...values);
        const maxIdx = values.indexOf(maxVal);
        const pct    = total > 0 ? ((maxVal / total) * 100).toFixed(1) : 0;
        ctx.fillStyle = '#fff';
        ctx.font      = 'bold 28px Inter';
        ctx.fillText(`${pct}%`, cx, cy - 10);
        ctx.fillStyle = '#8b949e';
        ctx.font      = '12px Inter';
        ctx.fillText(labels[maxIdx], cx, cy + 15);
      }
      ctx.restore();
    }
  };

  Chart.defaults.plugins.legend.labels.color = '#ffffff';

  const canvas = $('modal-chart');
  modalChartInst = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    plugins: [centerTextPlugin],
    data: {
      labels:   filtered.map(x => x.label),
      datasets: [{ data: filtered.map(x => x.value), backgroundColor: filtered.map(x => x.color) }],
    },
    options: {
      cutout: '50%',
      responsive: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#8b949e', font: { size: 11 }, padding: 10,
            generateLabels(chart) {
              const d     = chart.data.datasets[0].data;
              const total = d.reduce((a, b) => a + b, 0);
              return chart.data.labels.map((label, i) => ({
                text:        `${label}: (${total > 0 ? ((d[i] / total) * 100).toFixed(1) : 0}%)`,
                fillStyle:   chart.data.datasets[0].backgroundColor[i],
                strokeStyle: chart.data.datasets[0].backgroundColor[i],
                fontColor:   '#ffffff',
                hidden:      false,
                index:       i,
              }));
            }
          }
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct   = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
              return `${ctx.label}: ${ctx.raw} (${pct}%)`;
            }
          }
        }
      }
    }
  });

  canvas.onclick = e => {
    if (!modalChartInst) return;
    const rect  = canvas.getBoundingClientRect();
    const chart = modalChartInst;
    const cx = (chart.chartArea.left + chart.chartArea.right)  / 2;
    const cy = (chart.chartArea.top  + chart.chartArea.bottom) / 2;
    const dx = e.clientX - rect.left - cx;
    const dy = e.clientY - rect.top  - cy;
    if (Math.sqrt(dx * dx + dy * dy) < chart.getDatasetMeta(0).data[0]?.innerRadius) {
      donutCenterMode = donutCenterMode === 'total' ? 'most' : 'total';
      chart.update();
    }
  };
}

function closeModal() {
  modalOverlay.style.display = 'none';
  modalVideo.src = '';
}

// =========================================================
// EVENT LISTENERS
// =========================================================
function bindEvents() {
  modeUploadRadio.addEventListener('change', () => switchMode(MODE.UPLOAD));
  modeCameraRadio.addEventListener('change', () => switchMode(MODE.CAMERA));

  fileInput.addEventListener('change', e => handleFileSelect(e.target.files[0]));
  uploadLabel.addEventListener('dragover',  e => { e.preventDefault(); uploadLabel.style.borderColor = '#2563eb'; });
  uploadLabel.addEventListener('dragleave', ()  => { uploadLabel.style.borderColor = ''; });
  uploadLabel.addEventListener('drop', e => {
    e.preventDefault();
    uploadLabel.style.borderColor = '';
    handleFileSelect(e.dataTransfer.files[0]);
  });

  btnPreviewCam.addEventListener('click', previewCamera);
  if (btnFlipCam) {
    btnFlipCam.style.display = 'none';
    btnFlipCam.addEventListener('click', () => {
      state.cameraFlip = !state.cameraFlip;
      btnFlipCam.classList.toggle('active', state.cameraFlip);
      if (videoStream.src.includes('/camera_feed')) {
          fetch('/stop_camera', { method: 'POST' })
            .finally(() => {
                setTimeout(() => startCameraStream(), 200);
            });
      }
      else if (state.firstFrameBase64 && state.mode === MODE.CAMERA) {
        previewCamera();
      }
      toast(state.cameraFlip ? '↔ Camera flipped' : '↔ Camera normal', 'info');
    });
  }

  btnDrawRoi.addEventListener('click', () => {
    state.roiDrawing     = true;
    state.roiPoints      = [];
    state.roiSaved       = false;
    roiCanvas.classList.add('drawing');
    roiModeLabel.textContent  = `Drawing: ${state.config.roi_mode === ROI.LINE ? 'Line' : 'Polygon'}`;
    roiPointCount.textContent = 'Points: 0';
    roiStatus.style.display   = 'flex';
    drawRoi();
    toast(
      state.config.roi_mode === ROI.LINE
        ? 'Click 2 points to draw a line'
        : 'Click to add points. Double-click to finish.',
      'info', 4000
    );
  });

  btnClearRoi.addEventListener('click', () => {
    state.ghostRoiPoints = null;
    state.ghostRoiMode   = null;
    clearRoi();
    toast('ROI cleared', 'info');
  });

  btnSaveRoi.addEventListener('click', () => {
    if (state.roiPoints.length < 2) { toast('Draw ROI first', 'warning'); return; }
    state.roiSaved   = true;
    state.roiDrawing = false;
    toast('✅ ROI saved', 'success');
  });

  roiCanvas.addEventListener('click',    canvasClick);
  roiCanvas.addEventListener('dblclick', canvasDblClick);

  btnStart.addEventListener('click',  startSession);
  btnPause.addEventListener('click',  pauseSession);
  btnResume.addEventListener('click', resumeSession);
  btnStop.addEventListener('click',   stopSession);

  btnConfig.addEventListener('click',      openDrawer);
  btnCloseDrawer.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click',  closeDrawer);
  btnApplyConfig.addEventListener('click', applyConfig);

  cfgConf.addEventListener('input', () => { confVal.textContent = parseFloat(cfgConf.value).toFixed(2); });
  cfgIou.addEventListener('input',  () => { iouVal.textContent  = parseFloat(cfgIou.value).toFixed(2); });

  btnRefreshHist.addEventListener('click', loadHistory);

  btnCloseModal.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

  window.addEventListener('resize', resizeCanvas);
}

// =========================================================
// INIT
// =========================================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  renderClassCheckboxes();
  applyConfigToUI();
  initChart();
  bindEvents();
  loadHistory();
  resizeCanvas();
  setStatus('idle');
  hdrModel.textContent   = modelLabel(state.config.model);
  hdrTracker.textContent = trackerLabel(state.config.tracker);
});