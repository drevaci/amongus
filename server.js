const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.resolve(__dirname, 'public');
const rooms = new Map();
const sockets = new Map();

function code() {
  let c;
  do c = Math.random().toString(36).slice(2, 8).toUpperCase();
  while (rooms.has(c));
  return c;
}

function safeRoom(r) {
  return {
    code: r.code,
    hostId: r.hostId,
    status: r.status,
    tasks: r.tasks,
    players: [...r.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      role: p.role || null
    }))
  };
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(r, data) {
  for (const p of r.players.values()) send(p.ws, data);
}

function broadcastRoom(r) {
  broadcast(r, { type: 'room', room: safeRoom(r) });
}

function leave(ws) {
  const info = sockets.get(ws);
  if (!info) return;

  const r = rooms.get(info.code);
  sockets.delete(ws);
  if (!r) return;

  r.players.delete(info.id);
  if (!r.players.size) {
    rooms.delete(r.code);
    return;
  }

  if (r.hostId === info.id) {
    r.hostId = r.players.keys().next().value;
  }
  broadcastRoom(r);
}

// ----- HTTP / website -----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jfif': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad request');
  }

  // Useful Render health check.
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('OK');
  }

  if (pathname === '/') pathname = '/index.html';

  // Only serve files inside /public.
  const relative = pathname.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relative);

  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (statErr, stat) => {
    if (!statErr && stat.isDirectory()) {
      return serveFile(path.join(filePath, 'index.html'), res);
    }
    serveFile(filePath, res);
  });
});

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

// ----- WebSocket multiplayer -----
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Neplatná správa.' });
    }

    if (m.type === 'create') {
      const c = code();
      const id = Math.random().toString(36).slice(2, 10);
      const r = {
        code: c,
        hostId: id,
        status: 'lobby',
        tasks: [],
        players: new Map()
      };

      r.players.set(id, {
        id,
        name: String(m.name || '').slice(0, 16),
        ws
      });
      rooms.set(c, r);
      sockets.set(ws, { code: c, id });

      return send(ws, {
        type: 'created',
        playerId: id,
        hostId: id,
        room: safeRoom(r)
      });
    }

    if (m.type === 'join') {
      const c = String(m.code || '').toUpperCase();
      const r = rooms.get(c);

      if (!r) return send(ws, { type: 'error', message: 'Miestnosť s týmto kódom neexistuje.' });
      if (r.status !== 'lobby') return send(ws, { type: 'error', message: 'Táto hra už začala.' });
      if (r.players.size >= 15) return send(ws, { type: 'error', message: 'Miestnosť je plná.' });

      const id = Math.random().toString(36).slice(2, 10);
      r.players.set(id, {
        id,
        name: String(m.name || '').slice(0, 16),
        ws
      });
      sockets.set(ws, { code: c, id });

      send(ws, { type: 'joined', playerId: id, hostId: r.hostId, room: safeRoom(r) });
      return broadcastRoom(r);
    }

    const info = sockets.get(ws);
    if (!info) return;
    const r = rooms.get(info.code);
    if (!r) return;

    if (m.type === 'addTask') {
      if (r.hostId !== info.id || r.status !== 'lobby') return;

      const location = String(m.location || '').trim().slice(0, 30);
      const name = String(m.name || '').trim().slice(0, 60);
      if (!location || !name) return send(ws, { type: 'error', message: 'Miesto aj úloha sú povinné.' });
      if (r.tasks.length >= 30) return send(ws, { type: 'error', message: 'Maximum je 30 úloh.' });

      r.tasks.push({ location, name });
      return broadcastRoom(r);
    }

    if (m.type === 'removeTask') {
      if (r.hostId !== info.id || r.status !== 'lobby') return;
      const i = Number(m.index);
      if (Number.isInteger(i) && i >= 0 && i < r.tasks.length) r.tasks.splice(i, 1);
      return broadcastRoom(r);
    }

    if (m.type === 'start') {
      if (r.hostId !== info.id) return;
      if (r.players.size < 2) return send(ws, { type: 'error', message: 'Na spustenie potrebujete aspoň 2 hráčov.' });
      if (!r.tasks.length) return send(ws, { type: 'error', message: 'Pred spustením musíš pridať aspoň jednu úlohu.' });

      const ps = [...r.players.values()];
      ps.forEach(p => p.role = 'Crewmate');
      ps[Math.floor(Math.random() * ps.length)].role = 'Impostor';
      r.status = 'playing';
      return broadcastRoom(r);
    }

    if (m.type === 'leave') leave(ws);
  });

  ws.on('close', () => leave(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Among Us server beží na porte ${PORT}`);
});
