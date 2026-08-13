const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const OUTPUT_PATH = path.join(process.cwd(), "data", "weather.json");
const STATUS_MARKER = "__KMA_HTTP_STATUS__:";
const CURL_ARGS = [
  "-4", "--silent", "--show-error", "--fail-with-body",
  "--connect-timeout", "30", "--max-time", "90",
  "--retry", "3", "--retry-delay", "5", "--retry-all-errors",
  "--write-out", `\\n${STATUS_MARKER}%{http_code}`,
];
const BEACHES = {
  haeundae: { name: "\uD574\uC6B4\uB300\uD574\uC218\uC695\uC7A5", nx: 99, ny: 75 },
  gwangalli: { name: "\uAD11\uC548\uB9AC\uD574\uC218\uC695\uC7A5", nx: 99, ny: 75 },
  songjeong: { name: "\uC1A1\uC815\uD574\uC218\uC695\uC7A5", nx: 100, ny: 76 },
  songdo: { name: "\uC1A1\uB3C4\uD574\uC218\uC695\uC7A5", nx: 97, ny: 73 },
  dadaepo: { name: "\uB2E4\uB300\uD3EC\uD574\uC218\uC695\uC7A5", nx: 96, ny: 73 },
  ilgwang: { name: "\uC77C\uAD11\uD574\uC218\uC695\uC7A5", nx: 101, ny: 78 },
  imrang: { name: "\uC784\uB791\uD574\uC218\uC695\uC7A5", nx: 101, ny: 79 },
};

function koreaNow(offsetMinutes = 0) { return new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetMinutes * 60 * 1000); }
function ymd(date) { return date.toISOString().slice(0, 10).replaceAll("-", ""); }
function kst(date) { return `${date.toISOString().slice(0, 19)}+09:00`; }
function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function decodeKeyOnce(key) { try { return decodeURIComponent(key); } catch { return key; } }
function numberOrNull(value) { if (value === undefined || value === null || value === "") return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function itemsOf(json) { const items = json?.response?.body?.items?.item; return Array.isArray(items) ? items : items ? [items] : []; }
function valueOf(items, category) { return items.find((item) => item.category === category)?.obsrValue; }
function precipitationType(value) { return ["\uC5C6\uC74C", "\uBE44", "\uBE44/\uB208", "\uB208", "\uC18C\uB098\uAE30"][Number(value)] ?? null; }
function skyType(sky, pty) {
  const precipitation = precipitationType(pty);
  if (precipitation && precipitation !== "\uC5C6\uC74C") return precipitation;
  return Number(sky) === 1 ? "\uB9D1\uC74C" : Number(sky) === 3 ? "\uAD6C\uB984 \uB9CE\uC74C" : "\uD750\uB9BC";
}

function ultraBase(attempt) {
  const date = koreaNow(-45 - attempt * 60);
  return { date: ymd(date), time: `${String(date.getUTCHours()).padStart(2, "0")}00` };
}

function villageBase(attempt) {
  const date = koreaNow(-15 - attempt * 180);
  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  let hour = slots.find((slot) => slot <= date.getUTCHours());
  if (hour === undefined) { date.setUTCDate(date.getUTCDate() - 1); hour = 23; }
  return { date: ymd(date), time: `${String(hour).padStart(2, "0")}00` };
}

function buildUrl(endpoint, beach, base, serviceKey) {
  const params = new URLSearchParams({
    // Decoding Key or Encoding Key is accepted; URLSearchParams then performs one encoding pass.
    serviceKey: decodeKeyOnce(serviceKey),
    pageNo: "1", numOfRows: "1000", dataType: "JSON",
    base_date: base.date, base_time: base.time,
    nx: String(beach.nx), ny: String(beach.ny),
  });
  return `${BASE_URL}/${endpoint}?${params.toString()}`;
}

function redact(text, serviceKey) {
  if (!text) return "";
  const rawKey = String(serviceKey);
  const encodedKey = encodeURIComponent(decodeKeyOnce(rawKey));
  return String(text)
    .replaceAll(rawKey, "[REDACTED]")
    .replaceAll(encodedKey, "[REDACTED]")
    .replace(/serviceKey=[^&\s'"\]]+/gi, "serviceKey=[REDACTED]");
}

async function curlJson(url, beachId, serviceKey) {
  console.log("[Weather] curl request attempt=1 (curl retries up to 3 times)");
  try {
    const { stdout, stderr } = await execFileAsync("curl", [...CURL_ARGS, url], {
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    if (stderr?.trim()) console.log(`[Weather] curl notice=${redact(stderr.trim(), serviceKey)}`);
    const markerIndex = stdout.lastIndexOf(STATUS_MARKER);
    if (markerIndex < 0) throw new Error("curl response did not include an HTTP status");
    const body = stdout.slice(0, markerIndex).trim();
    const status = stdout.slice(markerIndex + STATUS_MARKER.length).trim();
    console.log(`[Weather] HTTP=${status}`);
    console.log("[Weather] curl request successful");
    return body;
  } catch (error) {
    // execFile does not echo arguments. Only the sanitized curl diagnostic is exposed.
    const exitCode = typeof error?.code === "number" ? error.code : "unknown";
    console.error(`[Weather ERROR] beach=${beachId}`);
    console.error(`[Weather ERROR] curl exit code=${exitCode}`);
    console.error(`[Weather ERROR] curl stderr=${redact(error?.stderr?.trim() || error?.message || "unknown curl failure", serviceKey)}`);
    throw error;
  }
}

async function requestForBaseTime(endpoint, beachId, beach, baseFactory, serviceKey) {
  let lastNoData;
  for (let baseAttempt = 0; baseAttempt < 3; baseAttempt += 1) {
    const base = baseFactory(baseAttempt);
    const endpointUrl = `${BASE_URL}/${endpoint}`;
    console.log(`[Weather] beach=${beachId}`);
    console.log(`[Weather] nx=${beach.nx} ny=${beach.ny}`);
    console.log(`[Weather] URL endpoint=${endpointUrl}`);
    console.log(`[Weather] params pageNo=1 numOfRows=1000 dataType=JSON base_date=${base.date} base_time=${base.time} nx=${beach.nx} ny=${beach.ny}`);

    let body;
    try {
      body = await curlJson(buildUrl(endpoint, beach, base, serviceKey), beachId, serviceKey);
    } catch (error) {
      // curl has already retried transient connection errors three times at this exact base_time.
      throw error;
    }

    let json;
    try { json = JSON.parse(body); } catch { throw new Error("response was not valid JSON"); }
    const header = json?.response?.header;
    console.log(`[Weather] resultCode=${header?.resultCode ?? "missing"}`);
    console.log(`[Weather] resultMsg=${header?.resultMsg ?? "missing"}`);
    if (header?.resultCode === "00") {
      const items = itemsOf(json);
      console.log(`[Weather] itemCount=${items.length}`);
      return { items, base };
    }

    const noData = header?.resultMsg === "NO_DATA" || header?.resultCode === "03";
    if (!noData) throw new Error(`resultCode=${header?.resultCode ?? "missing"}; resultMsg=${header?.resultMsg ?? "missing"}`);
    lastNoData = new Error(`resultCode=${header.resultCode}; resultMsg=${header.resultMsg}`);
    if (baseAttempt < 2) {
      console.log(`[Weather] NO_DATA; retrying previous base_time=${baseFactory(baseAttempt + 1).time}`);
      await pause(500);
    }
  }
  throw lastNoData;
}

async function fetchCurrent(id, beach, serviceKey, strict = false) {
  try {
    const { items, base } = await requestForBaseTime("getUltraSrtNcst", id, beach, ultraBase, serviceKey);
    const t1h = valueOf(items, "T1H"), reh = valueOf(items, "REH"), rn1 = valueOf(items, "RN1"), pty = valueOf(items, "PTY"), wsd = valueOf(items, "WSD");
    const temperature = numberOrNull(t1h);
    console.log(`[Weather] T1H=${temperature ?? "missing"}`);
    console.log(`[Weather] REH=${reh ?? "missing"}`);
    console.log(`[Weather] RN1=${rn1 ?? "missing"}`);
    console.log(`[Weather] PTY=${pty ?? "missing"}`);
    console.log(`[Weather] WSD=${wsd ?? "missing"}`);
    if (temperature === null) return null;
    return { temperature, humidity: numberOrNull(reh), rain1h: numberOrNull(rn1), precipitationType: precipitationType(pty), windSpeed: numberOrNull(wsd), observedAt: `${base.date.slice(0, 4)}-${base.date.slice(4, 6)}-${base.date.slice(6)}T${base.time.slice(0, 2)}:00+09:00` };
  } catch (error) {
    console.error(`[Weather ERROR] current data unavailable for beach=${id}: ${error.message}`);
    if (strict) throw error;
    return null;
  }
}

async function fetchForecast(id, beach, serviceKey) {
  try {
    const { items } = await requestForBaseTime("getVilageFcst", id, beach, villageBase, serviceKey);
    const periods = [...new Set(items.filter((item) => item.category === "TMP").map((item) => `${item.fcstDate}${item.fcstTime}`))].sort().slice(0, 6);
    return periods.map((period) => {
      const value = (category) => items.find((item) => item.category === category && `${item.fcstDate}${item.fcstTime}` === period)?.fcstValue;
      const temperature = numberOrNull(value("TMP"));
      return temperature === null ? null : { date: period.slice(0, 8), time: period.slice(8), temperature, rainProbability: numberOrNull(value("POP")), sky: skyType(value("SKY"), value("PTY")), precipitationType: precipitationType(value("PTY")) };
    }).filter(Boolean);
  } catch (error) {
    console.error(`[Weather ERROR] forecast data unavailable for beach=${id}: ${error.message}`);
    return [];
  }
}

function beachData(beach, previous, current, forecast) {
  if (current || forecast.length) return { name: beach.name, grid: { nx: beach.nx, ny: beach.ny }, status: current && forecast.length ? "ok" : "partial", current, forecast };
  if (previous?.current || previous?.forecast?.length) return { ...previous, status: "stale", error: "weather unavailable" };
  return { name: beach.name, grid: { nx: beach.nx, ny: beach.ny }, status: "unavailable", current: null, forecast: [], error: "weather unavailable" };
}

async function main() {
  const serviceKey = process.env.KMA_API_KEY;
  if (!serviceKey) throw new Error("KMA_API_KEY is missing");
  console.log(`[Weather] KMA_API_KEY present=${Boolean(serviceKey)}`);
  console.log(`[Weather] KMA_API_KEY length=${serviceKey.length}`);

  let previous = {};
  try { previous = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8")).beaches || {}; } catch { /* no existing cache */ }

  // Test only Haeundae first. A curl connection failure exits without replacing the prior real file.
  const haeundaeCurrent = await fetchCurrent("haeundae", BEACHES.haeundae, serviceKey, true);
  if (!haeundaeCurrent) throw new Error("Haeundae current-weather diagnostic returned no T1H; keeping existing weather.json");

  // Sequentially request each distinct grid. Haeundae and Gwangalli share (99,75).
  const grids = new Map();
  for (const [id, beach] of Object.entries(BEACHES)) {
    const gridKey = `${beach.nx},${beach.ny}`;
    if (grids.has(gridKey)) continue;
    const current = id === "haeundae" ? haeundaeCurrent : await fetchCurrent(id, beach, serviceKey);
    const forecast = await fetchForecast(id, beach, serviceKey);
    grids.set(gridKey, { current, forecast });
  }

  const entries = Object.entries(BEACHES).map(([id, beach]) => {
    const result = grids.get(`${beach.nx},${beach.ny}`);
    return [id, beachData(beach, previous[id], result.current, result.forecast)];
  });
  if (!entries.some(([, beach]) => beach.status === "ok" || beach.status === "partial")) throw new Error("KMA API returned no usable weather data; keeping existing weather.json");

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify({ generatedAt: kst(koreaNow()), beaches: Object.fromEntries(entries), source: { name: "\uAE30\uC0C1\uCCAD \uB2E8\uAE30\uC608\uBCF4 \uC870\uD68C\uC11C\uBE44\uC2A4" } }, null, 2)}\n`, "utf8");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
