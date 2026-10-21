/* STEPPESHIELD — общие расчёты.
   Один и тот же файл работает в браузере (window.SSCore) и в Node (require),
   поэтому сайт и Telegram-бот считают тревоги одинаково. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SSCore = factory();
})(typeof self !== "undefined" ? self : this, function () {

  const SPECIES = [
    { sci: "Vanellus gregarius",     ru: "Кречётка",       iucn: "CR" },
    { sci: "Falco cherrug",          ru: "Балобан",        iucn: "EN" },
    { sci: "Aquila nipalensis",      ru: "Степной орёл",   iucn: "EN" },
    { sci: "Otis tarda",             ru: "Дрофа",          iucn: "VU" },
    { sci: "Chlamydotis macqueenii", ru: "Дрофа-красотка", iucn: "VU" },
    { sci: "Aquila heliaca",         ru: "Могильник",      iucn: "VU" },
    { sci: "Tetrax tetrax",          ru: "Стрепет",        iucn: "NT" },
    { sci: "Circus macrourus",       ru: "Степной лунь",   iucn: "NT" },
    { sci: "Saiga tatarica",         ru: "Сайгак",         iucn: "NT" }
  ];
  const BY_SCI = Object.fromEntries(SPECIES.map(s => [s.sci, s]));
  const WEIGHT = { CR: 5, EN: 4, VU: 3, NT: 2 };
  const BBOX = { w: 46.4, s: 40.5, e: 87.4, n: 55.5 };

  /* Постоянный источник: точка, которая повторяется в радиусе 750 м
     в разные дни. Степной пал уходит дальше за сутки, а газовый факел
     и промышленные печи светятся на одном месте неделями. */
  const PERSIST = { radiusKm: 0.75, minDays: 4 };

  function haversine(a, b, c, d) {
    const R = 6371, r = Math.PI / 180;
    const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function parseFirmsCsv(text, satLabel) {
    const lines = String(text).trim().split(/\r?\n/);
    if (lines.length < 1 || !/latitude/i.test(lines[0])) throw new Error((lines[0] || "пустой ответ").slice(0, 120));
    const h = lines[0].split(",").map(s => s.trim().toLowerCase()), ix = n => h.indexOf(n);
    const iLat = ix("latitude"), iLon = ix("longitude"), iFrp = ix("frp"), iConf = ix("confidence"),
          iDate = ix("acq_date"), iTime = ix("acq_time"), iDn = ix("daynight"), iSat = ix("satellite");
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(","), lat = +c[iLat], lon = +c[iLon];
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (lat < BBOX.s || lat > BBOX.n || lon < BBOX.w || lon > BBOX.e) continue;
      const conf = (c[iConf] || "").trim().toLowerCase();
      if (conf === "l" || conf === "low") continue;
      if (/^\d+$/.test(conf) && +conf < 30) continue;
      const t = (c[iTime] || "").trim().padStart(4, "0");
      out.push({
        lat, lon,
        frp: +c[iFrp] || 0,
        date: (c[iDate] || "").trim(),
        time: t.slice(0, 2) + ":" + t.slice(2) + " UTC",
        dn: iDn >= 0 ? (c[iDn] || "").trim() : "",
        sat: satLabel || (iSat >= 0 ? (c[iSat] || "").trim() : "")
      });
    }
    return out;
  }

  function fireTime(f) {
    if (!f.date) return 0;
    const hm = (f.time || "00:00").slice(0, 5).split(":");
    return Date.parse(f.date + "T" + (hm[0] || "00") + ":" + (hm[1] || "00") + ":00Z") || Date.parse(f.date + "T00:00:00Z") || 0;
  }

  /* Помечает постоянные источники. Каждой точке ставит f.days — в скольких
     разных днях в радиусе 750 м что-то горело — и f.persistent, если дней
     не меньше minDays. Возвращает сводку. */
  function markPersistent(fires, opt) {
    const o = Object.assign({}, PERSIST, opt || {});
    const cLat = 0.01, cLon = 0.015, grid = new Map();
    const key = (a, b) => a + "|" + b;
    for (const f of fires) {
      const gy = Math.floor(f.lat / cLat), gx = Math.floor(f.lon / cLon), k = key(gy, gx);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(f);
    }
    const dates = new Set(fires.map(f => f.date).filter(Boolean));
    let count = 0;
    const sites = [];
    for (const f of fires) {
      const gy = Math.floor(f.lat / cLat), gx = Math.floor(f.lon / cLon), days = new Set();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cell = grid.get(key(gy + dy, gx + dx));
        if (!cell) continue;
        for (const g of cell) if (g.date && haversine(f.lat, f.lon, g.lat, g.lon) <= o.radiusKm) days.add(g.date);
      }
      f.days = days.size;
      f.persistent = days.size >= o.minDays;
      if (f.persistent) count++;
    }
    // считаем отдельные объекты: точки ближе 1,5 км друг к другу — один источник
    for (const f of fires) {
      if (!f.persistent) continue;
      if (!sites.some(s => haversine(s.lat, s.lon, f.lat, f.lon) <= 1.5)) sites.push(f);
    }
    return { points: count, sites: sites.length, historyDays: dates.size, minDays: o.minDays };
  }

  /* Окно показа: последние N календарных дней относительно самой свежей даты в данных */
  function latestDate(fires) {
    let m = "";
    for (const f of fires) if (f.date > m) m = f.date;
    return m;
  }
  function inLastDays(fires, days) {
    const last = latestDate(fires);
    if (!last) return fires.slice();
    const edge = new Date(Date.parse(last + "T00:00:00Z") - (days - 1) * 864e5).toISOString().slice(0, 10);
    return fires.filter(f => f.date >= edge);
  }
  function inLastHours(fires, hours, now) {
    const edge = (now || Date.now()) - hours * 3600 * 1000;
    return fires.filter(f => fireTime(f) >= edge);
  }

  /* Тревоги: для каждой находки вида ищем ближайший пожар в радиусе.
     Находки одного вида в одной клетке ~50 км схлопываются в одну тревогу. */
  function computeAlerts(occ, fires, radiusKm) {
    const R = radiusKm, dLat = R / 111, cells = new Map(), threat = new Set();
    if (!fires.length || !occ.length) return { alerts: [], threat };
    for (const o of occ) {
      const dLon = R / (111 * Math.cos(o.lat * Math.PI / 180));
      let best = null, bd = Infinity;
      for (const f of fires) {
        if (Math.abs(f.lat - o.lat) > dLat || Math.abs(f.lon - o.lon) > dLon) continue;
        const d = haversine(o.lat, o.lon, f.lat, f.lon);
        if (d < bd) { bd = d; best = f; }
      }
      if (!best || bd > R) continue;
      threat.add(o);
      const score = Math.round(WEIGHT[o.sp.iucn] * (1 - bd / R) * 20);
      const k = o.sp.sci + "|" + Math.round(o.lat * 2) + "|" + Math.round(o.lon * 2), prev = cells.get(k);
      if (!prev || score > prev.score) cells.set(k, { o, f: best, d: bd, score, count: (prev ? prev.count : 0) + 1, key: k });
      else prev.count++;
    }
    return { alerts: [...cells.values()].sort((a, b) => b.score - a.score), threat };
  }

  return { SPECIES, BY_SCI, WEIGHT, BBOX, PERSIST, haversine, parseFirmsCsv, fireTime,
           markPersistent, latestDate, inLastDays, inLastHours, computeAlerts };
});
