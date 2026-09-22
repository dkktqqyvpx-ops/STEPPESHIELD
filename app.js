/* ================= Горизонт с ковылём ================= */
(function drawHorizon(){
  const svg=document.getElementById("horizon"), NS="http://www.w3.org/2000/svg";
  let seed=7; const r=()=>((seed=(seed*16807)%2147483647)/2147483647);
  const base=200;
  const add=(tag,attrs)=>{const el=document.createElementNS(NS,tag);for(const k in attrs)el.setAttribute(k,attrs[k]);svg.appendChild(el);return el;};
  // дальние очаги на горизонте
  const defs=add("defs",{});
  defs.innerHTML='<radialGradient id="glow"><stop offset="0" stop-color="#d8431f" stop-opacity=".55"/><stop offset="1" stop-color="#d8431f" stop-opacity="0"/></radialGradient>';
  [[260,34],[640,22],[930,40]].forEach(([x,w])=>{
    add("ellipse",{cx:x,cy:base-2,rx:w*2.4,ry:w,fill:"url(#glow)"});
    add("circle",{cx:x,cy:base-3,r:3.2,fill:"#d8431f"});
  });
  add("rect",{x:0,y:base,width:1200,height:40,fill:"#dfe5d8"});
  add("line",{x1:0,y1:base,x2:1200,y2:base,stroke:"#1e2b24","stroke-width":1.5});
  // стебли ковыля
  const colors=["#7f9270","#9aa98a","#c8a03c","#b5ab86"];
  for(let i=0;i<420;i++){
    const x=r()*1200, h=30+r()*150*(0.4+Math.abs(Math.sin(x/170))*0.6), lean=10+r()*40;
    const y0=base+4+r()*30;
    add("path",{d:`M${x.toFixed(1)} ${y0.toFixed(1)} Q ${(x+lean*.3).toFixed(1)} ${(y0-h*.6).toFixed(1)} ${(x+lean).toFixed(1)} ${(y0-h).toFixed(1)}`,
      stroke:colors[Math.floor(r()*colors.length)],"stroke-width":(0.6+r()*1.1).toFixed(2),fill:"none","stroke-linecap":"round",opacity:(0.45+r()*0.5).toFixed(2)});
  }
})();

/* ================= Данные ================= */
const SPECIES=[
  {sci:"Vanellus gregarius",ru:"Кречётка",iucn:"CR"},
  {sci:"Falco cherrug",ru:"Балобан",iucn:"EN"},
  {sci:"Aquila nipalensis",ru:"Степной орёл",iucn:"EN"},
  {sci:"Otis tarda",ru:"Дрофа",iucn:"VU"},
  {sci:"Chlamydotis macqueenii",ru:"Дрофа-красотка",iucn:"VU"},
  {sci:"Aquila heliaca",ru:"Могильник",iucn:"VU"},
  {sci:"Tetrax tetrax",ru:"Стрепет",iucn:"NT"},
  {sci:"Circus macrourus",ru:"Степной лунь",iucn:"NT"},
  {sci:"Saiga tatarica",ru:"Сайгак",iucn:"NT"}
];
const WEIGHT={CR:5,EN:4,VU:3,NT:2};
const BBOX={w:46.4,s:40.5,e:87.4,n:55.5};

let fires=[],occ=[],alerts=[],radiusKm=50,occIsDemo=false,firesLoaded=false;

const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function store(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function load(k){try{return localStorage.getItem(k)}catch(e){return null}}
function setStatus(id,text,cls){const el=$(id);el.textContent=text;el.className=cls||"";}
function plural(n,a,b,c){const m=n%10,h=n%100;if(m===1&&h!==11)return a;if(m>=2&&m<=4&&(h<12||h>14))return b;return c;}
function haversine(a,b,c,d){const R=6371,r=Math.PI/180,x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));}

/* ---------- FIRMS ---------- */
function parseFirmsCsv(text){
  const lines=text.trim().split(/\r?\n/);
  if(lines.length<2||!/latitude/i.test(lines[0])) throw new Error(lines[0].slice(0,120)||"пустой ответ");
  const h=lines[0].split(",").map(s=>s.trim().toLowerCase()),ix=n=>h.indexOf(n);
  const iLat=ix("latitude"),iLon=ix("longitude"),iFrp=ix("frp"),iConf=ix("confidence"),iDate=ix("acq_date"),iTime=ix("acq_time");
  const out=[];
  for(let i=1;i<lines.length;i++){
    const c=lines[i].split(","),lat=+c[iLat],lon=+c[iLon];
    if(!isFinite(lat)||!isFinite(lon))continue;
    if(lat<BBOX.s||lat>BBOX.n||lon<BBOX.w||lon>BBOX.e)continue;
    const conf=(c[iConf]||"").trim();
    if(conf==="l"||conf==="low")continue;
    if(/^\d+$/.test(conf)&&+conf<30)continue;
    const t=(c[iTime]||"").padStart(4,"0");
    out.push({lat,lon,frp:+c[iFrp]||0,date:c[iDate]||"",time:t.slice(0,2)+":"+t.slice(2)+" UTC"});
  }
  return out;
}
async function loadFirms(){
  const key=$("mapKey").value.trim();
  if(!key){setStatus("stFires","Пожары: вставьте ключ FIRMS или загрузите CSV","err");$("settings").open=true;return;}
  store("firmsKey",key);
  if(occIsDemo) await loadSpecies();
  const src=$("source").value,days=$("days").value;
  setStatus("stFires","Пожары: загружаю из NASA FIRMS…");
  try{
    const r=await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${src}/${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}/${days}`);
    fires=parseFirmsCsv(await r.text());
    firesLoaded=true; demoMode(false);
    setStatus("stFires",`Пожары: ${fires.length} точек за ${days} дн. (${src})`,"ok");
    drawFires();compute();
  }catch(e){
    setStatus("stFires","Пожары: не загрузились ("+e.message+"). Скачайте CSV на сайте FIRMS и нажмите «Загрузить CSV».","err");
    updateLive();
  }
}

/* ---------- GBIF ---------- */
async function loadSpecies(){
  setStatus("stSpecies","Виды: загружаю из GBIF…");
  const year=new Date().getFullYear();
  const res=await Promise.allSettled(SPECIES.map(async sp=>{
    const r=await fetch(`https://api.gbif.org/v1/occurrence/search?country=KZ&hasCoordinate=true&hasGeospatialIssue=false&year=2000,${year}&limit=300&scientificName=${encodeURIComponent(sp.sci)}`);
    if(!r.ok)throw new Error(r.status);
    const j=await r.json();
    return j.results.filter(o=>o.decimalLatitude!=null).map(o=>({lat:o.decimalLatitude,lon:o.decimalLongitude,sp,year:o.year||"",link:`https://www.gbif.org/occurrence/${o.key}`}));
  }));
  const ok=res.filter(x=>x.status==="fulfilled");
  if(!ok.length){setStatus("stSpecies","Виды: GBIF не отвечает. Нажмите «Демо-данные», чтобы показать работу на примере.","err");return;}
  occ=ok.flatMap(x=>x.value); occIsDemo=false;
  setStatus("stSpecies",`Виды: ${occ.length} находок, ${ok.length} из ${SPECIES.length} видов (GBIF, с 2000 г.)`,"ok");
  drawOcc();compute();
}

/* ---------- Демо ---------- */
function demoMode(on){$("demoFlag").hidden=!on;}
function loadDemo(){
  let s=2026;const rand=()=>((s=(s*16807)%2147483647)/2147483647);
  fires=[];
  [[52.6,63.8],[51.4,69.2],[49.6,57.6],[50.6,51.9],[48.3,73.4],[46.2,70.1],[47.4,66.6]].forEach(([la,lo])=>{
    const n=6+Math.floor(rand()*14);
    for(let i=0;i<n;i++)fires.push({lat:la+(rand()-.5)*1.1,lon:lo+(rand()-.5)*1.6,frp:3+rand()*60,date:new Date(Date.now()-rand()*2*864e5).toISOString().slice(0,10),time:""});
  });
  const centers=[[52.2,63.0],[51.0,68.5],[49.9,58.3],[50.2,52.6],[48.0,72.5],[46.6,69.4],[47.9,67.2],[44.8,76.8],[43.6,51.3]];
  occ=[];
  SPECIES.forEach((sp,k)=>{for(let i=0;i<25;i++){const[la,lo]=centers[(k+i)%centers.length];occ.push({lat:la+(rand()-.5)*2.2,lon:lo+(rand()-.5)*3,sp,year:2015+Math.floor(rand()*10),link:""});}});
  occIsDemo=true;firesLoaded=true;demoMode(true);
  setStatus("stFires",`Пожары: ${fires.length} демо-точек`,"ok");
  setStatus("stSpecies",`Виды: ${occ.length} демо-находок`,"ok");
  drawFires();drawOcc();compute();
}

/* ================= Карта ================= */
let map,fireLayer,occLayer,focusLayer;
function initMap(){
  if(map){map.invalidateSize();return;}
  map=L.map("map",{preferCanvas:true}).fitBounds([[BBOX.s,BBOX.w],[BBOX.n,BBOX.e]]);
  const attr="&copy; OpenStreetMap | NASA FIRMS | GBIF";
  // несколько источников подложки: если один не отвечает, включаем следующий
  const PROVIDERS=[
    {name:"OpenStreetMap",url:"https://tile.openstreetmap.org/{z}/{x}/{y}.png",max:19},
    {name:"OpenStreetMap DE",url:"https://tile.openstreetmap.de/{z}/{x}/{y}.png",max:18},
    {name:"Esri, спутник",url:"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",max:17},
    {name:"Без карты",url:"",max:18}
  ];
  let base=null,pi=0,errs=0;
  function setBase(i){
    pi=i;errs=0;
    if(base)map.removeLayer(base);
    const p=PROVIDERS[i];
    if(!p.url){base=null;$("baseName").textContent="карта не загрузилась, точки показаны без подложки";return;}
    base=L.tileLayer(p.url,{maxZoom:p.max,attribution:attr});
    base.on("tileerror",()=>{ if(++errs>8&&pi===i) setBase(i+1<PROVIDERS.length?i+1:PROVIDERS.length-1); });
    base.addTo(map);base.bringToBack();
    $("baseName").textContent="подложка: "+p.name;
  }
  setBase(0);
  $("baseSwitch").onclick=()=>setBase((pi+1)%PROVIDERS.length);
  fireLayer=L.layerGroup().addTo(map);occLayer=L.layerGroup().addTo(map);focusLayer=L.layerGroup().addTo(map);
  L.control.layers(null,{"Пожары":fireLayer,"Места обитания":occLayer}).addTo(map);
  drawFires();drawOcc(lastThreat);
}
function drawFires(){
  if(!map)return;fireLayer.clearLayers();
  firesInScope().forEach(f=>L.circleMarker([f.lat,f.lon],{radius:3+Math.min(9,Math.sqrt(f.frp)),color:"#d8431f",weight:1,fillColor:"#d8431f",fillOpacity:.7})
    .bindPopup(`<b>Пожар</b><br>${esc(f.date)} ${esc(f.time)}<br>Мощность ${f.frp.toFixed(1)} МВт<br>${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}`).addTo(fireLayer));
}
let lastThreat=null;
function drawOcc(threat){
  lastThreat=threat||null;
  if(!map)return;occLayer.clearLayers();
  occ.forEach(o=>{
    const hot=threat&&threat.has(o);
    L.circleMarker([o.lat,o.lon],hot?{radius:6,color:"#d8431f",weight:2,fillColor:"#1e2b24",fillOpacity:1}:{radius:4,color:"#5f7351",weight:1,fillColor:"#7f9270",fillOpacity:.6})
     .bindPopup(`<b>${esc(o.sp.ru)}</b> <i>${esc(o.sp.sci)}</i><br>Категория МСОП: ${o.sp.iucn}<br>Год наблюдения: ${esc(o.year)}${o.link?`<br><a href="${o.link}" target="_blank" rel="noopener">Запись в GBIF</a>`:""}`)
     .addTo(occLayer);
  });
}

/* ================= Тревоги ================= */
/* Фильтр по времени: оставляем пожары за последние 24 часа */
function fireTime(f){
  if(!f.date)return 0;
  const hm=(f.time||"00:00").slice(0,5).split(":");
  return Date.parse(f.date+"T"+(hm[0]||"00")+":"+(hm[1]||"00")+":00Z")||Date.parse(f.date+"T00:00:00Z")||0;
}
function firesInScope(){
  if($("fAge").value==="all")return fires;
  const edge=Date.now()-24*3600*1000;
  const recent=fires.filter(f=>fireTime(f)>=edge);
  return recent.length?recent:fires;
}
function fillSpeciesFilter(){
  const sel=$("fSp"),cur=sel.value,seen=new Map();
  alertsAll.forEach(a=>seen.set(a.o.sp.sci,a.o.sp));
  sel.innerHTML='<option value="all">все виды</option>'+[...seen.values()].map(sp=>`<option value="${sp.sci}">${sp.ru}</option>`).join("");
  sel.value=[...seen.keys()].includes(cur)?cur:"all";
}
let alertsAll=[];
function applyFilters(){
  const minScore=+$("fScore").value,sp=$("fSp").value;
  alerts=alertsAll.filter(a=>a.score>=minScore&&(sp==="all"||a.o.sp.sci===sp));
  $("alertsHead").textContent=alerts.length<alertsAll.length
    ? `Тревоги: ${alerts.length} из ${alertsAll.length}`
    : "Тревоги, по убыванию риска";
  renderAlerts();updateLive();
}
function compute(){
  const fires=firesInScope();
  if(fires.length&&occ.length){
    const R=radiusKm,dLat=R/111,cells=new Map(),threat=new Set();
    for(const o of occ){
      const dLon=R/(111*Math.cos(o.lat*Math.PI/180));let best=null,bd=Infinity;
      for(const f of fires){
        if(Math.abs(f.lat-o.lat)>dLat||Math.abs(f.lon-o.lon)>dLon)continue;
        const d=haversine(o.lat,o.lon,f.lat,f.lon);if(d<bd){bd=d;best=f;}
      }
      if(!best||bd>R)continue;
      threat.add(o);
      const score=Math.round(WEIGHT[o.sp.iucn]*(1-bd/R)*20);
      const key=o.sp.sci+"|"+Math.round(o.lat*2)+"|"+Math.round(o.lon*2),prev=cells.get(key);
      if(!prev||score>prev.score)cells.set(key,{o,f:best,d:bd,score,count:(prev?prev.count:0)+1});else prev.count++;
    }
    alertsAll=[...cells.values()].sort((a,b)=>b.score-a.score);
    drawOcc(threat);
  }else alertsAll=[];
  drawFires();fillSpeciesFilter();applyFilters();
}
function renderAlerts(){
  const n=new Set(alerts.map(a=>a.o.sp.sci)).size;
  $("nSpecies").textContent=n;
  $("countText").textContent=`${plural(n,"вид","вида","видов")} в радиусе ${radiusKm} км от огня`;
  const list=$("alertList");
  if(!firesLoaded){list.innerHTML='<div class="empty">Загрузите пожары в настройках выше. Нет ключа — нажмите «Демо-данные».</div>';return;}
  if(!alerts.length){list.innerHTML=`<div class="empty">В радиусе ${radiusKm} км от пожаров мест обитания редких видов нет. Увеличьте радиус или период.</div>`;return;}
  list.innerHTML=alerts.map((a,i)=>{
    const lvl=a.score>=60?"high":a.score>=30?"mid":"low";
    return `<div class="alert" data-i="${i}" tabindex="0" role="button" aria-label="${esc(a.o.sp.ru)}, риск ${a.score}">
      <div class="score ${lvl}" title="Риск из 100">${a.score}</div>
      <div><h3>${esc(a.o.sp.ru)}<span class="tag ${a.o.sp.iucn}">${a.o.sp.iucn}</span></h3>
      <div class="sci">${esc(a.o.sp.sci)}</div>
      <div class="meta">Огонь в <strong>${a.d.toFixed(1)} км</strong>, ${esc(a.f.date)}${a.count>1?`, находок рядом: ${a.count}`:""}</div>
      <div class="meta">${a.o.lat.toFixed(4)}, ${a.o.lon.toFixed(4)}</div></div></div>`;
  }).join("");
  list.querySelectorAll(".alert").forEach(el=>{const go=()=>focusAlert(+el.dataset.i,el);el.onclick=go;el.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();go();}};});
}
function focusAlert(i,el){
  const a=alerts[i];if(!a||!map)return;
  document.querySelectorAll(".alert.active").forEach(x=>x.classList.remove("active"));el.classList.add("active");
  focusLayer.clearLayers();
  L.circle([a.f.lat,a.f.lon],{radius:radiusKm*1000,color:"#d8431f",weight:1,fillOpacity:.05}).addTo(focusLayer);
  L.polyline([[a.o.lat,a.o.lon],[a.f.lat,a.f.lon]],{color:"#1e2b24",weight:2,dashArray:"6 6"}).addTo(focusLayer);
  map.flyToBounds(L.latLngBounds([[a.o.lat,a.o.lon],[a.f.lat,a.f.lon]]).pad(1.2),{maxZoom:10,duration:.8});
  L.popup().setLatLng([a.o.lat,a.o.lon]).setContent(`<b>${esc(a.o.sp.ru)}</b>: огонь в ${a.d.toFixed(1)} км<br>Риск ${a.score} из 100`).openOn(map);
  if(window.innerWidth<=820)$("map").scrollIntoView({behavior:"smooth"});
}

/* Живая строка на главной */
function updateLive(){
  const line=$("liveLine"),span=line.querySelector("span");
  if(!firesLoaded){line.classList.remove("on");
    span.innerHTML=load("firmsKey")?"Подключаем спутниковые данные…":"Откройте карту и подключите ключ NASA FIRMS, чтобы увидеть пожары за последние дни.";return;}
  const n=new Set(alerts.map(a=>a.o.sp.sci)).size,days=$("days").value,fires=firesInScope();
  line.classList.add("on");
  span.innerHTML=`${occIsDemo?"Демо: ":"Сейчас: "}спутники видят <strong>${fires.length} ${plural(fires.length,"очаг","очага","очагов")}</strong> за ${days} ${plural(+days,"день","дня","дней")}. <strong>${n} ${plural(n,"редкий вид","редких вида","редких видов")}</strong> в радиусе ${radiusKm} км от огня.`;
}

/* ================= Переходы ================= */
function showApp(){$("landing").hidden=true;$("app").hidden=false;window.scrollTo(0,0);if(location.hash!=="#map")history.pushState(null,"","#map");requestAnimationFrame(initMap);}
function showHome(e){if(e)e.preventDefault();$("app").hidden=true;$("landing").hidden=false;if(location.hash)history.pushState(null,"",location.pathname);}
document.querySelectorAll("[data-open]").forEach(b=>b.onclick=showApp);
document.querySelectorAll("[data-home]").forEach(b=>b.onclick=showHome);
window.addEventListener("popstate",()=>location.hash==="#map"?showApp():showHome());

$("radius").oninput=e=>{radiusKm=+e.target.value;$("radiusVal").textContent=radiusKm;};
$("radius").onchange=compute;
$("fAge").onchange=compute;
$("fScore").onchange=applyFilters;
$("fSp").onchange=applyFilters;
$("btnFirms").onclick=loadFirms;
$("btnDemo").onclick=loadDemo;
$("btnCsv").onclick=()=>$("csvFile").click();
$("csvFile").onchange=async e=>{
  const f=e.target.files[0];if(!f)return;
  try{if(occIsDemo)await loadSpecies();fires=parseFirmsCsv(await f.text());firesLoaded=true;demoMode(false);
    setStatus("stFires",`Пожары: ${fires.length} точек из файла ${f.name}`,"ok");drawFires();compute();}
  catch(err){setStatus("stFires","Пожары: файл не похож на CSV из FIRMS","err");}
  e.target.value="";
};

/* Старт */
renderAlerts();updateLive();
const key=load("firmsKey");
if(key){$("mapKey").value=key;loadSpecies().then(loadFirms);}else{$("settings").open=true;loadSpecies();}
if(location.hash==="#map")showApp();
