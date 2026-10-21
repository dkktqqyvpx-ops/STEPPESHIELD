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
const {SPECIES,BY_SCI,BBOX,haversine,parseFirmsCsv,fireTime,markPersistent,inLastDays,inLastHours,computeAlerts}=SSCore;
const HISTORY_DAYS=10;  // сколько дней истории берём, чтобы узнавать постоянные источники

/* fires — вся история за 10 дней, occ — находки видов */
let fires=[],occ=[],alerts=[],alertsAll=[],radiusKm=50,occIsDemo=false,firesLoaded=false;
let persistInfo=null,dataSource="",dataUpdated="";

const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function store(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function load(k){try{return localStorage.getItem(k)}catch(e){return null}}
function setStatus(id,text,cls){const el=$(id);el.textContent=text;el.className=cls||"";}
function plural(n,a,b,c){const m=n%10,h=n%100;if(m===1&&h!==11)return a;if(m>=2&&m<=4&&(h<12||h>14))return b;return c;}
const fmtDays=n=>`${n} ${plural(n,"день","дня","дней")}`;

function setFires(list,source,updated){
  fires=list;dataSource=source;dataUpdated=updated||"";
  persistInfo=markPersistent(fires);
  firesLoaded=true;
  updateFireStatus();drawFires();compute();
}
function updateFireStatus(){
  if(!firesLoaded)return;
  const shown=firesForDisplay().length,days=+$("days").value;
  let t=`Пожары: ${shown} ${plural(shown,"точка","точки","точек")} за ${fmtDays(days)}`;
  if(dataSource)t+=` (${dataSource}${dataUpdated?", обновлено "+dataUpdated:""})`;
  setStatus("stFires",t,"ok");
  const p=persistInfo;
  if(!p||p.historyDays<p.minDays){
    setStatus("stFlares",`Факелы: для распознавания нужна история от ${p?p.minDays:4} дней, сейчас ${p?fmtDays(p.historyDays):"нет данных"}`,"");
  }else{
    setStatus("stFlares",`Постоянных источников найдено: ${p.sites} (горят ${p.minDays}+ ${plural(p.minDays,"день","дня","дней")} из ${p.historyDays} на одном месте)`,"ok");
  }
}

/* ---------- Готовые данные с сервера (их обновляет GitHub Actions) ---------- */
async function loadPrepared(){
  try{
    const r=await fetch("data/fires.json",{cache:"no-store"});
    if(!r.ok)return false;
    const j=await r.json();
    if(!j||!Array.isArray(j.fires)||!j.fires.length)return false;
    const list=j.fires.map(f=>({lat:f.lat,lon:f.lon,frp:f.frp,date:f.date,time:f.time,dn:f.dn||"",sat:f.sat||""}));
    demoMode(false);
    setFires(list,j.source||"NASA FIRMS",j.updated?new Date(j.updated).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"");
    return true;
  }catch(e){return false;}
}
async function loadPreparedSpecies(){
  try{
    const r=await fetch("data/species.json",{cache:"no-store"});
    if(!r.ok)return false;
    const j=await r.json();
    if(!j||!Array.isArray(j.occ)||!j.occ.length)return false;
    occ=j.occ.filter(o=>BY_SCI[o.sci]).map(o=>({lat:o.lat,lon:o.lon,sp:BY_SCI[o.sci],year:o.year||"",link:o.key?`https://www.gbif.org/occurrence/${o.key}`:""}));
    occIsDemo=false;
    const nsp=new Set(occ.map(o=>o.sp.sci)).size;
    setStatus("stSpecies",`Виды: ${occ.length} находок, ${nsp} из ${SPECIES.length} видов (GBIF, с 2000 г.)`,"ok");
    drawOcc();
    return true;
  }catch(e){return false;}
}

/* ---------- FIRMS по ключу ---------- */
async function fetchFirms(key,src,days){
  const r=await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${src}/${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}/${days}`);
  return parseFirmsCsv(await r.text());
}
async function loadFirms(){
  const key=$("mapKey").value.trim();
  if(!key){setStatus("stFires","Пожары: вставьте ключ FIRMS или загрузите CSV","err");$("settings").open=true;return;}
  store("firmsKey",key);
  if(occIsDemo||!occ.length) await loadSpecies();
  const src=$("source").value;
  setStatus("stFires","Пожары: загружаю из NASA FIRMS за "+fmtDays(HISTORY_DAYS)+"…");
  try{
    let list;
    try{list=await fetchFirms(key,src,HISTORY_DAYS);}
    catch(e){list=await fetchFirms(key,src,$("days").value);}  // если 10 дней не дали, берём короткий период
    demoMode(false);
    setFires(list,src);
  }catch(e){
    setStatus("stFires","Пожары: не загрузились ("+e.message+"). Скачайте CSV на сайте FIRMS и нажмите «Загрузить CSV».","err");
    updateLive();
  }
}

/* ---------- GBIF напрямую ---------- */
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
  if(!ok.length){setStatus("stSpecies","Виды: GBIF не отвечает. Нажмите «Демо-данные», чтобы показать работу на примере.","err");return false;}
  occ=ok.flatMap(x=>x.value); occIsDemo=false;
  setStatus("stSpecies",`Виды: ${occ.length} находок, ${ok.length} из ${SPECIES.length} видов (GBIF, с 2000 г.)`,"ok");
  drawOcc();compute();
  return true;
}

/* ---------- Демо ---------- */
function demoMode(on){$("demoFlag").hidden=!on;}
function loadDemo(){
  let s=2026;const rand=()=>((s=(s*16807)%2147483647)/2147483647);
  const today=Date.now(),day=i=>new Date(today-i*864e5).toISOString().slice(0,10);
  const list=[];
  // степные палы: каждый очаг живёт 1–2 дня и сдвигается
  [[52.6,63.8],[51.4,69.2],[49.6,57.6],[50.6,51.9],[48.3,73.4],[46.2,70.1],[47.4,66.6]].forEach(([la,lo])=>{
    const n=6+Math.floor(rand()*14);
    for(let i=0;i<n;i++)list.push({lat:la+(rand()-.5)*1.1,lon:lo+(rand()-.5)*1.6,frp:3+rand()*60,date:day(Math.floor(rand()*2)),time:`${String(5+Math.floor(rand()*4)).padStart(2,"0")}:${String(Math.floor(rand()*60)).padStart(2,"0")} UTC`});
  });
  // старые палы прошлой недели в других местах
  for(let i=0;i<30;i++)list.push({lat:43+rand()*10,lon:52+rand()*28,frp:2+rand()*20,date:day(3+Math.floor(rand()*7)),time:"08:40 UTC"});
  // газовые факелы: горят каждый день на одном месте, один стоит рядом с гнездовьями
  [[50.25,52.75,"Факел рядом с гнездовьями"],[43.35,52.85,""],[47.12,51.92,""],[51.05,53.25,""]].forEach(([la,lo])=>{
    for(let d=0;d<HISTORY_DAYS;d++){
      if(rand()<.2)continue;  // облачность: часть пролётов пропадает
      list.push({lat:la+(rand()-.5)*.004,lon:lo+(rand()-.5)*.006,frp:8+rand()*6,date:day(d),time:"21:10 UTC",dn:"N"});
    }
  });
  const centers=[[52.2,63.0],[51.0,68.5],[49.9,58.3],[50.2,52.6],[48.0,72.5],[46.6,69.4],[47.9,67.2],[44.8,76.8],[43.6,51.3]];
  occ=[];
  SPECIES.forEach((sp,k)=>{for(let i=0;i<25;i++){const[la,lo]=centers[(k+i)%centers.length];occ.push({lat:la+(rand()-.5)*2.2,lon:lo+(rand()-.5)*3,sp,year:2015+Math.floor(rand()*10),link:""});}});
  occIsDemo=true;demoMode(true);
  setStatus("stSpecies",`Виды: ${occ.length} демо-находок`,"ok");
  drawOcc();
  setFires(list,"демо-данные");
}

/* ================= Карта ================= */
let map,fireLayer,flareLayer,occLayer,focusLayer;
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
  flareLayer=L.layerGroup().addTo(map);fireLayer=L.layerGroup().addTo(map);occLayer=L.layerGroup().addTo(map);focusLayer=L.layerGroup().addTo(map);
  L.control.layers(null,{"Пожары":fireLayer,"Постоянные источники":flareLayer,"Места обитания":occLayer}).addTo(map);
  drawFires();drawOcc(lastThreat);
  focusFromHash();
}
function drawFires(){
  if(!map)return;fireLayer.clearLayers();flareLayer.clearLayers();
  const hist=persistInfo?persistInfo.historyDays:0;
  firesForDisplay().forEach(f=>{
    if(f.persistent){
      L.circleMarker([f.lat,f.lon],{radius:5,color:"#4d5a52",weight:1.5,fillColor:"#9aa39c",fillOpacity:.9})
        .bindPopup(`<b>Постоянный источник</b><br>Горит на этом месте ${f.days} ${plural(f.days,"день","дня","дней")} из ${hist}.<br>Вероятно газовый факел или промышленный объект.${flaresCounted()?"":"<br><i>В тревогах не учитывается.</i>"}<br>${esc(f.date)} ${esc(f.time)}<br>${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}`)
        .addTo(flareLayer);
      return;
    }
    L.circleMarker([f.lat,f.lon],{radius:3+Math.min(9,Math.sqrt(f.frp)),color:"#d8431f",weight:1,fillColor:"#d8431f",fillOpacity:.7})
      .bindPopup(`<b>Пожар</b><br>${esc(f.date)} ${esc(f.time)}<br>Мощность ${f.frp.toFixed(1)} МВт<br>${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}`).addTo(fireLayer);
  });
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
const flaresCounted=()=>!$("fFlare").checked;
/* Точки за выбранный период показа (1–7 дней) и, если включено, за 24 часа */
function firesForDisplay(){
  let list=inLastDays(fires,+$("days").value);
  if($("fAge").value==="24"){const recent=inLastHours(list,24);if(recent.length)list=recent;}
  return list;
}
/* Точки, которые участвуют в расчёте тревог */
function firesForAlerts(){
  const list=firesForDisplay();
  return flaresCounted()?list:list.filter(f=>!f.persistent);
}
function fillSpeciesFilter(){
  const sel=$("fSp"),cur=sel.value,seen=new Map();
  alertsAll.forEach(a=>seen.set(a.o.sp.sci,a.o.sp));
  sel.innerHTML='<option value="all">все виды</option>'+[...seen.values()].map(sp=>`<option value="${sp.sci}">${sp.ru}</option>`).join("");
  sel.value=[...seen.keys()].includes(cur)?cur:"all";
}
function applyFilters(){
  const minScore=+$("fScore").value,sp=$("fSp").value;
  alerts=alertsAll.filter(a=>a.score>=minScore&&(sp==="all"||a.o.sp.sci===sp));
  $("alertsHead").textContent=alerts.length<alertsAll.length
    ? `Тревоги: ${alerts.length} из ${alertsAll.length}`
    : "Тревоги, по убыванию риска";
  renderAlerts();updateLive();
}
let filteredOut=0;
function compute(){
  const all=firesForDisplay(),use=firesForAlerts();
  const res=computeAlerts(occ,use,radiusKm);
  alertsAll=res.alerts;
  // сколько тревог убрал отсев: считаем, что было бы с факелами
  filteredOut=0;
  if(!flaresCounted()&&use.length!==all.length){
    const withFlares=computeAlerts(occ,all,radiusKm).alerts;
    const keep=new Set(alertsAll.map(a=>a.key+"|"+a.score));
    filteredOut=withFlares.filter(a=>a.f.persistent&&!keep.has(a.key+"|"+a.score)).length;
  }
  $("flareNote").textContent=filteredOut?`Отсеяно ложных тревог от факелов: ${filteredOut}`:"";
  drawOcc(res.threat);drawFires();fillSpeciesFilter();applyFilters();updateFireStatus();
}
function renderAlerts(){
  const n=new Set(alerts.map(a=>a.o.sp.sci)).size;
  $("nSpecies").textContent=n;
  $("countText").textContent=`${plural(n,"вид","вида","видов")} в радиусе ${radiusKm} км от огня`;
  const list=$("alertList");
  if(!firesLoaded){list.innerHTML='<div class="empty">Загружаем пожары…</div>';return;}
  if(!alerts.length){list.innerHTML=`<div class="empty">В радиусе ${radiusKm} км от пожаров мест обитания редких видов нет. Увеличьте радиус или период.</div>`;return;}
  list.innerHTML=alerts.map((a,i)=>{
    const lvl=a.score>=60?"high":a.score>=30?"mid":"low";
    const flare=a.f.persistent?`<div class="meta flare-mark">Источник горит ${a.f.days} ${plural(a.f.days,"день","дня","дней")} подряд, возможно факел</div>`:"";
    return `<div class="alert" data-i="${i}" tabindex="0" role="button" aria-label="${esc(a.o.sp.ru)}, риск ${a.score}">
      <div class="score ${lvl}" title="Риск из 100">${a.score}</div>
      <div><h3>${esc(a.o.sp.ru)}<span class="tag ${a.o.sp.iucn}">${a.o.sp.iucn}</span></h3>
      <div class="sci">${esc(a.o.sp.sci)}</div>
      <div class="meta">Огонь в <strong>${a.d.toFixed(1)} км</strong>, ${esc(a.f.date)}${a.count>1?`, находок рядом: ${a.count}`:""}</div>
      <div class="meta">${a.o.lat.toFixed(4)}, ${a.o.lon.toFixed(4)}</div>${flare}</div></div>`;
  }).join("");
  list.querySelectorAll(".alert").forEach(el=>{const go=()=>focusAlert(+el.dataset.i,el);el.onclick=go;el.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();go();}};});
}
function focusAlert(i,el){
  const a=alerts[i];if(!a||!map)return;
  document.querySelectorAll(".alert.active").forEach(x=>x.classList.remove("active"));
  if(el){el.classList.add("active");}
  focusLayer.clearLayers();
  L.circle([a.f.lat,a.f.lon],{radius:radiusKm*1000,color:"#d8431f",weight:1,fillOpacity:.05}).addTo(focusLayer);
  L.polyline([[a.o.lat,a.o.lon],[a.f.lat,a.f.lon]],{color:"#1e2b24",weight:2,dashArray:"6 6"}).addTo(focusLayer);
  map.flyToBounds(L.latLngBounds([[a.o.lat,a.o.lon],[a.f.lat,a.f.lon]]).pad(1.2),{maxZoom:10,duration:.8});
  const route=`https://www.google.com/maps/dir/?api=1&destination=${a.f.lat.toFixed(5)},${a.f.lon.toFixed(5)}`;
  L.popup().setLatLng([a.o.lat,a.o.lon]).setContent(`<b>${esc(a.o.sp.ru)}</b>: огонь в ${a.d.toFixed(1)} км<br>Риск ${a.score} из 100<br><a href="${route}" target="_blank" rel="noopener">Маршрут к огню</a>`).openOn(map);
  if(window.innerWidth<=820)$("map").scrollIntoView({behavior:"smooth"});
}

/* Ссылка из Telegram: #map&focus=широта,долгота — открываем ближайшую тревогу */
let pendingFocus=null;
function readFocus(){
  const m=location.hash.match(/focus=(-?[\d.]+),(-?[\d.]+)/);
  pendingFocus=m?{lat:+m[1],lon:+m[2]}:null;
}
function focusFromHash(){
  if(!pendingFocus||!map||!alertsAll.length)return;
  if($("fScore").value!=="0"||$("fSp").value!=="all"){$("fScore").value="0";$("fSp").value="all";applyFilters();}
  let best=-1,bd=Infinity;
  alerts.forEach((a,i)=>{const d=Math.min(haversine(a.o.lat,a.o.lon,pendingFocus.lat,pendingFocus.lon),haversine(a.f.lat,a.f.lon,pendingFocus.lat,pendingFocus.lon));if(d<bd){bd=d;best=i;}});
  if(best<0||bd>5)return;
  pendingFocus=null;
  const el=document.querySelector(`.alert[data-i="${best}"]`);
  if(el)el.scrollIntoView({block:"nearest"});
  focusAlert(best,el);
}

/* Живая строка на главной */
function updateLive(){
  const line=$("liveLine"),span=line.querySelector("span");
  if(!firesLoaded){line.classList.remove("on");span.innerHTML="Подключаем спутниковые данные…";return;}
  const n=new Set(alerts.map(a=>a.o.sp.sci)).size,days=+$("days").value,shown=firesForAlerts();
  line.classList.add("on");
  span.innerHTML=`${occIsDemo?"Демо: ":"Сейчас: "}спутники видят <strong>${shown.length} ${plural(shown.length,"очаг","очага","очагов")}</strong> за ${fmtDays(days)}. <strong>${n} ${plural(n,"редкий вид","редких вида","редких видов")}</strong> в радиусе ${radiusKm} км от огня.`;
}

/* ================= Переходы ================= */
function showApp(){$("landing").hidden=true;$("app").hidden=false;window.scrollTo(0,0);if(!location.hash.startsWith("#map"))history.pushState(null,"","#map");requestAnimationFrame(initMap);}
function showHome(e){if(e)e.preventDefault();$("app").hidden=true;$("landing").hidden=false;if(location.hash)history.pushState(null,"",location.pathname);}
document.querySelectorAll("[data-open]").forEach(b=>b.onclick=showApp);
document.querySelectorAll("[data-home]").forEach(b=>b.onclick=showHome);
window.addEventListener("popstate",()=>location.hash.startsWith("#map")?showApp():showHome());

$("radius").oninput=e=>{radiusKm=+e.target.value;$("radiusVal").textContent=radiusKm;};
$("radius").onchange=compute;
$("days").onchange=compute;
$("fAge").onchange=compute;
$("fFlare").onchange=compute;
$("fScore").onchange=applyFilters;
$("fSp").onchange=applyFilters;
$("btnFirms").onclick=loadFirms;
$("btnDemo").onclick=loadDemo;
$("btnCsv").onclick=()=>$("csvFile").click();
$("csvFile").onchange=async e=>{
  const f=e.target.files[0];if(!f)return;
  try{
    if(occIsDemo||!occ.length)await loadSpecies();
    const list=parseFirmsCsv(await f.text());
    demoMode(false);setFires(list,"файл "+f.name);
  }catch(err){setStatus("stFires","Пожары: файл не похож на CSV из FIRMS","err");}
  e.target.value="";
};

/* ================= Старт =================
   1) готовые данные, которые каждые 3 часа обновляет GitHub Actions;
   2) личный ключ FIRMS, если он сохранён в этом браузере;
   3) иначе демо-данные, чтобы карта никогда не была пустой. */
readFocus();
renderAlerts();updateLive();
(async()=>{
  const key=load("firmsKey");
  if(key)$("mapKey").value=key;
  const speciesReady=await loadPreparedSpecies();
  if(await loadPrepared()){
    if(!speciesReady)await loadSpecies();
  }else if(key){
    if(!speciesReady)await loadSpecies();
    await loadFirms();
    if(!firesLoaded)loadDemo();
  }else{
    loadDemo();
  }
  focusFromHash();
})();
if(location.hash.startsWith("#map"))showApp();
