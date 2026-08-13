const fs = require("node:fs/promises");
const path = require("node:path");

const API = "https://apis.data.go.kr/B552587/ParkingInfoService_v2/getParkingInfoList_v2";
const output = path.join(process.cwd(), "data", "parking.json");
const beaches = {
  haeundae: { name: "해운대해수욕장", codes: ["A36", "A25", "A17", "A18", "A24", "A41", "A50"], primaryCode: "A36" },
  gwangalli: { name: "광안리해수욕장", codes: ["A23"], primaryCode: "A23" },
  songjeong: { name: "송정해수욕장", codes: [], primaryCode: null },
  songdo: { name: "송도해수욕장", codes: [], primaryCode: null },
  dadaepo: { name: "다대포해수욕장", codes: [], primaryCode: null },
  ilgwang: { name: "일광해수욕장", codes: [], primaryCode: null },
  imrang: { name: "임랑해수욕장", codes: [], primaryCode: null }
};
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function nowKst() { return `${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 19)}+09:00`; }
function itemsOf(json) { const items = json?.response?.body?.items?.item; return Array.isArray(items) ? items : items ? [items] : []; }
function toLot(item, expectedCode) {
  const code = item?.parkcd ? String(item.parkcd) : expectedCode;
  const name = item?.parknm ? String(item.parknm) : null;
  const total = numberOrNull(item?.maxcnt);
  const occupied = numberOrNull(item?.curvacnt);
  const available = numberOrNull(item?.parkingcnt);
  if (!name || total === null || occupied === null || available === null || total <= 0 || available < 0) return null;
  return { code, name, total, occupied, available, updatedAt: item?.lastupdatetime ? String(item.lastupdatetime) : null };
}
async function fetchCode(code) {
  const query = new URLSearchParams({ serviceKey: process.env.PARKING_API_KEY, pageNo: "1", numOfRows: "10", pParkGCd: code, resultType: "json" });
  const response = await fetch(`${API}?${query}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json?.response?.header?.resultCode !== "00") throw new Error(json?.response?.header?.resultMsg || "parking unavailable");
  const item = itemsOf(json).find((value) => String(value.parkcd || "") === code) || itemsOf(json)[0];
  return toLot(item, code);
}
async function fetchBeach(config) {
  if (!config.codes.length) return { name: config.name, status: "unavailable", primary: null, parkingLots: [], error: "실시간 주차정보 제공 주차장 미확인" };
  const attempts = await Promise.all(config.codes.map(async (code) => { try { console.log(`Fetching parking ${code}...`); return await fetchCode(code); } catch { return null; } }));
  const parkingLots = attempts.filter(Boolean);
  if (!parkingLots.length) return { name: config.name, status: "unavailable", primary: null, parkingLots: [], error: "실시간 주차 정보 미제공" };
  const primary = parkingLots.find((lot) => lot.code === config.primaryCode) || parkingLots[0];
  return { name: config.name, status: "ok", primary, parkingLots };
}
async function main() {
  if (!process.env.PARKING_API_KEY) throw new Error("PARKING_API_KEY is required");
  const entries = await Promise.all(Object.entries(beaches).map(async ([id, config]) => [id, await fetchBeach(config)]));
  if (!entries.some(([, beach]) => beach.status === "ok")) {
    throw new Error("Parking API returned no live parking data; keeping existing parking.json");
  }
  const data = { generatedAt: nowKst(), beaches: Object.fromEntries(entries), source: { name: "부산시설공단 공영주차장 실시간 주차현황" } };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
main().catch((error) => { console.error(error.message); process.exit(1); });
