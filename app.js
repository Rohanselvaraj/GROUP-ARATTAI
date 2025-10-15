// Simple Group Chat client (vanilla JS)
// Uses Socket.IO for realtime chat and signaling, WebRTC for calls

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ===== BACKEND CONFIGURATION =====
const BACKEND_URL = 'https://group-chart-2.onrender.com';
// =================================

const state = {
  socket: null,
  room: null, // { name, code }
  me: { name: '', color: '' },
  typingTimer: null,
  pcMap: new Map(), // peerId -> RTCPeerConnection
  streams: { local: null },
  inCall: false
};

function resolveImageUrl(u) {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return `${BACKEND_URL}${u.startsWith('/') ? u : '/' + u}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
}

function toast(text) {
  console.log('[toast]', text);
}

function renderMembers(members) {
  const list = $('#memberList');
  list.innerHTML = '';
  members.forEach(m => {
    const li = document.createElement('li');
    li.textContent = m.name;
    li.style.color = m.color || '';
    list.appendChild(li);
  });
  $('#membersCount').textContent = members.length;
}

function messageElement(msg) {
  const tpl = $('#messageTpl');
  const li = tpl.content.firstElementChild.cloneNode(true);
  const avatar = li.querySelector('.avatar');
  const author = li.querySelector('.author');
  const time = li.querySelector('.time');
  const content = li.querySelector('.content');

  avatar.style.background = msg.color || '#334155';
  author.textContent = msg.author || 'System';
  time.textContent = fmtTime(msg.ts || Date.now());

  // Mark self messages and set initials
  const meName = (state.me?.name || '').trim();
  if (meName && msg.author === meName) {
    li.classList.add('self');
  }
  const initials = (msg.author || 'S').split(/\s+/).map(s => s[0]).join('').slice(0,2).toUpperCase();
  avatar.textContent = initials;

  if (msg.text) {
    const p = document.createElement('p');
    p.textContent = msg.text;
    content.appendChild(p);
  }
  if (msg.imageUrl) {
    const img = document.createElement('img');
    img.src = resolveImageUrl(msg.imageUrl);
    img.alt = 'image';
    content.appendChild(img);
  }
  return li;
}

function appendMessage(msg) {
  const list = $('#messageList');
  list.appendChild(messageElement(msg));
  list.scrollTop = list.scrollHeight;
}

function setPanels(joined) {
  $('#authPanel').classList.toggle('hidden', joined);
  $('#chatPanel').classList.toggle('hidden', !joined);
}

function copyInvite() {
  if (!state.room) return;
  const url = `${location.origin}/?code=${encodeURIComponent(state.room.code)}`;
  navigator.clipboard.writeText(url).then(() => toast('Invite link copied'));
}

function currentCodeOrNameInput() {
  return $('#roomInput').value.trim();
}

function connectSocket() {
  // Connect to Render backend
  state.socket = io(BACKEND_URL, { 
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5
  });

  state.socket.on('connect', () => {
    console.log('connected to backend:', state.socket.id);
    toast('Connected to server');
  });

  state.socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    toast('Connection error - retrying...');
  });

  state.socket.on('disconnect', () => {
    console.log('Disconnected from server');
    toast('Disconnected from server');
  });

  state.socket.on('room:joined', ({ name, code, messages }) => {
    state.room = { name, code };
    $('#roomTitle').textContent = name;
    $('#roomCode').textContent = `#${code}`;
    $('#messageList').innerHTML = '';
    messages.forEach(m => appendMessage(m));
    setPanels(true);
  });

  state.socket.on('room:members', ({ members }) => renderMembers(members));

  state.socket.on('system:join', ({ name, ts }) => {
    appendMessage({ author: 'System', color: '#64748b', text: `${name} joined`, ts });
  });
  state.socket.on('system:leave', ({ name, ts }) => {
    appendMessage({ author: 'System', color: '#64748b', text: `${name} left`, ts });
  });

  state.socket.on('message:new', (msg) => appendMessage(msg));

  let typingUsers = new Set();
  let typingTimeout = null;
  function updateTyping() {
    const el = $('#typing');
    if (typingUsers.size === 0) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    const names = Array.from(typingUsers).slice(0, 3);
    const more = typingUsers.size - names.length;
    const who = names.join(', ') + (more > 0 ? ` and ${more} more` : '');
    el.textContent = `${who} ${typingUsers.size > 1 ? 'are' : 'is'} typing…`;
    el.classList.remove('hidden');
  }

  state.socket.on('message:typing', ({ name, state: isTyping }) => {
    if (isTyping) typingUsers.add(name); else typingUsers.delete(name);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      typingUsers.clear();
      updateTyping();
    }, 2000);
    updateTyping();
  });

  // WebRTC signaling events
  state.socket.on('webrtc:peers', ({ peers }) => {
    peers.forEach(async peerId => {
      await createPeerConnection(peerId, true);
    });
  });

  state.socket.on('webrtc:peer-join', async ({ id }) => {
    await createPeerConnection(id, false);
  });

  state.socket.on('webrtc:signal', async ({ fromId, data }) => {
    const pc = state.pcMap.get(fromId);
    if (!pc) return;
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (pc.signalingState === 'have-remote-offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        state.socket.emit('webrtc:signal', { targetId: fromId, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
    }
  });

  state.socket.on('webrtc:peer-leave', ({ id }) => {
    const pc = state.pcMap.get(id);
    if (pc) {
      pc.close();
      state.pcMap.delete(id);
    }
    removeRemoteVideo(id);
  });
}

function joinRoom(codeOrName, displayName) {
  state.me.name = displayName;
  state.socket.emit('room:join', { codeOrName, name: displayName });
}

function leaveRoom() {
  state.socket.emit('room:leave');
  endCall();
  setPanels(false);
  // Clear UI after leaving
  $('#messageList').innerHTML = '';
  $('#memberList').innerHTML = '';
  $('#roomTitle').textContent = 'Room';
  $('#roomCode').textContent = '';
  // Clear typing and upload indicators
  $('#typing').classList.add('hidden');
  $('#uploadStatus').classList.add('hidden');
  $('#uploadBar').classList.add('hidden');
}

async function sendMessage() {
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text) return;
  state.socket.emit('message:send', { text });
  input.value = '';
}

function onTyping() {
  clearTimeout(state.typingTimer);
  state.socket.emit('message:typing', true);
  state.typingTimer = setTimeout(() => state.socket.emit('message:typing', false), 1500);
}

async function uploadImage(file) {
  // Use XHR so we can show progress - now points to Render backend
  const fd = new FormData();
  fd.append('image', file);
  const xhr = new XMLHttpRequest();
  const statusEl = $('#uploadStatus');
  const pctEl = $('#uploadPct');
  const bar = $('#uploadBar');
  const barFill = $('#uploadBarFill');
  statusEl.classList.remove('hidden');
  bar.classList.remove('hidden');
  barFill.style.width = '0%';
  pctEl.textContent = '0%';

  const url = await new Promise((resolve, reject) => {
    xhr.open('POST', `${BACKEND_URL}/api/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        barFill.style.width = pct + '%';
        pctEl.textContent = pct + '%';
      }
    };
    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300 && res.url) {
          resolve(resolveImageUrl(res.url));
        } else {
          reject(new Error('Upload failed'));
        }
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(fd);
  });

  statusEl.classList.add('hidden');
  bar.classList.add('hidden');
  return url;
}

async function sendImage(file) {
  try {
    const url = await uploadImage(file);
    state.socket.emit('message:send', { text: '', imageUrl: url });
  } catch (e) {
    toast('Failed to upload image');
  }
}

// WebRTC helpers
function addRemoteVideo(peerId, stream) {
  let grid = $('#videoGrid');
  let el = document.getElementById(`v-${peerId}`);
  if (!el) {
    el = document.createElement('video');
    el.id = `v-${peerId}`;
    el.autoplay = true;
    el.playsInline = true;
    grid.appendChild(el);
  }
  el.srcObject = stream;
}
function removeRemoteVideo(peerId) {
  const el = document.getElementById(`v-${peerId}`);
  if (el) el.remove();
}

async function ensureLocalStream() {
  if (state.streams.local) return state.streams.local;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  state.streams.local = stream;
  // show local
  addRemoteVideo('local', stream);
  const localEl = document.getElementById('v-local');
  if (localEl) localEl.muted = true; else {
    const el = document.getElementById('v-local');
    if (el) el.muted = true;
  }
  return stream;
}

async function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }
    ]
  });
  state.pcMap.set(peerId, pc);

  const local = await ensureLocalStream();
  local.getTracks().forEach(t => pc.addTrack(t, local));

  pc.ontrack = (e) => {
    const [stream] = e.streams;
    addRemoteVideo(peerId, stream);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.socket.emit('webrtc:signal', { targetId: peerId, data: { candidate: e.candidate } });
    }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit('webrtc:signal', { targetId: peerId, data: { sdp: pc.localDescription } });
  }

  return pc;
}

async function startCall() {
  try {
    await ensureLocalStream();
    state.inCall = true;
    $('#startCallBtn').disabled = true;
    $('#leaveCallBtn').disabled = false;
    $('#toggleMicBtn').disabled = false;
    $('#toggleCamBtn').disabled = false;
    $('#shareScreenBtn').disabled = false;
    state.socket.emit('webrtc:join');
  } catch (e) {
    toast('Cannot start call (permissions?)');
  }
}

function endCall() {
  state.socket.emit('webrtc:leave');
  state.pcMap.forEach(pc => pc.close());
  state.pcMap.clear();
  if (state.streams.local) {
    state.streams.local.getTracks().forEach(t => t.stop());
    state.streams.local = null;
  }
  $$('#videoGrid video').forEach(v => v.remove());
  state.inCall = false;
  $('#startCallBtn').disabled = false;
  $('#leaveCallBtn').disabled = true;
  $('#toggleMicBtn').disabled = true;
  $('#toggleCamBtn').disabled = true;
  $('#shareScreenBtn').disabled = true;
}

function toggleMic() {
  const stream = state.streams.local; if (!stream) return;
  const track = stream.getAudioTracks()[0]; if (!track) return;
  track.enabled = !track.enabled;
  $('#toggleMicBtn').textContent = track.enabled ? '🎤' : '🔇';
}

function toggleCam() {
  const stream = state.streams.local; if (!stream) return;
  const track = stream.getVideoTracks()[0]; if (!track) return;
  track.enabled = !track.enabled;
  $('#toggleCamBtn').textContent = track.enabled ? '📷' : '🚫';
}

async function shareScreen() {
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = displayStream.getVideoTracks()[0];
    state.pcMap.forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
    });
    screenTrack.onended = () => {
      // revert to camera
      const camTrack = state.streams.local?.getVideoTracks()[0];
      if (!camTrack) return;
      state.pcMap.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(camTrack);
      });
    };
  } catch (e) {
    toast('Screen share cancelled');
  }
}

// Wire UI
window.addEventListener('DOMContentLoaded', () => {
  // Theme toggle
  $('#themeToggle').addEventListener('click', () => {
    const next = (document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
    setTheme(next);
  });

  // Copy invite link
  $('#copyInvite').addEventListener('click', copyInvite);

  // Join/create
  $('#createRoomBtn').addEventListener('click', () => {
    const name = $('#displayName').value.trim() || 'Guest';
    const roomName = currentCodeOrNameInput() || `room-${Math.random().toString(36).slice(2,7)}`;
    joinRoom(roomName, name);
  });
  $('#joinRoomBtn').addEventListener('click', () => {
    const name = $('#displayName').value.trim() || 'Guest';
    const value = currentCodeOrNameInput();
    if (!value) { $('#authError').textContent = 'Enter room name or code'; return; }
    $('#authError').textContent = '';
    joinRoom(value, name);
  });

  // Composer
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  $('#messageInput').addEventListener('input', onTyping);
  $('#imageBtn').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) sendImage(file);
    e.target.value = '';
  });

  // Calls
  $('#startCallBtn').addEventListener('click', startCall);
  $('#leaveCallBtn').addEventListener('click', endCall);
  $('#toggleMicBtn').addEventListener('click', toggleMic);
  $('#toggleCamBtn').addEventListener('click', toggleCam);
  $('#shareScreenBtn').addEventListener('click', shareScreen);
  // Leave room
  $('#leaveRoomBtn').addEventListener('click', () => {
    leaveRoom();
  });
  // Toggle Members/Call visibility
  $('#toggleMembersBtn').addEventListener('click', () => {
    document.querySelector('.sidebar')?.classList.toggle('hidden');
  });
  $('#toggleCallBtn').addEventListener('click', () => {
    document.getElementById('callPanel')?.classList.toggle('hidden');
  });

  // Auto-join if code in URL
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const savedName = localStorage.getItem('displayName');
  if (code) {
    $('#displayName').value = savedName || '';
    setPanels(false);
  }

  // Save name on change
  $('#displayName').addEventListener('change', () => localStorage.setItem('displayName', $('#displayName').value.trim()));

  // Connect socket
  connectSocket();

  // If invite code present and name provided already, try auto join
  if (code && (savedName && savedName.trim())) {
    joinRoom(code, savedName.trim());
  }
});
