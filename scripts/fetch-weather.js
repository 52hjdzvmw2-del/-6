const fs = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");

const BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const OUTPUT_PATH = path.join(process.cwd(), "data", "weather.json");
// KMA can be slow from a GitHub-hosted runner. This is an overall request limit, not a base_time retry trigger.
const REQUEST_TIMEOUT_MS = 90_000;
const NETWORK_RETRY_DELAYS_MS = [5_000, 10_000];
const NETWORK_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "ABORT_ERR"]);
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
function toKstString(date) { return `${date.toISOString().slice(0, 19)}+09:00`; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function decodeKeyOnce(key) { try { return decodeURIComponent(key); } catch { return key; } }
function numberOrNull(value) { if (value === undefined || value === null || value === "") return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function asItems(json) { const items = json?.response?.body?.items?.item; return Array.isArray(items) ? items : items ? [items] : []; }
function itemValue(items, category) { return items.find((item) => item.category === category)?.obsrValue; }
function errorCode(error) { return error?.cause?.code ?? error?.code; }
function isNetworkError(error) {
  return error?.name === "AbortError"
    || error?.cause?.name === "AbortError"
    || NETWORK_CODES.has(errorCode(error));
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

function precipitationType(value) { return ["\uC5C6\uC74C", "\uBE44", "\uBE44/\uB208", "\uB208", "\uC18C\uB098\uAE30"][Number(value)] ?? null; }
function skyType(sky, pty) {
  const precipitation = precipitationType(pty);
  if (precipitation && precipitation !== "\uC5C6\uC74C") return precipitation;
  return Number(sky) === 1 ? "\uB9D1\uC74C" : Number(sky) === 3 ? "\uAD6C\uB984 \uB9CE\uC74C" : "\uD750\uB9BC";
}

function getResponse(url) {
  // No external undici package is required. The built-in HTTPS client works in the repository without npm install.
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, contentType: response.headers["content-type"] ?? "missing", body }));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const timeoutError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutError.code = "ETIMEDOUT";
      request.destroy(timeoutError);
    });
    request.on("error", reject);
  });
}

function makeUrl(endpoint, beach, base, serviceKey) {
  const params = new URLSearchParams({
    // Decode an Encoding Key once, then URLSearchParams performs exactly one encoding pass.
    serviceKey: decodeKeyOnce(serviceKey),
    pageNo: "1", numOfRows: "1000", dataType: "JSON",
    base_date: base.date, base_time: base.time, nx: String(beach.nx), ny: String(beach.ny),
  });
  return `${BASE_URL}/${endpoint}?${params.toString()}`;
}

async function requestOnce(endpoint, beachId, beach, base, serviceKey, attempt) {
  const endpointUrl = `${BASE_URL}/${endpoint}`;
  console.log(`[Weather] beach=${beachId}`);
  console.log(`[Weather] nx=${beach.nx} ny=${beach.ny}`);
  console.log(`[Weather] URL endpoint=${endpointUrl}`);
  console.log(`[Weather] params pageNo=1 numOfRows=1000 dataType=JSON base_date=${base.date} base_time=${base.time} nx=${beach.nx} ny=${beach.ny}`);
  console.log(`[Weather] request attempt=${attempt}`);

  let response;
  try {
    response = await getResponse(makeUrl(endpoint, beach, base, serviceKey));
  } catch (error) {
    // The full request URL is deliberately never logged because it contains serviceKey.
    console.error(`[Weather ERROR] attempt=${attempt}`);
    console.error(`[Weather ERROR] beach=${beachId}`);
    console.error(`[Weather ERROR] name=${error?.name ?? "unknown"}`);
    console.error(`[Weather ERROR] message=${error?.message ?? "unknown"}`);
    if (error?.cause) {
      console.error(`[Weather ERROR] causeCode=${error.cause.code ?? "none"}`);
      console.error(`[Weather ERROR] causeMessage=${error.cause.message ?? "none"}`);
    } else {
      console.error(`[Weather ERROR] causeCode=${error?.code ?? "none"}`);
      console.error("[Weather ERROR] causeMessage=none");
    }
    throw error;
  }

  console.log(`[Weather] HTTP=${response.status}`);
  console.log(`[Weather] content-type=${response.contentType}`);
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);

  let json;
  try { json = JSON.parse(response.body); } catch { throw new Error("response was not valid JSON"); }
  const header = json?.response?.header;
  console.log(`[Weather] resultCode=${header?.resultCode ?? "missing"}`);
  console.log(`[Weather] resultMsg=${header?.resultMsg ?? "missing"}`);
  if (header?.resultCode !== "00") {
    const error = new Error(`resultCode=${header?.resultCode ?? "missing"}; resultMsg=${header?.resultMsg ?? "missing"}`);
    error.noData = header?.resultMsg === "NO_DATA" || header?.resultCode === "03";
    throw error;
  }
  const items = asItems(json);
  console.log(`[Weather] itemCount=${items.length}`);
  return items;
}

async function requestWithNetworkRetry(endpoint, beachId, beach, base, serviceKey) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await requestOnce(endpoint, beachId, beach, base, serviceKey, attempt); }
    catch (error) {
      if (!isNetworkError(error) || attempt === 3) throw error;
      const wait = NETWORK_RETRY_DELAYS_MS[attempt - 1];
      console.log(`[Weather] retrying in ${wait / 1000}s`);
      await delay(wait);
    }
  }
  throw new Error("unreachable");
}

async function requestForBaseTime(endpoint, beachId, beach, baseFactory, serviceKey) {
  let lastNoData;
  for (let baseAttempt = 0; baseAttempt < 3; baseAttempt += 1) {
    const base = baseFactory(baseAttempt);
    try { return { items: await requestWithNetworkRetry(endpoint, beachId, beach, base, serviceKey), base }; }
    catch (error) {
      if (!error.noData) throw error;
      lastNoData = error;
      if (baseAttempt < 2) console.log(`[Weather] NO_DATA; retrying previous base_time=${baseFactory(baseAttempt + 1).time}`);
    }
  }
  throw lastNoData;
}

function observedAt(base) { return `${base.date.slice(0, 4)}-${base.date.slice(4, 6)}-${base.date.slice(6)}T${base.time.slice(0, 2)}:00+09:00`; }

async function fetchCurrent(id, beach, serviceKey, strict = false) {
  try {
    const response = await requestForBaseTime("getUltraSrtNcst", id, beach, ultraBase, serviceKey);
    const t1h = itemValue(response.items, "T1H");
    const reh = itemValue(response.items, "REH");
    const rn1 = itemValue(response.items, "RN1");
    const pty = itemValue(response.items, "PTY");
    const wsd = itemValue(response.items, "WSD");
    const temperature = numberOrNull(t1h);
    console.log(`[Weather] T1H=${temperature ?? "missing"}`);
    console.log(`[Weather] REH=${reh ?? "missing"}`);
    console.log(`[Weather] RN1=${rn1 ?? "missing"}`);
    console.log(`[Weather] PTY=${pty ?? "missing"}`);
    console.log(`[Weather] WSD=${wsd ?? "missing"}`);
    if (temperature === null) return null;
    return { temperature, humidity: numberOrNull(reh), rain1h: numberOrNull(rn1), precipitationType: precipitationType(pty), windSpeed: numberOrNull(wsd), observedAt: observedAt(response.base) };
  } catch (error) {
    console.error(`[Weather ERROR] current data unavailable for beach=${id}: ${error.message}`);
    if (strict) throw error;
    return null;
  }
}

async function fetchForecast(id, beach, serviceKey) {
  try {
    const response = await requestForBaseTime("getVilageFcst", id, beach, villageBase, serviceKey);
    const periods = [...new Set(response.items.filter((item) => item.category === "TMP").map((item) => `${item.fcstDate}${item.fcstTime}`))].sort().slice(0, 6);
    return periods.map((period) => {
      const value = (category) => response.items.find((item) => item.category === category && `${item.fcstDate}${item.fcstTime}` === period)?.fcstValue;
      const temperature = numberOrNull(value("TMP"));
      return temperature === null ? null : { date: period.slice(0, 8), time: period.slice(8), temperature, rainProbability: numberOrNull(value("POP")), sky: skyType(value("SKY"), value("PTY")), precipitationType: precipitationType(value("PTY")) };
    }).filter(Boolean);
  } catch (error) {
    console.error(`[Weather ERROR] forecast data unavailable for beach=${id}: ${error.message}`);
    return [];
  }
}

function toBeachData(beach, previous, current, forecast) {
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
  try { previous = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8")).beaches || {}; } catch { /* preserve nothing when no cache exists */ }

  // First request is a single Haeundae diagnostic. Network failure stops here and preserves the existing file.
  const firstCurrent = await fetchCurrent("haeundae", BEACHES.haeundae, serviceKey, true);
  if (!firstCurrent) throw new Error("Haeundae current-weather diagnostic returned no T1H; keeping existing weather.json");

  // Fetch every distinct grid sequentially. Haeundae and Gwangalli (99,75) share one API result.
  const gridCache = new Map();
  for (const [id, beach] of Object.entries(BEACHES)) {
    const key = `${beach.nx},${beach.ny}`;
    if (gridCache.has(key)) continue;
    const current = id === "haeundae" ? firstCurrent : await fetchCurrent(id, beach, serviceKey);
    const forecast = await fetchForecast(id, beach, serviceKey);
    gridCache.set(key, { current, forecast });
  }

  const entries = Object.entries(BEACHES).map(([id, beach]) => {
    const grid = gridCache.get(`${beach.nx},${beach.ny}`);
    return [id, toBeachData(beach, previous[id], grid.current, grid.forecast)];
  });
  if (!entries.some(([, beach]) => beach.status === "ok" || beach.status === "partial")) throw new Error("KMA API returned no usable weather data; keeping existing weather.json");

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify({ generatedAt: toKstString(koreaNow()), beaches: Object.fromEntries(entries), source: { name: "\uAE30\uC0C1\uCCAD \uB2E8\uAE30\uC608\uBCF4 \uC870\uD68C\uC11C\uBE44\uC2A4" } }, null, 2)}\n`, "utf8");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
