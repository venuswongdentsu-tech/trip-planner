"use strict";
/* ════════════════════════════════════════════════════════════════
   旅程助手 · app.js  v1
   ─ 行程：日期／開始-結束時間／地點／由上一個地點嘅交通時間／備註
   ─ 航班：航班編號＋日期時間 → 實時狀態（狀態、航廈、閘口／行李帶）＋ 酒店
   ─ 支出：手動輸入 ＋ 上載收據由你自己嘅 AI 辨識（OpenRouter／Mistral／Qwen）
   資料：你自己嘅 GitHub 私有 repo → trip.json / flight-status.json / photos/
   航班狀態：香港機場官方資料，由 Hermes 定時任務寫入 flight-status.json
             （瀏覽器直接呼叫機場網站會被 403，所以一定經後端抓）
   交通時間：OSRM；地點座標：Nominatim（兩者都開放 CORS）
   ════════════════════════════════════════════════════════════════ */

var VERSION = "1.0";
var LS_SET = "trip.settings", LS_DB = "trip.db", LS_PH = "trip.photos";
var F_TRIP = "trip.json", F_STATUS = "flight-status.json";
var DEF_REPO = "venuswongdentsu-tech/trip-planner-data";

var CATS = ["機票", "住宿", "餐飲", "交通", "購物", "觀光娛樂", "通訊", "保險", "手信", "其他"];
var CAT_ALIAS = {
  "機票": "機票", "flight": "機票", "air": "機票", "航空": "機票", "airline": "機票",
  "住宿": "住宿", "hotel": "住宿", "酒店": "住宿", "旅館": "住宿", "hostel": "住宿",
  "餐飲": "餐飲", "飲食": "餐飲", "餐廳": "餐飲", "food": "餐飲", "dining": "餐飲", "cafe": "餐飲",
  "交通": "交通", "transport": "交通", "車費": "交通", "taxi": "交通", "地鐵": "交通", "mtr": "交通",
  "購物": "購物", "shopping": "購物", "超市": "購物", "百貨": "購物",
  "觀光娛樂": "觀光娛樂", "觀光": "觀光娛樂", "娛樂": "觀光娛樂", "門票": "觀光娛樂", "tour": "觀光娛樂", "sightseeing": "觀光娛樂",
  "通訊": "通訊", "電話": "通訊", "sim": "通訊", "roaming": "通訊",
  "保險": "保險", "insurance": "保險",
  "手信": "手信", "手信禮品": "手信", "souvenir": "手信", "gift": "手信",
  "其他": "其他", "other": "其他", "雜項": "其他"
};
var DEF_RATES = {
  HKD: 1, THB: 0.2195, JPY: 0.0525, TWD: 0.25, CNY: 1.09, USD: 7.8, GBP: 10.2,
  EUR: 8.6, SGD: 5.9, AUD: 5.1, KRW: 0.0057, MYR: 1.78, PHP: 0.135, VND: 0.00031,
  IDR: 0.00049, INR: 0.092, AED: 2.12, CHF: 8.9, CAD: 5.6, NZD: 4.7
};
var MODES = { walk: "步行", drive: "車程", transit: "公共交通" };

var PROVIDERS = {
  openrouter: {
    style: "openai", base: "https://openrouter.ai/api/v1",
    model: "thinkingmachines/inkling-small:free", label: "OpenRouter",
    note: "香港可用・支援睇圖・有免費模型（20 次/分、50 次/日）",
    keyUrl: "https://openrouter.ai/keys", visionRx: null
  },
  mistral: {
    style: "openai", base: "https://api.mistral.ai/v1",
    model: "mistral-small-latest", label: "Mistral AI",
    note: "香港可用；要揀支援睇圖嘅型號",
    keyUrl: "https://console.mistral.ai/api-keys",
    visionRx: /pixtral|mistral-(small|medium|large|tiny)-(latest|2\d{3})|magistral-(small|medium)-(latest|2\d{3})|ministral-3-14b/i
  },
  qwen: {
    style: "openai", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-max-latest", label: "Qwen（阿里雲國際版）",
    note: "香港可用・支援睇圖",
    keyUrl: "https://modelstudio.console.alibabacloud.com/",
    visionRx: /-vl|-omni|vl-/i
  },
  custom: {
    style: "openai", base: "", model: "", label: "自訂",
    note: "任何 OpenAI 相容端點；對方必須開放瀏覽器 CORS。",
    keyUrl: null, visionRx: null
  }
};
/* 免費睇圖模型（429 時自動輪替；全部經實測香港可用） */
var FREE_MODELS = [
  "thinkingmachines/inkling-small:free",
  "dots-studio/dots-3-note-preview:free",
  "thinkingmachines/inkling:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
];

var EXP_PROMPT = [
  "你係收據辨識助手。睇圖，抽取資料，只回傳一個 JSON 物件，唔要任何其他文字或 markdown。",
  '格式：{"item":"商店或項目簡稱（中文，盡量短）","date":"YYYY-MM-DD（睇唔到就空字串）",',
  '"amount":總金額數字（冇就 0）,"cur":"ISO 幣別如 THB/HKD/USD/JPY","place":"城市或店名地點（可空）",',
  '"cat":"由以下揀一個：機票/住宿/餐飲/交通/購物/觀光娛樂/通訊/保險/手信/其他","note":"少於40字重點（可空）"}',
  "規則：amount 一定要係最終應付總額（含稅、已扣折扣）；睇唔清楚嘅欄位留空或 0，唔好估；唔要加解釋。"
].join("\n");

/* ── 1. 小工具 ─────────────────────────────────────────────── */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function uid(p) { return (p || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function clampNum(v, lo, hi) { v = parseFloat(v); return isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)); }
function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function todayISO(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addDays(iso, n) { var d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return todayISO(d); }
function dayDiff(a, b) { return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000); }
var WD = ["日", "一", "二", "三", "四", "五", "六"];
function javaDay(iso) { return WD[new Date(iso + "T12:00:00").getDay()]; }
function fmtDay(iso) { var p = String(iso).split("-"); return num(p[1]) + "月" + num(p[2]) + "日"; }
function fmtDayW(iso) { return fmtDay(iso) + "（" + javaDay(iso) + "）"; }
function money(v) { return num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function hhmm(s) { return String(s || "").slice(0, 5); }
function normNo(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function normCat(v) {
  var k = String(v || "").trim().toLowerCase();
  if (CAT_ALIAS[k]) return CAT_ALIAS[k];
  var hit = CATS.filter(function (c) { return c === String(v || "").trim(); })[0];
  return hit || "其他";
}
function rate(cur) {
  cur = String(cur || "HKD").toUpperCase();
  if (DB.trip.rates && DB.trip.rates[cur] != null) return num(DB.trip.rates[cur]);
  if (DEF_RATES[cur] != null) return DEF_RATES[cur];
  return 1;
}
function toHKD(amount, cur) { return num(amount) * rate(cur); }

var _toastT = null;
function toast(msg, isErr) {
  var t = $("toast");
  t.textContent = msg;
  t.className = "toast on" + (isErr ? " err" : "");
  clearTimeout(_toastT);
  _toastT = setTimeout(function () { t.className = "toast"; }, isErr ? 4200 : 2400);
}
function ov(on, txt) {
  try {
    var o = $("ov");
    if (on) { $("ovTxt").textContent = txt || "處理中…"; o.hidden = false; }
    else o.hidden = true;
  } catch (e) { }
}
var _booted = false;
function fitViewport() {
  try {
    var vv = window.visualViewport;
    var h = Math.min(vv ? vv.height : window.innerHeight, window.innerHeight);
    var el = $("app");
    if (el && h > 200) el.style.height = h + "px";
  } catch (e) { }
}

/* ── 2. 本機儲存 ───────────────────────────────────────────── */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

function defaultSettings() {
  var p = PROVIDERS.openrouter;
  return { provider: "openrouter", base: p.base, key: "", model: p.model, repo: DEF_REPO, token: "", ratesTxt: "" };
}
function defaultDB() {
  return {
    v: 1,
    trip: { name: "香港 → 曼谷", start: "2026-11-25", end: "2026-11-29", from: "HKG", to: "BKK", cur: "THB", rates: {} },
    flights: [], hotels: [], itinerary: [], expenses: [], pending: [], places: {}
  };
}
var S = defaultSettings();
var DB = defaultDB();
var STATUS = { updated: "", source: "", range: "", updatedTS: 0, flights: {} };
var UI = { view: "itin", day: "", syncT: 0 };

function loadLocal() {
  try { var j = lsGet(LS_SET); if (j) S = Object.assign(defaultSettings(), JSON.parse(j)); } catch (e) { }
  try { var d = lsGet(LS_DB); if (d) DB = Object.assign(defaultDB(), JSON.parse(d)); } catch (e) { }
  if (!DB.places) DB.places = {};
  if (!DB.pending) DB.pending = [];
  UI.day = DB.trip.start;
}
function saveLocal() { lsSet(LS_SET, JSON.stringify(S)); lsSet(LS_DB, JSON.stringify(DB)); }

/* 收據相片：本機用 dataURL 快取（上限 60 張，超過就掉最舊；
   相片同時會上傳到你嘅私有 repo photos/，所以本機掉咗都翻得返） */
function phGet(rid) {
  try { return (JSON.parse(lsGet(LS_PH) || "{}"))[rid] || ""; } catch (e) { return ""; }
}
function phSet(rid, dataUrl) {
  try {
    var m = JSON.parse(lsGet(LS_PH) || "{}");
    m[rid] = dataUrl;
    var ks = Object.keys(m);
    if (ks.length > 60) ks.slice(0, ks.length - 60).forEach(function (k) { delete m[k]; });
    if (!lsSet(LS_PH, JSON.stringify(m))) throw new Error("quota");
    return true;
  } catch (e) { toast("本機暫存已滿：相片只會存喺雲端", true); return false; }
}
function phDrop(rid) {
  try { var m = JSON.parse(lsGet(LS_PH) || "{}"); delete m[rid]; lsSet(LS_PH, JSON.stringify(m)); } catch (e) { }
}

/* ── 3. GitHub 私有資料庫 ──────────────────────────────────── */
function ghOK() { return !!(S.token && S.repo && S.repo.indexOf("/") > 0); }
function ghHeaders() {
  return {
    "Authorization": "Bearer " + S.token,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}
function b64enc(str) {
  var bytes = new TextEncoder().encode(str), bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64dec(b64) {
  var bin = atob(String(b64).replace(/\s/g, ""));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function ghApi(path, opts) {
  var r = await fetch("https://api.github.com/repos/" + S.repo + "/contents/" + path +
    "?ref=main&nc=" + Date.now(), opts || { headers: ghHeaders(), cache: "no-store" });
  return r;
}
async function ghGetJson(path) {
  if (!ghOK()) return null;
  var r = await ghApi(path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("GitHub " + r.status + " " + (await r.text()).slice(0, 140));
  var j = await r.json();
  if (!j || !j.content) return null;
  return JSON.parse(b64dec(j.content));
}
async function ghGetMeta(path) {
  if (!ghOK()) return null;
  var r = await ghApi(path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("GitHub " + r.status);
  return await r.json();
}
/* content：文字或 base64；isB64 = true 表示已係 base64（相片） */
async function ghPut(path, content, isB64, msg) {
  if (!ghOK()) throw new Error("未設定資料庫（設定 → 私有資料庫）");
  var meta = await ghGetMeta(path);
  var body = { message: msg || ("update " + path), content: isB64 ? content : b64enc(content) };
  if (meta && meta.sha) body.sha = meta.sha;
  var r = await ghApi(path, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
  if (r.status === 409) { /* sha 撞：重試一次 */
    var m2 = await ghGetMeta(path);
    if (m2 && m2.sha) body.sha = m2.sha; else delete body.sha;
    r = await ghApi(path, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
  }
  if (!r.ok) throw new Error("GitHub " + r.status + " " + (await r.text()).slice(0, 140));
  return true;
}
function ghPutJson(path, obj, msg) { return ghPut(path, JSON.stringify(obj, null, 1), false, msg); }

var _saveT = null, _saving = false;
function saveRemote(now) {
  saveLocal();
  if (!ghOK()) return;
  if (now) return doPush();
  clearTimeout(_saveT);
  _saveT = setTimeout(doPush, 1500);
}
async function doPush() {
  if (_saving) { clearTimeout(_saveT); _saveT = setTimeout(doPush, 1200); return; }
  _saving = true;
  try {
    DB.updated = new Date().toISOString();
    await ghPutJson(F_TRIP, DB, "trip: 更新資料 " + DB.updated.slice(0, 16).replace("T", " "));
    UI.syncT = Date.now();
  } catch (e) {
    toast("同步失敗：" + e.message, true);
  } finally { _saving = false; }
}
async function pullRemote() {
  if (!ghOK()) return false;
  var t = await ghGetJson(F_TRIP);
  if (t && t.trip) {
    DB = Object.assign(defaultDB(), t);
    if (!DB.places) DB.places = {};
    if (!DB.pending) DB.pending = [];
    saveLocal();
  }
  await pullStatus();
  return true;
}
async function pullStatus() {
  try {
    var st = await ghGetJson(F_STATUS);
    if (st && st.flights) { STATUS = Object.assign({ updated: "", source: "", range: "", flights: {} }, st); STATUS.updatedTS = Date.parse(st.updated || "") || 0; }
  } catch (e) { /* 靜靜失敗：app 會顯示「未收到狀態」 */ }
}
async function putPhoto(rid, dataUrl) {
  var i = String(dataUrl).indexOf(",");
  if (i < 0) return;
  await ghPut("photos/" + rid + ".jpg", String(dataUrl).slice(i + 1), true, "receipt photo " + rid);
}
async function fetchPhotoRemote(rid) {
  var r = await ghApi("photos/" + rid + ".jpg");
  if (!r.ok) throw new Error("HTTP " + r.status);
  var j = await r.json();
  return "data:image/jpeg;base64," + String(j.content || "").replace(/\s/g, "");
}

/* ── 4. 地點 / 交通時間 ────────────────────────────────────── */
var _geoLast = 0;
async function geocode(q) {
  q = String(q || "").trim();
  if (!q) throw new Error("未輸入地點");
  if (DB.places[q]) return DB.places[q];
  var wait = 1100 - (Date.now() - _geoLast);
  if (wait > 0) await sleep(wait);
  _geoLast = Date.now();
  var r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q),
    { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("定位服務 HTTP " + r.status);
  var j = await r.json();
  if (!j || !j.length) throw new Error("搵唔到「" + q + "」，試吓加城市名");
  var o = { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), disp: j[0].display_name || q };
  DB.places[q] = o;
  return o;
}
/* OSRM 公開 demo 伺服器唔分 profile（三個都回車程），所以：
   車程／公共交通 → 用 OSRM 車程；步行 → 用距離 ÷ 1.25 m/s 估算。兩者都標明係估算。 */
async function travelEst(a, b, mode) {
  var u = "https://router.project-osrm.org/route/v1/driving/" + a.lon + "," + a.lat + ";" + b.lon + "," + b.lat + "?overview=false";
  var r = await fetch(u);
  if (!r.ok) throw new Error("路線服務 HTTP " + r.status);
  var j = await r.json();
  if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error("呢兩點算唔到路線");
  var dist = j.routes[0].distance, sec = j.routes[0].duration;
  if (mode === "walk") return { min: Math.max(1, Math.round(dist / 1.25 / 60)), dist: dist, how: "步行估算" };
  if (mode === "transit") return { min: Math.max(3, Math.round(sec / 60) + 12), dist: dist, how: "車程＋等車估算" };
  return { min: Math.max(1, Math.round(sec / 60)), dist: dist, how: "車程估算" };
}

/* ── 5. AI 收據辨識 ────────────────────────────────────────── */
function pdef() { return PROVIDERS[S.provider] || PROVIDERS.openrouter; }
function effBase() { var p = pdef(); return String(S.base || p.base || "").replace(/\/+$/, ""); }
function effModel() { var p = pdef(); return String(S.model || p.model || "").trim(); }
function msgOf(txt) {
  try {
    var j = JSON.parse(txt);
    var e = j.error && (j.error.message || j.error.code);
    if (e) return String(e).slice(0, 160);
    if (j.message) return String(j.message).slice(0, 160);
  } catch (e) { }
  return (String(txt).replace(/\s+/g, " ").slice(0, 160) || "冇內容");
}
function explainHTTP(code, body) {
  var m = msgOf(body);
  if (code === 401) return "HTTP 401：API key 唔啱或未生效。";
  if (code === 402) return "HTTP 402：冇餘額／未付款。";
  if (code === 403) return "HTTP 403：key 有效但被拒（最常見係 key 設咗 Credit limit → 去供應商改成 Unlimited）。" + m;
  if (code === 429) return "HTTP 429：額度用盡／擠塞，已試輪替。";
  if (code === 400 && /location is not supported|FAILED_PRECONDITION/i.test(body || "")) return "HTTP 400：呢個地區被封（換供應商）。";
  return "HTTP " + code + "： " + m;
}
async function callModel(model, dataUrl) {
  var base = effBase();
  if (!base) throw new Error("未填 Base URL");
  if (!S.key) throw new Error("未填 API Key（設定 → AI 收據辨識）");
  var msgs;
  if (dataUrl) {
    msgs = [{ role: "user", content: [{ type: "text", text: EXP_PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }];
  } else {
    msgs = [{ role: "user", content: "只回覆兩個字：可以" }];
  }
  var r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + S.key },
    body: JSON.stringify({ model: model, temperature: 0, max_tokens: 500, messages: msgs })
  });
  var txt = await r.text();
  if (!r.ok) { var E = new Error(explainHTTP(r.status, txt)); E.status = r.status; throw E; }
  var j = JSON.parse(txt);
  var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (Array.isArray(c)) c = c.map(function (p) { return p.text || ""; }).join("");
  if (!c) throw new Error("模型冇回覆內容");
  return String(c);
}
function parseExp(text) {
  var s = String(text).replace(/```json|```/gi, "").trim();
  var i = s.indexOf("{"), k = s.lastIndexOf("}");
  if (i < 0 || k < i) throw new Error("辨識結果唔係 JSON");
  var j = JSON.parse(s.slice(i, k + 1));
  var amt = num(String(j.amount == null ? "" : j.amount).replace(/[^0-9.\-]/g, ""));
  return {
    item: String(j.item || "").trim().slice(0, 60) || "收據",
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || "").trim()) ? String(j.date).trim() : "",
    amount: amt,
    cur: String(j.cur || DB.trip.cur || "THB").toUpperCase().slice(0, 3),
    place: String(j.place || "").trim().slice(0, 60),
    cat: normCat(j.cat),
    note: String(j.note || "").trim().slice(0, 80)
  };
}
async function recognize(dataUrl) {
  var first = effModel();
  var list = [first].concat(FREE_MODELS.filter(function (m) { return m !== first; }));
  var lastErr = null;
  for (var i = 0; i < list.length; i++) {
    try {
      return parseExp(await callModel(list[i], dataUrl));
    } catch (e) {
      lastErr = e;
      if (e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503) continue;
      if (e.status === 402) continue;              /* 呢個模型冇額度，試下一個 */
      throw e;
    }
  }
  throw lastErr || new Error("辨識失敗");
}

/* ── 6. 匯率 ───────────────────────────────────────────────── */
async function refreshRates() {
  try {
    var r = await fetch("https://open.er-api.com/v6/latest/HKD");
    if (!r.ok) return;
    var j = await r.json();
    if (!j || !j.rates) return;
    var out = { HKD: 1 };
    Object.keys(j.rates).forEach(function (c) {
      var v = num(j.rates[c]);
      if (v > 0 && DEF_RATES[c] != null) out[c] = 1 / v;
    });
    DB.trip.rates = Object.assign({}, DEF_RATES, out);
    saveLocal();
    renderExpenses();
  } catch (e) { }
}

/* ── 7. 渲染 ───────────────────────────────────────────────── */
function tripDays() {
  var set = {};
  var a = DB.trip.start, b = DB.trip.end;
  if (a && b && dayDiff(a, b) >= 0 && dayDiff(a, b) < 120) {
    for (var i = 0; i <= dayDiff(a, b); i++) set[addDays(a, i)] = 1;
  }
  DB.itinerary.forEach(function (x) { if (x.date) set[x.date] = 1; });
  DB.flights.forEach(function (f) { if (f.date) set[f.date] = 1; });
  if (DB.trip.start) set[DB.trip.start] = 1;
  return Object.keys(set).sort();
}
function countdown() {
  var t = todayISO(), a = DB.trip.start, b = DB.trip.end;
  if (!a) return { k: "行程", v: "—", s: "未設定旅程" };
  if (dayDiff(t, a) > 0) return { k: "出發倒數", v: dayDiff(t, a) + " 日", s: fmtDayW(a) + " 出發" };
  if (b && dayDiff(b, t) >= 0) return { k: "旅程進行中", v: "第 " + (dayDiff(a, t) + 1) + " 日", s: fmtDayW(t) + "・" + (dayDiff(a, b) + 1) + " 日行程" };
  return { k: "旅程已完結", v: "已回程", s: fmtDay(a) + " – " + fmtDay(b) };
}
function statusOf(f) {
  return STATUS.flights[normNo(f.no) + "|" + f.date] || null;
}
function chipCls(st) {
  var s = String(st || "").toLowerCase();
  if (/cancel/.test(s)) return "err";
  if (/delay|later|retim/.test(s)) return "warn";
  if (/board|last call|gate clos|depart|arriv|landed|at gate/.test(s)) return "info";
  if (/on time|schedul|準時|預計/.test(s)) return "ok";
  return "";
}
function statusHTML(f) {
  var st = statusOf(f);
  var isArr = normNo(f.to) === "HKG" || (!normNo(f.from) && false);
  if (!st) {
    return '<div class="st"><div class="st-hd"><b>實時狀態</b><span class="chip">未取得</span></div>' +
      '<div class="st-note">按上面「更新狀態」由你嘅私有資料庫攞最新航班狀態。' +
      '<br>航班狀態由香港機場官方資料提供，經 Hermes 定時任務更新（非出發日每日一次；出發日每 15 分鐘）。</div></div>';
  }
  if (st.ok === false) {
    return '<div class="st"><div class="st-hd"><b>實時狀態</b><span class="chip warn">暫無資料</span></div>' +
      '<div class="st-note">' + esc(st.reason || "機場未提供呢班機嘅資料") + '</div></div>';
  }
  var boxes = [];
  boxes.push('<div class="st-bx"><i>狀態</i><b style="font-size:13px">' + esc(st.statusText || "—") + '</b></div>');
  boxes.push('<div class="st-bx"><i>航廈</i><b>' + esc(st.terminal || "—") + '</b></div>');
  if (st.direction === "arrival") {
    boxes.push('<div class="st-bx"><i>行李帶</i><b>' + esc(st.baggage || "—") + '</b></div>');
  } else {
    boxes.push('<div class="st-bx"><i>閘口</i><b>' + esc(st.gate || "—") + '</b></div>');
  }
  var extra = [];
  if (st.scheduled && st.scheduled !== f.time) extra.push("機場顯示時間 " + esc(st.scheduled));
  if (st.aisle) extra.push("登機閘區 " + esc(st.aisle));
  if (st.hall) extra.push("行李大堂 " + esc(st.hall));
  if (st.stand) extra.push("泊位 " + esc(st.stand));
  if (st.codeshares && st.codeshares.length > 1) extra.push("共用航班 " + esc(st.codeshares.slice(1).join("、")));
  return '<div class="st">' +
    '<div class="st-hd"><b>' + (st.direction === "arrival" ? "抵港" : "離港") + '・' + (isArr || st.direction === "arrival" ? "行李帶" : "閘口") + '</b>' +
    '<span class="chip ' + chipCls(st.statusText) + '">' + esc(st.statusText || "—") + '</span></div>' +
    '<div class="st-grid">' + boxes.join("") + '</div>' +
    (extra.length ? '<div class="st-note">' + extra.join("・") + '</div>' : "") +
    '<div class="st-note">最後更新 ' + esc(st.fetchedText || "—") + '・來源：' + esc(STATUS.source || "機場官方資料") + '</div>' +
    '</div>';
}

function renderHeader() {
  $("hdTitle").textContent = DB.trip.name || "旅程助手";
  var t = tripDays(), n = DB.itinerary.length + DB.flights.length + DB.expenses.length;
  $("hdSub").textContent = (DB.trip.start ? fmtDay(DB.trip.start) + "–" + fmtDay(DB.trip.end) + "・" + t.length + " 日" : "未設定旅程") +
    "・" + DB.expenses.length + " 筆支出";
}

function renderHero() {
  var c = countdown();
  $("heroTrip").textContent = DB.trip.name || "行程";
  $("heroDays").textContent = c.v;
  $("heroRange").textContent = c.s + (DB.trip.from ? "・" + DB.trip.from + " → " + DB.trip.to : "");
}

function renderNext() {
  var el = $("nextCard");
  var now = new Date();
  var t = todayISO() + "T" + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  var fs = DB.flights.filter(function (f) { return f.date && f.time; })
    .sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
  var next = fs.filter(function (f) { return (f.date + "T" + f.time) >= t; })[0] || null;
  if (!next) {
    el.innerHTML = fs.length
      ? '<div class="itm"><div class="itm-h">航班已完成</div><div class="itm-s">共 ' + fs.length + ' 班・可以喺「航班」分頁睇返狀態</div></div>'
      : "";
    return;
  }
  var st = statusOf(next);
  var chip = st && st.ok !== false ? '<span class="chip ' + chipCls(st.statusText) + '">' + esc(st.statusText) + '</span>'
    : '<span class="chip">未取得狀態</span>';
  el.innerHTML = '<div class="itm">' +
    '<div class="itm-top"><div><div class="itm-h">✈ 下一班機 ' + esc(next.no) + '</div>' +
    '<div class="itm-s">' + fmtDayW(next.date) + " " + esc(next.time) + "・" + esc(next.from) + " → " + esc(next.to) + '</div></div>' + chip + '</div>' +
    (st && st.ok !== false ? '<div class="st-note">' + esc(st.terminal || "") + (st.gate ? "・閘口 " + esc(st.gate) : "") + (st.baggage ? "・行李帶 " + esc(st.baggage) : "") + '</div>' : "") +
    '</div>';
}

function renderDayBar() {
  var days = tripDays(), t = todayISO();
  $("dayBar").innerHTML = days.map(function (d) {
    var n = DB.itinerary.filter(function (x) { return x.date === d; }).length;
    return '<button class="daychip' + (d === UI.day ? " is-on" : "") + '" data-d="' + d + '">' +
      '<b>' + (d === t ? "今日" : fmtDay(d)) + '</b><i>' + javaDay(d) + (n ? "・" + n + " 項" : "") + '</i></button>';
  }).join("");
  if (!days.length) $("dayBar").innerHTML = '<div class="hint">先喺「設定 → 旅程」填出發同回程日期。</div>';
}

function renderItin() {
  var day = UI.day || DB.trip.start;
  $("dayTitle").textContent = day ? fmtDayW(day) + " 行程" : "當日行程";
  var items = DB.itinerary.filter(function (x) { return x.date === day; })
    .sort(function (a, b) { return String(a.start || "").localeCompare(String(b.start || "")); });
  $("itinEmpty").hidden = items.length > 0;
  $("itinList").innerHTML = items.map(function (x, i) {
    var prev = items[i - 1] || null;
    var tr = "";
    if (x.travelMin != null || (prev && prev.place && x.place)) {
      var m = x.travelMin != null ? x.travelMin : "";
      var mode = MODES[x.mode] || MODES.drive;
      tr = '<div class="it-m">' +
        '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>' +
        '由上一個地點：' + mode + (m !== "" ? " " + esc(m) + " 分鐘" : "（未計）") +
        (x.travelHow ? "・" + esc(x.travelHow) : "") + '</div>';
    }
    var map = (x.lat != null && x.lon != null)
      ? '<div class="it-m"><svg viewBox="0 0 24 24"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>' +
        '<a class="mlink" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + x.lat + "," + x.lon + '">喺地圖開啟</a></div>'
      : "";
    return '<div class="it">' +
      '<div class="it-t"><b>' + esc(hhmm(x.start) || "—") + '</b><i>' + esc(hhmm(x.end) || "") + '</i></div>' +
      '<div class="it-b">' +
      '<div class="it-h">' + esc(x.title || x.place || "（未命名）") + '</div>' +
      (x.place ? '<div class="it-p">📍 ' + esc(x.place) + '</div>' : "") +
      tr + map +
      (x.remark ? '<div class="it-r">' + esc(x.remark).replace(/\n/g, "<br>") + '</div>' : "") +
      '</div>' +
      '<div class="it-x">' +
      '<button class="iconbtn" data-eit="' + x.id + '" aria-label="編輯"><svg viewBox="0 0 24 24"><path d="M4.6 19.4h3.2L18.6 8.6a2.3 2.3 0 0 0-3.2-3.2L4.6 16.2v3.2Z"/></svg></button>' +
      '<button class="iconbtn" data-dit="' + x.id + '" aria-label="刪除"><svg viewBox="0 0 24 24"><path d="M5.4 7.4h13.2M9.2 7.4V5.6h5.6v1.8M7 7.4l.9 11.2h8.2L17 7.4"/></svg></button>' +
      '</div></div>';
  }).join("");
}

function renderFlights() {
  var fs = DB.flights.slice().sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
  $("flyEmpty").hidden = fs.length > 0;
  $("flyList").innerHTML = fs.map(function (f) {
    return '<div class="itm">' +
      '<div class="itm-top"><div><div class="itm-h">' + esc(f.no) + '</div>' +
      '<div class="itm-s">' + fmtDayW(f.date) + " " + esc(f.time) + "・" + esc(f.from) + " → " + esc(f.to) + '</div></div>' +
      '<span class="chip ' + (statusOf(f) ? chipCls(statusOf(f).statusText) : "") + '">' + esc(statusOf(f) ? (statusOf(f).statusText || "—") : "待更新") + '</span></div>' +
      statusHTML(f) +
      (f.note ? '<div class="kv"><span class="k">備註</span><span class="v">' + esc(f.note) + '</span></div>' : "") +
      '<div class="itm-act"><button data-efly="' + f.id + '">編輯</button><button class="dg" data-dfly="' + f.id + '">刪除</button></div>' +
      '</div>';
  }).join("");

  var hs = DB.hotels.slice();
  $("hotelEmpty").hidden = hs.length > 0;
  $("hotelList").innerHTML = hs.map(function (h) {
    var map = h.addr ? '<div class="it-m"><svg viewBox="0 0 24 24"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>' +
      '<a class="mlink" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(h.addr) + '">喺地圖開啟</a></div>' : "";
    return '<div class="itm">' +
      '<div class="itm-h">🏨 ' + esc(h.name || "酒店") + '</div>' +
      (h.addr ? '<div class="itm-s">' + esc(h.addr) + '</div>' : "") + map +
      ((h.ci || h.co) ? '<div class="kv"><span class="k">入住/退房</span><span class="v">' + esc(h.ci || "—") + " → " + esc(h.co || "—") + '</span></div>' : "") +
      (h.conf ? '<div class="kv"><span class="k">確認號</span><span class="v">' + esc(h.conf) + '</span></div>' : "") +
      (h.phone ? '<div class="kv"><span class="k">電話</span><span class="v"><a class="mlink" href="tel:' + esc(h.phone) + '">' + esc(h.phone) + '</a></span></div>' : "") +
      (h.note ? '<div class="kv"><span class="k">備註</span><span class="v">' + esc(h.note) + '</span></div>' : "") +
      '<div class="itm-act"><button data-ehot="' + h.id + '">編輯</button><button class="dg" data-dhot="' + h.id + '">刪除</button></div>' +
      '</div>';
  }).join("");

  var up = STATUS.updatedTS ? new Date(STATUS.updatedTS).toLocaleString("zh-HK", { hour12: false }).slice(0, 16) : "未收到";
  $("flyFoot").textContent = "航班狀態最後更新：" + up + (STATUS.source ? "\n資料來源：" + STATUS.source : "") +
    (STATUS.range ? "\n機場開放範圍：" + STATUS.range : "") +
    (STATUS.updatedTS ? "" : "\n（Hermes 定時任務未寫入過狀態檔；可以先喺「更新狀態」試一次）");
  if (STATUS.updatedTS && STATUS.flights) {
    var miss = DB.flights.filter(function (f) { var s = statusOf(f); return s && s.ok === false; });
    if (miss.length) $("flyFoot").textContent += "\n\n有 " + miss.length + " 班未能取得資料：" +
      miss.map(function (f) { return f.no + "（" + (statusOf(f).reason || "") + "）"; }).join("；");
  }

  var today = DB.flights.filter(function (f) { return f.date === todayISO(); }).length;
  var b = $("flyBadge");
  b.hidden = !today;
  b.textContent = today;
}

function renderExpenses() {
  var list = DB.expenses.slice().sort(function (a, b) { return (b.date + "").localeCompare(a.date + ""); });
  var total = list.reduce(function (s, e) { return s + num(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur)); }, 0);
  var hidden = lsGet("trip.hideAmt") === "1";
  $("heroAmt").textContent = hidden ? "••••••" : "HK$ " + money(total);
  $("heroSub").textContent = list.length + " 筆・" + (DB.trip.cur || "") + " 自動換算 HKD" + (hidden ? "（已隱藏）" : "");
  try { $("eyeBtn").querySelector(".eye-slash").style.display = hidden ? "" : "none"; } catch (e) { }

  var byCat = {};
  list.forEach(function (e) {
    var c = normCat(e.cat);
    byCat[c] = (byCat[c] || 0) + num(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur));
  });
  var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; }).slice(0, 6);
  $("expStats").innerHTML = cats.map(function (c) {
    return '<div class="stat"><i>' + esc(c) + '</i><b>' + (hidden ? "•••" : "HK$ " + money(byCat[c])) + '</b></div>';
  }).join("");

  var groups = {};
  list.forEach(function (e) { (groups[e.date] = groups[e.date] || []).push(e); });
  var html = Object.keys(groups).sort().reverse().map(function (d) {
    var sum = groups[d].reduce(function (s, e) { return s + num(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur)); }, 0);
    return '<div class="exp-day"><span>' + fmtDayW(d) + '</span><span>' + (hidden ? "•••" : "HK$ " + money(sum)) + '</span></div>' +
      groups[d].map(function (e) {
        var ph = e.rid ? '<img src="' + (phGet(e.rid) || "data:image/gif;base64,R0lGODlhAQABAAAAACw=") + '" data-ph="' + e.rid + '" alt="">' : "";
        return '<div class="q">' + (ph || '<div style="width:46px"></div>') +
          '<div class="q-b"><div class="q-t">' + esc(e.item || "支出") + '</div>' +
          '<div class="q-s">' + esc(normCat(e.cat)) + (e.place ? "・" + esc(e.place) : "") + (e.note ? "・" + esc(e.note) : "") + '</div>' +
          '<div class="q-s">' + esc(e.cur) + " " + money(e.amount) + (String(e.cur || "").toUpperCase() !== "HKD" ? " → HK$ " + money(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur)) : "") + '</div>' +
          '</div>' +
          '<div class="it-x">' +
          '<button class="iconbtn" data-eexp="' + e.id + '"><svg viewBox="0 0 24 24"><path d="M4.6 19.4h3.2L18.6 8.6a2.3 2.3 0 0 0-3.2-3.2L4.6 16.2v3.2Z"/></svg></button>' +
          '<button class="iconbtn" data-dexp="' + e.id + '"><svg viewBox="0 0 24 24"><path d="M5.4 7.4h13.2M9.2 7.4V5.6h5.6v1.8M7 7.4l.9 11.2h8.2L17 7.4"/></svg></button>' +
          '</div></div>';
      }).join("");
  }).join("");
  $("expEmpty").hidden = list.length > 0;
  $("expList").innerHTML = html;
  DB.expenses.forEach(function (e) { /* 補抓雲端相片 */
    if (e.rid && !phGet(e.rid) && ghOK()) {
      fetchPhotoRemote(e.rid).then(function (u) { phSet(e.rid, u); var im = document.querySelector('[data-ph="' + e.rid + '"]'); if (im) im.src = u; }).catch(function () { });
    }
  });
  renderPending();
  var pb = $("pendBadge");
  pb.hidden = !DB.pending.length;
  pb.textContent = DB.pending.length;
}

function renderPending() {
  $("pendWrap").hidden = DB.pending.length === 0;
  $("pendList").innerHTML = DB.pending.map(function (p) {
    var img = p.rid ? phGet(p.rid) : "";
    return '<div class="q">' +
      (img ? '<img src="' + img + '" alt="">' : '<div style="width:46px"></div>') +
      '<div class="q-b"><div class="q-t">' + esc(p.item || "待確認") + (p.src === "manual" ? "（手動）" : "") + '</div>' +
      '<div class="q-s">' + esc(p.date || "") + "・" + esc(normCat(p.cat)) + "・" + esc(p.cur) + " " + money(p.amount) + '</div>' +
      (p.note ? '<div class="q-s">' + esc(p.note) + '</div>' : "") +
      '</div>' +
      '<div class="it-x">' +
      '<button class="iconbtn" data-epen="' + p.id + '"><svg viewBox="0 0 24 24"><path d="M4.6 19.4h3.2L18.6 8.6a2.3 2.3 0 0 0-3.2-3.2L4.6 16.2v3.2Z"/></svg></button>' +
      '<button class="iconbtn" data-dpen="' + p.id + '"><svg viewBox="0 0 24 24"><path d="M5.4 7.4h13.2M9.2 7.4V5.6h5.6v1.8M7 7.4l.9 11.2h8.2L17 7.4"/></svg></button>' +
      '</div></div>';
  }).join("");
}

function renderSettings() {
  $("tName").value = DB.trip.name || "";
  $("tStart").value = DB.trip.start || "";
  $("tEnd").value = DB.trip.end || "";
  $("tFrom").value = DB.trip.from || "";
  $("tTo").value = DB.trip.to || "";
  $("tCur").value = DB.trip.cur || "";
  $("fProvider").value = S.provider || "openrouter";
  $("fBase").value = S.base || "";
  $("fKey").value = S.key || "";
  $("fModel").value = S.model || "";
  $("fRepo").value = S.repo || "";
  $("fToken").value = S.token || "";
  $("fRates").value = S.ratesTxt || "";
  var p = pdef();
  $("keyHelp").innerHTML = "目前供應商：<b>" + esc(p.label) + "</b>・" + esc(p.note) +
    (p.keyUrl ? '<br>攞 key：<a class="mlink" target="_blank" rel="noopener" href="' + p.keyUrl + '">' + esc(p.keyUrl) + '</a>' : "");
  $("ghHelp").innerHTML = '去 <a class="mlink" target="_blank" rel="noopener" href="https://github.com/settings/personal-access-tokens/new">GitHub 建立 fine-grained token</a>' +
    '：Repository access 揀 <b>' + esc((S.repo || "").split("/")[0] || "你嘅帳號") + '</b> 嘅 <b>' + esc((S.repo || "").split("/")[1] || "私有資料 repo") + '</b>，' +
    'Permissions → <b>Contents: Read and write</b>。';
  var rk = Object.keys(DB.trip.rates || {}).length;
  $("about").innerHTML = "介面版本 <b>v" + VERSION + "</b>・行程 " + DB.itinerary.length + " 項・航班 " + DB.flights.length +
    " 班・酒店 " + DB.hotels.length + " 間・支出 " + DB.expenses.length + " 筆" +
    (rk ? "・已快取 " + rk + " 種匯率" : "") +
    (DB.updated ? "<br>最後同步：" + String(DB.updated).slice(0, 16).replace("T", " ") : "<br>未同步到雲端（只存本機）");
}

function renderAll() {
  try { renderHeader(); } catch (e) { }
  try { renderHero(); } catch (e) { }
  try { renderNext(); } catch (e) { }
  try { renderDayBar(); } catch (e) { }
  try { renderItin(); } catch (e) { }
  try { renderFlights(); } catch (e) { }
  try { renderExpenses(); } catch (e) { }
  try { renderSettings(); } catch (e) { }
}

/* ── 8. 分頁切換 ───────────────────────────────────────────── */
function showView(v) {
  UI.view = v;
  ["itin", "fly", "exp", "set"].forEach(function (k) { var el = $("v-" + k); if (el) el.hidden = k !== v; });
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
    b.classList.toggle("is-on", b.getAttribute("data-v") === v);
  });
  $("views").scrollTop = 0;
  if (v === "set") renderSettings();
  if (v === "fly") renderFlights();
  if (v === "exp") renderExpenses();
}

/* ── 9. Sheet（新增／編輯）─────────────────────────────────── */
var SHEET = { save: null };
function openSheet(title, html, onSave) {
  $("edTitle").textContent = title;
  $("edBody").innerHTML = html;
  SHEET.save = onSave;
  $("editSheet").hidden = false;
}
function closeSheet() { $("editSheet").hidden = true; SHEET.save = null; }
function fv(id) { var e = $(id); return e ? e.value : ""; }
function fld(label, id, type, val, ph, extra) {
  return '<label class="fld">' + esc(label) + '<input id="' + id + '" type="' + (type || "text") + '" value="' + esc(val == null ? "" : val) + '"' +
    (ph ? ' placeholder="' + esc(ph) + '"' : "") + (extra || "") + '></label>';
}
function fsel(label, id, opts, val) {
  return '<label class="fld">' + esc(label) + '<select id="' + id + '">' + opts.map(function (o) {
    return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(val) ? " selected" : "") + '>' + esc(o[1]) + '</option>';
  }).join("") + '</select></label>';
}
function catOpts(val) { return CATS.map(function (c) { return [c, c]; }); }
function curOpts(val) {
  var cs = ["THB", "HKD", "USD", "JPY", "TWD", "CNY", "EUR", "GBP", "SGD", "KRW", "MYR", "AUD", "VND", "PHP"];
  if (val && cs.indexOf(val) < 0) cs.unshift(val);
  return cs.map(function (c) { return [c, c]; });
}

/* ── 行程編輯 ── */
function editItin(id) {
  var x = DB.itinerary.filter(function (a) { return a.id === id; })[0] || {
    id: "", date: UI.day || DB.trip.start, start: "09:00", end: "10:00", title: "", place: "",
    lat: null, lon: null, mode: "drive", travelMin: null, travelHow: "", remark: ""
  };
  var html =
    '<div class="edform">' +
    fld("日期", "eDate", "date", x.date) +
    '<div class="grid2">' + fld("開始時間", "eStart", "time", x.start) + fld("結束時間", "eEnd", "time", x.end) + '</div>' +
    fld("行程標題", "eTitle", "text", x.title, "例：大皇宮 + 玉佛寺") +
    fld("地點", "ePlace", "text", x.place, "例：The Grand Palace, Bangkok") +
    '<div class="btnrow"><button class="btn btn-sm" id="eGeo">📍 定位呢個地點</button>' +
    '<button class="btn btn-sm" id="eTravel">⏱ 自動算交通時間</button></div>' +
    '<div class="hint" id="eGeoOut">' + (x.lat != null ? "已定位：" + esc(String(x.lat).slice(0, 7)) + ", " + esc(String(x.lon).slice(0, 7)) : "未定位（定位後先可以用地圖／自動算交通）") + '</div>' +
    fsel("由上一個地點前往（交通方式）", "eMode", Object.keys(MODES).map(function (k) { return [k, MODES[k]]; }), x.mode) +
    fld("交通時間（分鐘）", "eMin", "number", x.travelMin == null ? "" : x.travelMin, "留空＝未計") +
    fld("備註", "eRemark", "text", x.remark, "例：記得帶遮、預約 14:00") +
    '</div>';
  openSheet(id ? "編輯行程" : "新增行程", html, function () {
    var t = fv("eTitle").trim(), pl = fv("ePlace").trim();
    if (!t && !pl) { toast("請填標題或地點", true); return false; }
    var o = {
      id: x.id || uid("i"), date: fv("eDate") || UI.day, start: fv("eStart"), end: fv("eEnd"),
      title: t, place: pl, lat: x.lat, lon: x.lon, mode: fv("eMode"),
      travelMin: fv("eMin") === "" ? null : num(fv("eMin")), travelHow: x.travelHow, remark: fv("eRemark")
    };
    if (x.id) { DB.itinerary = DB.itinerary.map(function (a) { return a.id === x.id ? o : a; }); }
    else DB.itinerary.push(o);
    UI.day = o.date;
    saveRemote(); renderAll(); showView("itin");
    toast(x.id ? "已更新行程" : "已加入行程");
    return true;
  });
  /* 綁 sheet 內按鈕 */
  $("eGeo").onclick = async function () {
    var q = fv("ePlace").trim();
    if (!q) { toast("請先填地點", true); return; }
    ov(true, "定位中…（OpenStreetMap）");
    try {
      var g = await geocode(q);
      x.lat = g.lat; x.lon = g.lon;
      $("eGeoOut").innerHTML = "已定位：" + esc(String(g.lat).slice(0, 7)) + ", " + esc(String(g.lon).slice(0, 7)) + "<br>" + esc(String(g.disp).slice(0, 90));
      toast("已定位，記住按「儲存」");
    } catch (e) { toast(e.message, true); }
    ov(false);
  };
  $("eTravel").onclick = async function () {
    var q = fv("ePlace").trim();
    try {
      var o = x.lat != null ? { lat: x.lat, lon: x.lon } : await geocode(q);
      x.lat = o.lat; x.lon = o.lon;
      var prev = prevItemFor(DB.itinerary, { id: x.id, date: fv("eDate"), start: fv("eStart") });
      if (!prev) { toast("呢日之前冇其他行程，冇得計", true); return; }
      var p = prev.lat != null ? { lat: prev.lat, lon: prev.lon } : await geocode(prev.place);
      prev.lat = p.lat; prev.lon = p.lon;
      ov(true, "計緊交通時間…（OSRM）");
      var t = await travelEst(p, o, fv("eMode"));
      $("eMin").value = t.min;
      x.travelHow = t.how + "（" + (t.dist / 1000).toFixed(1) + " km）";
      toast("約 " + t.min + " 分鐘・" + x.travelHow);
    } catch (e) { toast(e.message, true); }
    ov(false);
  };
}
function prevItemFor(arr, cur) {
  var same = arr.filter(function (a) {
    return a.id !== cur.id && a.date === cur.date && a.place && String(a.start || "") < String(cur.start || "99:99");
  }).sort(function (a, b) { return String(b.start).localeCompare(String(a.start)); });
  return same[0] || null;
}

/* ── 航班／酒店編輯 ── */
function editFlight(id) {
  var f = DB.flights.filter(function (a) { return a.id === id; })[0] || {
    id: "", no: "", date: DB.trip.start, time: "", from: DB.trip.from || "HKG", to: DB.trip.to || "BKK", note: ""
  };
  openSheet(id ? "編輯航班" : "新增航班",
    '<div class="edform">' +
    fld("航班編號", "fNo", "text", f.no, "例：CX617", ' autocapitalize="characters" spellcheck="false"') +
    fld("日期", "fDate", "date", f.date) +
    '<div class="grid2">' + fld("起飛時間", "fTime", "time", f.time) +
    fld("出發地（IATA）", "fFrom", "text", f.from, "HKG", ' autocapitalize="characters" spellcheck="false"') + '</div>' +
    '<div class="grid2">' + fld("目的地（IATA）", "fTo", "text", f.to, "BKK", ' autocapitalize="characters" spellcheck="false"') +
    fld("抵達時間", "fArr", "time", f.arr, "可留空") + '</div>' +
    fld("備註", "fNote", "text", f.note, "例：Terminal 1、已網上 check-in") +
    '<div class="hint">狀態會以「航班編號＋日期」去對香港機場官方資料。只支援喺香港國際機場起降嘅航班（HKG ↔ 其他地方）。</div>' +
    '</div>', function () {
      var no = fv("fNo").trim().toUpperCase();
      if (!no) { toast("請填航班編號", true); return false; }
      var o = {
        id: f.id || uid("f"), no: no, date: fv("fDate"), time: fv("fTime"),
        from: fv("fFrom").trim().toUpperCase(), to: fv("fTo").trim().toUpperCase(),
        arr: fv("fArr"), note: fv("fNote")
      };
      if (f.id) DB.flights = DB.flights.map(function (a) { return a.id === f.id ? o : a; });
      else DB.flights.push(o);
      saveRemote(); renderAll(); showView("fly");
      toast("已儲存・按「更新狀態」攞實時資料");
      return true;
    });
}
function editHotel(id) {
  var h = DB.hotels.filter(function (a) { return a.id === id; })[0] || { id: "", name: "", addr: "", ci: DB.trip.start, co: "", conf: "", phone: "", note: "" };
  openSheet(id ? "編輯酒店" : "新增酒店",
    '<div class="edform">' +
    fld("酒店名稱", "hName", "text", h.name, "例：曼谷文華東方酒店") +
    fld("地址", "hAddr", "text", h.addr, "例：48 Oriental Ave, Bangkok") +
    '<div class="grid2">' + fld("入住", "hCi", "date", h.ci) + fld("退房", "hCo", "date", h.co) + '</div>' +
    '<div class="grid2">' + fld("確認號", "hConf", "text", h.conf) + fld("電話", "hPhone", "tel", h.phone) + '</div>' +
    fld("備註", "hNote", "text", h.note, "例：早餐 6:30–10:30、check-in 15:00") +
    '</div>', function () {
      if (!fv("hName").trim()) { toast("請填酒店名稱", true); return false; }
      var o = {
        id: h.id || uid("h"), name: fv("hName").trim(), addr: fv("hAddr").trim(),
        ci: fv("hCi"), co: fv("hCo"), conf: fv("hConf"), phone: fv("hPhone"), note: fv("hNote")
      };
      if (h.id) DB.hotels = DB.hotels.map(function (a) { return a.id === h.id ? o : a; });
      else DB.hotels.push(o);
      saveRemote(); renderAll(); showView("fly");
      toast("已儲存酒店");
      return true;
    });
}

/* ── 支出編輯（手動／待確認）─ */
function expForm(e, isPending) {
  var img = e.rid ? phGet(e.rid) : "";
  return '<div class="edform">' +
    (e.rid ? '<div class="q"><img id="eImg" src="' + (img || "") + '" alt=""><div class="q-b"><div class="q-t">收據相片</div><div class="q-s">' + (img ? "已存本機" : "未下載（存喺雲端）") + '</div></div></div>' : "") +
    '<div class="grid2">' + fld("日期", "xDate", "date", e.date || todayISO()) + fld("項目", "xItem", "text", e.item, "例：午餐") + '</div>' +
    '<div class="grid2">' + fld("金額", "xAmt", "number", e.amount, "0", ' inputmode="decimal" step="0.01"') +
    fsel("幣別", "xCur", curOpts(String(e.cur || DB.trip.cur || "THB").toUpperCase()), String(e.cur || DB.trip.cur || "THB").toUpperCase()) + '</div>' +
    '<div class="grid2">' + fsel("類別", "xCat", catOpts(normCat(e.cat)), normCat(e.cat)) + fld("地點", "xPlace", "text", e.place, "可留空") + '</div>' +
    fld("備註", "xNote", "text", e.note, "可留空") +
    '<div class="hint" id="xCalc"></div>' +
    (!e.rid && !isPending ? '<div class="btnrow"><button class="btn btn-sm" id="xAddPhoto">📷 加收據相片</button></div>' : "") +
    '</div>';
}
function bindExpCalc() {
  var upd = function () {
    var a = num(fv("xAmt")), c = fv("xCur"), r = rate(c);
    $("xCalc").textContent = String(c).toUpperCase() === "HKD" ? "" : ("HK$ " + money(a * r) + "（1 " + c + " = " + r + " HKD）");
  };
  ["xAmt", "xCur"].forEach(function (id) { var el = $(id); if (el) el.oninput = upd; if (el) el.onchange = upd; });
  var ap = $("xAddPhoto");
  if (ap) ap.onclick = function () { pickPhotoFor(null); };
  upd();
}
function editExpense(id, isPending) {
  var src = isPending ? DB.pending : DB.expenses;
  var e = src.filter(function (a) { return a.id === id; })[0];
  if (!e) return;
  openSheet(isPending ? "確認收據" : "編輯支出", expForm(e, isPending), function () {
    var o = {
      id: e.id, date: fv("xDate") || todayISO(), item: fv("xItem").trim() || "支出",
      amount: num(fv("xAmt")), cur: fv("xCur"), cat: fv("xCat"), place: fv("xPlace").trim(),
      note: fv("xNote").trim(), rid: e.rid || "", src: e.src || "manual", ts: e.ts || Date.now()
    };
    o.hkd = toHKD(o.amount, o.cur);
    if (isPending) {
      DB.pending = DB.pending.map(function (a) { return a.id === id ? o : a; });
    } else {
      DB.expenses = DB.expenses.map(function (a) { return a.id === id ? o : a; });
    }
    saveRemote(); renderAll();
    toast("已儲存");
    return true;
  });
  bindExpCalc();
}
function addExpenseManual() {
  var e = { id: "", date: todayISO(), item: "", amount: "", cur: DB.trip.cur || "THB", cat: "餐飲", place: "", note: "", rid: "" };
  openSheet("手動入帳", expForm(e, false), function () {
    var o = {
      id: uid("e"), date: fv("xDate") || todayISO(), item: fv("xItem").trim() || "支出",
      amount: num(fv("xAmt")), cur: fv("xCur"), cat: fv("xCat"), place: fv("xPlace").trim(),
      note: fv("xNote").trim(), rid: e.rid || "", src: "manual", ts: Date.now()
    };
    if (o.amount <= 0) { toast("請填金額", true); return false; }
    o.hkd = toHKD(o.amount, o.cur);
    DB.expenses.push(o);
    saveRemote(); renderAll(); showView("exp");
    toast("已入帳 HK$" + money(o.hkd));
    return true;
  });
  bindExpCalc();
}

/* ── 10. 相片：壓縮 + 收據辨識流程 ────────────────────────── */
function readAsDataURL(file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(fr.result); };
    fr.onerror = function () { rej(new Error("讀取檔案失敗")); };
    fr.readAsDataURL(file);
  });
}
function shrink(dataUrl, maxPx, q) {
  return new Promise(function (res) {
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        var s = Math.min(1, maxPx / Math.max(w, h));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * s));
        c.height = Math.max(1, Math.round(h * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL("image/jpeg", q));
      } catch (e) { res(dataUrl); }
    };
    img.onerror = function () { res(dataUrl); };
    img.src = dataUrl;
  });
}
var _photoTarget = null;
function pickPhotoFor(target) {
  _photoTarget = target;
  var f = $("file");
  f.value = "";
  f.onchange = async function () {
    var file = f.files && f.files[0];
    if (!file) return;
    try {
      if (!/^image\//.test(file.type)) { toast("呢個係 PDF／非圖片，唔可以自動辨識，請手動入帳", true); return; }
      ov(true, "壓縮相片…");
      var raw = await readAsDataURL(file);
      var small = await shrink(raw, 1280, 0.72);
      var rid = uid("r");
      phSet(rid, small);
      if (ghOK()) { try { await putPhoto(rid, small); } catch (e) { toast("相片上傳雲端失敗（會留喺本機）", true); } }
      if (_photoTarget === null && $("editSheet").hidden === false) { /* 由支出表單加相 */
        var cur = $("eImg"); if (cur) { cur.src = small; }
        _lastRid = rid;
        toast("已加相片，記住按「儲存」");
        ov(false);
        return;
      }
      /* 由「上載收據」入：即時 AI 辨識 */
      ov(true, "AI 辨識收據中…");
      var r = await recognize(small);
      DB.pending.push(Object.assign({ id: uid("p"), rid: rid, src: "ai", ts: Date.now() }, r));
      saveRemote(); renderAll(); showView("exp");
      toast("辨識完成：" + r.item + " " + r.cur + " " + money(r.amount));
    } catch (e) {
      /* 辨識失敗：仍然建立一條待確認紀錄，唔會白做 */
      var rid2 = _lastRid || "";
      DB.pending.push({ id: uid("p"), rid: rid2, src: "ai", item: "收據（辨識失敗）", date: todayISO(), amount: 0, cur: DB.trip.cur || "THB", cat: "其他", place: "", note: "", ts: Date.now() });
      saveRemote(); renderAll(); showView("exp");
      toast("AI 辨識失敗：" + e.message + "\n已建立待確認紀錄，可手動填金額。", true);
    } finally { ov(false); _lastRid = null; _photoTarget = null; }
  };
  f.click();
}
var _lastRid = null;
async function uploadReceipts(files) {
  var arr = Array.prototype.slice.call(files || []);
  if (!arr.length) return;
  var okN = 0, failN = 0;
  for (var i = 0; i < arr.length; i++) {
    var file = arr[i];
    try {
      if (!/^image\//.test(file.type)) { toast("「" + file.name + "」唔係圖片，略過", true); continue; }
      ov(true, "處理 " + (i + 1) + "/" + arr.length + "：壓縮中…");
      var raw = await readAsDataURL(file);
      var small = await shrink(raw, 1280, 0.72);
      var rid = uid("r");
      phSet(rid, small);
      if (ghOK()) { try { await putPhoto(rid, small); } catch (e) { } }
      _lastRid = rid;
      ov(true, "處理 " + (i + 1) + "/" + arr.length + "：AI 辨識中…");
      var r = await recognize(small);
      DB.pending.push(Object.assign({ id: uid("p"), rid: rid, src: "ai", ts: Date.now() }, r));
      okN++;
      DB.pending = DB.pending.slice();
      renderAll();
    } catch (e) {
      failN++;
      if (_lastRid) {
        DB.pending.push({ id: uid("p"), rid: _lastRid, src: "ai", item: "收據（辨識失敗）", date: todayISO(), amount: 0, cur: DB.trip.cur || "THB", cat: "其他", place: "", note: String(e.message).slice(0, 60), ts: Date.now() });
        renderAll();
      }
      toast("「" + file.name + "」辨識失敗：" + e.message + "\n已加入待確認，可手動填。", true);
    }
    _lastRid = null;
  }
  saveRemote(); renderAll(); showView("exp"); ov(false);
  toast("完成：成功 " + okN + " 張" + (failN ? "・失敗 " + failN + " 張（已加入待確認，可手動填）" : "") + "\n請核對金額後按「全部入帳」");
}
function commitPending() {
  if (!DB.pending.length) return;
  var n = 0;
  DB.pending.forEach(function (p) {
    if (num(p.amount) <= 0 && !p.item) return;
    DB.expenses.push({
      id: uid("e"), date: p.date || todayISO(), item: p.item || "支出", amount: num(p.amount),
      cur: String(p.cur || "HKD").toUpperCase(), cat: normCat(p.cat), place: p.place || "", note: p.note || "",
      rid: p.rid || "", src: p.src || "ai", ts: Date.now(), hkd: toHKD(p.amount, p.cur)
    });
    n++;
  });
  DB.pending = [];
  saveRemote(); renderAll(); showView("exp");
  toast("已入帳 " + n + " 筆");
}

/* ── 11. Excel 匯出 ────────────────────────────────────────── */
function exportXlsx() {
  try {
    if (!window.XLSX) { toast("Excel 元件未載入（請重新載入頁面）", true); return; }
    var wb = XLSX.utils.book_new();
    var A = [];
    A.push(["日期", "項目", "類別", "地點", "幣別", "金額", "匯率", "HKD", "備註", "有相片"]);
    DB.expenses.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).forEach(function (e) {
      A.push([e.date, e.item, normCat(e.cat), e.place || "", e.cur, num(e.amount), rate(e.cur), num(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur)), e.note || "", e.rid ? "有" : ""]);
    });
    var s1 = XLSX.utils.aoa_to_sheet(A);
    s1["!cols"] = [{ wch: 11 }, { wch: 22 }, { wch: 11 }, { wch: 20 }, { wch: 7 }, { wch: 12 }, { wch: 9 }, { wch: 12 }, { wch: 26 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, s1, "支出明細");

    var byCat = {};
    DB.expenses.forEach(function (e) {
      var c = normCat(e.cat);
      byCat[c] = byCat[c] || { n: 0, h: 0 };
      byCat[c].n++; byCat[c].h += num(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur));
    });
    var A2 = [["類別", "筆數", "HKD 合計"]].concat(Object.keys(byCat).sort(function (a, b) { return byCat[b].h - byCat[a].h; })
      .map(function (c) { return [c, byCat[c].n, Math.round(byCat[c].h * 100) / 100]; }));
    var tot = DB.expenses.reduce(function (s, e) { return s + num(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur)); }, 0);
    A2.push(["總計", DB.expenses.length, Math.round(tot * 100) / 100]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(A2), "分類統計");

    var byDay = {};
    DB.expenses.forEach(function (e) { byDay[e.date] = (byDay[e.date] || 0) + num(e.hkd != null ? e.hkd : toHKD(e.amount, e.cur)); });
    var A3 = [["日期", "星期", "HKD 合計"]].concat(Object.keys(byDay).sort().map(function (d) { return [d, javaDay(d), Math.round(byDay[d] * 100) / 100]; }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(A3), "每日合計");

    var A4 = [["日期", "開始", "結束", "標題", "地點", "前往方式", "交通分鐘", "備註"]];
    DB.itinerary.slice().sort(function (a, b) { return (a.date + a.start).localeCompare(b.date + b.start); }).forEach(function (x) {
      A4.push([x.date, x.start, x.end, x.title || "", x.place || "", MODES[x.mode] || "", x.travelMin == null ? "" : x.travelMin, x.remark || ""]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(A4), "行程");

    var A5 = [["航班編號", "日期", "起飛", "出發", "抵達", "抵達時間", "狀態", "航廈", "閘口", "行李帶", "最後更新", "備註"]];
    DB.flights.slice().sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); }).forEach(function (f) {
      var s = statusOf(f);
      A5.push([f.no, f.date, f.time, f.from, f.to, f.arr || "", s ? (s.ok === false ? (s.reason || "無資料") : (s.statusText || "")) : "", s ? (s.terminal || "") : "", s ? (s.gate || "") : "", s ? (s.baggage || "") : "", s ? (s.fetchedText || "") : "", f.note || ""]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(A5), "航班");

    var A6 = [["酒店", "地址", "入住", "退房", "確認號", "電話", "備註"]];
    DB.hotels.forEach(function (h) { A6.push([h.name, h.addr, h.ci, h.co, h.conf, h.phone, h.note]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(A6), "酒店");

    var name = (DB.trip.name || "trip").replace(/[\\/:*?"<>|\s]+/g, "_") + "_" + todayISO() + ".xlsx";
    XLSX.writeFile(wb, name);
    toast("已下載 " + name);
  } catch (e) { toast("匯出失敗：" + e.message, true); }
}

/* ── 12. 設定：供應商／測試 ────────────────────────────────── */
function applyProvider() {
  var p = pdef();
  S.base = p.base || "";
  S.model = p.model || "";
  $("fBase").value = S.base;
  $("fModel").value = S.model;
  renderSettings();
}
async function testConn() {
  var out = $("testOut");
  out.className = "hint";
  out.textContent = "測試中…";
  try {
    var c = await callModel(effModel(), null);
    out.className = "hint ok";
    out.textContent = "✅ 連線成功・模型：" + effModel() + "\n回覆：" + String(c).trim().slice(0, 40);
  } catch (e) {
    out.className = "hint err";
    out.textContent = "❌ " + e.message;
  }
}
async function listModels() {
  var out = $("modelOut");
  out.className = "hint";
  out.textContent = "查詢中…";
  try {
    var base = effBase();
    var r = await fetch(base + "/models", { headers: { "Authorization": "Bearer " + S.key } });
    var txt = await r.text();
    if (!r.ok) throw new Error(explainHTTP(r.status, txt));
    var j = JSON.parse(txt);
    var arr = j.data || j.models || [];
    var p = pdef();
    var vis = arr.filter(function (m) {
      var id = m.id || m.name || "";
      var im = (m.architecture && m.architecture.input_modalities) || m.input_modalities || m.modalities || [];
      var isImg = Array.isArray(im) && im.indexOf("image") >= 0;
      if (p.visionRx) return isImg || p.visionRx.test(id);
      return isImg;
    });
    var free = vis.filter(function (m) { return /:free$|free/i.test(m.id || ""); });
    var show = (free.length ? free : vis).slice(0, 12);
    out.innerHTML = "✅ 讀到 " + arr.length + " 個模型；支援睇圖 " + vis.length + " 個" + (free.length ? "（當中有 " + free.length + " 個免費）" : "") + "：<br>" +
      show.map(function (m) { return "・" + esc((m.id || m.name) + " " + (m.name && m.id ? "（" + m.name + "）" : "")); }).join("<br>") +
      '<br><span class="hint">打上面任何一個入「模型」欄即可。</span>';
    var dl = $("models");
    dl.innerHTML = show.map(function (m) { return '<option value="' + esc(m.id || m.name) + '"></option>'; }).join("") + dl.innerHTML;
  } catch (e) { out.className = "hint err"; out.textContent = "❌ " + e.message; }
}
async function testGh() {
  var out = $("ghOut");
  out.className = "hint";
  out.textContent = "測試中…";
  try {
    if (!ghOK()) throw new Error("請先填 repo 同 token");
    var r = await fetch("https://api.github.com/repos/" + S.repo, { headers: ghHeaders() });
    var txt = await r.text();
    if (!r.ok) throw new Error("GitHub " + r.status + "：" + msgOf(txt));
    var j = JSON.parse(txt);
    var meta = null;
    try { meta = await ghGetMeta(F_TRIP); } catch (e) { }
    out.className = "hint ok";
    out.textContent = "✅ 連到 " + j.full_name + "（" + (j.private ? "私有" : "公開") + "）" +
      (meta ? "\n已有 " + F_TRIP + "（上次更新 " + String(meta.sha || "").slice(0, 7) + "）" : "\n未見 " + F_TRIP + "，第一次儲存時會自動建立");
  } catch (e) { out.className = "hint err"; out.textContent = "❌ " + e.message; }
}

/* ── 13. 事件繫結 + 啟動 ───────────────────────────────────── */
function bindEvents() {
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
    b.onclick = function () { showView(b.getAttribute("data-v")); };
  });
  $("dayBar").onclick = function (ev) {
    var b = ev.target.closest(".daychip");
    if (!b) return;
    UI.day = b.getAttribute("data-d");
    renderDayBar(); renderItin();
  };
  $("btnAddItin").onclick = function () { editItin(""); };
  $("itinList").onclick = function (ev) {
    var e1 = ev.target.closest("[data-eit]"), d1 = ev.target.closest("[data-dit]");
    if (e1) return editItin(e1.getAttribute("data-eit"));
    if (d1) {
      var id = d1.getAttribute("data-dit");
      if (confirm("刪除呢項行程？")) {
        DB.itinerary = DB.itinerary.filter(function (a) { return a.id !== id; });
        saveRemote(); renderAll();
      }
    }
  };
  $("btnAddFlight").onclick = function () { editFlight(""); };
  $("btnAddHotel").onclick = function () { editHotel(""); };
  $("btnFlyRefresh").onclick = async function () {
    ov(true, "攞緊航班狀態…");
    await pullStatus();
    renderAll();
    ov(false);
    toast(STATUS.updatedTS ? "狀態已更新（" + new Date(STATUS.updatedTS).toLocaleString("zh-HK", { hour12: false }).slice(0, 16) + "）" : "私有資料庫未有狀態檔：Hermes 定時任務未寫入過", !STATUS.updatedTS);
  };
  $("flyList").onclick = function (ev) {
    var e1 = ev.target.closest("[data-efly]"), d1 = ev.target.closest("[data-dfly]");
    if (e1) return editFlight(e1.getAttribute("data-efly"));
    if (d1 && confirm("刪除呢班航班？")) {
      var id = d1.getAttribute("data-dfly");
      DB.flights = DB.flights.filter(function (a) { return a.id !== id; });
      saveRemote(); renderAll();
    }
  };
  $("hotelList").onclick = function (ev) {
    var e1 = ev.target.closest("[data-ehot]"), d1 = ev.target.closest("[data-dhot]");
    if (e1) return editHotel(e1.getAttribute("data-ehot"));
    if (d1 && confirm("刪除呢間酒店？")) {
      var id = d1.getAttribute("data-dhot");
      DB.hotels = DB.hotels.filter(function (a) { return a.id !== id; });
      saveRemote(); renderAll();
    }
  };
  $("btnQuick").onclick = addExpenseManual;
  $("btnPick").onclick = function () { pickPhotoFor("queue"); };
  $("file").onchange = null;
  $("btnXlsx").onclick = exportXlsx;
  $("expList").onclick = function (ev) {
    var e1 = ev.target.closest("[data-eexp]"), d1 = ev.target.closest("[data-dexp]");
    if (e1) return editExpense(e1.getAttribute("data-eexp"), false);
    if (d1 && confirm("刪除呢筆支出？")) {
      var id = d1.getAttribute("data-dexp");
      var ex = DB.expenses.filter(function (a) { return a.id === id; })[0];
      DB.expenses = DB.expenses.filter(function (a) { return a.id !== id; });
      if (ex && ex.rid) phDrop(ex.rid);
      saveRemote(); renderAll();
    }
  };
  $("pendList").onclick = function (ev) {
    var e1 = ev.target.closest("[data-epen]"), d1 = ev.target.closest("[data-dpen]");
    if (e1) return editExpense(e1.getAttribute("data-epen"), true);
    if (d1) {
      var id = d1.getAttribute("data-dpen");
      DB.pending = DB.pending.filter(function (a) { return a.id !== id; });
      saveRemote(); renderAll();
    }
  };
  $("btnCommitAll").onclick = commitPending;
  $("btnClearAll").onclick = function () {
    if (!DB.pending.length) return;
    if (confirm("刪除全部待確認收據？")) { DB.pending = []; saveRemote(); renderAll(); }
  };
  $("eyeBtn").onclick = function () { lsSet("trip.hideAmt", lsGet("trip.hideAmt") === "1" ? "0" : "1"); renderExpenses(); };

  $("edCancel").onclick = closeSheet;
  $("edSave").onclick = function () {
    try { if (!SHEET.save || SHEET.save() !== false) closeSheet(); }
    catch (e) { toast("儲存失敗：" + e.message, true); }
  };
  $("edBody").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.tagName === "INPUT" && ev.target.type !== "date" && ev.target.type !== "time") {
      ev.preventDefault(); $("edSave").click();
    }
  });

  $("fProvider").onchange = function () { S.provider = $("fProvider").value; applyProvider(); };
  $("btnTest").onclick = function () { S.base = fv("fBase"); S.key = fv("fKey"); S.model = fv("fModel"); saveLocal(); testConn(); };
  $("btnModels").onclick = function () { S.base = fv("fBase"); S.key = fv("fKey"); saveLocal(); listModels(); };
  $("btnGhTest").onclick = function () { S.repo = fv("fRepo").trim(); S.token = fv("fToken").trim(); saveLocal(); testGh(); };
  $("btnTripSave").onclick = function () {
    DB.trip.name = fv("tName").trim() || "行程";
    DB.trip.start = fv("tStart") || DB.trip.start;
    DB.trip.end = fv("tEnd") || DB.trip.end;
    DB.trip.from = fv("tFrom").trim().toUpperCase();
    DB.trip.to = fv("tTo").trim().toUpperCase();
    DB.trip.cur = fv("tCur").trim().toUpperCase() || "THB";
    if (dayDiff(DB.trip.start, DB.trip.end) < 0) DB.trip.end = DB.trip.start;
    UI.day = DB.trip.start;
    if (DB.trip.cur && DEF_RATES[DB.trip.cur] == null) { DB.trip.rates = DB.trip.rates || {}; if (DB.trip.rates[DB.trip.cur] == null) DB.trip.rates[DB.trip.cur] = 1; }
    saveRemote(true); renderAll(); showView("itin");
    toast("旅程設定已儲存");
  };
  $("btnSave").onclick = function () {
    S.provider = fv("fProvider"); S.base = fv("fBase"); S.key = fv("fKey"); S.model = fv("fModel");
    S.repo = fv("fRepo").trim(); S.token = fv("fToken").trim();
    S.ratesTxt = fv("fRates").trim();
    if (S.ratesTxt) {
      try {
        var r = JSON.parse(S.ratesTxt);
        DB.trip.rates = Object.assign({}, DEF_RATES, r);
        toast("已儲存（含自訂匯率）");
      } catch (e) { toast("匯率格式要係 JSON，例如 {\"THB\":0.22}", true); return; }
    } else { toast("已儲存"); }
    saveRemote(true); renderAll();
  };
  $("btnWipe").onclick = function () {
    if (!confirm("清除本機快取（設定、行程、相片快取）？\n雲端 repo 嘅資料唔會受影響。")) return;
    try { localStorage.removeItem(LS_SET); localStorage.removeItem(LS_DB); localStorage.removeItem(LS_PH); } catch (e) { }
    location.reload();
  };
  $("btnHard").onclick = function () {
    if ("caches" in window) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); });
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); });
    setTimeout(function () { location.href = "index.html?hard=" + Date.now(); }, 400);
  };
  window.addEventListener("resize", fitViewport);
  window.addEventListener("orientationchange", function () { setTimeout(fitViewport, 250); });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", fitViewport);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && Date.now() - UI.syncT > 60000) {
      pullRemote().then(function () { renderAll(); }).catch(function () { });
    }
  });
}

async function init() {
  try {
    $("verline").innerHTML = "介面版本 <b>v" + VERSION + "</b>" + (VERSION !== "1.0" ? "（如你見到唔係 v1.0，請重新載入）" : "");
  } catch (e) { }
  loadLocal();
  fitViewport();
  bindEvents();
  renderAll();
  showView("itin");
  _booted = true;
  ov(false);

  /* 定位：第一次跑就攞匯率 */
  setTimeout(function () { if (!lsGet("trip.ratesAt")) { refreshRates(); lsSet("trip.ratesAt", "1"); } }, 1200);

  /* 拉雲端資料 */
  if (ghOK()) {
    try { await pullRemote(); renderAll(); } catch (e) { toast("雲端同步失敗：" + e.message, true); }
  }
  parseHash();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { });
  }
}
function parseHash() {
  var h = String(location.hash || "").replace(/^#/, "");
  if (!h) return;
  var p = h.split("&"), v = p[0];
  if (["itin", "fly", "exp", "set"].indexOf(v) >= 0) showView(v);
  p.slice(1).forEach(function (kv) {
    var a = kv.split("=");
    if (a[0] === "add" && a[1] === "expense") addExpenseManual();
    if (a[0] === "add" && a[1] === "flight") editFlight("");
  });
}

/* 保險閘：任何未捕捉錯誤都唔可以卡住白色載入畫面 */
window.addEventListener("error", function () { if (!_booted) { ov(false); } });
window.addEventListener("unhandledrejection", function () { if (!_booted) { ov(false); } });
setTimeout(function () { if (!_booted) ov(false); }, 9000);

document.addEventListener("DOMContentLoaded", function () { init(); });
