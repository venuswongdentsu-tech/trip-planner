#!/usr/bin/env python3
"""旅程助手 · 航班實時狀態抓取器（Hermes 定時任務用；純腳本，唔用 LLM）

做啲乜：
  1. 由你嘅 GitHub 私有 repo 讀 trip.json，睇你有邊幾班機
  2. 抓香港國際機場官方航班資料（hongkongairport.com flightinfo-rest）
  3. 寫入 flight-status.json（app 唔可以直接叫機場 API：帶 Origin 會 403）

節奏（喺行程期內外自動調整）：
  · 航班當日（前後 1 日）→ 每次跑都抓（cron 每 15 分鐘）
  · 其他日子          → 每 20 小時最多抓一次
  · 航班距今 > 14 日   → 唔呼叫機場（資料未開放），只記錄原因同開放日期

環境：GH_TOKEN 或 ~/.hermes/github_token（需要該 repo Contents: Read and write）
"""
import os
import sys
import json
import base64
import datetime as dt
import urllib.request
import urllib.error

HK = dt.timezone(dt.timedelta(hours=8))
TOK_FILE = os.path.expanduser("~/.hermes/github_token")
REPO = os.environ.get("TRIP_DATA_REPO", "venuswongdentsu-tech/trip-planner-data")
API = "https://api.github.com"
HKIA = "https://www.hongkongairport.com/flightinfo-rest/rest/flights"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Safari/605.1.15")   # 機場擋 Python 預設 UA
LEAD_DAYS = 14          # 機場只開放 D+14 以內嘅航班資料
DAILY_EVERY_H = 20      # 非行程期：每 20 小時最多抓一次


def log(*a):
    print(*a, flush=True)


def token():
    t = (os.environ.get("GH_TOKEN") or "").strip()
    if not t:
        # 旅程專用 token 優先（~/.hermes/github_token.trip），唔會影響其他 App 用嘅主 token
        for p in (TOK_FILE + ".trip", TOK_FILE):
            if os.path.exists(p):
                t = open(p).read().strip()
                if t:
                    break
    return t


TOK = token()


def gh(method, path, body=None, ok=(200, 201, 204)):
    url = API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "trip-flight-status")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            txt = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(txt) if txt.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, {"message": e.read().decode("utf-8", "replace")[:300]}
    except Exception as e:
        return 0, {"message": str(e)}


def gh_get_json(path):
    st, j = gh("GET", "/repos/%s/contents/%s?ref=main&nc=%d" % (REPO, path, int(dt.datetime.now().timestamp())))
    if st != 200 or not j.get("content"):
        return None, None
    raw = base64.b64decode(j["content"]).decode("utf-8", "replace")
    try:
        return json.loads(raw), j.get("sha")
    except Exception as e:
        log("! %s 唔係有效 JSON：%s" % (path, e))
        return None, j.get("sha")


def gh_put_json(path, obj, msg):
    st, cur = gh("GET", "/repos/%s/contents/%s" % (REPO, path))
    body = {"message": msg, "content": base64.b64encode(
        json.dumps(obj, ensure_ascii=False, indent=1).encode()).decode()}
    if st == 200 and cur.get("sha"):
        body["sha"] = cur["sha"]
    st, j = gh("PUT", "/repos/%s/contents/%s" % (REPO, path), body)
    if st in (200, 201):
        return True
    log("! 寫入 %s 失敗 %s：%s" % (path, st, str(j.get("message", ""))[:160]))
    return False


def hkia(date, arrival):
    url = "%s?span=1&date=%s&lang=en&cargo=false&arrival=%s" % (HKIA, date, "true" if arrival else "false")
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def norm(no):
    return "".join(ch for ch in str(no).upper() if ch.isalnum())


def pick(records, no, date):
    """喺機場回應入面搵返呢班機（會計埋共用航班 codeshare）

    回應格式：[{"date":"YYYY-MM-DD","arrival":bool,"list":[{...},{...}]}]
    注意：回應可以含多過一日（例如前一晚嘅尾班），所以優先只認目標日期。
    """
    want = norm(no)

    def scan(days):
        for day in days:
            for rec in (day.get("list") if isinstance(day, dict) else None) or []:
                for f in (rec.get("flight") or []):
                    if norm(f.get("no", "")) == want:
                        return rec
        return None

    days = [d for d in (records or []) if isinstance(d, dict)]
    same = [d for d in days if str(d.get("date") or "") == str(date)]
    return scan(same) or scan(days)


def main():
    if not TOK:
        log("✗ 冇 token")
        return 1
    now = dt.datetime.now(HK)
    today = now.strftime("%Y-%m-%d")

    trip, _ = gh_get_json("trip.json")
    if not trip:
        log("・私有 repo 未有 trip.json（未發佈過資料），今次唔做嘢")
        return 0

    flights = trip.get("flights") or []
    if not flights:
        log("・trip.json 未有航班，今次唔做嘢")
        return 0

    prev, _ = gh_get_json("flight-status.json") or ({}, None)
    prev = prev or {}
    prev_map = prev.get("flights") or {}
    last_fetch = 0
    try:
        last_fetch = float(prev.get("lastFetchTS") or 0)
    except Exception:
        last_fetch = 0

    trip_start = (trip.get("trip") or {}).get("start") or ""
    trip_end = (trip.get("trip") or {}).get("end") or ""

    # ── 快慢節奏：行程期內每次跑都抓；之外每 20 小時一次
    in_window = False
    try:
        if trip_start and trip_end:
            a = dt.datetime.strptime(trip_start, "%Y-%m-%d").date() - dt.timedelta(days=1)
            b = dt.datetime.strptime(trip_end, "%Y-%m-%d").date() + dt.timedelta(days=1)
            in_window = a <= now.date() <= b
    except Exception:
        pass
    if not in_window and last_fetch and (now.timestamp() - last_fetch) < DAILY_EVERY_H * 3600:
        hrs = (now.timestamp() - last_fetch) / 3600.0
        log("・非行程期，上次抓取 %.1f 小時前（< %d 小時）→ 今次跳過" % (hrs, DAILY_EVERY_H))
        return 0

    # ── 需要邊幾個日期嘅機場資料
    need = {}          # date -> set(departure?) True=離港
    out_map = {}
    for f in flights:
        no = str(f.get("no") or "").strip().upper()
        d = str(f.get("date") or "").strip()
        if not no or not d:
            continue
        frm = norm(f.get("from"))
        to = norm(f.get("to"))
        if frm == "HKG":
            direction = "departure"
        elif to == "HKG":
            direction = "arrival"
        else:
            out_map[norm(no) + "|" + d] = {
                "no": no, "date": d, "ok": False,
                "reason": "呢班機唔喺香港國際機場起降，暫未支援實時狀態（可以自己喺備註寫低）",
                "fetchedAt": now.isoformat(),
            }
            continue
        try:
            fday = dt.datetime.strptime(d, "%Y-%m-%d").date()
        except Exception:
            out_map[norm(no) + "|" + d] = {"no": no, "date": d, "ok": False,
                                           "reason": "航班日期格式唔啱（要 YYYY-MM-DD）",
                                           "fetchedAt": now.isoformat()}
            continue
        key = norm(no) + "|" + d
        days_ahead = (fday - now.date()).days
        if days_ahead > LEAD_DAYS:
            out_map[key] = {
                "no": no, "date": d, "direction": direction, "ok": False,
                "reason": "機場只喺航班前 %d 日開放資料，%s 之後先有得睇" % (
                    LEAD_DAYS, (fday - dt.timedelta(days=LEAD_DAYS)).strftime("%Y-%m-%d")),
                "openFrom": (fday - dt.timedelta(days=LEAD_DAYS)).strftime("%Y-%m-%d"),
                "scheduled": str(f.get("time") or ""), "fetchedAt": now.isoformat(),
            }
            continue
        if days_ahead < -91:
            out_map[key] = {"no": no, "date": d, "direction": direction, "ok": False,
                            "reason": "航班日期太舊，機場唔再提供", "fetchedAt": now.isoformat()}
            continue
        need.setdefault(d, set())
        if direction == "arrival":
            need[d].add("arr")
        else:
            need[d].add("dep")

    cache = {}
    kept = {}
    for key, s in out_map.items():
        kept[key] = s

    for d in sorted(need):
        for kind in sorted(need[d]):
            ck = (d, kind)
            if ck in cache:
                continue
            try:
                cache[ck] = hkia(d, kind == "arr")
                log("・抓 %s %s：%d 班" % (d, "抵港" if kind == "arr" else "離港",
                                          len(cache[ck][0].get("list", [])) if cache[ck] else 0))
            except Exception as e:
                cache[ck] = None
                log("! 抓 %s %s 失敗：%s" % (d, kind, e))

    for f in flights:
        no = str(f.get("no") or "").strip().upper()
        d = str(f.get("date") or "").strip()
        if not no or not d:
            continue
        key = norm(no) + "|" + d
        if key in kept:
            continue
        frm, to = norm(f.get("from")), norm(f.get("to"))
        kind = "arr" if (frm != "HKG" and to == "HKG") else "dep"
        direction = "arrival" if kind == "arr" else "departure"
        res = cache.get((d, kind))
        base = {
            "no": no, "date": d, "direction": direction,
            "scheduled": str(f.get("time") or ""),
            "fetchedAt": now.isoformat(),
            "fetchedText": now.strftime("%Y-%m-%d %H:%M") + " (香港時間)",
        }
        if not res:
            base.update({"ok": False, "reason": "機場資料暫時抓唔到，稍後會自動再試"})
            kept[key] = base
            continue
        rec = pick(res, no, d)
        if not rec:
            base.update({"ok": False, "reason": "機場今日清單見唔到呢班機（可能係代碼／日期唔同，或者航班未入機場系統）"})
            kept[key] = base
            continue
        codes = [x.get("no", "").strip() for x in (rec.get("flight") or [])]
        s = {
            "no": no, "date": d, "direction": direction, "ok": True,
            "scheduled": rec.get("time") or f.get("time") or "",
            "statusText": (rec.get("status") or "").strip() or "機場未公佈狀態",
            "airline": codes[0] if codes else "",
            "codeshares": codes,
            "terminal": rec.get("terminal") or "",
            "gate": rec.get("gate") or "",
            "aisle": rec.get("aisle") or "",
            "stand": rec.get("stand") or "",
            "baggage": rec.get("baggage") or "",
            "hall": rec.get("hall") or "",
            "city": (rec.get("destination") or rec.get("origin") or [""])[0],
            "fetchedAt": now.isoformat(),
            "fetchedText": now.strftime("%Y-%m-%d %H:%M") + " (香港時間)",
            "source": "香港國際機場官方航班資料",
        }
        kept[key] = s
        log("・%s %s：%s / 航廈 %s / %s %s" % (
            no, d, s["statusText"], s["terminal"] or "-",
            "行李帶" if direction == "arrival" else "閘口",
            s["baggage"] or s["gate"] or "-"))

    doc = {
        "updated": now.isoformat(),
        "updatedText": now.strftime("%Y-%m-%d %H:%M") + " (香港時間)",
        "source": "香港國際機場官方航班資料（hongkongairport.com）",
        "range": "機場只開放 D-91 至 D+14 嘅航班資料",
        "lastFetchTS": int(now.timestamp()),
        "flights": kept,
    }
    if gh_put_json("flight-status.json", doc, "flight-status: %s" % doc["updatedText"]):
        okN = sum(1 for v in kept.values() if v.get("ok"))
        log("✓ 已寫入 flight-status.json（%d/%d 班有資料）" % (okN, len(kept)))
    else:
        log("✗ 寫入失敗")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
