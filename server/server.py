import json
import os
import re
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

# ── ログファイル出力（コンソールと同時） ─────────────────────────────────────
class _Tee:
    def __init__(self, stream, path):
        self._stream = stream
        self._file   = open(path, 'a', encoding='utf-8', buffering=1)
    def write(self, data):
        self._stream.write(data)
        self._file.write(data)
    def flush(self):
        self._stream.flush()
        self._file.flush()

_log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         f'server_{datetime.now().strftime("%Y%m%d")}.log')
sys.stdout = _Tee(sys.stdout, _log_path)
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

PORT             = 8766
BASE_DIR         = os.path.dirname(os.path.abspath(__file__))
LIST_FILE        = os.path.join(BASE_DIR, "list.json")
CREDENTIALS_FILE = os.path.join(BASE_DIR, "credentials.json")
SPREADSHEET_ID        = "1ZzfoZ93b6Tqop6ncXrljR3JEoIesZ6kh4nqLWnVQUtI"
SHEET_HITS             = "hits"
SHEET_RESEARCH_TIMING  = "research_timing"
SHEET_REALTIME_LOG     = "realtime_log"
SCOPES                 = ["https://www.googleapis.com/auth/spreadsheets"]

REALTIME_HEADER        = ["日付", "収集件数", "型番一致件数", "ヒット件数", "新規型番件数"]
RESEARCH_TIMING_HEADER = ["日時", "グループ", "社数", "収集件数", "型番一致件数", "ヒット件数", "新規型番件数", "所要時間"]

HITS_HEADER = ["日時", "商品名", "型番", "ASIN", "メルカリURL", "Amazon価格", "メルカリ価格", "pmax", "差益", "ROI(%)", "利益率(%)", "スコア", "画像URL", "判定", "却下理由", "ランク", "購入日時"]
MIN_MARGIN       = 15    # ヒット条件：利益率15%以上
MIN_DIFF         = 800   # ヒット条件：差益800円以上（値引き交渉で1000円以上に到達しやすい金額）
MIN_AMAZON_PRICE = 3000  # Amazon価格の下限
MAX_HITS_PER_ASIN = 1   # 同一ASINのヒット上限
MAX_RANK          = 200000  # Amazonランキング上限（これより圏外は除外。export_frima.pyと統一・2026-06-30）

# 消耗品・アクセサリー型番プレフィックス（除外）
BUNDLE_KEYWORDS = ("個セット", "本セット", "枚セット", "個入り", "個入", "まとめ買い", "Bulk", "bulk")

CONSUMABLE_PREFIXES = (
    "BCI-", "BC-", "CLI-", "PGI-",  # インクカートリッジ
    "CF-VZ", "CF-SZ", "CF-NX",      # バッテリー系
    "VBL-", "VBN-", "VW-VBT",       # ビデオカメラバッテリー
)


def get_sheets_service():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    return build("sheets", "v4", credentials=creds)


def save_research_timing(group, total, elapsed_ms, collected=0, matched=0, hits=0, new_candidates=0):
    try:
        service = get_sheets_service()
        meta  = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
        names = [s["properties"]["title"] for s in meta["sheets"]]
        if SHEET_RESEARCH_TIMING not in names:
            service.spreadsheets().batchUpdate(
                spreadsheetId=SPREADSHEET_ID,
                body={"requests": [{"addSheet": {"properties": {"title": SHEET_RESEARCH_TIMING}}}]},
            ).execute()
            service.spreadsheets().values().update(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_RESEARCH_TIMING}!A1",
                valueInputOption="RAW",
                body={"values": [RESEARCH_TIMING_HEADER]},
            ).execute()
        else:
            # 旧ヘッダー（4列）なら8列に更新
            hres = service.spreadsheets().values().get(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_RESEARCH_TIMING}!A1:H1",
            ).execute()
            current = (hres.get("values") or [[]])[0]
            if current != RESEARCH_TIMING_HEADER:
                service.spreadsheets().values().update(
                    spreadsheetId=SPREADSHEET_ID,
                    range=f"{SHEET_RESEARCH_TIMING}!A1:H1",
                    valueInputOption="RAW",
                    body={"values": [RESEARCH_TIMING_HEADER]},
                ).execute()
        m, s = divmod(elapsed_ms // 1000, 60)
        row = [datetime.now().strftime("%Y-%m-%d %H:%M"), group, total,
               collected, matched, hits, new_candidates, f"{m}分{s}秒"]
        service.spreadsheets().values().append(
            spreadsheetId=SPREADSHEET_ID,
            range=f"{SHEET_RESEARCH_TIMING}!A1",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": [row]},
        ).execute()
        print(f"  → research_timing記録: {group} 社数{total} 収集{collected} 一致{matched} ヒット{hits} 新規{new_candidates} {m}分{s}秒")
    except Exception as e:
        print(f"research_timing保存失敗: {e}")


def save_realtime_log(collected, matched, hits, new_cands):
    try:
        service = get_sheets_service()
        today = datetime.now().strftime("%Y-%m-%d")

        meta  = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
        names = [s["properties"]["title"] for s in meta["sheets"]]
        if SHEET_REALTIME_LOG not in names:
            service.spreadsheets().batchUpdate(
                spreadsheetId=SPREADSHEET_ID,
                body={"requests": [{"addSheet": {"properties": {"title": SHEET_REALTIME_LOG}}}]},
            ).execute()
            service.spreadsheets().values().update(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_REALTIME_LOG}!A1",
                valueInputOption="RAW",
                body={"values": [REALTIME_HEADER]},
            ).execute()

        res  = service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID,
            range=f"{SHEET_REALTIME_LOG}!A1:E",
        ).execute()
        rows = res.get("values", [])

        today_idx = None
        for i, row in enumerate(rows[1:], start=2):
            if row and str(row[0]) == today:
                today_idx = i
                break

        def _int(v):
            try: return int(float(str(v)))
            except: return 0

        if today_idx is not None:
            existing = rows[today_idx - 1]
            new_row = [
                today,
                _int(existing[1] if len(existing) > 1 else 0) + collected,
                _int(existing[2] if len(existing) > 2 else 0) + matched,
                _int(existing[3] if len(existing) > 3 else 0) + hits,
                _int(existing[4] if len(existing) > 4 else 0) + new_cands,
            ]
            service.spreadsheets().values().update(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_REALTIME_LOG}!A{today_idx}:E{today_idx}",
                valueInputOption="RAW",
                body={"values": [new_row]},
            ).execute()
        else:
            service.spreadsheets().values().append(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_REALTIME_LOG}!A1",
                valueInputOption="RAW",
                insertDataOption="INSERT_ROWS",
                body={"values": [[today, collected, matched, hits, new_cands]]},
            ).execute()
        print(f"  → realtime_log: 収集+{collected} 一致+{matched} ヒット+{hits} 新規+{new_cands}")
    except Exception as e:
        print(f"realtime_log保存失敗: {e}")


def ensure_hits_sheet(service):
    meta = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
    names = [s["properties"]["title"] for s in meta["sheets"]]
    if SHEET_HITS not in names:
        service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={"requests": [{"addSheet": {"properties": {"title": SHEET_HITS}}}]},
        ).execute()
        service.spreadsheets().values().update(
            spreadsheetId=SPREADSHEET_ID,
            range=f"{SHEET_HITS}!A1",
            valueInputOption="RAW",
            body={"values": [HITS_HEADER]},
        ).execute()
        print(f"  → '{SHEET_HITS}' シートを作成しました")


def save_hits(matches):
    try:
        service = get_sheets_service()
        ensure_hits_sheet(service)
        now  = datetime.now().strftime("%Y-%m-%d %H:%M")
        rows = []
        for m in matches:
            amazon_price = m.get("amazon_price") or 0
            diff         = m["diff"]
            margin = round(diff / amazon_price * 100, 1) if amazon_price else ""
            roi    = round(diff / m["mercari_price"] * 100, 1) if m["mercari_price"] else ""
            score = round(
                (roi or 0) * 0.5 +
                (margin or 0) * 0.3 +
                (amazon_price or 0) / 1000 * 0.2, 1
            )
            rows.append([
                now,
                m["name"],
                m["model"],
                m["asin"],
                m.get("mercari_url", ""),
                amazon_price or "",
                m["mercari_price"],
                m["pmax"],
                diff,
                roi,
                margin,
                score,
                m.get("image_url", ""),
                "",  # 判定（未精査）
                "",  # 却下理由
                m.get("rank") or "",
                "",  # 購入日時
            ])
        service.spreadsheets().values().append(
            spreadsheetId=SPREADSHEET_ID,
            range=f"{SHEET_HITS}!A1",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": rows},
        ).execute()
        print(f"  → スプレッドシート '{SHEET_HITS}' に{len(rows)}件追記しました")
    except Exception as e:
        print(f"  → スプレッドシート書き込み失敗: {e}")


_item_list_cache:    dict = {}   # list.jsonのキャッシュ（サーバー起動時に一度だけ読み込む）
_pattern_cache:      dict = {}   # 型番→コンパイル済み正規表現のキャッシュ
_seen_hit_asins:     set  = set()  # ヒット済みASIN（サーバー起動中は重複記録しない）
_seen_candidates:    set  = set()  # 候補記録済み型番（セッション内重複防止）

# 新型番候補収集用
SHEET_CANDIDATES  = '新型番候補'
CAND_HEADER       = ['検知日時', '型番', '商品名', 'メルカリ価格', 'URL']
_model_extract_re = re.compile(r'\b[A-Z]{2,}[A-Z0-9\-\/\.]{3,}\b')

def load_list():
    global _item_list_cache, _pattern_cache
    if _item_list_cache:
        return _item_list_cache
    if not os.path.exists(LIST_FILE):
        return {}
    with open(LIST_FILE, "r", encoding="utf-8") as f:
        _item_list_cache = json.load(f)
    _pattern_cache = {
        model.upper(): re.compile(r'(?<![A-Z0-9])' + re.escape(model.upper()) + r'(?![A-Z0-9])')
        for model in _item_list_cache if len(model) >= 5
    }
    return _item_list_cache


TITLE_EXCLUDE_WORDS = [
    # 箱・付属品なし系
    "箱なし", "箱無し", "箱無", "ケースなし", "ケース無し",
    "付属品なし", "付属なし", "説明書なし",
    # 互換・非純正系
    "互換品", "互換", "非純正", "社外品",
    # 消耗品・パーツ系
    "フィルター", "交換用", "交換フィルター", "消耗品", "詰め替え", "レフィル", "パーツ", "部品取り",
    # 状態系
    "ジャンク", "訳あり", "訳アリ", "ダメージ", "傷あり", "難あり",
    # 開封済み系
    "開封済み", "開封済",
    # 動作・状態不良系
    "動作未確認", "動作不良", "現状品", "現状渡し", "故障", "破損",
]

# 型番の直後に「用」が続く場合はアクセサリー（別物）として除外するパターン
_ACCESSORY_SUFFIX = re.compile(r'.{0,3}用')

MAX_HITS_PER_MODEL = 5  # 同一型番のヒット上限（超えたら汎用語とみなす）

def find_matches(mercari_items, item_list):
    global _seen_hit_asins
    matches = []
    seen = set()
    model_hit_count = {}  # 型番ごとのヒット数カウント
    seen_asins      = set()  # 同一ASIN重複防止（このリクエスト内）
    n_model_match   = 0      # 型番文字列一致数（価格チェック前）
    for item in mercari_items:
        title = item.get("name", "")
        if any(w in title for w in TITLE_EXCLUDE_WORDS):
            continue
        title = title.upper()
        try:
            price = int(str(item.get("price", "0")).replace(",", ""))
        except ValueError:
            continue

        for model, data in item_list.items():
            if len(model) < 5:  # 短すぎる型番スキップ（5文字未満）
                continue
            if not any(c.isdigit() for c in model):  # 数字を含まない型番（英字のみ・ハイフン入り英字等）をスキップ
                continue
            # 出品者ゼロ・手数料取得不可と確定済み（価格・手数料が古いまま）は除外
            if data.get("fee_recheck_failed"):
                continue
            # 消耗品プレフィックス除外
            if any(model.upper().startswith(p.upper()) for p in CONSUMABLE_PREFIXES):
                continue
            if any(kw in data.get("title", "") for kw in BUNDLE_KEYWORDS):
                continue
            model_upper = model.upper()
            if model_upper not in title:  # 高速な事前チェック
                continue
            pat = _pattern_cache.get(model_upper)
            if pat and pat.search(title):
                n_model_match += 1
                # 型番の直後に「用」が続く場合はアクセサリー（別物）として除外
                m_pos = pat.search(title)
                if m_pos and _ACCESSORY_SUFFIX.match(title[m_pos.end():m_pos.end()+4]):
                    continue
                pmax         = data.get("pmax") or 0
                amazon_price = data.get("amazon_price") or 0
                diff         = pmax - price
                margin       = round(diff / amazon_price * 100, 1) if amazon_price else 0
                # 同一型番のヒット上限チェック（汎用語フィルタ）
                if model_hit_count.get(model, 0) >= MAX_HITS_PER_MODEL:
                    break
                rank_val = data.get("rank")
                if not data.get("premium") and rank_val and rank_val > MAX_RANK:
                    break
                asin = data.get("asin", "")
                if pmax and price <= pmax and price >= pmax / 3 and margin >= MIN_MARGIN and diff >= MIN_DIFF and amazon_price >= MIN_AMAZON_PRICE and item["name"] not in seen and asin not in seen_asins and asin not in _seen_hit_asins:
                    seen.add(item["name"])
                    seen_asins.add(asin)
                    _seen_hit_asins.add(asin)
                    model_hit_count[model] = model_hit_count.get(model, 0) + 1
                    matches.append({
                        "name":          item["name"],
                        "mercari_price": price,
                        "mercari_url":   item.get("url", ""),
                        "image_url":     item.get("image", ""),
                        "model":         model,
                        "amazon_price":  data.get("amazon_price"),
                        "pmax":          pmax,
                        "asin":          data.get("asin"),
                        "diff":          pmax - price,
                        "rank":          data.get("rank"),
                    })
                break

    matches.sort(key=lambda x: x["diff"], reverse=True)
    return matches, n_model_match


def extract_model(title):
    found = _model_extract_re.findall(title.upper())
    valid = [m for m in found if not m.isalpha() and len(m) >= 5]
    return max(valid, key=len) if valid else ''

def save_candidates(candidates):
    try:
        service = get_sheets_service()
        meta    = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
        names   = [s['properties']['title'] for s in meta['sheets']]
        if SHEET_CANDIDATES not in names:
            service.spreadsheets().batchUpdate(
                spreadsheetId=SPREADSHEET_ID,
                body={'requests': [{'addSheet': {'properties': {'title': SHEET_CANDIDATES}}}]},
            ).execute()
            service.spreadsheets().values().update(
                spreadsheetId=SPREADSHEET_ID,
                range=f'{SHEET_CANDIDATES}!A1',
                valueInputOption='RAW',
                body={'values': [CAND_HEADER]},
            ).execute()
        now  = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        rows = [[now, c['model'], c['name'], c['price'], c['url']] for c in candidates]
        service.spreadsheets().values().append(
            spreadsheetId=SPREADSHEET_ID,
            range=f'{SHEET_CANDIDATES}!A1',
            valueInputOption='RAW',
            insertDataOption='INSERT_ROWS',
            body={'values': rows},
        ).execute()
        print(f'  → 新型番候補 {len(rows)}件を記録')
    except Exception as e:
        print(f'  → 候補記録失敗: {e}')


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/get-manufacturers":
            try:
                creds   = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
                service = build("sheets", "v4", credentials=creds)
                res = service.spreadsheets().values().get(
                    spreadsheetId=SPREADSHEET_ID,
                    range="manufacturers!A2:F",
                ).execute()
                rows = res.get("values", [])
                manufacturers = []
                for row in rows:
                    if not row or not row[0].strip():
                        continue
                    name      = row[0].strip()
                    group     = row[2].strip() if len(row) > 2 else ""
                    enabled   = row[3].strip() if len(row) > 3 else "1"
                    url       = row[4].strip() if len(row) > 4 else ""
                    crawl_url = row[5].strip() if len(row) > 5 else ""
                    if not url:
                        continue
                    manufacturers.append({
                        "name":      name,
                        "url":       url,        # 出品中条件（ASINリサーチ用）
                        "crawl_url": crawl_url,  # 売り切れ条件（型番収集クロール用）
                        "group":     group,
                        "enabled":   enabled,
                    })
                active = [m for m in manufacturers if m["enabled"] != "0"]
                body = json.dumps({"manufacturers": active}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                print(f"メーカーリスト取得失敗: {e}")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/log-timing":
            length = int(self.headers.get("Content-Length", 0))
            body   = self.rfile.read(length)
            try:
                data = json.loads(body)
                t = data.get('type', '')
                if t == 'start':
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] [自動リサーチ開始] {data.get('group','')} {data.get('total',0)}社")
                elif t == 'mfr':
                    elapsed = data.get('elapsed_ms', 0) / 1000
                    print(f"[{datetime.now().strftime('%H:%M:%S')}]   {data.get('name',''):<16} {data.get('item_count',0):>4}件 {elapsed:.1f}秒")
                elif t == 'end':
                    ms            = data.get('elapsed_ms', 0)
                    group         = data.get('group', '')
                    total         = data.get('total', 0)
                    collected     = data.get('collected', 0)
                    matched       = data.get('matched', 0)
                    hits          = data.get('hits', 0)
                    new_candidates = data.get('new_candidates', 0)
                    m, s  = divmod(ms // 1000, 60)
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] [自動リサーチ完了] {total}社 {m}分{s}秒 収集{collected} 一致{matched} ヒット{hits} 新規{new_candidates}")
                    import threading
                    threading.Thread(target=save_research_timing, args=(group, total, ms, collected, matched, hits, new_candidates), daemon=True).start()
                self.send_response(200)
                self._cors()
                self.end_headers()
            except Exception as e:
                print(f"log-timing エラー: {e}")
                self.send_response(500)
                self.end_headers()
            return

        if self.path != "/check-mercari":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)
        try:
            data    = json.loads(body)
            items   = data.get("items", [])
            matches, n_model_match = find_matches(items, load_list())

            # 新型番候補収集（レスポンスに件数を含めるため先に計算）
            item_list = load_list()
            new_cands = []
            for item in items:
                title = item.get('name', '')
                if any(w in title for w in TITLE_EXCLUDE_WORDS):
                    continue
                model = extract_model(title)
                if not model or model in item_list or model in _seen_candidates:
                    continue
                _seen_candidates.add(model)
                price = int(str(item.get('price', '0')).replace(',', ''))
                new_cands.append({'model': model, 'name': title, 'price': price, 'url': item.get('url', '')})

            response_bytes = json.dumps({
                "matches": matches,
                "n_model_match": n_model_match,
                "new_candidates_count": len(new_cands),
            }, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(response_bytes)))
            self.end_headers()
            print(f"[{datetime.now().strftime('%H:%M:%S')}] 収集:{len(items)}件 型番一致:{n_model_match}件 ヒット:{len(matches)}件 新規:{len(new_cands)}件")

            if matches:
                import threading
                threading.Thread(target=save_hits, args=(matches,), daemon=True).start()
                for m in matches:
                    print(f"  ★ {m['model']}  メルカリ¥{m['mercari_price']:,}  差益¥{m['diff']:,}  pmax¥{m['pmax']:,}")

            if new_cands:
                import threading
                threading.Thread(target=save_candidates, args=(new_cands,), daemon=True).start()
                print(f'  → 新型番候補: {len(new_cands)}件')

            import threading
            threading.Thread(target=save_realtime_log, args=(len(items), n_model_match, len(matches), len(new_cands)), daemon=True).start()

            try:
                self.wfile.write(response_bytes)
                self.wfile.flush()
            except (ConnectionAbortedError, BrokenPipeError):
                print("  → レスポンス送信失敗（クライアント切断）")

        except Exception as e:
            print(f"エラー: {e}")
            try:
                self.send_response(500)
                self.end_headers()
            except Exception:
                pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    print("リストとパターンを読み込み中...")
    item_list = load_list()
    print("=" * 45)
    print(f"  ASINチェッカー サーバー  port:{PORT}")
    print(f"  リスト登録件数: {len(item_list)}件")
    print(f"  パターンキャッシュ: {len(_pattern_cache)}件")
    print("  待機中... (Ctrl+C で停止)")
    print("=" * 45)
    HTTPServer(("localhost", PORT), Handler).serve_forever()
