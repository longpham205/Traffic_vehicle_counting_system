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
  mode: MODE.UPLOAD,
  uploadedFilename: null,
  uploadedFilePath: null,
  sessionRunning: false,
  sessionId: null,
  roiMode: ROI.POLYGON,
  roiDrawing: false,
  roiPoints: [],
  roiSaved: false,
  statsInterval: null,
  streamActive: false,
  config: {},
  frameSize: { w: 640, h: 360 },
  firstFrameBase64: null,
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
      classes:    cfg.classes.coco_vehicle_ids,
      labels:     cfg.classes.labels,
      roi_mode:   cfg.roi.default_mode,
      models:     cfg.models   || [],
      trackers:   cfg.trackers || [],
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

// Stats
const statIn      = $('stat-in');
const statOut     = $('stat-out');
const statTotal   = $('stat-total');
const statCurrent = $('stat-current');
const infoModel   = $('info-model');
const infoTracker = $('info-tracker');
const infoDuration = $('info-duration');
const infoFps     = $('info-fps');
const infoSession = $('info-session');
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

// Chart
let vehicleChart = null;

// =========================================================
// TOAST
// =========================================================
function toast(msg, type = 'info', duration = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast'; }, duration);
}

// =========================================================
// LABEL HELPERS  (read from config, fallback to raw value)
// =========================================================
function modelLabel(val) {
  const found = state.config.models?.find(m => m.value === val);
  return found ? found.name : (val || 'YOLO11n');
}

function trackerLabel(val) {
  const found = state.config.trackers?.find(t => t.value === val);
  return found ? found.name : (val || 'ByteTrack');
}

// =========================================================
// CHART INIT
// =========================================================
function initChart() {
  const ctx = $('vehicle-chart').getContext('2d');
  vehicleChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Car', 'Motorcycle', 'Bus', 'Truck', 'Bicycle', 'Person'],
      datasets: [{
        label: 'Count',
        data: [0, 0, 0, 0, 0, 0],
        backgroundColor: [
          'rgba(37,99,235,0.7)', 'rgba(168,85,247,0.7)', 'rgba(34,197,94,0.7)',
          'rgba(245,158,11,0.7)', 'rgba(6,182,212,0.7)', 'rgba(239,68,68,0.7)',
        ],
        borderColor: ['#2563eb', '#a855f7', '#22c55e', '#f59e0b', '#06b6d4', '#ef4444'],
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: 'rgba(48,54,61,0.5)' } },
        y: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: 'rgba(48,54,61,0.5)' }, beginAtZero: true },
      }
    }
  });
}

function updateChart(counts) {
  if (!vehicleChart) return;
  vehicleChart.data.datasets[0].data = [
    counts.car || 0, counts.motorcycle || 0, counts.bus || 0,
    counts.truck || 0, counts.bicycle || 0, counts.person || 0,
  ];
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

// =========================================================
// MODE SWITCHING
// =========================================================
async function switchMode(mode) {
  state.mode = mode;
  if (mode === MODE.UPLOAD) {
    try { await fetch('/stop_camera', { method: 'POST' }); } catch (_) {}
    uploadSection.style.display = 'block';
    cameraSection.style.display = 'none';
    hideStream();
    clearRoi();
    return;
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
  progressBar.style.width = '0%';
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
      xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText));
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
  if (!state.firstFrameBase64) return;
  videoPlaceholder.style.display = 'none';
  videoStream.style.display      = 'block';
  videoStream.src = 'data:image/jpeg;base64,' + state.firstFrameBase64;
  roiCanvas.style.pointerEvents  = 'auto';
}

// =========================================================
// CAMERA PREVIEW
// =========================================================
async function previewCamera() {
  const id = parseInt(cameraId.value) || 0;
  try {
    const res = await fetch(`/first_frame?source=camera&camera_id=${id}`);
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
  videoStream.src                = '/camera_feed';
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
    mode:           state.mode,
    model:          state.config.model,
    tracker:        state.config.tracker,
    confidence:     state.config.confidence,
    iou:            state.config.iou,
    classes,
    roi_mode:       state.config.roi_mode,
    region_points:  state.roiSaved ? getRoiInVideoCoords() : [],
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
      await new Promise(r => setTimeout(r, 300));
    }
    const res  = await fetch('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Start failed');

    state.sessionId      = data.session_id;
    state.sessionRunning = true;
    lockUI(true);
    startStream();
    startStatsPolling();
    setStatus('running');
    toast('🚀 Session started', 'success');
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  }
}

async function stopSession() {
  await fetch('/stop', { method: 'POST' });
  state.sessionRunning = false;
  stopStatsPolling();
  restoreFirstFrame();
  lockUI(false);
  setStatus('stopped');
  toast('⏹ Session stopped', 'warning');
  setTimeout(() => showResultSection(), 1500);
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
// STATS POLLING
// =========================================================
function startStatsPolling() {
  state.statsInterval = setInterval(fetchStats, 800);
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
      restoreFirstFrame();
      lockUI(false);
      setStatus('done');
      clearRoi();
      processingBar.style.width     = '100%';
      processingPercent.textContent = '100%';
      processingEta.textContent     = 'Completed';
      toast('✅ Processing complete!', 'success');
      setTimeout(() => showResultSection(), 1500);
    }
  } catch (_) {}
}

function applyStats(data) {
  statIn.textContent      = data.in_count          ?? 0;
  statOut.textContent     = data.out_count         ?? 0;
  statTotal.textContent   = data.total_count       ?? 0;
  statCurrent.textContent = data.current_vehicles  ?? 0;

  infoModel.textContent    = data.model       || '—';
  infoTracker.textContent  = data.tracker     || '—';
  infoDuration.textContent = data.elapsed_hms || '—';
  infoFps.textContent      = data.fps ? `${data.fps} fps` : '—';
  infoSession.textContent  = data.session_id  || '—';

  hdrFps.textContent     = data.fps   || '—';
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

// =========================================================
// STATUS
// =========================================================
function setStatus(status) {
  const labels = { idle: 'IDLE', running: 'RUNNING', paused: 'PAUSED', stopped: 'STOPPED', done: 'DONE' };
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

    // Header
    modalTitle.textContent = data.video_name || sessionId;
    modalVideo.src         = `/result_video/${sessionId}`;
    modalDlVideo.href      = `/result_video/${sessionId}`;
    modalDlVideo.download  = `result_${sessionId}.mp4`;
    modalDlStats.href      = `/export/statistics/${sessionId}`;
    modalDlStats.download  = 'statistics.csv';
    modalDlLog.href        = `/export/vehicle_log/${sessionId}`;
    modalDlLog.download    = 'vehicle_log.csv';

    // Info grid
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

    // Vehicle cards + chart
    const counts = data.vehicle_counts || {};
    _renderVehicleCards(counts);
    _buildModalChart(counts);

    modalOverlay.style.display = 'flex';
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  }
}

function _renderVehicleCards(counts) {
  const items = [
    { icon: '🚗', name: 'Car',        key: 'car' },
    { icon: '🏍️', name: 'Motorcycle', key: 'motorcycle' },
    { icon: '🧍', name: 'Person',     key: 'person' },
    { icon: '🚌', name: 'Bus',        key: 'bus' },
    { icon: '🚚', name: 'Truck',      key: 'truck' },
    { icon: '🚲', name: 'Bicycle',    key: 'bicycle' },
  ];
  $('vehicle-cards').innerHTML = items.map(v => `
    <div class="vehicle-card">
      <div class="vehicle-card-icon">${v.icon}</div>
      <div class="vehicle-card-name">${v.name}</div>
      <div class="vehicle-card-value">${counts[v.key] || 0}</div>
    </div>
  `).join('');
}

function _buildModalChart(counts) {
  const ALL = [
    { label: 'Car',        key: 'car',        color: '#2563eb' },
    { label: 'Motorcycle', key: 'motorcycle', color: '#a855f7' },
    { label: 'Bus',        key: 'bus',        color: '#22c55e' },
    { label: 'Truck',      key: 'truck',      color: '#f59e0b' },
    { label: 'Bicycle',    key: 'bicycle',    color: '#06b6d4' },
    { label: 'Person',     key: 'person',     color: '#ef4444' },
  ];
  const filtered = ALL.map(x => ({ ...x, value: counts[x.key] || 0 })).filter(x => x.value > 0);

  if (modalChartInst) modalChartInst.destroy();

  let donutCenterMode = 'total';

  const centerTextPlugin = {
    id: 'centerText',
    beforeDraw(chart) {
      const { ctx } = chart;
      const values  = chart.data.datasets[0].data;
      const labels  = chart.data.labels;
      const total   = values.reduce((a, b) => a + b, 0);
      const cx = (chart.chartArea.left + chart.chartArea.right)  / 2;
      const cy = (chart.chartArea.top  + chart.chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      if (donutCenterMode === 'total') {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 28px Inter';
        ctx.fillText(total, cx, cy - 10);
        ctx.fillStyle = '#8b949e';
        ctx.font = '12px Inter';
        ctx.fillText('Vehicles', cx, cy + 15);
      } else {
        const maxVal = Math.max(...values);
        const maxIdx = values.indexOf(maxVal);
        const pct    = total > 0 ? ((maxVal / total) * 100).toFixed(1) : 0;
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 28px Inter';
        ctx.fillText(`${pct}%`, cx, cy - 10);
        ctx.fillStyle = '#8b949e';
        ctx.font = '12px Inter';
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
              const data  = chart.data.datasets[0].data;
              const total = data.reduce((a, b) => a + b, 0);
              return chart.data.labels.map((label, i) => {
                const pct = total > 0 ? ((data[i] / total) * 100).toFixed(1) : 0;
                return {
                  text: `${label}: (${pct}%)`,
                  fillStyle:   chart.data.datasets[0].backgroundColor[i],
                  strokeStyle: chart.data.datasets[0].backgroundColor[i],
                  fontColor: '#ffffff', hidden: false, index: i,
                };
              });
            }
          }
        },
        tooltip: {
          callbacks: {
            label(context) {
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const pct   = total > 0 ? ((context.raw / total) * 100).toFixed(1) : 0;
              return `${context.label}: ${context.raw} (${pct}%)`;
            }
          }
        }
      }
    }
  });

  // Toggle center display on click inside donut hole
  canvas.onclick = e => {
    if (!modalChartInst) return;
    const rect   = canvas.getBoundingClientRect();
    const chart  = modalChartInst;
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

  btnDrawRoi.addEventListener('click', () => {
    state.roiDrawing = true;
    state.roiPoints  = [];
    state.roiSaved   = false;
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

  btnClearRoi.addEventListener('click', () => { clearRoi(); toast('ROI cleared', 'info'); });
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

function closeModal() {
  modalOverlay.style.display = 'none';
  modalVideo.src = '';
}

// =========================================================
// INIT
// =========================================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  applyConfigToUI();
  initChart();
  bindEvents();
  loadHistory();
  resizeCanvas();
  setStatus('idle');
  hdrModel.textContent   = modelLabel(state.config.model);
  hdrTracker.textContent = trackerLabel(state.config.tracker);
});