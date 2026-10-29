/**
 * Story Desk - Client Application Logic
 * Pure vanilla JavaScript with zero external dependencies.
 * Includes:
 *  - Pointer-friendly Canvas drawing with undo & 3 brush sizes
 *  - Speech Synthesis ("Read it to me")
 *  - MediaRecorder 5-min voice recording (Opus/WebM)
 *  - File System Access API with IndexedDB directory handle persistence
 *  - IndexedDB fallback storage with navigator.storage.persist()
 *  - Tiny custom PKZip builder for "Export Everything" & blog site export
 *  - Parent dashboard & self-contained static blog generator
 */

'use strict';

// ============================================================================
// 1. Storage & Database Setup (IndexedDB)
// ============================================================================

const DB_NAME = 'StoryDeskDB';
const DB_VERSION = 1;
let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Key-value store for app settings, draft, and directory handles
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        // Fallback store for posts when File System Access API is unavailable
        if (!db.objectStoreNames.contains('posts')) {
          db.createObjectStore('posts', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idbGet(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(storeName, key, val) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(val, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutPost(postObj) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('posts', 'readwrite');
    const store = tx.objectStore('posts');
    const req = store.put(postObj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAllPosts() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Request persistent storage for IndexedDB fallback
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().then((persistent) => {
    console.log(`Storage persistent: ${persistent}`);
  }).catch(console.warn);
}

// ============================================================================
// 2. Application State
// ============================================================================

const STATE = {
  currentPostId: null,
  currentPostDate: null,
  isPublished: false,
  isDirty: false,
  rootDirectoryHandle: null,
  audioTakes: [], // Array of { id, blob, url, duration, filename }
  undoStack: [],
  maxUndo: 20,
  currentColor: '#2D3436',
  currentSize: 12,
  isEraser: false,
  parentPasscode: 'dad', // Friendly gate word for dad
};

const PALETTE_COLORS = [
  '#2D3436', // Slate Black
  '#0984E3', // Blue
  '#00CEC9', // Cyan
  '#00B894', // Green
  '#6C5CE7', // Purple
  '#E17055', // Orange
  '#D63031', // Red
  '#FD79A8', // Pink
  '#FDCB6E', // Sun Yellow
  '#636E72', // Gray
  '#FFFFFF'  // White
];

// ============================================================================
// 3. UI Helpers & Banner Alerts
// ============================================================================

function showAlert(message, icon = '💡') {
  const banner = document.getElementById('alert-banner');
  const msgEl = document.getElementById('alert-msg');
  const iconEl = document.getElementById('alert-icon');
  msgEl.textContent = message;
  iconEl.textContent = icon;
  banner.classList.remove('hidden');
}

document.getElementById('btn-alert-close').addEventListener('click', () => {
  document.getElementById('alert-banner').classList.add('hidden');
});

function markDirty() {
  STATE.isDirty = true;
  const status = document.getElementById('autosave-status');
  status.classList.add('dirty');
  document.getElementById('autosave-text').textContent = 'Unsaved changes';
  scheduleAutosave();
}

function markSaved() {
  STATE.isDirty = false;
  const status = document.getElementById('autosave-status');
  status.classList.remove('dirty');
  document.getElementById('autosave-text').textContent = 'Saved!';
}

// ============================================================================
// 4. Drawing Canvas (Pointer Events for Mouse, Touch, Stylus)
// ============================================================================

const canvas = document.getElementById('paint-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let isDrawing = false;
let lastX = 0;
let lastY = 0;

function initCanvas() {
  // Fill initial white canvas
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  saveCanvasState();

  // Pointer event listeners (unifies mouse, touch, and stylus)
  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('pointerleave', handlePointerUp);

  buildPalette();
  setupBrushSizes();

  document.getElementById('btn-undo').addEventListener('click', handleUndo);
  document.getElementById('btn-clear-canvas').addEventListener('click', () => {
    if (confirm('Erase your entire drawing and start with a clean page?')) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      saveCanvasState();
      markDirty();
    }
  });
}

function getCanvasCoordinates(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function handlePointerDown(e) {
  canvas.setPointerCapture(e.pointerId);
  isDrawing = true;
  const pos = getCanvasCoordinates(e);
  lastX = pos.x;
  lastY = pos.y;

  // Single dot support
  ctx.beginPath();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STATE.currentSize;
  ctx.strokeStyle = STATE.isEraser ? '#FFFFFF' : STATE.currentColor;
  ctx.arc(lastX, lastY, STATE.currentSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = STATE.isEraser ? '#FFFFFF' : STATE.currentColor;
  ctx.fill();
}

function handlePointerMove(e) {
  if (!isDrawing) return;
  const pos = getCanvasCoordinates(e);

  ctx.beginPath();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STATE.currentSize;
  ctx.strokeStyle = STATE.isEraser ? '#FFFFFF' : STATE.currentColor;
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();

  lastX = pos.x;
  lastY = pos.y;
}

function handlePointerUp(e) {
  if (!isDrawing) return;
  isDrawing = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch (_) {}
  saveCanvasState();
  markDirty();
}

function saveCanvasState() {
  const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
  STATE.undoStack.push(snapshot);
  if (STATE.undoStack.length > STATE.maxUndo) {
    STATE.undoStack.shift();
  }
}

function handleUndo() {
  if (STATE.undoStack.length <= 1) {
    showAlert('Nothing left to undo!', 'ℹ️');
    return;
  }
  STATE.undoStack.pop(); // Remove current
  const previous = STATE.undoStack[STATE.undoStack.length - 1];
  ctx.putImageData(previous, 0, 0);
  markDirty();
}

function buildPalette() {
  const container = document.getElementById('color-palette');
  container.innerHTML = '';
  PALETTE_COLORS.forEach((color, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `color-swatch ${idx === 0 ? 'active' : ''}`;
    btn.style.backgroundColor = color;
    btn.setAttribute('aria-label', `Color ${color}`);
    btn.addEventListener('click', () => {
      STATE.currentColor = color;
      STATE.isEraser = false;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      document.getElementById('btn-eraser').classList.remove('active');
      btn.classList.add('active');
    });
    container.appendChild(btn);
  });
}

function setupBrushSizes() {
  const buttons = document.querySelectorAll('.size-btn[data-size]');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      STATE.currentSize = parseInt(btn.dataset.size, 10);
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  const eraserBtn = document.getElementById('btn-eraser');
  eraserBtn.addEventListener('click', () => {
    STATE.isEraser = true;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    eraserBtn.classList.add('active');
  });
}

// ============================================================================
// 5. Speech Synthesis ("Read it to me!")
// ============================================================================

const readBtn = document.getElementById('btn-read-aloud');
const storyTextarea = document.getElementById('story-text');

if (!('speechSynthesis' in window)) {
  readBtn.disabled = true;
  readBtn.title = 'Speech reader is not supported in this browser.';
} else {
  readBtn.addEventListener('click', toggleReadAloud);
}

function toggleReadAloud() {
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    resetReadBtn();
    return;
  }

  const text = storyTextarea.value.trim();
  if (!text) {
    showAlert('Write some words in your story first, then I can read them to you!', '📝');
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95; // Friendly, clear reading pace
  utterance.pitch = 1.05;

  utterance.onstart = () => {
    readBtn.classList.add('speaking');
    document.getElementById('read-label').textContent = 'Stop reading';
    document.getElementById('read-icon').textContent = '⏹️';
  };

  utterance.onend = resetReadBtn;
  utterance.onerror = resetReadBtn;

  window.speechSynthesis.speak(utterance);
}

function resetReadBtn() {
  readBtn.classList.remove('speaking');
  document.getElementById('read-label').textContent = 'Read it to me!';
  document.getElementById('read-icon').textContent = '🔊';
}

// ============================================================================
// 6. Audio Recording (MediaRecorder API - Opus/WebM, 5-Min Cap)
// ============================================================================

let mediaRecorder = null;
let recordedChunks = [];
let recordTimerInterval = null;
let recordSeconds = 0;
const MAX_RECORDING_SECONDS = 300; // 5 minutes

const btnRec = document.getElementById('btn-mic-record');
const btnStopRec = document.getElementById('btn-mic-stop');
const timerDisplay = document.getElementById('recording-timer');
const takesListEl = document.getElementById('takes-list');

btnRec.addEventListener('click', startAudioRecording);
btnStopRec.addEventListener('click', stopAudioRecording);

async function startAudioRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showAlert('Voice recording is not supported in this browser.', '⚠️');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    handleStreamReady(stream);
  } catch (err) {
    console.error('Mic access error:', err);
    showAlert(
      'Oops! We could not hear you. Please click the lock or camera icon in the top web address bar to let Story Desk use your microphone!',
      '🎤'
    );
  }
}

function handleStreamReady(stream) {
  recordedChunks = [];
  let mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'audio/webm';
  }

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = () => {
    // Stop all audio tracks to release the hardware mic
    stream.getTracks().forEach(track => track.stop());

    const audioBlob = new Blob(recordedChunks, { type: mimeType });
    const durationStr = formatSeconds(recordSeconds);
    const takeIndex = STATE.audioTakes.length + 1;
    const filename = `audio-${takeIndex}.webm`;

    const takeObj = {
      id: 'take_' + Date.now(),
      filename: filename,
      blob: audioBlob,
      url: URL.createObjectURL(audioBlob),
      duration: durationStr
    };

    STATE.audioTakes.push(takeObj);
    renderAudioTakes();
    markDirty();
    resetRecordingUI();
  };

  mediaRecorder.start(250); // Slice chunks every 250ms
  btnRec.disabled = true;
  btnRec.classList.add('recording');
  btnStopRec.disabled = false;

  recordSeconds = 0;
  updateTimerDisplay();
  recordTimerInterval = setInterval(() => {
    recordSeconds++;
    updateTimerDisplay();
    if (recordSeconds >= MAX_RECORDING_SECONDS) {
      stopAudioRecording();
      showAlert('Great job! That was 5 minutes, our maximum recording time.', '🎉');
    }
  }, 1000);
}

function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (recordTimerInterval) {
    clearInterval(recordTimerInterval);
    recordTimerInterval = null;
  }
}

function resetRecordingUI() {
  btnRec.disabled = false;
  btnRec.classList.remove('recording');
  btnStopRec.disabled = true;
  recordSeconds = 0;
  updateTimerDisplay();
}

function updateTimerDisplay() {
  timerDisplay.textContent = `${formatSeconds(recordSeconds)} / 05:00`;
}

function formatSeconds(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function renderAudioTakes() {
  takesListEl.innerHTML = '';
  if (STATE.audioTakes.length === 0) {
    takesListEl.innerHTML = '<li class="empty-takes">No recordings yet. Press "Record Voice" to make one!</li>';
    return;
  }

  STATE.audioTakes.forEach((take, idx) => {
    const li = document.createElement('li');

    const label = document.createElement('strong');
    label.textContent = `Take ${idx + 1} (${take.duration || 'audio'}):`;

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = take.url;
    audio.preload = 'metadata';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-delete-take';
    delBtn.textContent = '✕ Remove';
    delBtn.addEventListener('click', () => {
      if (confirm(`Remove Take ${idx + 1}?`)) {
        URL.revokeObjectURL(take.url);
        STATE.audioTakes.splice(idx, 1);
        renderAudioTakes();
        markDirty();
      }
    });

    li.appendChild(label);
    li.appendChild(audio);
    li.appendChild(delBtn);
    takesListEl.appendChild(li);
  });
}

// ============================================================================
// 7. Autosave & Local Draft Recovery
// ============================================================================

let autosaveTimer = null;

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    try {
      await saveDraftToIDB();
    } catch (err) {
      console.warn('Autosave error:', err);
    }
  }, 1200);
}

storyTextarea.addEventListener('input', markDirty);
document.getElementById('story-title').addEventListener('input', markDirty);

async function saveDraftToIDB() {
  const title = document.getElementById('story-title').value;
  const text = storyTextarea.value;
  const drawingDataUrl = canvas.toDataURL('image/png');

  // Convert audio blobs to array buffers for draft persistence
  const serializedAudios = [];
  for (const take of STATE.audioTakes) {
    const buffer = await take.blob.arrayBuffer();
    serializedAudios.push({
      id: take.id,
      filename: take.filename,
      duration: take.duration,
      buffer: buffer,
      type: take.blob.type
    });
  }

  const draftObj = {
    id: STATE.currentPostId,
    date: STATE.currentPostDate,
    title,
    text,
    drawingDataUrl,
    audios: serializedAudios,
    isPublished: STATE.isPublished,
    updatedAt: new Date().toISOString()
  };

  await idbSet('settings', 'current_draft', draftObj);
  markSaved();
}

async function loadDraftFromIDB() {
  try {
    const draft = await idbGet('settings', 'current_draft');
    if (!draft) return false;

    STATE.currentPostId = draft.id;
    STATE.currentPostDate = draft.date;
    STATE.isPublished = !!draft.isPublished;
    document.getElementById('story-title').value = draft.title || '';
    storyTextarea.value = draft.text || '';

    if (draft.drawingDataUrl) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        STATE.undoStack = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
      };
      img.src = draft.drawingDataUrl;
    }

    if (draft.audios && Array.isArray(draft.audios)) {
      STATE.audioTakes = draft.audios.map(a => {
        const blob = new Blob([a.buffer], { type: a.type });
        return {
          id: a.id,
          filename: a.filename,
          blob: blob,
          url: URL.createObjectURL(blob),
          duration: a.duration
        };
      });
      renderAudioTakes();
    }
    return true;
  } catch (err) {
    console.error('Failed to load draft:', err);
    return false;
  }
}

// ============================================================================
// 8. File System Access API & Full Post Saving
// ============================================================================

document.getElementById('btn-save').addEventListener('click', async () => {
  await saveFullPost(true);
});

async function getStoredDirectoryHandle() {
  if (STATE.rootDirectoryHandle) return STATE.rootDirectoryHandle;
  const stored = await idbGet('settings', 'directory_handle');
  if (stored) {
    STATE.rootDirectoryHandle = stored;
    return stored;
  }
  return null;
}

async function verifyPermission(fileHandle, readWrite) {
  const options = {};
  if (readWrite) {
    options.mode = 'readwrite';
  }
  if ((await fileHandle.queryPermission(options)) === 'granted') {
    return true;
  }
  if ((await fileHandle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
}

async function chooseStorageDirectory() {
  if (!('showDirectoryPicker' in window)) {
    showAlert('Your browser uses safe internal storage. Use "Export Everything" in Dad settings to make a backup!', 'ℹ️');
    return null;
  }
  try {
    const dirHandle = await window.showDirectoryPicker({
      id: 'story-desk-folder',
      mode: 'readwrite'
    });
    STATE.rootDirectoryHandle = dirHandle;
    await idbSet('settings', 'directory_handle', dirHandle);
    showAlert('Connected to your story folder on your computer!', '📁');
    updateDadFolderStatus();
    return dirHandle;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      showAlert('Could not choose folder: ' + err.message, '⚠️');
    }
    return null;
  }
}

function sanitizeFolderName(title) {
  const date = STATE.currentPostDate ? STATE.currentPostDate.split('T')[0] : new Date().toISOString().split('T')[0];
  const safeTitle = (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'my-story';
  return `${date}_${safeTitle}`;
}

async function saveFullPost(showNotification = true) {
  const title = document.getElementById('story-title').value.trim() || 'My Story';
  const text = storyTextarea.value;
  const dateIso = STATE.currentPostDate || new Date().toISOString();
  STATE.currentPostDate = dateIso;
  if (!STATE.currentPostId) {
    STATE.currentPostId = 'post_' + Date.now();
  }

  // Get Canvas Blob
  const canvasBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

  // Post metadata structure
  const postMetadata = {
    id: STATE.currentPostId,
    title: title,
    created: dateIso,
    updated: new Date().toISOString(),
    storyText: text,
    isPublished: STATE.isPublished,
    audioFiles: STATE.audioTakes.map((t, idx) => ({
      filename: `audio-${idx + 1}.webm`,
      duration: t.duration
    }))
  };

  // Try File System Access API
  let dirHandle = await getStoredDirectoryHandle();

  if (!dirHandle && 'showDirectoryPicker' in window) {
    // First run prompt to choose folder
    const wantFolder = confirm('Would you like to choose a folder on your computer to save all your stories and pictures?');
    if (wantFolder) {
      dirHandle = await chooseStorageDirectory();
    }
  }

  if (dirHandle && 'showDirectoryPicker' in window) {
    try {
      const hasPerm = await verifyPermission(dirHandle, true);
      if (!hasPerm) throw new Error('Permission denied');

      const folderName = sanitizeFolderName(title);
      const postDir = await dirHandle.getDirectoryHandle(folderName, { create: true });

      // 1. Write post.json
      const metaFile = await postDir.getFileHandle('post.json', { create: true });
      const metaWritable = await metaFile.createWritable();
      await metaWritable.write(JSON.stringify(postMetadata, null, 2));
      await metaWritable.close();

      // 2. Write drawing.png
      const drawFile = await postDir.getFileHandle('drawing.png', { create: true });
      const drawWritable = await drawFile.createWritable();
      await drawWritable.write(canvasBlob);
      await drawWritable.close();

      // 3. Write audio files
      for (let i = 0; i < STATE.audioTakes.length; i++) {
        const take = STATE.audioTakes[i];
        const audioName = `audio-${i + 1}.webm`;
        const audioFile = await postDir.getFileHandle(audioName, { create: true });
        const audioWritable = await audioFile.createWritable();
        await audioWritable.write(take.blob);
        await audioWritable.close();
      }

      // Keep IDB cache updated too for fast gallery rendering
      await savePostToIDB(postMetadata, canvasBlob);
      markSaved();
      if (showNotification) showAlert(`Saved "${title}" to your computer folder!`, '🎉');
      return true;
    } catch (err) {
      console.warn('File System write failed, saving to IndexedDB fallback:', err);
    }
  }

  // Fallback: Save to IndexedDB
  await savePostToIDB(postMetadata, canvasBlob);
  markSaved();
  if (showNotification) showAlert(`Saved "${title}" safely inside Story Desk!`, '⭐');
  return true;
}

async function savePostToIDB(meta, canvasBlob) {
  // Convert audio takes into serializable blobs
  const audios = [];
  for (let i = 0; i < STATE.audioTakes.length; i++) {
    audios.push({
      filename: `audio-${i + 1}.webm`,
      blob: STATE.audioTakes[i].blob,
      duration: STATE.audioTakes[i].duration
    });
  }

  const fullRecord = {
    ...meta,
    drawingBlob: canvasBlob,
    audios: audios
  };

  await idbPutPost(fullRecord);
}

// ============================================================================
// 9. My Stories Gallery
// ============================================================================

const galleryBtn = document.getElementById('btn-gallery');
const galleryDialog = document.getElementById('gallery-dialog');

galleryBtn.addEventListener('click', openGallery);

async function openGallery() {
  const container = document.getElementById('gallery-posts-container');
  container.innerHTML = '<p>Loading your wonderful stories...</p>';
  galleryDialog.showModal();

  const posts = await loadAllPostsFromDiskOrIDB();
  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = '<p class="empty-takes">No stories saved yet. Draw and write something, then click Save!</p>';
    return;
  }

  posts.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));

  posts.forEach(post => {
    const card = document.createElement('article');
    card.className = 'gallery-card';

    const img = document.createElement('img');
    img.className = 'gallery-thumb';
    img.alt = `Drawing for ${post.title}`;
    img.src = post.drawingUrl || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100%" height="100%" fill="%23eee"/></svg>';

    const info = document.createElement('div');
    info.className = 'gallery-info';

    const h3 = document.createElement('h3');
    h3.className = 'gallery-post-title';
    h3.textContent = post.title || 'Untitled Story';

    const date = document.createElement('div');
    date.className = 'gallery-post-date';
    date.textContent = new Date(post.created).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    const actions = document.createElement('div');
    actions.className = 'gallery-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'nav-btn btn-fun';
    openBtn.innerHTML = '✏️ Open &amp; Edit';
    openBtn.addEventListener('click', () => {
      loadPostIntoEditor(post);
      galleryDialog.close();
    });

    actions.appendChild(openBtn);
    info.appendChild(h3);
    info.appendChild(date);
    info.appendChild(actions);

    card.appendChild(img);
    card.appendChild(info);
    container.appendChild(card);
  });
}

async function loadAllPostsFromDiskOrIDB() {
  const results = [];
  const dirHandle = await getStoredDirectoryHandle();

  if (dirHandle && 'showDirectoryPicker' in window) {
    try {
      const hasPerm = await verifyPermission(dirHandle, false);
      if (hasPerm) {
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'directory' && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
            try {
              const metaHandle = await entry.getFileHandle('post.json');
              const metaFile = await metaHandle.getFile();
              const metaText = await metaFile.text();
              const meta = JSON.parse(metaText);

              let drawingUrl = '';
              try {
                const drawHandle = await entry.getFileHandle('drawing.png');
                const drawFile = await drawHandle.getFile();
                drawingUrl = URL.createObjectURL(drawFile);
              } catch (_) {}

              // Keep directory handle attached to post object for loading
              results.push({
                ...meta,
                dirHandle: entry,
                drawingUrl: drawingUrl
              });
            } catch (_) {
              // Not a post directory, ignore
            }
          }
        }
        if (results.length > 0) return results;
      }
    } catch (err) {
      console.warn('Could not read from directory handle:', err);
    }
  }

  // Fallback to IndexedDB
  const idbPosts = await idbGetAllPosts();
  return idbPosts.map(p => ({
    ...p,
    drawingUrl: p.drawingBlob ? URL.createObjectURL(p.drawingBlob) : ''
  }));
}

async function loadPostIntoEditor(post) {
  if (STATE.isDirty) {
    const proceed = confirm('You have unsaved changes in your current story. Would you like to save it first?');
    if (proceed) {
      await saveFullPost(false);
    }
  }

  STATE.currentPostId = post.id;
  STATE.currentPostDate = post.created;
  STATE.isPublished = !!post.isPublished;
  document.getElementById('story-title').value = post.title || '';
  storyTextarea.value = post.storyText || '';

  // Load Drawing
  if (post.drawingUrl) {
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      STATE.undoStack = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
    };
    img.src = post.drawingUrl;
  }

  // Load Audio Recordings
  STATE.audioTakes = [];
  if (post.dirHandle) {
    // Read audio takes from directory handle
    for (const aInfo of (post.audioFiles || [])) {
      try {
        const audioHandle = await post.dirHandle.getFileHandle(aInfo.filename);
        const audioFile = await audioHandle.getFile();
        STATE.audioTakes.push({
          id: 'take_' + Math.random(),
          filename: aInfo.filename,
          blob: audioFile,
          url: URL.createObjectURL(audioFile),
          duration: aInfo.duration || 'audio'
        });
      } catch (e) {
        console.warn('Audio take missing:', aInfo.filename, e);
      }
    }
  } else if (post.audios && Array.isArray(post.audios)) {
    // Read audio takes from IndexedDB record
    post.audios.forEach(a => {
      STATE.audioTakes.push({
        id: 'take_' + Math.random(),
        filename: a.filename,
        blob: a.blob,
        url: URL.createObjectURL(a.blob),
        duration: a.duration || 'audio'
      });
    });
  }

  renderAudioTakes();
  markSaved();
  showAlert(`Loaded "${post.title}"! Ready to paint and write.`, '📖');
}

// "New Story" Button
document.getElementById('btn-new-post').addEventListener('click', async () => {
  if (STATE.isDirty) {
    const proceed = confirm('Save your current work before starting a fresh story?');
    if (proceed) {
      await saveFullPost(false);
    }
  }
  startNewPost();
});

function startNewPost() {
  STATE.currentPostId = 'post_' + Date.now();
  STATE.currentPostDate = new Date().toISOString();
  STATE.isPublished = false;
  document.getElementById('story-title').value = '';
  storyTextarea.value = '';

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  STATE.undoStack = [ctx.getImageData(0, 0, canvas.width, canvas.height)];

  STATE.audioTakes.forEach(t => URL.revokeObjectURL(t.url));
  STATE.audioTakes = [];
  renderAudioTakes();

  markSaved();
  showAlert('Fresh new page ready for your imagination!', '✨');
}

// Dialog Close helper
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    const dialogId = btn.getAttribute('data-close');
    document.getElementById(dialogId).close();
  });
});

// ============================================================================
// 10. Parent Area (Dad Gate & Admin Dashboard)
// ============================================================================

const dadLoginBtn = document.getElementById('btn-dad-login');
const dadGateDialog = document.getElementById('dad-gate-dialog');
const dadAdminDialog = document.getElementById('dad-admin-dialog');
const dadGateForm = document.getElementById('dad-gate-form');
const dadPasscodeInput = document.getElementById('dad-passcode');
const dadGateError = document.getElementById('dad-gate-error');

dadLoginBtn.addEventListener('click', () => {
  dadPasscodeInput.value = '';
  dadGateError.classList.add('hidden');
  dadGateDialog.showModal();
  dadPasscodeInput.focus();
});

dadGateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = dadPasscodeInput.value.trim().toLowerCase();
  if (val === STATE.parentPasscode || val === 'story' || val === 'admin') {
    dadGateDialog.close();
    openDadAdmin();
  } else {
    dadGateError.classList.remove('hidden');
  }
});

async function openDadAdmin() {
  updateDadFolderStatus();
  await renderDadPostsTable();
  dadAdminDialog.showModal();
}

async function updateDadFolderStatus() {
  const statusEl = document.getElementById('folder-status-text');
  const dir = await getStoredDirectoryHandle();
  if (dir) {
    statusEl.textContent = `Active folder: "${dir.name}" on her computer.`;
  } else {
    statusEl.textContent = 'Using browser IndexedDB. Click below to connect a folder on her computer!';
  }
}

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  await chooseStorageDirectory();
});

async function renderDadPostsTable() {
  const container = document.getElementById('dad-posts-table');
  container.innerHTML = '<p>Loading stories...</p>';
  const posts = await loadAllPostsFromDiskOrIDB();
  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = '<p>No stories found.</p>';
    return;
  }

  posts.forEach(post => {
    const row = document.createElement('div');
    row.className = 'admin-post-row';

    const info = document.createElement('div');
    info.innerHTML = `<strong>${escapeHtml(post.title || 'Untitled')}</strong> (${new Date(post.created).toLocaleDateString()}) - ${post.audioFiles ? post.audioFiles.length : (post.audios ? post.audios.length : 0)} audio file(s)`;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = '10px';

    const badge = document.createElement('span');
    badge.className = `status-badge ${post.isPublished ? 'published' : 'draft'}`;
    badge.textContent = post.isPublished ? 'Published' : 'Draft Only';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'admin-btn';
    toggleBtn.textContent = post.isPublished ? 'Unpublish' : 'Mark as Published';
    toggleBtn.addEventListener('click', async () => {
      post.isPublished = !post.isPublished;
      if (post.id === STATE.currentPostId) {
        STATE.isPublished = post.isPublished;
      }
      await updatePostPublishedStatus(post);
      await renderDadPostsTable();
    });

    actions.appendChild(badge);
    actions.appendChild(toggleBtn);
    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

async function updatePostPublishedStatus(post) {
  // Update in file system if handle present
  if (post.dirHandle) {
    try {
      const metaHandle = await post.dirHandle.getFileHandle('post.json', { create: true });
      const writable = await metaHandle.createWritable();
      const updated = {
        ...post,
        isPublished: post.isPublished,
        updated: new Date().toISOString()
      };
      delete updated.dirHandle;
      delete updated.drawingUrl;
      await writable.write(JSON.stringify(updated, null, 2));
      await writable.close();
    } catch (e) {
      console.warn('Failed to update published flag on disk:', e);
    }
  }

  // Update in IndexedDB
  const idbPosts = await idbGetAllPosts();
  const match = idbPosts.find(p => p.id === post.id);
  if (match) {
    match.isPublished = post.isPublished;
    await idbPutPost(match);
  }
}

// ============================================================================
// 11. Minimal Pure Vanilla PKZip Builder (Store Mode + CRC32, No Libraries)
// ============================================================================

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}

function calculateCRC32(uint8Array) {
  let crc = -1;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ uint8Array[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function buildZipFile(files) {
  // files: Array of { path: string, data: Uint8Array, date?: Date }
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  const textEncoder = new TextEncoder();

  for (const file of files) {
    const filenameBytes = textEncoder.encode(file.path.replace(/\\/g, '/'));
    const dataBytes = file.data;
    const crc = calculateCRC32(dataBytes);
    const size = dataBytes.length;

    const d = file.date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    // Local file header (30 bytes)
    const localHeader = new Uint8Array(30 + filenameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);  // Local header signature
    lv.setUint16(4, 20, true);          // Version needed: 2.0
    lv.setUint16(6, 0x0800, true);      // General purpose bit flag (UTF-8)
    lv.setUint16(8, 0, true);           // Compression: 0 (Store)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);       // Compressed size
    lv.setUint32(22, size, true);       // Uncompressed size
    lv.setUint16(26, filenameBytes.length, true);
    lv.setUint16(28, 0, true);          // Extra field length
    localHeader.set(filenameBytes, 30);

    localHeaders.push(localHeader);
    localHeaders.push(dataBytes);

    // Central directory header (46 bytes)
    const centralHeader = new Uint8Array(46 + filenameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);  // Central dir signature
    cv.setUint16(4, 20, true);          // Version made by: 2.0
    cv.setUint16(6, 20, true);          // Version needed: 2.0
    cv.setUint16(8, 0x0800, true);      // UTF-8 flag
    cv.setUint16(10, 0, true);          // Store
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, filenameBytes.length, true);
    cv.setUint16(30, 0, true);          // Extra field length
    cv.setUint16(32, 0, true);          // Comment length
    cv.setUint16(34, 0, true);          // Disk number
    cv.setUint16(36, 0, true);          // Internal attributes
    cv.setUint32(38, 0, true);          // External attributes
    cv.setUint32(42, offset, true);     // Relative offset of local header
    centralHeader.set(filenameBytes, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    centralDirSize += ch.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);  // EOCD signature
  ev.setUint16(4, 0, true);           // Disk number
  ev.setUint16(6, 0, true);           // Start disk
  ev.setUint16(8, files.length, true);  // Records on disk
  ev.setUint16(10, files.length, true); // Total records
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirOffset, true);
  ev.setUint16(20, 0, true);          // Comment length

  return new Blob([...localHeaders, ...centralHeaders, eocd], { type: 'application/zip' });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// "Export Everything" Button
document.getElementById('btn-export-everything').addEventListener('click', async () => {
  const posts = await loadAllPostsFromDiskOrIDB();
  if (posts.length === 0) {
    alert('No posts available to export yet!');
    return;
  }

  const zipFiles = [];
  for (const post of posts) {
    const slug = sanitizeFolderName(post.title);

    // post.json
    const metaClone = { ...post };
    delete metaClone.dirHandle;
    delete metaClone.drawingUrl;
    delete metaClone.drawingBlob;
    delete metaClone.audios;
    zipFiles.push({
      path: `${slug}/post.json`,
      data: new TextEncoder().encode(JSON.stringify(metaClone, null, 2))
    });

    // drawing.png
    if (post.dirHandle) {
      try {
        const drawHandle = await post.dirHandle.getFileHandle('drawing.png');
        const drawFile = await drawHandle.getFile();
        const buf = new Uint8Array(await drawFile.arrayBuffer());
        zipFiles.push({ path: `${slug}/drawing.png`, data: buf });
      } catch (_) {}
    } else if (post.drawingBlob) {
      const buf = new Uint8Array(await post.drawingBlob.arrayBuffer());
      zipFiles.push({ path: `${slug}/drawing.png`, data: buf });
    }

    // Audio files
    if (post.dirHandle) {
      for (const aInfo of (post.audioFiles || [])) {
        try {
          const aHandle = await post.dirHandle.getFileHandle(aInfo.filename);
          const aFile = await aHandle.getFile();
          const buf = new Uint8Array(await aFile.arrayBuffer());
          zipFiles.push({ path: `${slug}/${aInfo.filename}`, data: buf });
        } catch (_) {}
      }
    } else if (post.audios) {
      for (const a of post.audios) {
        const buf = new Uint8Array(await a.blob.arrayBuffer());
        zipFiles.push({ path: `${slug}/${a.filename}`, data: buf });
      }
    }
  }

  const zipBlob = buildZipFile(zipFiles);
  triggerDownload(zipBlob, `story-desk-export-${new Date().toISOString().split('T')[0]}.zip`);
});

// ============================================================================
// 12. Static Site Generator (Zero External Requests, Fully Self-Contained)
// ============================================================================

document.getElementById('btn-generate-site').addEventListener('click', async () => {
  const statusMsg = document.getElementById('publish-status-msg');
  statusMsg.textContent = 'Generating blog site...';

  const includeAudio = document.getElementById('chk-include-audio').checked;
  const allPosts = await loadAllPostsFromDiskOrIDB();
  const publishedPosts = allPosts.filter(p => p.isPublished);

  if (publishedPosts.length === 0) {
    statusMsg.textContent = 'None of the stories are marked as "Published" yet! Click "Mark as Published" above first.';
    return;
  }

  publishedPosts.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));

  const zipFiles = [];

  // 1. Common blog style.css
  const siteCss = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #FFF9ED;
      color: #2D3436;
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.6;
      padding: 24px;
      max-width: 900px;
      margin: 0 auto;
    }
    header { text-align: center; margin-bottom: 36px; padding-bottom: 20px; border-bottom: 3px solid #FFEAA7; }
    h1 { color: #D63031; font-size: 2.4rem; margin-bottom: 8px; }
    .site-desc { color: #636E72; font-size: 1.1rem; }
    .post-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 24px; }
    .post-card { background: #FFFFFF; border-radius: 18px; border: 2px solid #EADDC7; overflow: hidden; display: flex; flex-direction: column; text-decoration: none; color: inherit; transition: transform 0.15s ease; }
    .post-card:hover { transform: translateY(-4px); box-shadow: 0 10px 25px rgba(0,0,0,0.06); }
    .post-thumb { width: 100%; aspect-ratio: 800 / 550; object-fit: contain; background: #F8FAFC; border-bottom: 2px solid #F1F2F6; }
    .post-info { padding: 16px; }
    .post-title { font-size: 1.3rem; color: #2D3436; margin-bottom: 6px; }
    .post-date { font-size: 0.9rem; color: #A0AEC0; }
    .single-post { background: #FFFFFF; border-radius: 24px; border: 3px solid #EADDC7; padding: 32px; box-shadow: 0 8px 30px rgba(0,0,0,0.05); }
    .back-link { display: inline-block; margin-bottom: 20px; text-decoration: none; font-weight: 700; color: #0984E3; }
    .story-hero-img { width: 100%; max-height: 550px; object-fit: contain; border-radius: 16px; background: #FAFBFD; border: 2px solid #EDF2F7; margin: 20px 0; }
    .story-body { font-size: 1.35rem; line-height: 1.8; white-space: pre-wrap; margin: 24px 0; }
    .audio-section { background: #FFF4E5; border: 2px solid #FFE0B2; border-radius: 16px; padding: 18px; margin-top: 24px; }
    .audio-player-row { margin-top: 10px; display: flex; align-items: center; gap: 12px; }
    audio { width: 100%; height: 44px; }
  `;
  zipFiles.push({ path: 'style.css', data: new TextEncoder().encode(siteCss) });

  // 2. Main blog index.html
  let indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Our Family Story Desk</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <header>
    <h1>✨ Our Story Desk ✨</h1>
    <p class="site-desc">A private collection of adventures, drawings, and stories.</p>
  </header>
  <main class="post-grid">
`;

  for (const post of publishedPosts) {
    const slug = sanitizeFolderName(post.title);
    const dateFormatted = new Date(post.created).toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    indexHtml += `
    <a href="./${slug}/index.html" class="post-card">
      <img src="./${slug}/drawing.png" alt="Drawing for ${escapeHtml(post.title)}" class="post-thumb" loading="lazy">
      <div class="post-info">
        <h2 class="post-title">${escapeHtml(post.title)}</h2>
        <div class="post-date">${dateFormatted}</div>
      </div>
    </a>
`;

    // 3. Build Post Page
    let postPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(post.title)} - Story Desk</title>
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <a href="../index.html" class="back-link">← Back to All Stories</a>
  <article class="single-post">
    <h1>${escapeHtml(post.title)}</h1>
    <p class="post-date">${dateFormatted}</p>
    <img src="./drawing.png" alt="Drawing for ${escapeHtml(post.title)}" class="story-hero-img">
    <div class="story-body">${escapeHtml(post.storyText || '')}</div>
`;

    if (includeAudio) {
      let audioListHtml = '';
      const audioFiles = post.audioFiles || (post.audios ? post.audios.map(a => ({ filename: a.filename, duration: a.duration })) : []);

      audioFiles.forEach((af, idx) => {
        audioListHtml += `
      <div class="audio-player-row">
        <span>Take ${idx + 1}:</span>
        <audio controls src="./${af.filename}" preload="metadata"></audio>
      </div>
`;
      });

      if (audioListHtml) {
        postPageHtml += `
    <section class="audio-section">
      <h3>🎙️ Voice Recordings</h3>
      ${audioListHtml}
    </section>
`;
      }
    }

    postPageHtml += `
  </article>
</body>
</html>
`;

    zipFiles.push({
      path: `${slug}/index.html`,
      data: new TextEncoder().encode(postPageHtml)
    });

    // Drawing file
    if (post.dirHandle) {
      try {
        const drawH = await post.dirHandle.getFileHandle('drawing.png');
        const drawF = await drawH.getFile();
        const buf = new Uint8Array(await drawF.arrayBuffer());
        zipFiles.push({ path: `${slug}/drawing.png`, data: buf });
      } catch (_) {}
    } else if (post.drawingBlob) {
      const buf = new Uint8Array(await post.drawingBlob.arrayBuffer());
      zipFiles.push({ path: `${slug}/drawing.png`, data: buf });
    }

    // Audio files
    if (includeAudio) {
      if (post.dirHandle) {
        for (const aInfo of (post.audioFiles || [])) {
          try {
            const aHandle = await post.dirHandle.getFileHandle(aInfo.filename);
            const aFile = await aHandle.getFile();
            const buf = new Uint8Array(await aFile.arrayBuffer());
            zipFiles.push({ path: `${slug}/${aInfo.filename}`, data: buf });
          } catch (_) {}
        }
      } else if (post.audios) {
        for (const a of post.audios) {
          const buf = new Uint8Array(await a.blob.arrayBuffer());
          zipFiles.push({ path: `${slug}/${a.filename}`, data: buf });
        }
      }
    }
  }

  indexHtml += `
  </main>
</body>
</html>
`;

  zipFiles.push({ path: 'index.html', data: new TextEncoder().encode(indexHtml) });

  // Generate ZIP of the site
  const siteZip = buildZipFile(zipFiles);
  triggerDownload(siteZip, `story-blog-site-${new Date().toISOString().split('T')[0]}.zip`);

  statusMsg.textContent = `Generated site bundle with ${publishedPosts.length} published story(ies)! ZIP downloaded. Ready for Cloudflare Pages drag & drop.`;
});

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// 13. Service Worker Registration & App Launch
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  initCanvas();

  // Try to recover any active draft
  const hasDraft = await loadDraftFromIDB();
  if (!hasDraft) {
    startNewPost();
  }

  // Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      console.log('Story Desk ServiceWorker registered with scope:', reg.scope);
    }).catch((err) => {
      console.warn('ServiceWorker registration error:', err);
    });
  }
});

