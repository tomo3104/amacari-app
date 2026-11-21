// ==UserScript==
// @name         QS販売数係（Amacari）
// @namespace    amacari
// @version      1.1
// @description  精査待ちの商品のAmazonページを順に開き、クイックショップの「過去の販売数」を読み取ってAmacariに送る。専用タブでだけ動く。
// @match        https://www.amazon.co.jp/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

/*
 * 使い方（2026-11-21）
 *  メインPC（夜）：https://www.amazon.co.jp/?amacari_qs=main を開く（一気通貫バッチが自動で開く）
 *  ミニPC（昼）  ：https://www.amazon.co.jp/?amacari_qs=mini を開いたままにする
 *    → メインPCが動いている間（合図が10分以内）は待機、止まったら引き継ぐ（判定は server.py 側）
 *  止める：画面左下の「停止」ボタン、またはそのタブを閉じる
 *
 *  動くのは上のURLで開始したタブだけ（sessionStorageの印）。普段のAmazon閲覧には影響しない。
 *  ASINリサーチのサーバー（localhost:8766）の /qs/queue・/qs/result を使う（qs_sales.py）。
 */
(function () {
  "use strict";
  const SERVER = "http://localhost:8766";
  const KEY_WORKER = "amacariQsWorker";
  const KEY_EXPECT = "amacariQsExpect";
  const KEY_STATS = "amacariQsStats";
  const INTERVAL_SEC = { main: 20, mini: 60 };   // 1件ごとの間隔
  const IDLE_WAIT_MIN = 5;                        // キューが空/待機のときの再確認間隔
  const ERROR_WAIT_MIN = 2;                       // サーバーに繋がらないとき
  const CAPTCHA_WAIT_MIN = 30;                    // ロボット確認が出たとき
  // クイックショップの表が出るまで待つ上限。v1.1：ミニPCはページ表示が遅く、1件目が
  // 25秒で間に合わず「表なし」になったため延長＋出なければ1回だけ再読み込みして再挑戦。
  const READ_TIMEOUT_SEC = { main: 30, mini: 60 };
  const KEY_RETRY = "amacariQsRetry";

  // ---- 開始／停止の印 ----
  const params = new URLSearchParams(location.search);
  const startParam = params.get("amacari_qs");
  if (startParam === "stop") { sessionStorage.removeItem(KEY_WORKER); return; }
  if (startParam === "main" || startParam === "mini") {
    sessionStorage.setItem(KEY_WORKER, startParam);
    sessionStorage.removeItem(KEY_EXPECT);
  }
  const worker = sessionStorage.getItem(KEY_WORKER);
  if (!worker) return;

  const stats = JSON.parse(sessionStorage.getItem(KEY_STATS) || '{"ok":0,"nodata":0,"since":""}');
  if (!stats.since) stats.since = new Date().toLocaleString("ja-JP");
  const saveStats = () => sessionStorage.setItem(KEY_STATS, JSON.stringify(stats));

  // ---- 状態表示（左下） ----
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#1b2733;color:#fff;" +
    "font:12px/1.5 sans-serif;padding:8px 10px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);max-width:340px;";
  const label = document.createElement("div");
  const stopBtn = document.createElement("button");
  stopBtn.textContent = "停止";
  stopBtn.style.cssText = "margin-top:6px;font:12px sans-serif;";
  stopBtn.onclick = () => { sessionStorage.removeItem(KEY_WORKER); sessionStorage.removeItem(KEY_EXPECT); setStatus("停止しました（このタブは閉じてOK）"); clearTimeout(timerId); };
  box.append(label, stopBtn);
  document.body.appendChild(box);
  function setStatus(msg) {
    label.textContent = `📦 QS販売数係［${worker === "main" ? "メインPC" : "ミニPC"}］\n` +
      `取得 ${stats.ok}件 / 表なし ${stats.nodata}件（${stats.since}〜）\n${msg}`;
    label.style.whiteSpace = "pre-wrap";
  }
  let timerId = null;
  const later = (fn, sec) => { clearTimeout(timerId); timerId = setTimeout(fn, sec * 1000); };

  // ---- サーバーとのやり取り ----
  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: SERVER + path, timeout: 90000,
        headers: body ? { "Content-Type": "application/json" } : {},
        data: body ? JSON.stringify(body) : undefined,
        onload: r => { try { r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(new Error("HTTP " + r.status)); } catch (e) { reject(e); } },
        onerror: () => reject(new Error("サーバーに接続できません")),
        ontimeout: () => reject(new Error("サーバー応答なし")),
      });
    });
  }

  async function goNext() {
    setStatus("次の商品を問い合わせ中…");
    let q;
    try {
      q = await request("GET", `/qs/queue?worker=${worker}&n=1`);
    } catch (e) {
      setStatus(`⚠ ${e.message}（${ERROR_WAIT_MIN}分後に再試行）`);
      return later(goNext, ERROR_WAIT_MIN * 60);
    }
    if (q.status === "standby") {
      setStatus(`メインPCが担当中のため待機（合図 ${q.main_last}）\n${IDLE_WAIT_MIN}分後に再確認`);
      return later(goNext, IDLE_WAIT_MIN * 60);
    }
    if (!q.asins || q.asins.length === 0) {
      setStatus(`精査待ちは全部取得済み。${IDLE_WAIT_MIN}分後に再確認`);
      return later(goNext, IDLE_WAIT_MIN * 60);
    }
    const asin = q.asins[0];
    sessionStorage.setItem(KEY_EXPECT, asin);
    setStatus(`残り約${q.pending_total}件 → ${asin} を開きます`);
    location.href = `https://www.amazon.co.jp/dp/${asin}`;
  }

  // ---- クイックショップの表を読む ----
  function readQs() {
    const tds = [...document.querySelectorAll("td")].filter(td => (td.textContent || "").trim() === "過去の販売数");
    if (!tds.length) return null;
    const table = tds[0].closest("table");
    if (!table) return null;
    const t = (table.innerText || "").replace(/\s+/g, " ");
    const row = lab => { const m = t.match(new RegExp(lab + "\\s+(\\d+)\\s+(\\d+)")); return m ? [+m[1], +m[2]] : null; };
    const m1 = row("1ヶ月前"), m2 = row("2ヶ月前"), m3 = row("3ヶ月前"), total = row("3ヶ月合計"), avg = row("月間平均");
    if (!avg && !total) return null;
    const r = {
      m1: m1 && m1[0], m2: m2 && m2[0], m3: m3 && m3[0],
      total: total && total[0], avg: avg && avg[0],
    };
    // 出品者数（メイン商品の欄：<span>出品者数</span> の周り。関連商品側は<th>なので除外）
    for (const sp of document.querySelectorAll("span")) {
      if ((sp.textContent || "").trim() !== "出品者数") continue;
      let el = sp.parentElement;
      for (let i = 0; el && i < 4; i++, el = el.parentElement) {
        const m = (el.innerText || "").replace(/\s+/g, " ").match(/出品者数\s*新品\s*(\d+)\s*中古\s*(\d+)/);
        if (m) { r.new_sellers = +m[1]; r.used_sellers = +m[2]; break; }
      }
      if (r.new_sellers !== undefined) break;
    }
    return r;
  }

  const isCaptcha = () => !!document.querySelector('form[action*="validateCaptcha"]') ||
    /ロボットではありません|文字を入力してください/.test(document.body.innerText.slice(0, 2000));

  async function handleProductPage(asin) {
    if (isCaptcha()) {
      setStatus(`⚠ Amazonのロボット確認が出ました。${CAPTCHA_WAIT_MIN}分休みます`);
      return later(() => { location.href = "https://www.amazon.co.jp/"; }, CAPTCHA_WAIT_MIN * 60);
    }
    setStatus(`${asin} のクイックショップ表示を待っています…`);
    const started = Date.now();
    const limit = (READ_TIMEOUT_SEC[worker] || 60) * 1000;
    let data = null;
    while (Date.now() - started < limit) {
      data = readQs();
      if (data) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!data && sessionStorage.getItem(KEY_RETRY) !== asin) {
      // 1回だけ再読み込みして再挑戦（表示が遅いだけのことが多い）
      sessionStorage.setItem(KEY_RETRY, asin);
      setStatus(`${asin} 表が出ないので再読み込みして再挑戦します`);
      location.reload();
      return;
    }
    sessionStorage.removeItem(KEY_RETRY);
    const payload = Object.assign({ asin, worker, status: data ? "ok" : "nodata" }, data || {});
    try {
      await request("POST", "/qs/result", payload);
      if (data) stats.ok++; else stats.nodata++;
      saveStats();
    } catch (e) {
      setStatus(`⚠ 保存失敗：${e.message}（${ERROR_WAIT_MIN}分後に次へ）`);
      sessionStorage.removeItem(KEY_EXPECT);
      return later(goNext, ERROR_WAIT_MIN * 60);
    }
    sessionStorage.removeItem(KEY_EXPECT);
    const wait = INTERVAL_SEC[worker] || 60;
    setStatus((data ? `✅ ${asin} 月平均${data.avg ?? "-"}個（新品${data.new_sellers ?? "-"}人）` : `– ${asin} 表なし`) + `\n${wait}秒後に次へ`);
    later(goNext, wait);
  }

  // ---- 起動 ----
  const expect = sessionStorage.getItem(KEY_EXPECT);
  const here = (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1];
  if (expect && here === expect) {
    handleProductPage(expect);
  } else if (expect && isCaptcha()) {
    setStatus(`⚠ Amazonのロボット確認が出ました。${CAPTCHA_WAIT_MIN}分休みます`);
    later(() => { location.href = "https://www.amazon.co.jp/"; }, CAPTCHA_WAIT_MIN * 60);
  } else {
    if (expect) {
      // 商品ページにたどり着けなかった（転送・削除済み等）→ 表なしとして記録して次へ
      request("POST", "/qs/result", { asin: expect, worker, status: "nodata" }).catch(() => {});
      sessionStorage.removeItem(KEY_EXPECT);
    }
    later(goNext, 3);
  }
})();
