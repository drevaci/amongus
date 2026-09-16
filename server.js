const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const rooms = new Map();
const sockets = new Map();
const MAX_PLAYERS = 15;
const KILL_COOLDOWN = 30;

const COLORS = ['red','blue','green','pink','orange','yellow','black','white','purple','brown','cyan','lime','navy','gray','coral'];

function roomCode() {
  let c;
  do c = Math.random().toString(36).slice(2, 8).toUpperCase(); while (rooms.has(c));
  return c;
}
function id() { return Math.random().toString(36).slice(2, 10); }
function cleanName(v) { return String(v || '').trim().slice(0, 16); }
function cleanText(v, max) { return String(v || '').trim().slice(0, max); }
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data) { for (const p of room.players.values()) send(p.ws, data); }
function broadcastViews(room) { for (const p of room.players.values()) send(p.ws, { type:'state', state:viewFor(room, p.id) }); }
function playerArray(room) { return [...room.players.values()]; }

function publicPlayer(p, includeRole=false) {
  return {
    id: p.id, name: p.name, color: p.color, alive: p.alive,
    role: includeRole ? p.role : null,
    tasksDone: p.tasksDone,
    tasksTotal: p.tasksTotal,
    airUsed: p.airUsed
  };
}

function viewFor(room, viewerId) {
  const viewer = room.players.get(viewerId);
  const isHost = viewerId === room.hostId;
  return {
    code: room.code,
    status: room.status,
    phase: room.phase,
    hostId: room.hostId,
    players: playerArray(room).map(p => publicPlayer(p, p.id === viewerId || isHost)),
    tasks: room.tasks,
    warning: room.warning,
    warningText: room.warningText,
    airCount: room.airCount,
    airResolved: room.airResolved,
    voting: room.voting ? { active:true, votes:Object.fromEntries(room.voting.votes) } : null,
    result: room.result,
    me: viewer ? {
      id: viewer.id, name: viewer.name, color: viewer.color, role: viewer.role,
      alive: viewer.alive, tasksDone: viewer.tasksDone, tasksTotal: viewer.tasksTotal,
      taskDone: viewer.taskDone, killReadyAt: viewer.killReadyAt, airUsed: viewer.airUsed,
      roleRevealed: room.roleReveal
    } : null
  };
}

function makeRoom(hostName, color, ws) {
  const hostId = id();
  const p = {
    id: hostId, name: hostName, color, ws, role: 'Crewmate', alive: true,
    tasksDone: 0, tasksTotal: 0, taskDone: [], killReadyAt: 0, airUsed: false
  };
  const r = {
    code: roomCode(), hostId, status:'lobby', phase:'lobby', players:new Map([[hostId,p]]),
    tasks:[], warning:null, warningText:'', airCount:0, airResolved:false,
    voting:null, result:null, roleReveal:false, roleRevealUntil:0
  };
  rooms.set(r.code, r);
  sockets.set(ws, { code:r.code, id:hostId });
  return r;
}

function resetPlayerForGame(p, tasksTotal) {
  p.alive = true; p.tasksDone = 0; p.tasksTotal = tasksTotal; p.taskDone = new Array(tasksTotal).fill(false);
  p.killReadyAt = 0; p.airUsed = false;
}

function chooseImpostors(room) {
  const ps = playerArray(room);
  ps.forEach(p => p.role = 'Crewmate');
  const count = ps.length >= 10 ? 2 : 1;
  const shuffled = [...ps].sort(() => Math.random() - 0.5);
  shuffled.slice(0, count).forEach(p => p.role = 'Impostor');
}

function startGame(room) {
  chooseImpostors(room);
  for (const p of room.players.values()) resetPlayerForGame(p, room.tasks.length);
  room.status='playing'; room.phase='roleReveal'; room.roleReveal=true; room.roleRevealUntil=Date.now()+4000;
  room.warning=null; room.result=null; room.airCount=0; room.airResolved=false; room.voting=null;
  broadcastViews(room);
  setTimeout(() => {
    if (rooms.get(room.code) !== room || room.status !== 'playing') return;
    if (room.phase === 'roleReveal') { room.phase='normal'; room.roleReveal=false; broadcastViews(room); checkWin(room); }
  }, 4100);
}

function triggerWarning(room, kind, text) {
  room.warning = kind;
  room.warningText = text || '';
  room.phase = kind === 'air' ? 'air' : kind === 'meeting' ? 'meeting' : 'report';
  broadcastViews(room);
}

function checkWin(room) {
  if (room.status !== 'playing' || room.warning || room.result) return false;
  const ps = playerArray(room);
  const aliveImpostors = ps.filter(p => p.alive && p.role === 'Impostor').length;
  const aliveCrew = ps.filter(p => p.alive && p.role === 'Crewmate').length;
  const allTasksDone = ps.every(p => p.tasksDone >= p.tasksTotal);
  if (allTasksDone) return endGame(room, 'Crewmates');
  if (aliveImpostors === 0) return endGame(room, 'Crewmates');
  if (aliveImpostors > aliveCrew) return endGame(room, 'Impostors');
  return false;
}

function endGame(room, winner) {
  room.status='ended'; room.phase='ended'; room.result=winner; room.warning=null; room.voting=null; room.roleReveal=false;
  broadcastViews(room);
  return true;
}

function resolveWarning(room) {
  if (!room.warning) return;
  const kind = room.warning;
  room.warning=null; room.warningText='';
  if (kind === 'air') {
    room.airResolved=true;
    room.phase='normal';
  } else {
    room.phase='normal';
  }
  broadcastViews(room);
}

function startVoting(room) {
  if (room.status !== 'playing' || !room.warning) return;
  room.voting = { votes:new Map() };
  room.phase='voting';
  room.warning=null; room.warningText='';
  broadcastViews(room);
}

function finishVoting(room) {
  if (!room.voting) return;
  const counts = new Map();
  for (const v of room.voting.votes.values()) counts.set(v, (counts.get(v)||0)+1);
  let selected = 'SKIP', best = 0, tie = false;
  for (const [target,count] of counts) {
    if (target === 'SKIP') continue;
    if (count > best) { best=count; selected=target; tie=false; }
    else if (count === best && count > 0) tie=true;
  }
  if (tie) selected='SKIP';
  let text = 'Vote skipped';
  if (selected !== 'SKIP') {
    const p=room.players.get(selected);
    if (p) {
      p.alive=false;
      text = p.name + (p.role === 'Impostor' ? ' was an Impostor' : ' was not an Impostor');
    }
  }
  room.voting=null; room.phase='result'; room.warning='voteResult'; room.warningText=text;
  broadcastViews(room);
  setTimeout(() => {
    if (rooms.get(room.code)!==room || room.status!=='playing' || room.warning!=='voteResult') return;
    room.warning=null; room.warningText=''; room.phase='normal'; broadcastViews(room); checkWin(room);
  }, 4500);
}

function leave(ws) {
  const info=sockets.get(ws); if(!info) return;
  const room=rooms.get(info.code); sockets.delete(ws); if(!room) return;
  room.players.delete(info.id);
  if (!room.players.size) { rooms.delete(room.code); return; }
  if (room.hostId===info.id) room.hostId=room.players.keys().next().value;
  broadcastViews(room);
  checkWin(room);
}

const server=http.createServer((req,res)=>{
  let p=new URL(req.url, `http://${req.headers.host}`).pathname;
  if(p==='/') p='/index.html';
  const fp=path.join(publicDir,path.normalize(p));
  if(!fp.startsWith(publicDir)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(fp,(e,data)=>{
    if(e){res.writeHead(404);return res.end('Not found');}
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.jfif':'image/jpeg','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[path.extname(fp)]||'application/octet-stream'});res.end(data);
  });
});

const wss=new WebSocket.Server({server});
wss.on('connection',ws=>{
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw)}catch{return send(ws,{type:'error',message:'Neplatná správa.'});}

    if(m.type==='create'){
      const name=cleanName(m.name); const color=COLORS.includes(m.color)?m.color:null;
      if(!name) return send(ws,{type:'error',message:'Zadaj meno.'});
      if(!color) return send(ws,{type:'error',message:'Vyber ikonu/farbu.'});
      const r=makeRoom(name,color,ws);
      return send(ws,{type:'connected',state:viewFor(r,r.hostId)});
    }
    if(m.type==='join'){
      const name=cleanName(m.name), color=COLORS.includes(m.color)?m.color:null, c=String(m.code||'').toUpperCase();
      const r=rooms.get(c);
      if(!name) return send(ws,{type:'error',message:'Zadaj meno.'});
      if(!color) return send(ws,{type:'error',message:'Vyber ikonu/farbu.'});
      if(!r) return send(ws,{type:'error',message:'Miestnosť s týmto kódom neexistuje.'});
      if(r.status!=='lobby') return send(ws,{type:'error',message:'Táto hra už začala.'});
      if(r.players.size>=MAX_PLAYERS) return send(ws,{type:'error',message:'Miestnosť je plná.'});
      if(playerArray(r).some(p=>p.color===color)) return send(ws,{type:'error',message:'Táto farba/ikona je už obsadená.'});
      const pid=id();
      r.players.set(pid,{id:pid,name,color,ws,role:'Crewmate',alive:true,tasksDone:0,tasksTotal:0,taskDone:[],killReadyAt:0,airUsed:false});
      sockets.set(ws,{code:c,id:pid});
      send(ws,{type:'connected',state:viewFor(r,pid)}); return broadcastViews(r);
    }

    const info=sockets.get(ws); if(!info) return;
    const r=rooms.get(info.code); if(!r) return;
    const me=r.players.get(info.id); if(!me) return;
    const host=info.id===r.hostId;

    if(m.type==='addTask'){
      if(!host||r.status!=='lobby') return;
      const location=cleanText(m.location,30), name=cleanText(m.name,60);
      if(!location||!name) return send(ws,{type:'error',message:'Miesto aj úloha sú povinné.'});
      if(r.tasks.length>=30) return send(ws,{type:'error',message:'Maximum je 30 úloh.'});
      r.tasks.push({location,name}); return broadcastViews(r);
    }
    if(m.type==='removeTask'){
      if(!host||r.status!=='lobby') return;
      const i=Number(m.index); if(Number.isInteger(i)&&i>=0&&i<r.tasks.length) r.tasks.splice(i,1);
      return broadcastViews(r);
    }
    if(m.type==='start'){
      if(!host) return; if(r.players.size<2) return send(ws,{type:'error',message:'Na spustenie potrebujete aspoň 2 hráčov.'});
      if(!r.tasks.length) return send(ws,{type:'error',message:'Pred spustením pridaj aspoň jednu úlohu.'});
      return startGame(r);
    }
    if(m.type==='completeTask'){
      if(r.status!=='playing'||r.phase==='roleReveal'||r.phase==='voting'||r.result) return;
      if(!me.alive||me.role!=='Crewmate') return;
      const i=Number(m.index); if(!Number.isInteger(i)||i<0||i>=r.tasks.length) return;
      if(!me.taskDone[i]) { me.taskDone[i]=true; me.tasksDone++; }
      broadcastViews(r); checkWin(r); return;
    }
    if(m.type==='markDead'){
      if(!host||r.status!=='playing') return;
      const p=r.players.get(String(m.playerId)); if(!p) return;
      p.alive=false; broadcastViews(r); checkWin(r); return;
    }
    if(m.type==='kill'){
      // KILL je iba tlačidlo pre Impostora. Koho zabije, rieši hráč mimo programu.
      if(r.status!=='playing'||me.role!=='Impostor'||!me.alive||r.warning||r.voting) return;
      const now=Date.now(); if(now<me.killReadyAt) return send(ws,{type:'error',message:'KILL ešte nie je pripravený.'});
      me.killReadyAt=now+KILL_COOLDOWN*1000;
      broadcastViews(r); return;
    }
    if(m.type==='air'){
      if(r.status!=='playing'||me.role!=='Impostor'||!me.alive||me.airUsed||r.warning||r.voting) return;
      me.airUsed=true; r.airCount++; r.airResolved=false; triggerWarning(r,'air','AIR'); return;
    }
    if(m.type==='doAir'){
      if(r.status!=='playing'||!r.warning||r.warning!=='air'||!me.alive||me.role!=='Crewmate') return;
      if(!me._airDone) { me._airDone=true; broadcastViews(r); }
      return;
    }
    if(m.type==='resolveWarning'){
      if(!host||!r.warning) return;
      for(const p of r.players.values()) delete p._airDone;
      resolveWarning(r); checkWin(r); return;
    }
    if(m.type==='emergency'){
      if(!host||r.status!=='playing'||r.warning||r.voting) return;
      triggerWarning(r,'meeting','EMERGENCY MEETING'); return;
    }
    if(m.type==='deadReport'){
      if(r.status!=='playing'||r.warning||r.voting||me.alive) return;
      triggerWarning(r,'report','DEAD BODY REPORT'); return;
    }
    if(m.type==='startVoting'){
      if(!host||r.status!=='playing'||!r.warning) return;
      return startVoting(r);
    }
    if(m.type==='vote'){
      if(r.status!=='playing'||r.phase!=='voting'||!r.voting||!me.alive) return;
      if(r.voting.votes.has(me.id)) return;
      const target=String(m.targetId||'SKIP');
      if(target!=='SKIP' && !r.players.has(target)) return;
      r.voting.votes.set(me.id,target); broadcastViews(r);
      const eligible=playerArray(r).filter(p=>p.alive).length;
      if(r.voting.votes.size>=eligible) finishVoting(r);
      return;
    }
    if(m.type==='hostResolveVote'){
      if(!host||!r.voting) return; finishVoting(r); return;
    }
    if(m.type==='leave') return leave(ws);
  });
  ws.on('close',()=>leave(ws));
});

server.listen(PORT,'0.0.0.0',()=>console.log('Among Us server beží na porte '+PORT));
