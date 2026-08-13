const fs = require("node:fs/promises");
const path = require("node:path");

const API = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const output = path.join(process.cwd(), "data", "weather.json");
const beaches = {
  haeundae: { name: "해운대해수욕장", nx: 99, ny: 75 },
  gwangalli: { name: "광안리해수욕장", nx: 99, ny: 75 },
  songjeong: { name: "송정해수욕장", nx: 100, ny: 76 },
  songdo: { name: "송도해수욕장", nx: 97, ny: 73 },
  dadaepo: { name: "다대포해수욕장", nx: 96, ny: 73 },
  ilgwang: { name: "일광해수욕장", nx: 101, ny: 78 },
  imrang: { name: "임랑해수욕장", nx: 101, ny: 79 }
};

function koreaDate(offsetMinutes = 0) {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetMinutes * 60 * 1000);
}
function ymd(date) { return date.toISOString().slice(0, 10).replaceAll("-", ""); }
function isoKst(date) { return `${date.toISOString().slice(0, 19)}+09:00`; }
function ultraBase(offsetHours = 0) {
  const date = koreaDate(-45 - offsetHours * 60);
  return { date: ymd(date), time: `${String(date.getUTCHours()).padStart(2, "0")}00` };
}
function villageBase(offsetSlots = 0) {
  const date = koreaDate(-15 - offsetSlots * 3 * 60);
  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  let hour = slots.find((value) => value <= date.getUTCHours());
  if (hour === undefined) { date.setUTCDate(date.getUTCDate() - 1); hour = 23; }
  return { date: ymd(date), time: `${String(hour).padStart(2, "0")}00` };
}
function condition(sky, pty) {
  const precipitation = Number(pty);
  if (precipitation === 1 || precipitation === 4) return "비";
  if (precipitation === 2 || precipitation === 3) return "눈";
  if (Number(sky) === 1) return "맑음";
  if (Number(sky) === 3) return "구름많음";
  return "흐림";
}
function precipitationType(value) {
  return ["없음", "비", "비/눈", "눈", "소나기"][Number(value)] ?? "정보 미제공";
}
async function request(endpoint, base, beach) {
  const query = new URLSearchParams({ pageNo: "1", numOfRows: "1000", dataType: "JSON", base_date: base.date, base_time: base.time, nx: String(beach.nx), ny: String(beach.ny) });
  const response = await fetch(`${API}/${endpoint}?serviceKey=${process.env.KMA_API_KEY}&${query}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  const header = json?.response?.header;
  const items = json?.response?.body?.items?.item;
  if (header?.resultCode !== "00" || !Array.isArray(items)) throw new Error(header?.resultMsg || "weather unavailable");
  return items;
}
async function withRetry(endpoint, beach, baseForAttempt) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return { items: await request(endpoint, baseForAttempt(attempt), beach), base: baseForAttempt(attempt) }; }
    catch (error) { lastError = error; }
  }
  throw lastError;
}
function value(items, category) { return items.find((item) => item.category === category)?.obsrValue; }
async function fetchBeach(id, beach, previous) {
  console.log(`Fetching ${beach.name} weather...`);
  try {
    const currentResult = await withRetry("getUltraSrtNcst", beach, ultraBase);
    console.log("Current weather OK");
    const currentItems = currentResult.items;
    const temperature = Number(value(currentItems, "T1H"));
    if (!Number.isFinite(temperature)) throw new Error("T1H unavailable");
    const forecastResult = await withRetry("getVilageFcst", beach, villageBase);
    console.log("Forecast OK");
    const forecastItems = forecastResult.items;
    const periods = [...new Set(forecastItems.filter((item) => item.category === "TMP").map((item) => `${item.fcstDate}${item.fcstTime}`))].sort().slice(0, 6);
    const forecast = periods.map((period) => {
      const get = (category) => forecastItems.find((item) => item.category === category && `${item.fcstDate}${item.fcstTime}` === period)?.fcstValue;
      const temp = Number(get("TMP"));
      if (!Number.isFinite(temp)) return null;
      const pop = Number(get("POP"));
      return { date: period.slice(0, 8), time: period.slice(8, 12), temperature: temp, rainProbability: Number.isFinite(pop) ? pop : null, sky: condition(get("SKY"), get("PTY")), precipitationType: precipitationType(get("PTY")) };
    }).filter(Boolean);
    return { name: beach.name, grid: { nx: beach.nx, ny: beach.ny }, status: "ok", current: { temperature, humidity: numberOrNull(value(currentItems, "REH")), rain1h: numberOrNull(value(currentItems, "RN1")), precipitationType: precipitationType(value(currentItems, "PTY")), windSpeed: numberOrNull(value(currentItems, "WSD")), observedAt: `${currentResult.base.date.slice(0, 4)}-${currentResult.base.date.slice(4, 6)}-${currentResult.base.date.slice(6)}T${currentResult.base.time.slice(0, 2)}:00+09:00` }, forecast };
  } catch (error) {
    if (previous && (previous.status === "ok" || previous.status === "stale") && previous.current) return { ...previous, status: "stale", error: "weather unavailable" };
    return { name: beach.name, grid: { nx: beach.nx, ny: beach.ny }, status: "unavailable", current: null, forecast: [], error: "weather unavailable" };
  }
}
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
async function main() {
  if (!process.env.KMA_API_KEY) throw new Error("KMA_API_KEY is required");
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(output, "utf8")).beaches || {}; } catch { /* no prior data */ }
  const entries = await Promise.all(Object.entries(beaches).map(async ([id, beach]) => [id, await fetchBeach(id, beach, previous[id])]));
  if (!entries.some(([, beach]) => beach.status === "ok")) {
    throw new Error("KMA API returned no current weather data; keeping existing weather.json");
  }
  const data = { generatedAt: isoKst(koreaDate()), beaches: Object.fromEntries(entries), source: { name: "기상청 단기예보 조회서비스" } };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
main().catch((error) => { console.error(error.message); process.exit(1); });
