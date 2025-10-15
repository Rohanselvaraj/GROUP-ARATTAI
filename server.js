import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { Server as SocketIOServer } from 'socket.io';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static serving for client and uploads
app.use('/', express.static(CLIENT_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

// Ensure upload directory exists
import fs from 'fs';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer setup for image uploads
const maxMb = Number(process.env.MAX_UPLOAD_MB || 5);
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path.basename(file.originalname || 'img', ext).replace(/[^a-z0-9_-]/gi, '_');
    const stamp = Date.now();
    cb(null, `${base}_${stamp}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Invalid image type'), ok);
  }
});

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  return res.json({ url });
});

// In-memory rooms and messages
// Structure: rooms[code] = { name, code, members: Map<socketId, {name,color}>, messages: Array<{author,name,text,imageUrl,ts}> }
const rooms = Object.create(null);

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function ensureRoomByName(name) {
  // Try to find existing by name (case-insensitive)
  const key = Object.keys(rooms).find(c => rooms[c].name.toLowerCase() === name.toLowerCase());
  if (key) return rooms[key];
  const code = generateCode();
  rooms[code] = { name, code, members: new Map(), messages: [] };
  return rooms[code];
}

function getOrCreateRoomByCodeOrName(input) {
  const raw = String(input || '').trim();
  const byCode = rooms[raw];
  if (byCode) return byCode;
  // treat as name => create if missing
  return ensureRoomByName(raw || `room-${generateCode()}`);
}

function trimMessages(room) {
  const limit = 100;
  if (room.messages.length > limit) {
    room.messages = room.messages.slice(-limit);
  }
}

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

io.on('connection', (socket) => {
  let joinedCode = null;
  let user = { name: 'Guest', color: `hsl(${Math.floor(Math.random()*360)} 70% 50%)` };

  function emitMembers(code) {
    const room = rooms[code];
    if (!room) return;
    const members = Array.from(room.members.values()).map(m => ({ name: m.name, color: m.color }));
    io.to(code).emit('room:members', { members });
  }

  socket.on('room:join', ({ codeOrName, name }) => {
    const room = getOrCreateRoomByCodeOrName(codeOrName);
    joinedCode = room.code;
    user = { name: String(name || 'Guest').slice(0, 40), color: `hsl(${Math.floor(Math.random()*360)} 70% 50%)` };

    socket.join(room.code);
    room.members.set(socket.id, user);

    // Send initial state to joiner
    socket.emit('room:joined', {
      name: room.name,
      code: room.code,
      messages: room.messages
    });

    emitMembers(room.code);
    socket.to(room.code).emit('system:join', { name: user.name, ts: Date.now() });
  });

  socket.on('room:leave', () => {
    if (!joinedCode) return;
    const room = rooms[joinedCode];
    if (!room) return;
    room.members.delete(socket.id);
    socket.leave(joinedCode);
    io.to(joinedCode).emit('system:leave', { name: user.name, ts: Date.now() });
    emitMembers(joinedCode);
    joinedCode = null;
  });

  socket.on('message:typing', (state) => {
    if (!joinedCode) return;
    socket.to(joinedCode).emit('message:typing', { name: user.name, state: !!state });
  });

  socket.on('message:send', ({ text, imageUrl }) => {
    if (!joinedCode) return;
    const room = rooms[joinedCode];
    if (!room) return;
    const cleanText = String(text || '').slice(0, 2000);
    const msg = { author: user.name, color: user.color, text: cleanText, imageUrl: imageUrl || null, ts: Date.now() };
    room.messages.push(msg);
    trimMessages(room);
    io.to(joinedCode).emit('message:new', msg);
  });

  // WebRTC signaling for mesh
  socket.on('webrtc:join', () => {
    if (!joinedCode) return;
    // Tell others that a new peer is here
    socket.to(joinedCode).emit('webrtc:peer-join', { id: socket.id, name: user.name });
    // Provide existing peers list to the joiner
    const room = rooms[joinedCode];
    const peers = Array.from(io.sockets.adapter.rooms.get(joinedCode) || [])
      .filter(id => id !== socket.id);
    socket.emit('webrtc:peers', { peers });
  });

  socket.on('webrtc:signal', ({ targetId, data }) => {
    io.to(targetId).emit('webrtc:signal', { fromId: socket.id, data });
  });

  socket.on('webrtc:leave', () => {
    if (!joinedCode) return;
    socket.to(joinedCode).emit('webrtc:peer-leave', { id: socket.id });
  });

  socket.on('disconnect', () => {
    if (joinedCode) {
      const room = rooms[joinedCode];
      if (room) {
        room.members.delete(socket.id);
        socket.to(joinedCode).emit('system:leave', { name: user.name, ts: Date.now() });
        socket.to(joinedCode).emit('webrtc:peer-leave', { id: socket.id });
        emitMembers(joinedCode);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
