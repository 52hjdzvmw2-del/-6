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

function numberOrNull(value) { const valueAsNumber = Number(value); return Number.isFinite(valueAsNumber) ? valueAsNumber : null; }
function nowKst() { return `${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 19)}+09:00`; }
function decodeKeyOnce(value) { try { return decodeURIComponent(value); } catch { return value; } }
function itemsOf(json) {
  const rawItem = json?.response?.body?.items?.item;
  return Array.isArray(rawItem) ? rawItem : rawItem ? [rawItem] : [];
}
function toLot(item, expectedCode) {
  const code = item?.parkcd != null ? String(item.parkcd) : expectedCode;
  const name = item?.parknm != null ? String(item.parknm) : null;
  const total = numberOrNull(item?.maxcnt);
  const occupied = numberOrNull(item?.curvacnt);
  const available = numberOrNull(item?.parkingcnt);
  if (!name || total === null || occupied === null || available === null || total <= 0 || available < 0) return null;
  return { code, name, total, occupied, available, updatedAt: item?.lastupdatetime != null ? String(item.lastupdatetime) : null };
}
async function fetchCode(code) {
  console.log(`Fetching parking ${code}...`);
  const query = new URLSearchParams({ pageNo: "1", numOfRows: "10", pParkGCd: code, resultType: "json" });
  // Secrets copied from the portal can already be percent-encoded. Decode once,
  // then encode exactly once for the URL; never print this value.
  const serviceKey = encodeURIComponent(decodeKeyOnce(process.env.PARKING_API_KEY));
  const response = await fetch(`${API}?serviceKey=${serviceKey}&${query}`);
  console.log(`[Parking] code=${code} HTTP=${response.status}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  const header = json?.response?.header;
  console.log(`[Parking] code=${code} resultCode=${header?.resultCode ?? "missing"}`);
  console.log(`[Parking] code=${code} resultMsg=${header?.resultMsg ?? "missing"}`);
  if (header?.resultCode !== "00") throw new Error(`resultCode=${header?.resultCode ?? "missing"}; resultMsg=${header?.resultMsg ?? "missing"}`);
  const items = itemsOf(json);
  console.log(`[Parking] code=${code} itemCount=${items.length}`);
  if (!items.length) { console.log(`[Parking] code=${code} returned 0 items`); return null; }
  const item = items.find((entry) => String(entry.parkcd ?? "") === code) ?? items[0];
  console.log(`[Parking] parkcd=${item.parkcd ?? "missing"}`);
  console.log(`[Parking] parknm=${item.parknm ?? "missing"}`);
  console.log(`[Parking] maxcnt=${item.maxcnt ?? "missing"}`);
  console.log(`[Parking] curvacnt=${item.curvacnt ?? "missing"}`);
  console.log(`[Parking] parkingcnt=${item.parkingcnt ?? "missing"}`);
  console.log(`[Parking] lastupdatetime=${item.lastupdatetime ?? "missing"}`);
  const lot = toLot(item, code);
  if (!lot) console.log(`[Parking ERROR] code=${code} response item is missing a required live-data field`);
  return lot;
}
async function attemptCode(code) {
  try { return await fetchCode(code); }
  catch (error) { console.error(`[Parking ERROR] code=${code} ${error.message}`); return null; }
}
async function fetchBeach(config) {
  if (!config.codes.length) return { name: config.name, status: "unavailable", primary: null, parkingLots: [], error: "실시간 주차정보 제공 주차장 미확인" };
  const parkingLots = (await Promise.all(config.codes.map(attemptCode))).filter(Boolean);
  if (!parkingLots.length) return { name: config.name, status: "unavailable", primary: null, parkingLots: [], error: "실시간 주차 정보 미제공" };
  return { name: config.name, status: "ok", primary: parkingLots.find((lot) => lot.code === config.primaryCode) ?? parkingLots[0], parkingLots };
}
async function main() {
  if (!process.env.PARKING_API_KEY) throw new Error("PARKING_API_KEY is required");
  // Diagnostic only: it is never written to parking.json or shown by the site.
  await attemptCode("A01");
  const entries = await Promise.all(Object.entries(beaches).map(async ([id, config]) => [id, await fetchBeach(config)]));
  if (!entries.some(([, beach]) => beach.status === "ok")) throw new Error("Parking API returned no live parking data; keeping existing parking.json");
  const data = { generatedAt: nowKst(), beaches: Object.fromEntries(entries), source: { name: "부산시설공단 공영주차장 실시간 주차현황" } };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
main().catch((error) => { console.error(error.message); process.exit(1); });
