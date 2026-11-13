import os
import sys
import io
import csv
import json
import math
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timedelta, timezone
from html import escape

BBOX = (46.4, 40.5, 87.4, 55.5)
SITE = "https://dkktqqyvpx-ops.github.io/STEPPESHIELD/#map"
RADIUS_KM = 50
MIN_SCORE = 30
MAX_ALERTS = 8
FLARE_MIN_DATES = 3
FIRE_AGE_HOURS = 24
SENT_KEEP_DAYS = 7
SENT_FILE = "sent.json"
FLARES_FILE = "flares.json"
SPECIES_FILE = "species.json"
FIRE_SOURCES = ("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT")

SPECIES = [
    {"sci": "Vanellus gregarius", "ru": "Кречётка", "iucn": "CR"},
    {"sci": "Falco cherrug", "ru": "Балобан", "iucn": "EN"},
    {"sci": "Aquila nipalensis", "ru": "Степной орёл", "iucn": "EN"},
    {"sci": "Otis tarda", "ru": "Дрофа", "iucn": "VU"},
    {"sci": "Chlamydotis macqueenii", "ru": "Дрофа-красотка", "iucn": "VU"},
    {"sci": "Aquila heliaca", "ru": "Могильник", "iucn": "VU"},
    {"sci": "Tetrax tetrax", "ru": "Стрепет", "iucn": "NT"},
    {"sci": "Circus macrourus", "ru": "Степной лунь", "iucn": "NT"},
    {"sci": "Saiga tatarica", "ru": "Сайгак", "iucn": "NT"},
]
WEIGHT = {"CR": 5, "EN": 4, "VU": 3, "NT": 2}


def rnd(x):
    return math.floor(x + 0.5)


def cell_key(lat, lon):
    return f"{rnd(lat * 100)}|{rnd(lon * 100)}"


def load_env(path=".env"):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def http_get(url, timeout=120):
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as ex:
            last = ex
            time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"нет ответа от {url.split('?')[0][:60]}: {last}")


def haversine(a, b, c, d):
    r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def fetch_fires(key):
    fires = []
    errors = []
    for source in FIRE_SOURCES:
        try:
            fires += fetch_source(key, source)
        except RuntimeError as ex:
            errors.append(f"{source}: {ex}")
    if errors:
        print("Предупреждения FIRMS:", "; ".join(errors))
    if not fires and errors:
        raise RuntimeError("FIRMS не вернул данные")
    return fires


def fetch_source(key, source):
    w, s, e, n = BBOX
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{w},{s},{e},{n}/3"
    text = http_get(url).strip()
    if "latitude" not in text.split("\n", 1)[0].lower():
        raise RuntimeError("FIRMS: " + (text[:200] or "пустой ответ"))
    fires = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            if lat < s or lat > n or lon < w or lon > e:
                continue
            conf = (row.get("confidence") or "").strip().lower()
            if conf in ("l", "low"):
                continue
            if conf.isdigit() and int(conf) < 30:
                continue
            t = (row.get("acq_time") or "0").strip().zfill(4)
            when = datetime.strptime(f"{row['acq_date']} {t}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
            frp = float(row.get("frp") or 0)
        except (ValueError, KeyError):
            continue
        fires.append({"lat": lat, "lon": lon, "frp": frp, "when": when, "flare": False})
    return fires


def load_flare_cells():
    if not os.path.exists(FLARES_FILE):
        print("flares.json не найден, работает только правило повторов")
        return set()
    with open(FLARES_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return {cell_key(la, lo) for la, lo in data.get("cells", [])}


def near_flare_cell(cells, lat, lon):
    i = rnd(lat * 100)
    j = rnd(lon * 100)
    for a in (-1, 0, 1):
        for b in (-1, 0, 1):
            if f"{i + a}|{j + b}" in cells:
                return True
    return False


def mark_flares(fires, cells):
    dates = {}
    for f in fires:
        dates.setdefault(cell_key(f["lat"], f["lon"]), set()).add(f["when"].date())
    for f in fires:
        f["flare"] = near_flare_cell(cells, f["lat"], f["lon"]) or len(dates[cell_key(f["lat"], f["lon"])]) >= FLARE_MIN_DATES


def load_species_file():
    if not os.path.exists(SPECIES_FILE):
        return []
    try:
        with open(SPECIES_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (ValueError, OSError):
        return []
    occ = []
    for row in data.get("occ", []):
        if len(row) < 3 or not 0 <= row[2] < len(SPECIES):
            continue
        occ.append({"lat": row[0], "lon": row[1], "sp": SPECIES[row[2]]})
    return occ


def fetch_species():
    occ = load_species_file()
    if occ:
        print(f"Виды взяты из {SPECIES_FILE}")
        return occ
    year = datetime.now(timezone.utc).year
    for sp in SPECIES:
        q = urllib.parse.urlencode({
            "country": "KZ",
            "hasCoordinate": "true",
            "hasGeospatialIssue": "false",
            "year": f"2000,{year}",
            "limit": 300,
            "scientificName": sp["sci"],
        })
        try:
            data = json.loads(http_get("https://api.gbif.org/v1/occurrence/search?" + q))
        except Exception as ex:
            print(f"GBIF, {sp['sci']}: {ex}")
            continue
        for o in data.get("results", []):
            la = o.get("decimalLatitude")
            lo = o.get("decimalLongitude")
            if la is None or lo is None:
                continue
            occ.append({"lat": la, "lon": lo, "sp": sp})
    return occ


def compute_alerts(fires, occ):
    cells = {}
    dlat = RADIUS_KM / 111
    for o in occ:
        dlon = RADIUS_KM / (111 * max(0.1, math.cos(math.radians(o["lat"]))))
        best = None
        bd = float("inf")
        for f in fires:
            if abs(f["lat"] - o["lat"]) > dlat or abs(f["lon"] - o["lon"]) > dlon:
                continue
            d = haversine(o["lat"], o["lon"], f["lat"], f["lon"])
            if d < bd:
                bd = d
                best = f
        if best is None or bd > RADIUS_KM:
            continue
        score = int(WEIGHT[o["sp"]["iucn"]] * (1 - bd / RADIUS_KM) * 20 + 0.5)
        key = f"{o['sp']['sci']}|{rnd(o['lat'] * 2)}|{rnd(o['lon'] * 2)}"
        prev = cells.get(key)
        if prev is None or score > prev["score"]:
            cells[key] = {"key": key, "o": o, "f": best, "d": bd, "score": score}
    return sorted(cells.values(), key=lambda a: -a["score"])


def alert_id(a):
    f = a["f"]
    return f"{a['key']}|{f['lat']:.3f},{f['lon']:.3f}|{f['when']:%Y-%m-%d}"


def load_sent():
    if not os.path.exists(SENT_FILE):
        return {}
    try:
        with open(SENT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return {}


def save_sent(sent):
    edge = (datetime.now(timezone.utc) - timedelta(days=SENT_KEEP_DAYS)).isoformat()
    keep = {k: v for k, v in sent.items() if v >= edge}
    with open(SENT_FILE, "w", encoding="utf-8") as f:
        json.dump(keep, f, ensure_ascii=False, indent=1)


def build_message(alerts):
    lines = [f"🔥 <b>STEPPESHIELD: новые тревоги ({len(alerts)})</b>", ""]
    for i, a in enumerate(alerts, 1):
        o = a["o"]
        f = a["f"]
        osm = f"https://www.openstreetmap.org/?mlat={o['lat']:.5f}&mlon={o['lon']:.5f}#map=10/{o['lat']:.5f}/{o['lon']:.5f}"
        red = f"https://www.iucnredlist.org/search?query={urllib.parse.quote(o['sp']['sci'])}&amp;searchType=species"
        lines.append(f"{i}. <b>{escape(o['sp']['ru'])}</b> (<a href=\"{red}\">МСОП: {o['sp']['iucn']}</a>), риск {a['score']} из 100")
        lines.append(f"Огонь в {a['d']:.1f} км, {f['when']:%d.%m %H:%M} UTC, мощность {f['frp']:.0f} МВт")
        lines.append(f"Место обитания: <a href=\"{osm}\">{o['lat']:.3f}, {o['lon']:.3f}</a>")
        lines.append("")
    lines.append(f"<a href=\"{SITE}\">Открыть карту тревог</a>")
    return "\n".join(lines)


def send(token, chat, text):
    data = urllib.parse.urlencode({
        "chat_id": chat,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as ex:
        raise RuntimeError(f"Telegram ответил {ex.code}: {ex.read().decode(errors='replace')[:300]}")


def main():
    load_env()
    token = os.environ.get("TELEGRAM_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT", "").strip()
    key = os.environ.get("FIRMS_KEY", "").strip()
    dry = "--dry" in sys.argv

    if "--test" in sys.argv:
        if not token or not chat:
            sys.exit("Нужны TELEGRAM_TOKEN и TELEGRAM_CHAT")
        send(token, chat, "✅ STEPPESHIELD: бот подключён к каналу")
        print("Тестовое сообщение отправлено")
        return

    if not key:
        sys.exit("Нужен FIRMS_KEY")
    if not dry and (not token or not chat):
        sys.exit("Нужны TELEGRAM_TOKEN и TELEGRAM_CHAT (или запустите с --dry)")

    fires = fetch_fires(key)
    mark_flares(fires, load_flare_cells())
    edge = datetime.now(timezone.utc) - timedelta(hours=FIRE_AGE_HOURS)
    active = [f for f in fires if not f["flare"] and f["when"] >= edge]
    occ = fetch_species()
    alerts = [a for a in compute_alerts(active, occ) if a["score"] >= MIN_SCORE]
    print(f"Пожаров: {len(fires)}, постоянных источников: {sum(f['flare'] for f in fires)}, свежих без факелов: {len(active)}, находок видов: {len(occ)}, тревог: {len(alerts)}")

    sent = load_sent()
    fresh = [a for a in alerts if alert_id(a) not in sent][:MAX_ALERTS]
    if not fresh:
        print("Новых тревог нет")
        if not dry:
            save_sent(sent)
        return

    text = build_message(fresh)
    if dry:
        print(text)
        return

    send(token, chat, text)
    now = datetime.now(timezone.utc).isoformat()
    for a in fresh:
        sent[alert_id(a)] = now
    save_sent(sent)
    print(f"Отправлено тревог: {len(fresh)}")


if __name__ == "__main__":
    main()