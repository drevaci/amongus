const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const PORT=Number(process.env.PORT)||3000;
const publicDir=path.resolve(__dirname,'public');
const rooms=new Map();
const sockets=new Map();
const MAX_PLAYERS=15;
const KILL_COOLDOWN=30000;

const COLORS=[
 {name:'Červená',key:'red',hex:'#e53935'},
 {name:'Modrá',key:'blue',hex:'#42a5f5'},
 {name:'Zelená',key:'green',hex:'#43a047'},
 {name:'Ružová',key:'pink',hex:'#ec407a'},
 {name:'Oranžová',key:'orange',hex:'#fb8c00'},
 {name:'Žltá',key:'yellow',hex:'#fdd835'},
 {name:'Čierna',key:'black',hex:'#424242'},
 {name:'Biela',key:'white',hex:'#eeeeee'},
 {name:'Fialová',key:'purple',hex:'#8e24aa'},
 {name:'Hnedá',key:'brown',hex:'#795548'},
 {name:'Tyrkysová',key:'cyan',hex:'#26c6da'},
 {name:'Limetková',key:'lime',hex:'#7cb342'},
 {name:'Tmavomodrá',key:'navy',hex:'#3949ab'},
 {name:'Sivá',key:'gray',hex:'#78909c'},
 {name:'Korálová',key:'coral',hex:'#ff7043'}
];

function id(){return Math.random().toString(36).slice(2,10);}
function roomCode(){let c;do c=Math.random().toString(36).slice(2,8).toUpperCase();while(rooms.has(c));return c;}
function send(ws,d){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(d));}
function broadcastPlayers(r,d){for(const p of r.players.values())send(p.ws,d);}
function sendHost(r,d){if(r.hostWs)send(r.hostWs,d);}
function broadcastAll(r,d){sendHost(r,d);broadcastPlayers(r,d);}

function allColorsUsed(r,exceptId=null){
 const used=new Set();
 for(const p of r.players.values())if(p.id!==exceptId)used.add(p.color);
 return COLORS.every(c=>used.has(c.key));
}
function colorUsed(r,key,exceptId=null){
 if(allColorsUsed(r,exceptId))return false;
 for(const p of r.players.values())if(p.id!==exceptId&&p.color===key)return true;
 return false;
}
function pubPlayer(p){
 return {id:p.id,name:p.name,color:p.color,icon:p.icon,alive:p.alive,
   role:p.role||null,tasksCompleted:p.tasksCompleted,taskOrder:p.taskOrder||[],reportReady:!!p.reportReady,
   airPressed:!!p.airPressed,killReadyAt:p.killReadyAt||0};
}
function safeRoom(r){
 return {code:r.code,hostId:r.hostId,status:r.status,tasks:r.tasks,impostorCount:r.impostorCount,
   players:[...r.players.values()].map(pubPlayer),airUsed:r.airUsed,airCount:r.airCount,
   warning:r.warning?{kind:r.warning.kind,reporterId:r.warning.reporterId||null}:null,
   voting:r.voting?{votes:Object.fromEntries(r.voting.votes),eligible:[...r.voting.eligible]}:null,
   result:r.result||null,winner:r.winner||null};
}
function roomState(r){return {type:'state',room:safeRoom(r)};}
function broadcastRoom(r){broadcastAll(r,roomState(r));}
function allTasksDone(r){return r.tasks.length>0&&[...r.players.values()].every(p=>p.tasksCompleted.length>=r.tasks.length);}
function endGame(r,winner){
 r.status='ended';r.winner=winner;r.voting=null;r.warning=null;
 broadcastRoom(r);broadcastAll(r,{type:'gameOver',winner});
 return true;
}
function checkWin(r){
 if(r.status!=='playing')return false;
 if(allTasksDone(r))return endGame(r,'Crewmates');
 const imp=[...r.players.values()].filter(p=>p.alive&&p.role==='Impostor').length;
 const crew=[...r.players.values()].filter(p=>p.alive&&p.role==='Crewmate').length;
 if(imp===0)return endGame(r,'Crewmates');
 if(imp>crew)return endGame(r,'Impostors');
 return false;
}
function beginVoting(r){
 r.warning=null;
 r.voting={votes:new Map(),eligible:new Set([...r.players.values()].filter(p=>p.alive).map(p=>p.id))};
 r.status='voting';broadcastRoom(r);
}
function resolveVoting(r){
 if(!r.voting)return;
 const counts=new Map();
 for(const v of r.voting.votes.values())counts.set(v,(counts.get(v)||0)+1);
 let max=0,winners=[];
 for(const [target,n] of counts){
   if(n>max){max=n;winners=[target];}
   else if(n===max)winners.push(target);
 }
 let text='Vote skipped';
 if(winners.length===1&&winners[0]!=='SKIP'){
   const p=r.players.get(winners[0]);
   if(p){p.alive=false;text=`${p.name} was ${p.role==='Impostor'?'an Impostor':'not an Impostor'}`;}
 }else if(winners.length>1)text='Vote tied';
 r.result={text};r.voting=null;r.status='result';broadcastRoom(r);
 setTimeout(()=>{if(!rooms.has(r.code)||r.status!=='result')return;r.result=null;r.status='playing';broadcastRoom(r);checkWin(r);},5000);
}

function leaveSocket(ws){
 const info=sockets.get(ws);if(!info)return;sockets.delete(ws);
 const r=rooms.get(info.code);if(!r)return;
 if(info.kind==='host'){
   r.hostWs=null;
   // Host leaving does not turn a player into host; the host controls are simply unavailable.
   broadcastRoom(r);
   return;
 }
 r.players.delete(info.id);
 if(!r.players.size&&!r.hostWs){rooms.delete(r.code);return;}
 broadcastRoom(r);
}

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',
 '.jfif':'image/jpeg','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
 let pathname;
 try{pathname=decodeURIComponent(new URL(req.url||'/',`http://${req.headers.host||'localhost'}`).pathname);}
 catch{res.writeHead(400);return res.end('Bad request');}
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('OK');}
 if(pathname==='/')pathname='/index.html';
 const rel=pathname.replace(/^\/+/,'');
 const fp=path.resolve(publicDir,rel);
 if(fp!==publicDir&&!fp.startsWith(publicDir+path.sep)){res.writeHead(403);return res.end('Forbidden');}
 fs.stat(fp,(e,s)=>{if(!e&&s.isDirectory())return serve(path.join(fp,'index.html'),res);serve(fp,res);});
});
function serve(fp,res){fs.readFile(fp,(e,data)=>{if(e){res.writeHead(404);return res.end('Not Found');}
 res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);});}

const wss=new WebSocket.Server({server});
wss.on('connection',ws=>{
 send(ws,{type:'colors',colors:COLORS});
 ws.on('close',()=>leaveSocket(ws));
 ws.on('message',raw=>{
  let m;try{m=JSON.parse(raw.toString())}catch{return send(ws,{type:'error',message:'Neplatná správa.'});}

  if(m.type==='create'){
   if(sockets.has(ws))return send(ws,{type:'error',message:'Už si pripojený.'});
   const code=roomCode();
   const r={code,hostId:id(),hostWs:ws,status:'lobby',tasks:[],impostorCount:1,players:new Map(),
     airUsed:false,airCount:0,warning:null,voting:null,result:null,winner:null};
   rooms.set(code,r);sockets.set(ws,{kind:'host',code});
   return send(ws,{type:'created',hostId:r.hostId,room:safeRoom(r),colors:COLORS});
  }

  if(m.type==='join'){
   if(sockets.has(ws))return send(ws,{type:'error',message:'Už si pripojený.'});
   const code=String(m.code||'').trim().toUpperCase(),name=String(m.name||'').trim().slice(0,16),color=String(m.color||''),icon=String(m.icon||'red');
   const r=rooms.get(code);
   if(!r)return send(ws,{type:'error',message:'Miestnosť s týmto kódom neexistuje.'});
   if(r.status!=='lobby')return send(ws,{type:'error',message:'Táto hra už začala.'});
   if(r.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'Miestnosť je plná.'});
   if(!name)return send(ws,{type:'error',message:'Zadaj meno.'});
   if(!COLORS.some(c=>c.key===color))return send(ws,{type:'error',message:'Vyber farbu.'});
   if(colorUsed(r,color))return send(ws,{type:'error',message:'Táto farba je už obsadená.'});
   const pid=id();
   const p={id:pid,name,color,icon,ws,role:null,alive:true,tasksCompleted:[],taskOrder:[],reportReady:false,airPressed:false,killReadyAt:0};
   r.players.set(pid,p);sockets.set(ws,{kind:'player',code,id:pid});
   send(ws,{type:'joined',playerId:pid,room:safeRoom(r),colors:COLORS});return broadcastRoom(r);
  }

  const info=sockets.get(ws);if(!info)return send(ws,{type:'error',message:'Najprv vytvor alebo sa pripoj do hry.'});
  const r=rooms.get(info.code);if(!r)return send(ws,{type:'error',message:'Miestnosť už neexistuje.'});
  const isH=info.kind==='host';
  const me=isH?null:r.players.get(info.id);if(!isH&&!me)return;

  if(m.type==='addTask'){
   if(!isH||r.status!=='lobby')return;
   const name=String(m.name||'').trim().slice(0,60),location=String(m.location||'').trim().slice(0,30),description=String(m.description||'').trim().slice(0,300);
   if(!name||!location||!description)return send(ws,{type:'error',message:'Vyplň názov, miesto aj to, čo treba spraviť.'});
   if(r.tasks.length>=30)return send(ws,{type:'error',message:'Maximum je 30 úloh.'});
   r.tasks.push({name,location,description});return broadcastRoom(r);
  }
  if(m.type==='removeTask'){
   if(!isH||r.status!=='lobby')return;
   const i=Number(m.index);if(Number.isInteger(i)&&i>=0&&i<r.tasks.length)r.tasks.splice(i,1);return broadcastRoom(r);
  }
  if(m.type==='setImpostors'){
   if(!isH||r.status!=='lobby')return;
   const n=Math.max(1,Math.min(3,Math.floor(Number(m.count)||1)));
   if(r.players.size<n+1)return send(ws,{type:'error',message:`Na ${n} impostorov treba aspoň ${n+1} hráčov.`});
   r.impostorCount=n;return broadcastRoom(r);
  }
  if(m.type==='start'){
   if(!isH||r.status!=='lobby')return;
   if(!r.tasks.length)return send(ws,{type:'error',message:'Pred spustením musíš pridať aspoň jednu úlohu.'});
   if(r.players.size<r.impostorCount+1)return send(ws,{type:'error',message:`Na ${r.impostorCount} impostora${r.impostorCount>1?'ov':''} treba aspoň ${r.impostorCount+1} hráčov.`});
   const ps=[...r.players.values()];
   ps.forEach(p=>{p.role='Crewmate';p.alive=true;p.tasksCompleted=[];p.reportReady=false;p.airPressed=false;p.killReadyAt=0;});
   ps.sort(()=>Math.random()-.5).slice(0,r.impostorCount).forEach(p=>p.role='Impostor');
   ps.forEach(p=>{p.taskOrder=r.tasks.map((_,i)=>i).sort(()=>Math.random()-.5);});
   r.airUsed=false;r.airCount=0;r.warning=null;r.voting=null;r.result=null;r.winner=null;r.status='roleReveal';
   broadcastRoom(r);
   setTimeout(()=>{if(rooms.has(r.code)&&r.status==='roleReveal'){r.status='playing';broadcastRoom(r);checkWin(r);}},5000);
   return;
  }

  if(!me)return;
  if(m.type==='completeTask'){
   if(!['playing','warning','voting','result'].includes(r.status))return;
   if(r.status==='warning' && r.warning?.reporterId!==me.id)return;
   const i=Number(m.index);
   if(!Number.isInteger(i)||i<0||i>=r.tasks.length||me.tasksCompleted.includes(i))return;
   me.tasksCompleted.push(i);me.tasksCompleted.sort((a,b)=>a-b);
   broadcastRoom(r);return checkWin(r);
  }
  if(m.type==='kill'){
   if(r.status!=='playing'||me.role!=='Impostor'||!me.alive)return;
   const now=Date.now();if(me.killReadyAt>now)return send(ws,{type:'error',message:`KILL je ešte v cooldowne (${Math.ceil((me.killReadyAt-now)/1000)} s).`});
   me.killReadyAt=now+KILL_COOLDOWN;send(ws,{type:'killCooldown',readyAt:me.killReadyAt});return broadcastRoom(r);
  }
  if(m.type==='air'){
   if(r.status!=='playing'||me.role!=='Impostor'||!me.alive)return;
   if(r.airUsed)return send(ws,{type:'error',message:'AIR už bol v tejto hre použitý.'});
   r.airUsed=true;r.airCount=0;for(const p of r.players.values())p.airPressed=false;r.status='air';return broadcastRoom(r);
  }
  if(m.type==='airPress'){
   if(r.status!=='air'||me.role!=='Crewmate'||!me.alive)return;
   if(!me.airPressed){me.airPressed=true;r.airCount++;}return broadcastRoom(r);
  }
  if(m.type==='doAir'){
   if(!isH||r.status!=='air')return;r.status='playing';r.airCount=0;return broadcastRoom(r);
  }
  if(m.type==='markDead'){
   if(!isH||r.status!=='playing')return;
   const p=r.players.get(String(m.playerId));if(!p||!p.alive)return;
   p.alive=false;p.reportReady=true;broadcastRoom(r);return checkWin(r);
  }
  if(m.type==='deadReport'){
   if(r.status!=='playing'||me.alive||!me.reportReady)return;
   me.reportReady=false;r.warning={kind:'deadBody',reporterId:me.id};r.status='warning';return broadcastRoom(r);
  }
  if(m.type==='emergency'){
   if(!isH||r.status!=='playing')return;
   r.warning={kind:'emergency',reporterId:null};r.status='warning';return broadcastRoom(r);
  }
  if(m.type==='dismissWarning'){
   if(!isH||r.status!=='warning')return;return beginVoting(r);
  }
  if(m.type==='vote'){
   if(r.status!=='voting'||!me.alive||!r.voting.eligible.has(me.id)||r.voting.votes.has(me.id))return;
   const target=String(m.target);if(target!=='SKIP'&&!r.voting.eligible.has(target))return;
   r.voting.votes.set(me.id,target);broadcastRoom(r);
   if(r.voting.votes.size>=r.voting.eligible.size)resolveVoting(r);
   return;
  }
 });
});

server.listen(PORT,'0.0.0.0',()=>console.log('Among Us server beží na porte '+PORT));
