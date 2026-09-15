const http=require("http");
const fs=require("fs");
const path=require("path");
const WebSocket=require("ws");
const PORT=process.env.PORT||3000, publicDir=path.join(__dirname,"public");
const rooms=new Map(), sockets=new Map();

function code(){let c;do{c=Math.random().toString(36).slice(2,8).toUpperCase()}while(rooms.has(c));return c}
function safeRoom(r){return{code:r.code,hostId:r.hostId,status:r.status,tasks:r.tasks,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,role:p.role||null}))}}
function send(ws,d){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(d))}
function broadcast(r,d){for(const p of r.players.values())send(p.ws,d)}
function broadcastRoom(r){broadcast(r,{type:"room",room:safeRoom(r)})}
function leave(ws){const info=sockets.get(ws);if(!info)return;const r=rooms.get(info.code);sockets.delete(ws);if(!r)return;r.players.delete(info.id);if(!r.players.size){rooms.delete(r.code);return}if(r.hostId===info.id)r.hostId=r.players.keys().next().value;broadcastRoom(r)}

const server=http.createServer((req,res)=>{
 let p=new URL(req.url,`http://${req.headers.host}`).pathname;if(p==="/")p="/index.html";
 const fp=path.join(publicDir,path.normalize(p));if(!fp.startsWith(publicDir)){res.writeHead(403);return res.end("Forbidden")}
 fs.readFile(fp,(e,data)=>{if(e){res.writeHead(404);return res.end("Not found")}
 const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".jfif":"image/jpeg",".jpg":"image/jpeg",".png":"image/png"};
 res.writeHead(200,{"Content-Type":types[path.extname(fp)]||"application/octet-stream"});res.end(data)})
});
const wss=new WebSocket.Server({server});
wss.on("connection",ws=>{
 ws.on("message",raw=>{
  let m;try{m=JSON.parse(raw)}catch{return send(ws,{type:"error",message:"Neplatná správa."})}
  if(m.type==="create"){
   const c=code(),id=Math.random().toString(36).slice(2,10);
   const r={code:c,hostId:id,status:"lobby",tasks:[],players:new Map()};
   r.players.set(id,{id,name:String(m.name).slice(0,16),ws});rooms.set(c,r);sockets.set(ws,{code:c,id});
   return send(ws,{type:"created",playerId:id,hostId:id,room:safeRoom(r)});
  }
  if(m.type==="join"){
   const c=String(m.code||"").toUpperCase(),r=rooms.get(c);
   if(!r)return send(ws,{type:"error",message:"Miestnosť s týmto kódom neexistuje."});
   if(r.status!=="lobby")return send(ws,{type:"error",message:"Táto hra už začala."});
   if(r.players.size>=15)return send(ws,{type:"error",message:"Miestnosť je plná."});
   const id=Math.random().toString(36).slice(2,10);r.players.set(id,{id,name:String(m.name).slice(0,16),ws});sockets.set(ws,{code:c,id});
   send(ws,{type:"joined",playerId:id,hostId:r.hostId,room:safeRoom(r)});return broadcastRoom(r);
  }
  const info=sockets.get(ws);if(!info)return;const r=rooms.get(info.code);if(!r)return;
  if(m.type==="addTask"){
   if(r.hostId!==info.id||r.status!=="lobby")return;
   const location=String(m.location||"").trim().slice(0,30),name=String(m.name||"").trim().slice(0,60);
   if(!location||!name)return send(ws,{type:"error",message:"Miesto aj úloha sú povinné."});
   if(r.tasks.length>=30)return send(ws,{type:"error",message:"Maximum je 30 úloh."});
   r.tasks.push({location,name});return broadcastRoom(r);
  }
  if(m.type==="removeTask"){
   if(r.hostId!==info.id||r.status!=="lobby")return;
   const i=Number(m.index);if(Number.isInteger(i)&&i>=0&&i<r.tasks.length)r.tasks.splice(i,1);return broadcastRoom(r);
  }
  if(m.type==="start"){
   if(r.hostId!==info.id)return;
   if(r.players.size<2)return send(ws,{type:"error",message:"Na spustenie potrebujete aspoň 2 hráčov."});
   if(!r.tasks.length)return send(ws,{type:"error",message:"Pred spustením musíš pridať aspoň jednu úlohu."});
   const ps=[...r.players.values()];ps.forEach(p=>p.role="Crewmate");
   ps[Math.floor(Math.random()*ps.length)].role="Impostor";r.status="playing";return broadcastRoom(r);
  }
  if(m.type==="leave")leave(ws);
 });
 ws.on("close",()=>leave(ws));
});
server.listen(PORT, "0.0.0.0", ()=>console.log("Among Us server beží na porte "+PORT));
