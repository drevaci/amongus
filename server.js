
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.resolve(__dirname, 'public');
const rooms = new Map();
const sockets = new Map();
const MAX_PLAYERS = 15;
const KILL_COOLDOWN = 30_000;

const COLORS = [
  {name:'Červená', key:'red', hex:'#e74c3c'},
  {name:'Modrá', key:'blue', hex:'#3498db'},
  {name:'Zelená', key:'green', hex:'#2ecc71'},
  {name:'Ružová', key:'pink', hex:'#ff69b4'},
  {name:'Oranžová', key:'orange', hex:'#f39c12'},
  {name:'Žltá', key:'yellow', hex:'#f1c40f'},
  {name:'Čierna', key:'black', hex:'#222'},
  {name:'Biela', key:'white', hex:'#f5f5f5'},
  {name:'Fialová', key:'purple', hex:'#9b59b6'},
  {name:'Hnedá', key:'brown', hex:'#8b5a2b'},
  {name:'Tyrkysová', key:'cyan', hex:'#1abc9c'},
  {name:'Limetková', key:'lime', hex:'#8bc34a'},
  {name:'Tmavomodrá', key:'navy', hex:'#34495e'},
  {name:'Sivá', key:'gray', hex:'#7f8c8d'},
  {name:'Korálová', key:'coral', hex:'#ff7f66'}
];

function roomCode() {
  let c;
  do c = Math.random().toString(36).slice(2,8).toUpperCase();
  while (rooms.has(c));
  return c;
}
function id() { return Math.random().toString(36).slice(2,10); }
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(r, data) {
  for (const p of r.players.values()) send(p.ws, data);
}
function colorUsed(r, key, exceptId=null) {
  for (const p of r.players.values()) if (p.id !== exceptId && p.color === key) return true;
  return false;
}
function publicPlayer(p) {
  return {
    id:p.id, name:p.name, color:p.color, icon:p.icon,
    role:p.role || null, alive:p.alive, reportReady:!!p.reportReady, airPressed:!!p.airPressed,
    tasksCompleted:p.tasksCompleted,
    killReadyAt:p.killReadyAt || 0
  };
}
function safeRoom(r) {
  return {
    code:r.code, hostId:r.hostId, status:r.status, tasks:r.tasks,
    players:[...r.players.values()].map(publicPlayer),
    airUsed:r.airUsed, airCount:r.airCount,
    warning:r.warning ? {kind:r.warning.kind, reporterId:r.warning.reporterId || null} : null,
    voting:r.voting ? {
      votes:Object.fromEntries(r.voting.votes),
      eligible:[...r.voting.eligible]
    } : null,
    result:r.result || null
  };
}
function broadcastRoom(r) { broadcast(r,{type:'state',room:safeRoom(r)}); }
function allTasksDone(r) {
  return r.tasks.length > 0 && [...r.players.values()].every(p => p.tasksCompleted.length >= r.tasks.length);
}
function checkWin(r) {
  if (r.status !== 'playing') return false;
  if (allTasksDone(r)) return endGame(r,'Crewmates');
  const aliveImpostors=[...r.players.values()].filter(p=>p.alive && p.role==='Impostor').length;
  const aliveCrew=[...r.players.values()].filter(p=>p.alive && p.role==='Crewmate').length;
  if (aliveImpostors===0) return endGame(r,'Crewmates');
  if (aliveImpostors>aliveCrew) return endGame(r,'Impostors');
  return false;
}
function endGame(r,winner) {
  r.status='ended';
  r.winner=winner;
  broadcastRoom(r);
  broadcast(r,{type:'gameOver',winner});
  return true;
}
function beginVoting(r) {
  r.warning=null;
  const eligible=[...r.players.values()].filter(p=>p.alive).map(p=>p.id);
  r.voting={votes:new Map(),eligible:new Set(eligible)};
  r.status='voting';
  broadcastRoom(r);
}
function resolveVoting(r) {
  if (!r.voting) return;
  const counts=new Map();
  for (const vote of r.voting.votes.values()) counts.set(vote,(counts.get(vote)||0)+1);
  let max=0, winners=[];
  for (const [target,n] of counts) {
    if(n>max){max=n;winners=[target];}
    else if(n===max) winners.push(target);
  }
  let resultText='Vote skipped';
  if (winners.length===1) {
    const target=winners[0];
    if(target==='SKIP') resultText='Vote skipped';
    else {
      const p=r.players.get(target);
      if(p){
        p.alive=false;
        resultText = `${p.name} was ${p.role==='Impostor'?'an Impostor':'not an Impostor'}`;
      }
    }
  } else if (winners.length>1) {
    resultText='Vote tied';
  }
  r.result={kind:'vote',text:resultText};
  r.voting=null;
  r.status='result';
  broadcastRoom(r);
  setTimeout(()=>{
    if(!rooms.has(r.code) || r.status!=='result') return;
    r.result=null;
    r.status='playing';
    broadcastRoom(r);
    checkWin(r);
  },5000);
}
function leave(ws) {
  const info=sockets.get(ws);
  if(!info) return;
  sockets.delete(ws);
  const r=rooms.get(info.code);
  if(!r) return;
  r.players.delete(info.id);
  if(!r.players.size){ rooms.delete(r.code); return; }
  if(r.hostId===info.id) r.hostId=r.players.keys().next().value;
  broadcastRoom(r);
}
function validName(n){ return String(n||'').trim().slice(0,16); }
function validIcon(i){ return Math.max(1,Math.min(3,Number(i)||1)); }

// ---- HTTP ----
const MIME={
 '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
 '.js':'text/javascript; charset=utf-8','.jfif':'image/jpeg',
 '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
 '.svg':'image/svg+xml','.ico':'image/x-icon'
};
const server=http.createServer((req,res)=>{
  let pathname;
  try { pathname=decodeURIComponent(new URL(req.url||'/', 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if(pathname==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('OK');}
  if(pathname==='/') pathname='/index.html';
  const rel=pathname.replace(/^\/+/,'');
  const fp=path.resolve(publicDir,rel);
  if(fp!==publicDir && !fp.startsWith(publicDir+path.sep)){res.writeHead(403);return res.end('Forbidden');}
  fs.stat(fp,(e,s)=>{
    if(!e && s.isDirectory()) return serveFile(path.join(fp,'index.html'),res);
    serveFile(fp,res);
  });
});
function serveFile(fp,res){
  fs.readFile(fp,(e,data)=>{
    if(e){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Not Found');}
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});
    res.end(data);
  });
}

// ---- WebSocket game ----
const wss=new WebSocket.Server({server});
wss.on('connection',ws=>{
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw.toString());}catch{return send(ws,{type:'error',message:'Neplatná správa.'});}

    if(m.type==='create' || m.type==='join'){
      if(sockets.has(ws)) return send(ws,{type:'error',message:'Už si v miestnosti.'});
      const name=validName(m.name);
      const color=String(m.color||'');
      const icon=validIcon(m.icon);
      if(!name) return send(ws,{type:'error',message:'Zadaj meno.'});
      if(!COLORS.some(c=>c.key===color)) return send(ws,{type:'error',message:'Vyber farbu.'});

      let r;
      if(m.type==='create'){
        r={code:roomCode(),hostId:null,status:'lobby',tasks:[],players:new Map(),airUsed:false,airCount:0,warning:null,voting:null,result:null,winner:null};
        const pid=id();
        r.hostId=pid;
        r.players.set(pid,{id:pid,name,color,icon,ws,role:null,alive:true,tasksCompleted:[],killReadyAt:0});
        rooms.set(r.code,r);
        sockets.set(ws,{code:r.code,id:pid});
        return send(ws,{type:'created',playerId:pid,room:safeRoom(r),colors:COLORS});
      } else {
        const c=String(m.code||'').toUpperCase();
        r=rooms.get(c);
        if(!r) return send(ws,{type:'error',message:'Miestnosť s týmto kódom neexistuje.'});
        if(r.status!=='lobby') return send(ws,{type:'error',message:'Táto hra už začala.'});
        if(r.players.size>=MAX_PLAYERS) return send(ws,{type:'error',message:'Miestnosť je plná.'});
        if(colorUsed(r,color)) return send(ws,{type:'error',message:'Táto farba je už obsadená.'});
        const pid=id();
        r.players.set(pid,{id:pid,name,color,icon,ws,role:null,alive:true,tasksCompleted:[],killReadyAt:0});
        sockets.set(ws,{code:r.code,id:pid});
        send(ws,{type:'joined',playerId:pid,room:safeRoom(r),colors:COLORS});
        return broadcastRoom(r);
      }
    }

    const info=sockets.get(ws);
    if(!info) return send(ws,{type:'error',message:'Najprv sa pripoj do hry.'});
    const r=rooms.get(info.code);
    if(!r) return send(ws,{type:'error',message:'Miestnosť už neexistuje.'});
    const me=r.players.get(info.id);
    if(!me) return;

    if(m.type==='addTask'){
      if(r.hostId!==me.id || r.status!=='lobby') return;
      const location=String(m.location||'').trim().slice(0,30);
      const name=String(m.name||'').trim().slice(0,60);
      if(!location||!name)return send(ws,{type:'error',message:'Miesto aj úloha sú povinné.'});
      if(r.tasks.length>=30)return send(ws,{type:'error',message:'Maximum je 30 úloh.'});
      r.tasks.push({location,name});
      return broadcastRoom(r);
    }
    if(m.type==='removeTask'){
      if(r.hostId!==me.id||r.status!=='lobby')return;
      const i=Number(m.index);
      if(Number.isInteger(i)&&i>=0&&i<r.tasks.length)r.tasks.splice(i,1);
      return broadcastRoom(r);
    }
    if(m.type==='start'){
      if(r.hostId!==me.id)return;
      if(r.players.size<2)return send(ws,{type:'error',message:'Na spustenie potrebujete aspoň 2 hráčov.'});
      if(!r.tasks.length)return send(ws,{type:'error',message:'Pred spustením musíš pridať aspoň jednu úlohu.'});
      const ps=[...r.players.values()];
      ps.forEach(p=>{p.role='Crewmate';p.alive=true;p.tasksCompleted=[];p.killReadyAt=0;});
      ps[Math.floor(Math.random()*ps.length)].role='Impostor';
      r.airUsed=false;r.airCount=0;r.warning=null;r.voting=null;r.result=null;r.winner=null;
      ps.forEach(p=>{p.reportReady=false;p.airPressed=false;});
      r.status='roleReveal';
      broadcastRoom(r);
      setTimeout(()=>{
        if(rooms.has(r.code)&&r.status==='roleReveal'){
          r.status='playing'; broadcastRoom(r); checkWin(r);
        }
      },5000);
      return;
    }
    if(m.type==='completeTask'){
      if(!['playing','result'].includes(r.status))return;
      const i=Number(m.index);
      if(!Number.isInteger(i)||i<0||i>=r.tasks.length||me.tasksCompleted.includes(i))return;
      me.tasksCompleted.push(i);
      me.tasksCompleted.sort((a,b)=>a-b);
      broadcastRoom(r);
      return checkWin(r);
    }
    if(m.type==='kill'){
      if(r.status!=='playing'||me.role!=='Impostor')return;
      const now=Date.now();
      if(me.killReadyAt>now)return send(ws,{type:'error',message:`KILL je ešte v cooldowne (${Math.ceil((me.killReadyAt-now)/1000)} s).`});
      me.killReadyAt=now+KILL_COOLDOWN;
      send(ws,{type:'killCooldown',readyAt:me.killReadyAt});
      return broadcastRoom(r);
    }
    if(m.type==='air'){
      if(r.status!=='playing'||me.role!=='Impostor')return;
      if(r.airUsed)return send(ws,{type:'error',message:'AIR už bol v tejto hre použitý.'});
      r.airUsed=true;r.airCount=0;
      for(const p of r.players.values()) p.airPressed=false;
      r.status='air';
      return broadcastRoom(r);
    }
    if(m.type==='doAir'){
      if(r.status!=='air')return;
      if(r.hostId!==me.id)return;
      r.status='playing';r.airCount=0;
      broadcastRoom(r);
      return;
    }
    if(m.type==='airPress'){
      if(r.status!=='air'||me.role!=='Crewmate')return;
      if(!me.alive)return;
      if(!me.airPressed){me.airPressed=true;r.airCount++;}
      return broadcastRoom(r);
    }
    if(m.type==='markDead'){
      if(r.hostId!==me.id||r.status!=='playing')return;
      const target=r.players.get(String(m.playerId));
      if(!target||!target.alive)return;
      target.alive=false; target.reportReady=true;
      broadcastRoom(r);
      return checkWin(r);
    }
    if(m.type==='deadReport'){
      if(r.status!=='playing'||me.alive||!me.reportReady)return;
      me.reportReady=false;
      r.warning={kind:'deadBody',reporterId:me.id};
      r.status='warning';
      return broadcastRoom(r);
    }
    if(m.type==='emergency'){
      if(r.hostId!==me.id||r.status!=='playing')return;
      r.warning={kind:'emergency',reporterId:me.id};
      r.status='warning';
      return broadcastRoom(r);
    }
    if(m.type==='dismissWarning'){
      if(r.hostId!==me.id||r.status!=='warning')return;
      return beginVoting(r);
    }
    if(m.type==='vote'){
      if(r.status!=='voting'||!r.voting.eligible.has(me.id)||r.voting.votes.has(me.id))return;
      const target=String(m.target);
      if(target!=='SKIP' && !r.voting.eligible.has(target))return;
      r.voting.votes.set(me.id,target);
      broadcastRoom(r);
      if(r.voting.votes.size>=r.voting.eligible.size) resolveVoting(r);
      return;
    }
    if(m.type==='leave') return leave(ws);
  });
  ws.on('close',()=>leave(ws));
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Among Us server beží na porte ${PORT}`));
