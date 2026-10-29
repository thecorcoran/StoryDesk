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
  currentAuthorId: null, // Profile ID of the author for the active post
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
  profiles: [], // Array of { id, name, slug, emoji, color }
  activeProfileId: null, // Currently selected kid's profile ID
  blogBlobUrls: [], // Object URLs to clean up when exiting "See My Blog" view
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
  if (status) status.classList.add('dirty');
  const textEl = document.getElementById('autosave-text');
  if (textEl) textEl.textContent = 'Saving...';
  scheduleAutosave();
}

function markSaved() {
  STATE.isDirty = false;
  const status = document.getElementById('autosave-status');
  if (status) status.classList.remove('dirty');
  const textEl = document.getElementById('autosave-text');
  if (textEl) textEl.textContent = 'Saved!';
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

  // Ensure an author is assigned
  const authorId = STATE.currentAuthorId || STATE.activeProfileId || (STATE.profiles[0] ? STATE.profiles[0].id : null);
  STATE.currentAuthorId = authorId;

  // Get Canvas Blob
  const canvasBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

  // Post metadata structure
  const postMetadata = {
    id: STATE.currentPostId,
    title: title,
    author: authorId,
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
    const wantFolder = confirm('Would you like to choose a folder on your computer to save all your stories and pictures?');
    if (wantFolder) {
      dirHandle = await chooseStorageDirectory();
    }
  }

  if (dirHandle && 'showDirectoryPicker' in window) {
    try {
      const hasPerm = await verifyPermission(dirHandle, true);
      if (!hasPerm) throw new Error('Permission denied');

      // New Folder Layout: Stories/<kid-slug>/<YYYY-MM-DD>_<story-slug>/
      const storiesDir = await dirHandle.getDirectoryHandle('Stories', { create: true });
      const activeProf = STATE.profiles.find(p => p.id === authorId);
      const kidSlug = activeProf ? activeProf.slug : (authorId ? slugify(authorId) : 'general');
      const kidDir = await storiesDir.getDirectoryHandle(kidSlug, { create: true });
      const folderName = sanitizeFolderName(title);
      const postDir = await kidDir.getDirectoryHandle(folderName, { create: true });

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
// 9. My Stories Gallery & Multi-Profile Support
// ============================================================================

const galleryBtn = document.getElementById('btn-gallery');
const galleryDialog = document.getElementById('gallery-dialog');

galleryBtn.addEventListener('click', openGallery);

async function openGallery() {
  const container = document.getElementById('gallery-posts-container');
  container.innerHTML = '<p>Loading your wonderful stories...</p>';
  galleryDialog.showModal();

  const allPosts = await loadAllPostsFromDiskOrIDB();
  container.innerHTML = '';

  // Filter posts for the currently active profile
  const activeKid = STATE.profiles.find(p => p.id === STATE.activeProfileId);
  const posts = allPosts.filter(p => {
    if (!STATE.activeProfileId) return true;
    if (p.author === STATE.activeProfileId) return true;
    // Backward compat: if post has no author and only 1 profile exists, attribute to it
    if (!p.author && STATE.profiles.length <= 1) return true;
    return false;
  });

  if (posts.length === 0) {
    const kidName = activeKid ? activeKid.name : 'you';
    container.innerHTML = `<p class="empty-takes">No stories saved for ${escapeHtml(kidName)} yet. Draw and write something, then click Save!</p>`;
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
    h3.innerHTML = `${escapeHtml(post.title || 'Untitled Story')} <span class="gallery-badge ${post.isPublished ? 'published' : 'draft'}">${post.isPublished ? '⭐ Published' : '📝 Draft'}</span>`;

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

async function readPostFromDir(postDirHandle) {
  try {
    const metaHandle = await postDirHandle.getFileHandle('post.json');
    const metaFile = await metaHandle.getFile();
    const metaText = await metaFile.text();
    const meta = JSON.parse(metaText);

    let drawingUrl = '';
    try {
      const drawHandle = await postDirHandle.getFileHandle('drawing.png');
      const drawFile = await drawHandle.getFile();
      drawingUrl = URL.createObjectURL(drawFile);
    } catch (_) {}

    return {
      ...meta,
      dirHandle: postDirHandle,
      drawingUrl: drawingUrl
    };
  } catch (_) {
    return null;
  }
}

async function loadAllPostsFromDiskOrIDB() {
  const results = [];
  const seenIds = new Set();
  const dirHandle = await getStoredDirectoryHandle();

  if (dirHandle && 'showDirectoryPicker' in window) {
    try {
      const hasPerm = await verifyPermission(dirHandle, false);
      if (hasPerm) {
        // 1. Check Stories/ subfolder (New Layout: Stories/<kid-slug>/<post-folder>/)
        try {
          const storiesDir = await dirHandle.getDirectoryHandle('Stories');
          for await (const kidEntry of storiesDir.values()) {
            if (kidEntry.kind === 'directory' && !kidEntry.name.startsWith('.') && !kidEntry.name.startsWith('_')) {
              for await (const postEntry of kidEntry.values()) {
                if (postEntry.kind === 'directory' && !postEntry.name.startsWith('.')) {
                  const post = await readPostFromDir(postEntry);
                  if (post && !seenIds.has(post.id)) {
                    seenIds.add(post.id);
                    results.push(post);
                  }
                }
              }
            }
          }
        } catch (_) {}

        // 2. Check root-level entries (Old Layout: <post-folder>/ or direct <kid-slug>/<post-folder>/)
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'directory' && !entry.name.startsWith('.') && !entry.name.startsWith('_') && entry.name !== 'site' && entry.name !== 'Stories') {
            const directPost = await readPostFromDir(entry);
            if (directPost) {
              if (!seenIds.has(directPost.id)) {
                seenIds.add(directPost.id);
                results.push(directPost);
              }
            } else {
              // Check if entry is a kid folder containing post folders
              try {
                for await (const subEntry of entry.values()) {
                  if (subEntry.kind === 'directory' && !subEntry.name.startsWith('.')) {
                    const subPost = await readPostFromDir(subEntry);
                    if (subPost && !seenIds.has(subPost.id)) {
                      seenIds.add(subPost.id);
                      results.push(subPost);
                    }
                  }
                }
              } catch (_) {}
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
  STATE.currentAuthorId = post.author || STATE.activeProfileId || null;
  STATE.isPublished = !!post.isPublished;

  // Switch active profile in UI if post has a known author
  if (post.author) {
    const matchingProfile = STATE.profiles.find(p => p.id === post.author);
    if (matchingProfile && matchingProfile.id !== STATE.activeProfileId) {
      await setActiveProfile(matchingProfile.id);
    }
  }

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

// Delegated Dialog Close helper
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) {
    const dialogId = closeBtn.getAttribute('data-close');
    const dlg = document.getElementById(dialogId);
    if (dlg) {
      if (typeof dlg.close === 'function') {
        try {
          dlg.close();
        } catch (_) {
          dlg.removeAttribute('open');
        }
      } else {
        dlg.removeAttribute('open');
      }
    }
  }
});

function slugify(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'kid';
}

// ============================================================================
// 10. Multi-Kid Profile Management
// ============================================================================

async function loadProfilesFromDiskOrIDB() {
  let profiles = null;
  const dirHandle = await getStoredDirectoryHandle();
  if (dirHandle && 'showDirectoryPicker' in window) {
    try {
      const perm = await verifyPermission(dirHandle, false);
      if (perm) {
        const fileHandle = await dirHandle.getFileHandle('profiles.json');
        const file = await fileHandle.getFile();
        const text = await file.text();
        profiles = JSON.parse(text);
      }
    } catch (_) {}
  }
  if (!profiles || !Array.isArray(profiles) || profiles.length === 0) {
    profiles = await idbGet('settings', 'profiles');
  }
  return Array.isArray(profiles) ? profiles : [];
}

async function saveProfilesToDiskAndIDB(profiles) {
  STATE.profiles = profiles;
  await idbSet('settings', 'profiles', profiles);
  const dirHandle = await getStoredDirectoryHandle();
  if (dirHandle && 'showDirectoryPicker' in window) {
    try {
      const perm = await verifyPermission(dirHandle, true);
      if (perm) {
        const fileHandle = await dirHandle.getFileHandle('profiles.json', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(profiles, null, 2));
        await writable.close();
      }
    } catch (e) {
      console.warn('Could not write profiles.json to disk:', e);
    }
  }
  renderProfileDropdown();
  renderDadProfilesList();
}

function renderProfileDropdown() {
  const select = document.getElementById('select-profile');
  if (!select) return;
  select.innerHTML = '';

  if (STATE.profiles.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Add Kid...';
    select.appendChild(opt);
    updateActiveProfileVisuals(null);
    return;
  }

  STATE.profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.emoji || '⭐'} ${p.name}`;
    if (p.id === STATE.activeProfileId) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  const active = STATE.profiles.find(p => p.id === STATE.activeProfileId) || STATE.profiles[0];
  if (active && active.id !== STATE.activeProfileId) {
    setActiveProfile(active.id);
  } else {
    updateActiveProfileVisuals(active);
  }
}

async function setActiveProfile(profileId) {
  const profile = STATE.profiles.find(p => p.id === profileId);
  if (!profile) return;
  STATE.activeProfileId = profile.id;
  STATE.currentAuthorId = profile.id;
  await idbSet('settings', 'active_profile_id', profile.id);

  const select = document.getElementById('select-profile');
  if (select && select.value !== profile.id) {
    select.value = profile.id;
  }
  updateActiveProfileVisuals(profile);
}

function updateActiveProfileVisuals(profile) {
  const avatar = document.getElementById('active-profile-avatar');
  const pill = document.getElementById('profile-pill');
  if (!avatar || !pill) return;
  if (profile) {
    avatar.textContent = profile.emoji || '⭐';
    if (profile.color) {
      pill.style.borderColor = profile.color;
      pill.style.boxShadow = `0 2px 8px ${profile.color}40`;
    }
  } else {
    avatar.textContent = '⭐';
    pill.style.borderColor = '#FDCB6E';
    pill.style.boxShadow = 'none';
  }
}

document.getElementById('select-profile')?.addEventListener('change', async (e) => {
  const selectedId = e.target.value;
  if (!selectedId) return;

  if (STATE.isDirty) {
    const proceed = confirm('Save your current story changes before switching writers?');
    if (proceed) {
      await saveFullPost(false);
    }
  }
  await setActiveProfile(selectedId);
  startNewPost();
});

// Dad Profile Management: Add, Rename, Remove
function renderDadProfilesList() {
  const listContainer = document.getElementById('dad-profiles-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (STATE.profiles.length === 0) {
    listContainer.innerHTML = '<p class="kid-hint">No kid profiles yet. Add one below!</p>';
    return;
  }

  STATE.profiles.forEach(prof => {
    const row = document.createElement('div');
    row.className = 'profile-item-row';

    const info = document.createElement('div');
    info.className = 'profile-item-info';

    const avatar = document.createElement('div');
    avatar.className = 'profile-avatar-tag';
    avatar.style.backgroundColor = prof.color || '#FD79A8';
    avatar.textContent = prof.emoji || '⭐';

    const label = document.createElement('span');
    label.textContent = `${prof.name} (${prof.slug})`;

    info.appendChild(avatar);
    info.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'profile-item-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'admin-btn btn-secondary';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => handleRenameProfile(prof.id));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'admin-btn btn-danger-soft';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => handleRemoveProfile(prof.id));

    actions.appendChild(renameBtn);
    actions.appendChild(removeBtn);

    row.appendChild(info);
    row.appendChild(actions);
    listContainer.appendChild(row);
  });
}

document.getElementById('form-add-profile')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById('input-new-profile-name');
  const emojiSelect = document.getElementById('select-profile-emoji');
  const colorInput = document.getElementById('input-profile-color');

  const name = nameInput.value.trim();
  if (!name) return;

  let baseSlug = slugify(name);
  let finalSlug = baseSlug;
  let counter = 2;
  while (STATE.profiles.some(p => p.slug === finalSlug)) {
    finalSlug = `${baseSlug}-${counter++}`;
  }

  const newProfile = {
    id: 'profile_' + Date.now(),
    name: name,
    slug: finalSlug,
    emoji: emojiSelect.value || '⭐',
    color: colorInput.value || '#FD79A8'
  };

  const updatedProfiles = [...STATE.profiles, newProfile];
  await saveProfilesToDiskAndIDB(updatedProfiles);
  await setActiveProfile(newProfile.id);

  nameInput.value = '';
  showAlert(`Added profile for ${name}!`, '🎉');
  await renderDadPostsTable();
});

async function handleRenameProfile(profileId) {
  const profile = STATE.profiles.find(p => p.id === profileId);
  if (!profile) return;

  const newName = prompt(`Rename writer "${profile.name}" to:`, profile.name);
  if (!newName || !newName.trim() || newName.trim() === profile.name) return;

  profile.name = newName.trim();
  await saveProfilesToDiskAndIDB(STATE.profiles);
  showAlert(`Renamed to ${profile.name}!`, '✏️');
}

async function handleRemoveProfile(profileId) {
  const profile = STATE.profiles.find(p => p.id === profileId);
  if (!profile) return;

  const sure = confirm(
    `Remove profile for "${profile.name}"?\n\nNOTE: Stories written by ${profile.name} will NOT be deleted. They will become "Unassigned" so you can reassign them anytime.`
  );
  if (!sure) return;

  const updatedProfiles = STATE.profiles.filter(p => p.id !== profileId);
  if (STATE.activeProfileId === profileId) {
    STATE.activeProfileId = updatedProfiles.length > 0 ? updatedProfiles[0].id : null;
  }
  await saveProfilesToDiskAndIDB(updatedProfiles);
  showAlert(`Removed profile "${profile.name}". Stories were preserved!`, 'ℹ️');
  await renderDadPostsTable();
}

async function checkAndPromptFirstRun() {
  if (STATE.profiles.length === 0) {
    const setupDialog = document.getElementById('profile-setup-dialog');
    if (setupDialog && !setupDialog.open) {
      try {
        if (typeof setupDialog.showModal === 'function') {
          setupDialog.showModal();
        } else {
          setupDialog.setAttribute('open', '');
        }
      } catch (err) {
        console.warn('First-run dialog modal fallback:', err);
        setupDialog.setAttribute('open', '');
      }
    }
  }
}

document.getElementById('first-run-profile-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById('setup-kid-name');
  const emojiSelect = document.getElementById('setup-kid-emoji');
  const colorInput = document.getElementById('setup-kid-color');

  const name = nameInput.value.trim();
  if (!name) return;

  const firstProfile = {
    id: 'profile_' + Date.now(),
    name: name,
    slug: slugify(name),
    emoji: emojiSelect.value || '⭐',
    color: colorInput.value || '#FD79A8'
  };

  await saveProfilesToDiskAndIDB([firstProfile]);
  await setActiveProfile(firstProfile.id);

  // Reassign any existing unassigned stories to this new first profile
  const allPosts = await loadAllPostsFromDiskOrIDB();
  const unassigned = allPosts.filter(p => !p.author);
  for (const p of unassigned) {
    p.author = firstProfile.id;
    if (p.dirHandle) {
      try {
        const metaH = await p.dirHandle.getFileHandle('post.json', { create: true });
        const metaW = await metaH.createWritable();
        const clone = { ...p };
        delete clone.dirHandle;
        delete clone.drawingUrl;
        await metaW.write(JSON.stringify(clone, null, 2));
        await metaW.close();
      } catch (_) {}
    }
    const idbPosts = await idbGetAllPosts();
    const match = idbPosts.find(item => item.id === p.id);
    if (match) {
      match.author = firstProfile.id;
      await idbPutPost(match);
    }
  }

  document.getElementById('profile-setup-dialog')?.close();
  showAlert(`Welcome, ${name}! Your Story Desk is ready!`, '🎨');
  startNewPost();
});

// ============================================================================
// 11. Parent Area (Dad Gate & Admin Dashboard)
// ============================================================================

const dadLoginBtn = document.getElementById('btn-dad-login');
const dadGateDialog = document.getElementById('dad-gate-dialog');
const dadAdminDialog = document.getElementById('dad-admin-dialog');
const dadGateForm = document.getElementById('dad-gate-form');
const dadPasscodeInput = document.getElementById('dad-passcode');
const dadGateError = document.getElementById('dad-gate-error');

dadLoginBtn?.addEventListener('click', (e) => {
  e.preventDefault();

  // Close any potentially open modal dialogs that might be capturing top layer / clicks
  ['profile-setup-dialog', 'gallery-dialog', 'kid-blog-dialog'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.open) {
      try { el.close(); } catch (_) { el.removeAttribute('open'); }
    }
  });

  if (dadGateDialog) {
    if (dadGateDialog.open) {
      try { dadGateDialog.close(); } catch (_) { dadGateDialog.removeAttribute('open'); }
    }
    dadPasscodeInput.value = '';
    dadGateError.classList.add('hidden');
    try {
      if (typeof dadGateDialog.showModal === 'function') {
        dadGateDialog.showModal();
      } else {
        dadGateDialog.setAttribute('open', '');
      }
    } catch (err) {
      console.warn('showModal fallback:', err);
      dadGateDialog.setAttribute('open', '');
    }
    dadPasscodeInput.focus();
  }
});

dadGateForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = dadPasscodeInput.value.trim().toLowerCase();
  if (val === STATE.parentPasscode || val === 'story' || val === 'admin') {
    try { dadGateDialog.close(); } catch (_) { dadGateDialog.removeAttribute('open'); }
    openDadAdmin();
  } else {
    dadGateError.classList.remove('hidden');
  }
});

async function updateDadFolderStatus() {
  const statusEl = document.getElementById('folder-status-text');
  if (!statusEl) return;
  const dir = await getStoredDirectoryHandle();
  if (dir) {
    statusEl.textContent = `Active folder: "${dir.name}" on this computer.`;
  } else {
    statusEl.textContent = 'Using browser IndexedDB. Click below to connect a folder on this computer!';
  }
}

document.getElementById('btn-pick-folder')?.addEventListener('click', async () => {
  await chooseStorageDirectory();
});

async function openDadAdmin() {
  try {
    await updateDadFolderStatus();
  } catch (e) {
    console.warn('Folder status update error:', e);
  }
  try {
    renderDadProfilesList();
  } catch (e) {
    console.warn('Render profiles error:', e);
  }
  try {
    await updateUnassignedStoriesUI();
  } catch (e) {
    console.warn('Unassigned stories UI error:', e);
  }
  try {
    await renderDadPostsTable();
  } catch (e) {
    console.warn('Posts table error:', e);
  }

  if (dadAdminDialog) {
    if (dadAdminDialog.open) {
      try { dadAdminDialog.close(); } catch (_) { dadAdminDialog.removeAttribute('open'); }
    }
    try {
      if (typeof dadAdminDialog.showModal === 'function') {
        dadAdminDialog.showModal();
      } else {
        dadAdminDialog.setAttribute('open', '');
      }
    } catch (err) {
      console.warn('showModal fallback for dadAdminDialog:', err);
      dadAdminDialog.setAttribute('open', '');
    }
  }
}

async function updateUnassignedStoriesUI() {
  const unassignedSection = document.getElementById('dad-unassigned-section');
  const countText = document.getElementById('unassigned-count-text');
  if (!unassignedSection || !countText) return;

  const allPosts = await loadAllPostsFromDiskOrIDB();
  const unassigned = allPosts.filter(p => !p.author || !STATE.profiles.some(prof => prof.id === p.author));

  if (unassigned.length > 0 && STATE.profiles.length > 0) {
    unassignedSection.classList.remove('hidden');
    countText.textContent = `Found ${unassigned.length} story(ies) currently unassigned to an active profile.`;
  } else {
    unassignedSection.classList.add('hidden');
  }
}

document.getElementById('btn-reassign-all')?.addEventListener('click', async () => {
  const targetId = document.getElementById('select-reassign-profile')?.value;
  if (!targetId) {
    alert('Please select a profile to assign stories to.');
    return;
  }
  const targetProfile = STATE.profiles.find(p => p.id === targetId);
  if (!targetProfile) return;

  const allPosts = await loadAllPostsFromDiskOrIDB();
  const unassigned = allPosts.filter(p => !p.author || !STATE.profiles.some(prof => prof.id === p.author));

  for (const post of unassigned) {
    post.author = targetProfile.id;
    if (post.dirHandle) {
      try {
        const metaHandle = await post.dirHandle.getFileHandle('post.json', { create: true });
        const writable = await metaHandle.createWritable();
        const clone = { ...post };
        delete clone.dirHandle;
        delete clone.drawingUrl;
        await writable.write(JSON.stringify(clone, null, 2));
        await writable.close();
      } catch (err) {
        console.warn('Failed to update author on disk:', err);
      }
    }
    const idbPosts = await idbGetAllPosts();
    const match = idbPosts.find(p => p.id === post.id);
    if (match) {
      match.author = targetProfile.id;
      await idbPutPost(match);
    }
  }

  showAlert(`Assigned ${unassigned.length} story(ies) to ${targetProfile.name}!`, '🎉');
  await updateUnassignedStoriesUI();
  await renderDadPostsTable();
});

document.getElementById('filter-dad-author')?.addEventListener('change', renderDadPostsTable);

async function renderDadPostsTable() {
  const container = document.getElementById('dad-posts-table');
  const filterAuthor = document.getElementById('filter-dad-author')?.value;
  container.innerHTML = '<p>Loading stories...</p>';
  const posts = await loadAllPostsFromDiskOrIDB();
  container.innerHTML = '';

  const filtered = posts.filter(p => {
    if (!filterAuthor || filterAuthor === 'all') return true;
    return p.author === filterAuthor;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p>No stories found for this filter.</p>';
    return;
  }

  filtered.forEach(post => {
    const row = document.createElement('div');
    row.className = 'admin-post-row';

    const authorProf = STATE.profiles.find(p => p.id === post.author);
    const authorBadge = authorProf ? `${authorProf.emoji} ${authorProf.name}` : '⚠️ Unassigned';

    const info = document.createElement('div');
    info.innerHTML = `<strong>${escapeHtml(post.title || 'Untitled')}</strong> [${authorBadge}] (${new Date(post.created).toLocaleDateString()}) - ${post.audioFiles ? post.audioFiles.length : (post.audios ? post.audios.length : 0)} audio file(s)`;

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
  // Include profiles.json in backup
  zipFiles.push({
    path: 'profiles.json',
    data: new TextEncoder().encode(JSON.stringify(STATE.profiles, null, 2))
  });

  for (const post of posts) {
    const prof = STATE.profiles.find(p => p.id === post.author);
    const kidSlug = prof ? prof.slug : 'unassigned';
    const slug = sanitizeFolderName(post.title);
    const basePath = `Stories/${kidSlug}/${slug}`;

    const metaClone = { ...post };
    delete metaClone.dirHandle;
    delete metaClone.drawingUrl;
    delete metaClone.drawingBlob;
    delete metaClone.audios;
    zipFiles.push({
      path: `${basePath}/post.json`,
      data: new TextEncoder().encode(JSON.stringify(metaClone, null, 2))
    });

    if (post.dirHandle) {
      try {
        const drawHandle = await post.dirHandle.getFileHandle('drawing.png');
        const drawFile = await drawHandle.getFile();
        const buf = new Uint8Array(await drawFile.arrayBuffer());
        zipFiles.push({ path: `${basePath}/drawing.png`, data: buf });
      } catch (_) {}
    } else if (post.drawingBlob) {
      const buf = new Uint8Array(await post.drawingBlob.arrayBuffer());
      zipFiles.push({ path: `${basePath}/drawing.png`, data: buf });
    }

    if (post.dirHandle) {
      for (const aInfo of (post.audioFiles || [])) {
        try {
          const aHandle = await post.dirHandle.getFileHandle(aInfo.filename);
          const aFile = await aHandle.getFile();
          const buf = new Uint8Array(await aFile.arrayBuffer());
          zipFiles.push({ path: `${basePath}/${aInfo.filename}`, data: buf });
        } catch (_) {}
      }
    } else if (post.audios) {
      for (const a of post.audios) {
        const buf = new Uint8Array(await a.blob.arrayBuffer());
        zipFiles.push({ path: `${basePath}/${a.filename}`, data: buf });
      }
    }
  }

  const zipBlob = buildZipFile(zipFiles);
  triggerDownload(zipBlob, `story-desk-export-${new Date().toISOString().split('T')[0]}.zip`);
});

// ============================================================================
// 13. Shared Site & Blog Generator Templates (Feature 2 & Feature 5)
// ============================================================================

function getSharedSiteCss() {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #FFF9ED;
      color: #2D3436;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Comic Sans MS", sans-serif;
      line-height: 1.6;
      padding: 24px;
      max-width: 920px;
      margin: 0 auto;
    }
    header { text-align: center; margin-bottom: 36px; padding-bottom: 20px; border-bottom: 4px solid #FFEAA7; }
    h1 { color: #D63031; font-size: 2.4rem; margin-bottom: 8px; }
    .site-desc { color: #636E72; font-size: 1.15rem; }
    .kids-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; margin-top: 24px; }
    .kid-tile {
      background: #FFFFFF;
      border-radius: 24px;
      border: 3px solid #EADDC7;
      padding: 28px 20px;
      text-align: center;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .kid-tile:hover { transform: translateY(-4px); box-shadow: 0 12px 28px rgba(0,0,0,0.08); }
    .kid-tile-avatar { width: 72px; height: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2.5rem; margin-bottom: 4px; }
    .kid-tile-name { font-size: 1.6rem; font-weight: 800; color: #2D3436; }
    .kid-tile-count { font-size: 1rem; color: #636E72; font-weight: 600; }
    .post-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px; margin-top: 24px; }
    .post-card {
      background: #FFFFFF;
      border-radius: 20px;
      border: 3px solid #EADDC7;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      text-decoration: none;
      color: inherit;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .post-card:hover { transform: translateY(-4px); box-shadow: 0 10px 25px rgba(0,0,0,0.08); }
    .post-thumb { width: 100%; aspect-ratio: 800 / 550; object-fit: contain; background: #FAFBFD; border-bottom: 2px solid #F1F2F6; }
    .post-info { padding: 18px; }
    .post-title { font-size: 1.35rem; color: #2D3436; margin-bottom: 6px; font-weight: 800; }
    .post-date { font-size: 0.95rem; color: #A0AEC0; font-weight: 600; }
    .single-post { background: #FFFFFF; border-radius: 24px; border: 3px solid #EADDC7; padding: 32px; box-shadow: 0 8px 30px rgba(0,0,0,0.05); }
    .back-link { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 22px; text-decoration: none; font-weight: 800; color: #0984E3; font-size: 1.1rem; }
    .story-hero-img { width: 100%; max-height: 540px; object-fit: contain; border-radius: 16px; background: #FAFBFD; border: 2px solid #EDF2F7; margin: 20px 0; }
    .story-body { font-size: 1.35rem; line-height: 1.8; white-space: pre-wrap; margin: 24px 0; color: #2D3436; }
    .audio-section { background: #FFF4E5; border: 2px solid #FFE0B2; border-radius: 16px; padding: 20px; margin-top: 24px; }
    .audio-player-row { margin-top: 12px; display: flex; align-items: center; gap: 12px; }
    audio { width: 100%; height: 44px; }
  `;
}

function buildRobotsTxt() {
  return `User-agent: *\nDisallow: /\n`;
}

function renderFamilyLandingHtml(kidsData) {
  let tilesHtml = '';
  kidsData.forEach(kid => {
    tilesHtml += `
    <a href="./${escapeHtml(kid.slug)}/index.html" class="kid-tile">
      <div class="kid-tile-avatar" style="background-color: ${escapeHtml(kid.color || '#FD79A8')};">
        ${escapeHtml(kid.emoji || '⭐')}
      </div>
      <h2 class="kid-tile-name">${escapeHtml(kid.name)}</h2>
      <span class="kid-tile-count">${kid.publishedCount} published ${kid.publishedCount === 1 ? 'story' : 'stories'}</span>
    </a>
`;
  });

  return `<!DOCTYPE html>
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
    <h1>✨ Our Family Story Desk ✨</h1>
    <p class="site-desc">A private collection of drawings, adventures, and narrations.</p>
  </header>
  <main>
    <div class="kids-grid">
      ${tilesHtml}
    </div>
  </main>
</body>
</html>
`;
}

function renderKidStoriesGridHtml(profile, stories, isLiveSite = true) {
  const kidName = escapeHtml(profile ? profile.name : 'Stories');
  const kidEmoji = escapeHtml(profile ? (profile.emoji || '⭐') : '📚');
  const backHref = isLiveSite ? '../index.html' : '#';

  let cardsHtml = '';
  if (stories.length === 0) {
    cardsHtml = `<p style="grid-column: 1 / -1; text-align: center; color: #636E72; font-size: 1.2rem; padding: 40px 0;">No published stories yet! Stories marked as "Published" in Story Desk will appear here.</p>`;
  } else {
    stories.forEach((story, idx) => {
      const slug = sanitizeFolderName(story.title);
      const dateFormatted = new Date(story.created).toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });
      const cardHref = isLiveSite ? `./${slug}/index.html` : `#story-${idx}`;
      const imgSrc = isLiveSite ? `./${slug}/drawing.png` : (story.drawingUrl || '');

      cardsHtml += `
      <a href="${cardHref}" class="post-card" data-story-idx="${idx}">
        <img src="${imgSrc}" alt="Drawing for ${escapeHtml(story.title)}" class="post-thumb" loading="lazy">
        <div class="post-info">
          <h2 class="post-title">${escapeHtml(story.title)}</h2>
          <div class="post-date">${dateFormatted}</div>
        </div>
      </a>
`;
    });
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${kidName}'s Stories - Story Desk</title>
  <link rel="stylesheet" href="${isLiveSite ? '../style.css' : './style.css'}">
</head>
<body>
  <header>
    <a href="${backHref}" class="back-link" id="link-back-family">← Family Story Desk</a>
    <h1>${kidEmoji} ${kidName}'s Stories ${kidEmoji}</h1>
    <p class="site-desc">Explore drawings, stories, and voice recordings!</p>
  </header>
  <main class="post-grid" id="kid-stories-grid">
    ${cardsHtml}
  </main>
</body>
</html>
`;
}

function renderStoryDetailPageHtml(story, profile, isLiveSite = true, includeAudio = true) {
  const kidName = escapeHtml(profile ? profile.name : 'Stories');
  const backHref = isLiveSite ? '../index.html' : '#back-to-kid';
  const dateFormatted = new Date(story.created).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
  const imgSrc = isLiveSite ? './drawing.png' : (story.drawingUrl || '');

  let audioSectionHtml = '';
  if (includeAudio) {
    let audioRowsHtml = '';
    const audioFiles = story.audioFiles || (story.audios ? story.audios.map(a => ({ filename: a.filename, duration: a.duration, url: a.url })) : []);

    audioFiles.forEach((af, idx) => {
      const audioSrc = isLiveSite ? `./${af.filename}` : (af.url || '');
      audioRowsHtml += `
      <div class="audio-player-row">
        <strong>Take ${idx + 1}:</strong>
        <audio controls src="${audioSrc}" preload="metadata"></audio>
      </div>
`;
    });

    if (audioRowsHtml) {
      audioSectionHtml = `
      <section class="audio-section">
        <h3>🎙️ Voice Recordings</h3>
        ${audioRowsHtml}
      </section>
`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(story.title)} - ${kidName}'s Story Desk</title>
  <link rel="stylesheet" href="${isLiveSite ? '../../style.css' : './style.css'}">
</head>
<body>
  <a href="${backHref}" class="back-link" id="link-back-kid">← Back to ${kidName}'s Stories</a>
  <article class="single-post">
    <h1>${escapeHtml(story.title)}</h1>
    <p class="post-date">${dateFormatted}</p>
    <img src="${imgSrc}" alt="Drawing for ${escapeHtml(story.title)}" class="story-hero-img">
    <div class="story-body">${escapeHtml(story.storyText || '')}</div>
    ${audioSectionHtml}
  </article>
</body>
</html>
`;
}

// ============================================================================
// 14. Feature 2: One-Click Publish (File System site/ & ZIP Fallback)
// ============================================================================

document.getElementById('btn-publish-site')?.addEventListener('click', () => publishFamilySite(false));
document.getElementById('btn-generate-site-zip')?.addEventListener('click', () => publishFamilySite(true));

async function publishFamilySite(forceZip = false) {
  const resultBox = document.getElementById('publish-result-box');
  if (resultBox) {
    resultBox.className = 'publish-result-box';
    resultBox.classList.remove('hidden');
    resultBox.innerHTML = '<p>Publishing family site...</p>';
  }

  const allPosts = await loadAllPostsFromDiskOrIDB();
  const publishedPosts = allPosts.filter(p => p.isPublished);

  if (publishedPosts.length === 0) {
    if (resultBox) {
      resultBox.className = 'publish-result-box error';
      resultBox.innerHTML = '<p>⚠️ No stories are marked as "Published" yet! Use the review table below to mark stories as Published first.</p>';
    }
    return;
  }

  // Group stories by kid
  const kidsWithStories = [];
  const publishedCountByKid = {};

  for (const prof of STATE.profiles) {
    const kidStories = publishedPosts.filter(p => p.author === prof.id);
    kidStories.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
    kidsWithStories.push({
      ...prof,
      publishedCount: kidStories.length,
      stories: kidStories
    });
    publishedCountByKid[prof.name] = kidStories.length;
  }

  // Handle unassigned published stories if any
  const unassignedStories = publishedPosts.filter(p => !p.author || !STATE.profiles.some(prof => prof.id === p.author));
  if (unassignedStories.length > 0) {
    unassignedStories.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
    kidsWithStories.push({
      id: 'unassigned',
      name: 'Family Friends',
      slug: 'stories',
      emoji: '🌟',
      color: '#FDCB6E',
      publishedCount: unassignedStories.length,
      stories: unassignedStories
    });
    publishedCountByKid['Family Friends'] = unassignedStories.length;
  }

  const dirHandle = await getStoredDirectoryHandle();

  // Mode A: File System Access (Write to site/ subfolder)
  if (dirHandle && 'showDirectoryPicker' in window && !forceZip) {
    try {
      const hasPerm = await verifyPermission(dirHandle, true);
      if (!hasPerm) throw new Error('Permission denied');

      const siteDir = await dirHandle.getDirectoryHandle('site', { create: true });

      // 1. site/robots.txt
      const robotsH = await siteDir.getFileHandle('robots.txt', { create: true });
      const robotsW = await robotsH.createWritable();
      await robotsW.write(buildRobotsTxt());
      await robotsW.close();

      // 2. site/style.css
      const cssH = await siteDir.getFileHandle('style.css', { create: true });
      const cssW = await cssH.createWritable();
      await cssW.write(getSharedSiteCss());
      await cssW.close();

      // 3. site/index.html (Family landing page)
      const indexH = await siteDir.getFileHandle('index.html', { create: true });
      const indexW = await indexH.createWritable();
      await indexW.write(renderFamilyLandingHtml(kidsWithStories));
      await indexW.close();

      // 4. For each kid, build site/<kid-slug>/
      for (const kid of kidsWithStories) {
        const kidDir = await siteDir.getDirectoryHandle(kid.slug, { create: true });

        // site/<kid-slug>/index.html
        const kidIndexH = await kidDir.getFileHandle('index.html', { create: true });
        const kidIndexW = await kidIndexH.createWritable();
        await kidIndexW.write(renderKidStoriesGridHtml(kid, kid.stories, true));
        await kidIndexW.close();

        // Each story
        for (const story of kid.stories) {
          const storySlug = sanitizeFolderName(story.title);
          const storyDir = await kidDir.getDirectoryHandle(storySlug, { create: true });

          // site/<kid-slug>/<story-slug>/index.html
          const storyHtmlH = await storyDir.getFileHandle('index.html', { create: true });
          const storyHtmlW = await storyHtmlH.createWritable();
          await storyHtmlW.write(renderStoryDetailPageHtml(story, kid, true, true));
          await storyHtmlW.close();

          // drawing.png
          if (story.dirHandle) {
            try {
              const srcDrawH = await story.dirHandle.getFileHandle('drawing.png');
              const srcDrawF = await srcDrawH.getFile();
              const destDrawH = await storyDir.getFileHandle('drawing.png', { create: true });
              const destDrawW = await destDrawH.createWritable();
              await destDrawW.write(srcDrawF);
              await destDrawW.close();
            } catch (_) {}
          } else if (story.drawingBlob) {
            const destDrawH = await storyDir.getFileHandle('drawing.png', { create: true });
            const destDrawW = await destDrawH.createWritable();
            await destDrawW.write(story.drawingBlob);
            await destDrawW.close();
          }

          // Audio files
          if (story.dirHandle) {
            for (const aInfo of (story.audioFiles || [])) {
              try {
                const srcAudioH = await story.dirHandle.getFileHandle(aInfo.filename);
                const srcAudioF = await srcAudioH.getFile();
                const destAudioH = await storyDir.getFileHandle(aInfo.filename, { create: true });
                const destAudioW = await destAudioH.createWritable();
                await destAudioW.write(srcAudioF);
                await destAudioW.close();
              } catch (_) {}
            }
          } else if (story.audios) {
            for (const a of story.audios) {
              const destAudioH = await storyDir.getFileHandle(a.filename, { create: true });
              const destAudioW = await destAudioH.createWritable();
              await destAudioW.write(a.blob);
              await destAudioW.close();
            }
          }
        }
      }

      // Success breakdown
      let breakdownHtml = '<ul>';
      for (const [name, count] of Object.entries(publishedCountByKid)) {
        breakdownHtml += `<li><strong>${escapeHtml(name)}:</strong> ${count} published ${count === 1 ? 'story' : 'stories'}</li>`;
      }
      breakdownHtml += '</ul>';

      if (resultBox) {
        resultBox.innerHTML = `
          <p>🎉 <strong>Family Site Published Successfully!</strong></p>
          <p>Generated static site directly in your local <code>site/</code> folder:</p>
          <p><strong>Path:</strong> <code>${escapeHtml(dirHandle.name)}/site/</code></p>
          ${breakdownHtml}
          <p>Ready to deploy via <code>deploy/deploy.sh</code> or Cloudflare Pages!</p>
        `;
      }
      showAlert(`Published ${publishedPosts.length} stories into ${dirHandle.name}/site/!`, '🚀');
      return;
    } catch (err) {
      console.warn('File System site publish failed, falling back to ZIP:', err);
    }
  }

  // Mode B: Fallback to ZIP download
  const zipFiles = [];
  zipFiles.push({ path: 'robots.txt', data: new TextEncoder().encode(buildRobotsTxt()) });
  zipFiles.push({ path: 'style.css', data: new TextEncoder().encode(getSharedSiteCss()) });
  zipFiles.push({ path: 'index.html', data: new TextEncoder().encode(renderFamilyLandingHtml(kidsWithStories)) });

  for (const kid of kidsWithStories) {
    zipFiles.push({
      path: `${kid.slug}/index.html`,
      data: new TextEncoder().encode(renderKidStoriesGridHtml(kid, kid.stories, true))
    });

    for (const story of kid.stories) {
      const storySlug = sanitizeFolderName(story.title);
      const basePath = `${kid.slug}/${storySlug}`;

      zipFiles.push({
        path: `${basePath}/index.html`,
        data: new TextEncoder().encode(renderStoryDetailPageHtml(story, kid, true, true))
      });

      if (story.dirHandle) {
        try {
          const drawH = await story.dirHandle.getFileHandle('drawing.png');
          const drawF = await drawH.getFile();
          zipFiles.push({ path: `${basePath}/drawing.png`, data: new Uint8Array(await drawF.arrayBuffer()) });
        } catch (_) {}
      } else if (story.drawingBlob) {
        zipFiles.push({ path: `${basePath}/drawing.png`, data: new Uint8Array(await story.drawingBlob.arrayBuffer()) });
      }

      if (story.dirHandle) {
        for (const aInfo of (story.audioFiles || [])) {
          try {
            const aHandle = await story.dirHandle.getFileHandle(aInfo.filename);
            const aFile = await aHandle.getFile();
            zipFiles.push({ path: `${basePath}/${aInfo.filename}`, data: new Uint8Array(await aFile.arrayBuffer()) });
          } catch (_) {}
        }
      } else if (story.audios) {
        for (const a of story.audios) {
          zipFiles.push({ path: `${basePath}/${a.filename}`, data: new Uint8Array(await a.blob.arrayBuffer()) });
        }
      }
    }
  }

  const zipBlob = buildZipFile(zipFiles);
  triggerDownload(zipBlob, `story-desk-site-${new Date().toISOString().split('T')[0]}.zip`);

  let breakdownHtml = '<ul>';
  for (const [name, count] of Object.entries(publishedCountByKid)) {
    breakdownHtml += `<li><strong>${escapeHtml(name)}:</strong> ${count} published ${count === 1 ? 'story' : 'stories'}</li>`;
  }
  breakdownHtml += '</ul>';

  if (resultBox) {
    resultBox.innerHTML = `
      <p>📦 <strong>Site Bundle Downloaded (.ZIP)!</strong></p>
      ${breakdownHtml}
      <p>Extract this ZIP file and deploy to Cloudflare Pages.</p>
    `;
  }
}

// ============================================================================
// 15. Feature 5: "See My Blog" Kid Read-Only In-App View
// ============================================================================

const btnSeeBlog = document.getElementById('btn-see-blog');
const kidBlogDialog = document.getElementById('kid-blog-dialog');
const btnCloseKidBlog = document.getElementById('btn-close-kid-blog');
const kidBlogTitle = document.getElementById('kid-blog-title');
const kidBlogSubtitle = document.getElementById('kid-blog-subtitle');
const kidBlogBody = document.getElementById('kid-blog-body');

btnSeeBlog?.addEventListener('click', openKidBlogView);
btnCloseKidBlog?.addEventListener('click', closeKidBlogView);

function revokeBlogUrls() {
  STATE.blogBlobUrls.forEach(url => URL.revokeObjectURL(url));
  STATE.blogBlobUrls = [];
}

async function openKidBlogView() {
  revokeBlogUrls();
  const activeKid = STATE.profiles.find(p => p.id === STATE.activeProfileId);
  const kidName = activeKid ? activeKid.name : 'My';
  const kidEmoji = activeKid ? (activeKid.emoji || '⭐') : '⭐';

  if (kidBlogTitle) kidBlogTitle.textContent = `${kidEmoji} ${kidName}'s Story Blog ${kidEmoji}`;
  if (kidBlogSubtitle) kidBlogSubtitle.textContent = 'Here is how your stories look to family and friends!';
  if (kidBlogBody) kidBlogBody.innerHTML = '<p>Loading your published stories...</p>';
  if (kidBlogDialog) kidBlogDialog.showModal();

  const allPosts = await loadAllPostsFromDiskOrIDB();
  // Filter for active profile's published stories
  const publishedStories = allPosts.filter(p => {
    if (!p.isPublished) return false;
    if (!STATE.activeProfileId) return true;
    if (p.author === STATE.activeProfileId) return true;
    if (!p.author && STATE.profiles.length <= 1) return true;
    return false;
  });

  publishedStories.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));

  // Prepare Blob URLs for drawings and audios
  for (const story of publishedStories) {
    if (story.dirHandle) {
      try {
        const drawH = await story.dirHandle.getFileHandle('drawing.png');
        const drawF = await drawH.getFile();
        const drawUrl = URL.createObjectURL(drawF);
        STATE.blogBlobUrls.push(drawUrl);
        story.drawingUrl = drawUrl;
      } catch (_) {}

      story.audios = [];
      for (const aInfo of (story.audioFiles || [])) {
        try {
          const aHandle = await story.dirHandle.getFileHandle(aInfo.filename);
          const aFile = await aHandle.getFile();
          const aUrl = URL.createObjectURL(aFile);
          STATE.blogBlobUrls.push(aUrl);
          story.audios.push({
            filename: aInfo.filename,
            duration: aInfo.duration,
            url: aUrl
          });
        } catch (_) {}
      }
    } else if (story.drawingBlob) {
      const drawUrl = URL.createObjectURL(story.drawingBlob);
      STATE.blogBlobUrls.push(drawUrl);
      story.drawingUrl = drawUrl;

      if (story.audios && Array.isArray(story.audios)) {
        story.audios.forEach(a => {
          if (a.blob) {
            const aUrl = URL.createObjectURL(a.blob);
            STATE.blogBlobUrls.push(aUrl);
            a.url = aUrl;
          }
        });
      }
    }
  }

  renderKidBlogGrid(publishedStories, activeKid);
}

function renderKidBlogGrid(stories, activeKid) {
  if (!kidBlogBody) return;
  kidBlogBody.innerHTML = '';

  if (stories.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.textAlign = 'center';
    emptyMsg.style.padding = '40px 20px';
    emptyMsg.innerHTML = `
      <p style="font-size: 1.4rem; color: #2D3436; font-weight: 700; margin-bottom: 12px;">No published stories yet!</p>
      <p style="font-size: 1.1rem; color: #636E72;">Ask Dad to click <strong>🔒 Dad</strong> and mark your stories as <strong>Published</strong> to see them here.</p>
    `;
    kidBlogBody.appendChild(emptyMsg);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'blog-post-grid';

  stories.forEach((story) => {
    const card = document.createElement('article');
    card.className = 'blog-post-card';

    const img = document.createElement('img');
    img.className = 'blog-post-thumb';
    img.alt = `Drawing for ${story.title}`;
    img.src = story.drawingUrl || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100%" height="100%" fill="%23eee"/></svg>';

    const info = document.createElement('div');
    info.className = 'blog-post-info';

    const title = document.createElement('h3');
    title.className = 'blog-post-title';
    title.textContent = story.title || 'Untitled Story';

    const date = document.createElement('div');
    date.className = 'blog-post-date';
    date.textContent = new Date(story.created).toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    info.appendChild(title);
    info.appendChild(date);
    card.appendChild(img);
    card.appendChild(info);

    card.addEventListener('click', () => {
      renderKidBlogStoryDetail(story, stories, activeKid);
    });

    grid.appendChild(card);
  });

  kidBlogBody.appendChild(grid);
}

function renderKidBlogStoryDetail(story, allStories, activeKid) {
  if (!kidBlogBody) return;
  kidBlogBody.innerHTML = '';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'blog-back-btn';
  backBtn.innerHTML = '← Back to all stories';
  backBtn.addEventListener('click', () => {
    renderKidBlogGrid(allStories, activeKid);
  });

  const article = document.createElement('article');
  article.className = 'blog-single-post';

  const title = document.createElement('h2');
  title.style.fontSize = '2rem';
  title.style.color = '#D63031';
  title.style.marginBottom = '6px';
  title.textContent = story.title || 'Untitled Story';

  const date = document.createElement('p');
  date.className = 'blog-post-date';
  date.textContent = new Date(story.created).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });

  const heroImg = document.createElement('img');
  heroImg.className = 'blog-story-hero-img';
  heroImg.alt = `Drawing for ${story.title}`;
  heroImg.src = story.drawingUrl || '';

  const body = document.createElement('div');
  body.className = 'blog-story-body';
  body.textContent = story.storyText || '';

  article.appendChild(backBtn);
  article.appendChild(title);
  article.appendChild(date);
  article.appendChild(heroImg);
  article.appendChild(body);

  // Audio Recordings
  const audioList = story.audioFiles || (story.audios ? story.audios : []);
  if (audioList.length > 0) {
    const audioSec = document.createElement('section');
    audioSec.className = 'blog-audio-section';

    const audioH = document.createElement('h3');
    audioH.textContent = '🎙️ Voice Recordings';
    audioSec.appendChild(audioH);

    audioList.forEach((af, idx) => {
      const row = document.createElement('div');
      row.className = 'blog-audio-player-row';

      const label = document.createElement('strong');
      label.textContent = `Take ${idx + 1}:`;

      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = af.url || '';
      audio.preload = 'metadata';

      row.appendChild(label);
      row.appendChild(audio);
      audioSec.appendChild(row);
    });

    article.appendChild(audioSec);
  }

  kidBlogBody.appendChild(article);
}

function closeKidBlogView() {
  if (kidBlogDialog) kidBlogDialog.close();
  revokeBlogUrls();
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.addEventListener('DOMContentLoaded', async () => {
  initCanvas();

  // Load profiles from disk or IndexedDB
  const loadedProfiles = await loadProfilesFromDiskOrIDB();
  STATE.profiles = loadedProfiles;

  const cachedActiveId = await idbGet('settings', 'active_profile_id');
  if (cachedActiveId && STATE.profiles.some(p => p.id === cachedActiveId)) {
    STATE.activeProfileId = cachedActiveId;
  } else if (STATE.profiles.length > 0) {
    STATE.activeProfileId = STATE.profiles[0].id;
  }
  STATE.currentAuthorId = STATE.activeProfileId;

  renderProfileDropdown();

  // Check if first-run setup is required
  await checkAndPromptFirstRun();

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

