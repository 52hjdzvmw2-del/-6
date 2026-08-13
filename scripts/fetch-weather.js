const fs = require("node:fs/promises");
const path = require("node:path");

const BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const OUTPUT_PATH = path.join(process.cwd(), "data", "weather.json");
const BEACHES = {
  haeundae: { name: "\uD574\uC6B4\uB300\uD574\uC218\uC695\uC7A5", nx: 99, ny: 75 },
  gwangalli: { name: "\uAD11\uC548\uB9AC\uD574\uC218\uC695\uC7A5", nx: 99, ny: 75 },
  songjeong: { name: "\uC1A1\uC815\uD574\uC218\uC695\uC7A5", nx: 100, ny: 76 },
  songdo: { name: "\uC1A1\uB3C4\uD574\uC218\uC695\uC7A5", nx: 97, ny: 73 },
  dadaepo: { name: "\uB2E4\uB300\uD3EC\uD574\uC218\uC695\uC7A5", nx: 96, ny: 73 },
  ilgwang: { name: "\uC77C\uAD11\uD574\uC218\uC695\uC7A5", nx: 101, ny: 78 },
  imrang: { name: "\uC784\uB791\uD574\uC218\uC695\uC7A5", nx: 101, ny: 79 },
};

function koreaNow(offsetMinutes = 0) {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetMinutes * 60 * 1000);
}

function ymd(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function toKstString(date) {
  return `${date.toISOString().slice(0, 19)}+09:00`;
}

function decodeKeyOnce(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function asItems(json) {
  const items = json?.response?.body?.items?.item;
  return Array.isArray(items) ? items : items ? [items] : [];
}

function ultraBase(attempt) {
  const date = koreaNow(-45 - attempt * 60);
  return { date: ymd(date), time: `${String(date.getUTCHours()).padStart(2, "0")}00` };
}

function villageBase(attempt) {
  const date = koreaNow(-15 - attempt * 180);
  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  let hour = slots.find((slot) => slot <= date.getUTCHours());
  if (hour === undefined) {
    date.setUTCDate(date.getUTCDate() - 1);
    hour = 23;
  }
  return { date: ymd(date), time: `${String(hour).padStart(2, "0")}00` };
}

function precipitationType(value) {
  return ["\uC5C6\uC74C", "\uBE44", "\uBE44/\uB208", "\uB208", "\uC18C\uB098\uAE30"][Number(value)] ?? null;
}

function skyType(sky, pty) {
  const precipitation = precipitationType(pty);
  if (precipitation && precipitation !== "\uC5C6\uC74C") return precipitation;
  if (Number(sky) === 1) return "\uB9D1\uC74C";
  if (Number(sky) === 3) return "\uAD6C\uB984 \uB9CE\uC74C";
  return "\uD750\uB9BC";
}

function safeParameters(base, beach, serviceKey) {
  return new URLSearchParams({
    serviceKey: decodeKeyOnce(serviceKey),
    pageNo: "1",
    numOfRows: "1000",
    dataType: "JSON",
    base_date: base.date,
    base_time: base.time,
    nx: String(beach.nx),
    ny: String(beach.ny),
  });
}

async function request(endpoint, beachId, beach, base, serviceKey) {
  const endpointUrl = `${BASE_URL}/${endpoint}`;
  const params = safeParameters(base, beach, serviceKey);
  console.log(`[Weather] beach=${beachId}`);
  console.log(`[Weather] nx=${beach.nx} ny=${beach.ny}`);
  console.log(`[Weather] URL endpoint=${endpointUrl}`);
  console.log(`[Weather] params pageNo=1 numOfRows=1000 dataType=JSON base_date=${base.date} base_time=${base.time} nx=${beach.nx} ny=${beach.ny}`);

  let response;
  try {
    response = await fetch(`${endpointUrl}?${params.toString()}`);
  } catch (error) {
    // Do not print the full URL: it would include the secret serviceKey.
    console.error(`[Weather ERROR] beach=${beachId}`);
    console.error(`[Weather ERROR] name=${error?.name ?? "unknown"}`);
    console.error(`[Weather ERROR] message=${error?.message ?? "unknown"}`);
    if (error?.cause) {
      console.error(`[Weather ERROR] causeCode=${error.cause.code ?? "none"}`);
      console.error(`[Weather ERROR] causeMessage=${error.cause.message ?? "none"}`);
    }
    throw error;
  }

  console.log(`[Weather] HTTP=${response.status}`);
  console.log(`[Weather] content-type=${response.headers.get("content-type") ?? "missing"}`);
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("response was not valid JSON");
  }

  const header = json?.response?.header;
  console.log(`[Weather] resultCode=${header?.resultCode ?? "missing"}`);
  console.log(`[Weather] resultMsg=${header?.resultMsg ?? "missing"}`);
  if (header?.resultCode !== "00") {
    throw new Error(`resultCode=${header?.resultCode ?? "missing"}; resultMsg=${header?.resultMsg ?? "missing"}`);
  }

  const items = asItems(json);
  console.log(`[Weather] itemCount=${items.length}`);
  return items;
}

async function retry(endpoint, beachId, beach, baseFactory, serviceKey) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = baseFactory(attempt);
    try {
      return { items: await request(endpoint, beachId, beach, base, serviceKey), base };
    } catch (error) {
      lastError = error;
      console.error(`[Weather ERROR] beach=${beachId} base_time=${base.time} request failed`);
      if (attempt < 2) console.log(`[Weather] retry base_time=${baseFactory(attempt + 1).time}`);
    }
  }
  return { items: null, base: null, error: lastError };
}

function observedAt(base) {
  return `${base.date.slice(0, 4)}-${base.date.slice(4, 6)}-${base.date.slice(6)}T${base.time.slice(0, 2)}:00+09:00`;
}

function currentValue(items, category) {
  return items.find((item) => item.category === category)?.obsrValue;
}

async function fetchCurrent(id, beach, serviceKey) {
  const response = await retry("getUltraSrtNcst", id, beach, ultraBase, serviceKey);
  if (!response.items) return null;

  const t1h = currentValue(response.items, "T1H");
  const reh = currentValue(response.items, "REH");
  const rn1 = currentValue(response.items, "RN1");
  const pty = currentValue(response.items, "PTY");
  const wsd = currentValue(response.items, "WSD");
  const temperature = numberOrNull(t1h);
  console.log(`[Weather] T1H=${temperature ?? "missing"}`);
  console.log(`[Weather] REH=${reh ?? "missing"}`);
  console.log(`[Weather] RN1=${rn1 ?? "missing"}`);
  console.log(`[Weather] PTY=${pty ?? "missing"}`);
  console.log(`[Weather] WSD=${wsd ?? "missing"}`);

  if (temperature === null) return null;
  return {
    temperature,
    humidity: numberOrNull(reh),
    rain1h: numberOrNull(rn1),
    precipitationType: precipitationType(pty),
    windSpeed: numberOrNull(wsd),
    observedAt: observedAt(response.base),
  };
}

async function fetchForecast(id, beach, serviceKey) {
  const response = await retry("getVilageFcst", id, beach, villageBase, serviceKey);
  if (!response.items) return [];
  const periods = [...new Set(response.items
    .filter((item) => item.category === "TMP")
    .map((item) => `${item.fcstDate}${item.fcstTime}`))].sort().slice(0, 6);

  return periods.map((period) => {
    const value = (category) => response.items.find(
      (item) => item.category === category && `${item.fcstDate}${item.fcstTime}` === period,
    )?.fcstValue;
    const temperature = numberOrNull(value("TMP"));
    if (temperature === null) return null;
    return {
      date: period.slice(0, 8),
      time: period.slice(8),
      temperature,
      rainProbability: numberOrNull(value("POP")),
      sky: skyType(value("SKY"), value("PTY")),
      precipitationType: precipitationType(value("PTY")),
    };
  }).filter(Boolean);
}

async function fetchBeach(id, beach, previous, serviceKey, currentAlreadyFetched = null) {
  const current = currentAlreadyFetched ?? await fetchCurrent(id, beach, serviceKey);
  const forecast = await fetchForecast(id, beach, serviceKey);
  if (current || forecast.length) {
    return {
      name: beach.name,
      grid: { nx: beach.nx, ny: beach.ny },
      status: current && forecast.length ? "ok" : "partial",
      current,
      forecast,
    };
  }
  if (previous?.current || previous?.forecast?.length) return { ...previous, status: "stale", error: "weather unavailable" };
  return { name: beach.name, grid: { nx: beach.nx, ny: beach.ny }, status: "unavailable", current: null, forecast: [], error: "weather unavailable" };
}

async function main() {
  const serviceKey = process.env.KMA_API_KEY;
  if (!serviceKey) throw new Error("KMA_API_KEY is missing");
  console.log(`[Weather] KMA_API_KEY present=${Boolean(serviceKey)}`);
  console.log(`[Weather] KMA_API_KEY length=${serviceKey.length}`);

  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8")).beaches || {};
  } catch {
    // No existing cache is safe; do not create a fake replacement if requests fail.
  }

  // Diagnose a single real request first. If it cannot reach the API, do not obscure its cause with 13 more failures.
  const haeundaeCurrent = await fetchCurrent("haeundae", BEACHES.haeundae, serviceKey);
  if (!haeundaeCurrent) throw new Error("Haeundae current-weather diagnostic failed; keeping existing weather.json");

  const haeundae = await fetchBeach("haeundae", BEACHES.haeundae, previous.haeundae, serviceKey, haeundaeCurrent);
  const rest = await Promise.all(Object.entries(BEACHES)
    .filter(([id]) => id !== "haeundae")
    .map(async ([id, beach]) => [id, await fetchBeach(id, beach, previous[id], serviceKey)]));
  const entries = [["haeundae", haeundae], ...rest];

  if (!entries.some(([, beach]) => beach.status === "ok" || beach.status === "partial")) {
    throw new Error("KMA API returned no usable weather data; keeping existing weather.json");
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify({
    generatedAt: toKstString(koreaNow()),
    beaches: Object.fromEntries(entries),
    source: { name: "\uAE30\uC0C1\uCCAD \uB2E8\uAE30\uC608\uBCF4 \uC870\uD68C\uC11C\uBE44\uC2A4" },
  }, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
