const fs = require("node:fs/promises");
const path = require("node:path");

const API = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const output = path.join(process.cwd(), "data", "weather.json");
const beaches = {
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

function asKst(date) {
  return `${date.toISOString().slice(0, 19)}+09:00`;
}

function decodeKeyOnce(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function itemList(json) {
  const raw = json?.response?.body?.items?.item;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

// 초단기 실황은 발표 시간에 일정한 지연이 있으므로 45분 전부터 시도한다.
function ultraBase(attempt) {
  const date = koreaNow(-45 - attempt * 60);
  return { date: ymd(date), time: `${String(date.getUTCHours()).padStart(2, "0")}00` };
}

// 동네예보는 발표 시간(02, 05, 08 ... 23시)을 사용한다.
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

async function request(endpoint, beachId, beach, base) {
  console.log(`[Weather] beach=${beachId}`);
  console.log(`[Weather] nx=${beach.nx} ny=${beach.ny}`);
  console.log(`[Weather] endpoint=${endpoint}`);
  console.log(`[Weather] base_date=${base.date}`);
  console.log(`[Weather] base_time=${base.time}`);

  const query = new URLSearchParams({
    pageNo: "1",
    numOfRows: "1000",
    dataType: "JSON",
    base_date: base.date,
    base_time: base.time,
    nx: String(beach.nx),
    ny: String(beach.ny),
  });
  // Encoding Key와 Decoding Key 둘 모두 지원하며 serviceKey만 한 번 인코딩한다.
  const serviceKey = encodeURIComponent(decodeKeyOnce(process.env.KMA_API_KEY));
  const response = await fetch(`${API}/${endpoint}?serviceKey=${serviceKey}&${query}`);
  console.log(`[Weather] HTTP=${response.status}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const json = await response.json();
  const header = json?.response?.header;
  console.log(`[Weather] resultCode=${header?.resultCode ?? "missing"}`);
  console.log(`[Weather] resultMsg=${header?.resultMsg ?? "missing"}`);
  if (header?.resultCode !== "00") {
    throw new Error(`resultCode=${header?.resultCode ?? "missing"}; resultMsg=${header?.resultMsg ?? "missing"}`);
  }

  const items = itemList(json);
  console.log(`[Weather] itemCount=${items.length}`);
  return items;
}

async function retry(endpoint, beachId, beach, getBase) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = getBase(attempt);
    try {
      return { items: await request(endpoint, beachId, beach, base), base };
    } catch (error) {
      lastError = error;
      console.error(`[Weather ERROR] ${beachId} base_time=${base.time} ${error.message}`);
      if (attempt < 2) console.log(`[Weather] retry base_time=${getBase(attempt + 1).time}`);
    }
  }
  return { items: null, base: null, error: lastError };
}

function observedAt(base) {
  return `${base.date.slice(0, 4)}-${base.date.slice(4, 6)}-${base.date.slice(6)}T${base.time.slice(0, 2)}:00+09:00`;
}

function categoryValue(items, category) {
  return items.find((item) => item.category === category)?.obsrValue;
}

async function fetchBeach(id, beach, previous) {
  const currentResult = await retry("getUltraSrtNcst", id, beach, ultraBase);
  let current = null;
  if (currentResult.items) {
    const t1h = categoryValue(currentResult.items, "T1H");
    const reh = categoryValue(currentResult.items, "REH");
    const rn1 = categoryValue(currentResult.items, "RN1");
    const pty = categoryValue(currentResult.items, "PTY");
    const wsd = categoryValue(currentResult.items, "WSD");
    const temperature = numberOrNull(t1h);
    console.log(`[Weather] T1H=${temperature ?? "missing"}`);
    console.log(`[Weather] REH=${reh ?? "missing"}`);
    console.log(`[Weather] RN1=${rn1 ?? "missing"}`);
    console.log(`[Weather] PTY=${pty ?? "missing"}`);
    console.log(`[Weather] WSD=${wsd ?? "missing"}`);

    // 실황 유효성은 T1H와 관측 시각으로만 판정한다. 0은 정상적인 값이다.
    if (temperature !== null) {
      current = {
        temperature,
        humidity: numberOrNull(reh),
        rain1h: numberOrNull(rn1),
        precipitationType: precipitationType(pty),
        windSpeed: numberOrNull(wsd),
        observedAt: observedAt(currentResult.base),
      };
    }
  }

  // 예보 실패는 실황 데이터를 무효화하지 않는다.
  const forecastResult = await retry("getVilageFcst", id, beach, villageBase);
  let forecast = [];
  if (forecastResult.items) {
    const periods = [...new Set(
      forecastResult.items
        .filter((item) => item.category === "TMP")
        .map((item) => `${item.fcstDate}${item.fcstTime}`),
    )].sort().slice(0, 6);
    forecast = periods.map((period) => {
      const value = (category) => forecastResult.items.find(
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

  if (current || forecast.length) {
    return {
      name: beach.name,
      grid: { nx: beach.nx, ny: beach.ny },
      status: current && forecast.length ? "ok" : "partial",
      current,
      forecast,
    };
  }
  if (previous?.current || previous?.forecast?.length) {
    return { ...previous, status: "stale", error: "weather unavailable" };
  }
  return {
    name: beach.name,
    grid: { nx: beach.nx, ny: beach.ny },
    status: "unavailable",
    current: null,
    forecast: [],
    error: "weather unavailable",
  };
}

async function main() {
  if (!process.env.KMA_API_KEY) throw new Error("KMA_API_KEY is missing");

  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(output, "utf8")).beaches || {};
  } catch {
    // 기존 파일이 없으면 현재 API 결과만 사용한다.
  }

  // 먼저 해운대를 진단해 로그에서 실황 응답을 명확히 확인한다.
  const haeundae = await fetchBeach("haeundae", beaches.haeundae, previous.haeundae);
  const rest = await Promise.all(Object.entries(beaches)
    .filter(([id]) => id !== "haeundae")
    .map(async ([id, beach]) => [id, await fetchBeach(id, beach, previous[id])]));
  const entries = [["haeundae", haeundae], ...rest];

  if (!entries.some(([, beach]) => beach.status === "ok" || beach.status === "partial")) {
    throw new Error("KMA API returned no usable weather data; keeping existing weather.json");
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify({
    generatedAt: asKst(koreaNow()),
    beaches: Object.fromEntries(entries),
    source: { name: "\uAE30\uC0C1\uCCAD \uB2E8\uAE30\uC608\uBCF4 \uC870\uD68C\uC11C\uBE44\uC2A4" },
  }, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
