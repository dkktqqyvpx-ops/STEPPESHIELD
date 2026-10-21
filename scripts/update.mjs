/* STEPPESHIELD — обновление данных и Telegram-тревоги.
   Запускается GitHub Actions каждые 3 часа (см. .github/workflows/update.yml).

   Что делает:
   1. Берёт пожары NASA FIRMS за 10 дней (два спутника VIIRS) и помечает
      постоянные источники — вероятные газовые факелы.
   2. Берёт находки редких видов из GBIF.
   3. Сохраняет data/fires.json и data/species.json — сайт читает их
      без всякого ключа.
   4. Считает тревоги по пожарам за последние 24 часа и отправляет новые
      в Telegram. Уже отправленные запоминает в data/sent.json.

   Переменные окружения (секреты репозитория):
   FIRMS_KEY     — ключ NASA FIRMS (обязательно)
   TG_BOT_TOKEN  — токен бота от @BotFather (без него шаг Telegram пропускается)
   TG_CHAT_ID    — канал или чат, например @steppeshield_alerts
   SITE_URL      — адрес сайта для кнопки «Открыть на карте»
   FORCE=true    — ручной запуск для демонстрации: отправить лучшую тревогу,
                   даже если она уже уходила, или сводку, если тревог нет */

import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const core = require(path.join(here, "..", "core.js"));
const { SPECIES, BY_SCI, BBOX, parseFirmsCsv, markPersistent, inLastHours, computeAlerts } = core;

const env = process.env;
const DATA_DIR = env.DATA_DIR || path.join(here, "..", "data");
const SITE_URL = (env.SITE_URL || "https://dkktqqyvpx-ops.github.io/STEPPESHIELD/").replace(/#.*$/, "");
const FORCE = /^(1|true|yes)$/i.test(env.FORCE || "");
const RADIUS = +(env.RADIUS_KM || 50);
const MIN_SCORE = +(env.MIN_SCORE || 60);
const MAX_MESSAGES = +(env.MAX_MESSAGES || 5);
const HISTORY_DAYS = 10;
const SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT"];

const log = (...a) => console.log(...a);
const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA_DIR, name), "utf8")); }
  catch { return fallback; }
}
async function writeJson(name, obj) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, name), JSON.stringify(obj) + "\n");
}

/* ---------- 1. Пожары ---------- */
async function loadFires() {
  if (!env.FIRMS_KEY) throw new Error("нет секрета FIRMS_KEY");
  const all = [], used = [];
  for (const src of SOURCES) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(env.FIRMS_KEY)}/${src}/${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}/${HISTORY_DAYS}`;
    try {
      const r = await fetch(url);
      const text = await r.text();
      const list = parseFirmsCsv(text, src.startsWith("VIIRS_NOAA20") ? "NOAA-20" : "S-NPP");
      all.push(...list); used.push(src);
      log(`FIRMS ${src}: ${list.length} точек`);
    } catch (e) {
      log(`FIRMS ${src}: ошибка — ${e.message}`);
    }
  }
  if (!used.length) throw new Error("FIRMS не ответил ни по одному спутнику");
  return { fires: all, used };
}

/* ---------- 2. Виды ---------- */
async function loadSpecies(previous) {
  const year = new Date().getUTCFullYear(), out = [];
  let ok = 0;
  for (const sp of SPECIES) {
    const url = `https://api.gbif.org/v1/occurrence/search?country=KZ&hasCoordinate=true&hasGeospatialIssue=false&year=2000,${year}&limit=300&scientificName=${encodeURIComponent(sp.sci)}`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      for (const o of j.results || []) {
        if (o.decimalLatitude == null) continue;
        out.push({ lat: round(o.decimalLatitude), lon: round(o.decimalLongitude), sci: sp.sci, year: o.year || "", key: o.key });
      }
      ok++;
    } catch (e) {
      log(`GBIF ${sp.sci}: ошибка — ${e.message}`);
    }
  }
  if (!ok && previous && previous.occ && previous.occ.length) {
    log("GBIF не ответил, оставляю прошлые находки");
    return previous;
  }
  log(`GBIF: ${out.length} находок, ${ok} из ${SPECIES.length} видов`);
  return { updated: new Date().toISOString(), occ: out };
}

/* ---------- 3. Telegram ---------- */
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function alertMessage(a, note) {
  const sp = a.o.sp, f = a.f;
  const level = a.score >= 60 ? "высокий" : a.score >= 30 ? "средний" : "низкий";
  const lines = [
    note ? `<i>${esc(note)}</i>` : null,
    `🔥 <b>Тревога STEPPESHIELD · риск ${a.score} из 100</b> (${level})`,
    ``,
    `<b>${esc(sp.ru)}</b> <i>${esc(sp.sci)}</i>, Красный список МСОП: ${sp.iucn}`,
    `Огонь в <b>${a.d.toFixed(1)} км</b> от места обитания${a.count > 1 ? `, находок вида рядом: ${a.count}` : ""}`,
    `Снимок спутника: ${esc(f.date)} ${esc(f.time)}${f.sat ? ", " + esc(f.sat) : ""}`,
    `Мощность очага: ${f.frp.toFixed(1)} МВт`,
    `Координаты огня: <code>${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}</code>`
  ].filter(x => x !== null);
  const buttons = [[
    { text: "Открыть на карте", url: `${SITE_URL}#map&focus=${f.lat.toFixed(4)},${f.lon.toFixed(4)}` },
    { text: "Маршрут к огню", url: `https://www.google.com/maps/dir/?api=1&destination=${f.lat.toFixed(5)},${f.lon.toFixed(5)}` }
  ]];
  if (a.o.key) buttons.push([{ text: "Наблюдение вида в GBIF", url: `https://www.gbif.org/occurrence/${a.o.key}` }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: buttons } };
}

async function sendTelegram(msg) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, parse_mode: "HTML", disable_web_page_preview: true, ...msg })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || "HTTP " + r.status);
}

/* ---------- Главное ---------- */
async function main() {
  const now = Date.now();

  // пожары
  const { fires, used } = await loadFires();
  const persist = markPersistent(fires);
  log(`Постоянных источников: ${persist.sites} (точек ${persist.points}), истории ${persist.historyDays} дн.`);
  await writeJson("fires.json", {
    updated: new Date(now).toISOString(),
    source: used.map(s => s.replace("_NRT", "").replace("_", " ")).join(" + "),
    historyDays: HISTORY_DAYS,
    fires: fires.map(f => ({ lat: round(f.lat), lon: round(f.lon), frp: round(f.frp, 1), date: f.date, time: f.time, dn: f.dn, sat: f.sat }))
  });

  // виды
  const species = await loadSpecies(await readJson("species.json", null));
  await writeJson("species.json", species);
  const occ = species.occ.filter(o => BY_SCI[o.sci]).map(o => ({ ...o, sp: BY_SCI[o.sci] }));

  // тревоги по свежим пожарам без факелов
  const fresh = inLastHours(fires, 24, now).filter(f => !f.persistent);
  const { alerts } = computeAlerts(occ, fresh, RADIUS);
  const strong = alerts.filter(a => a.score >= MIN_SCORE);
  log(`Пожаров за 24 ч без факелов: ${fresh.length}; тревог: ${alerts.length}, из них от ${MIN_SCORE}: ${strong.length}`);

  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) { log("Telegram не настроен, пропускаю отправку"); return; }

  const sent = await readJson("sent.json", { keys: {} });
  const weekAgo = now - 7 * 864e5;
  for (const k of Object.keys(sent.keys)) if (Date.parse(sent.keys[k]) < weekAgo) delete sent.keys[k];
  const keyOf = a => `${a.key}|${a.f.date}`;

  let queue = strong.filter(a => !sent.keys[keyOf(a)]).slice(0, MAX_MESSAGES);
  let sentCount = 0;

  if (FORCE && !queue.length) {
    if (alerts.length) {
      await sendTelegram(alertMessage(alerts[0], "Проверка связи: самая опасная тревога прямо сейчас"));
      sentCount++;
    } else {
      await sendTelegram({ text: [
        "<i>Проверка связи STEPPESHIELD</i>",
        "",
        `За последние 24 часа спутники видят ${fresh.length} очагов.`,
        `Рядом с местами обитания редких видов (${RADIUS} км) огня нет.`,
        `Отсеяно постоянных источников, вероятных газовых факелов: ${persist.sites}.`
      ].join("\n"), reply_markup: { inline_keyboard: [[{ text: "Открыть карту", url: SITE_URL + "#map" }]] } });
      sentCount++;
    }
  }
  for (const a of queue) {
    try { await sendTelegram(alertMessage(a)); sent.keys[keyOf(a)] = new Date(now).toISOString(); sentCount++; }
    catch (e) { log("Telegram: ошибка — " + e.message); }
  }
  await writeJson("sent.json", sent);
  log(`Telegram: отправлено сообщений ${sentCount}`);
}

main().catch(e => { console.error("Ошибка: " + e.message); process.exit(1); });
