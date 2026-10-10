// ==UserScript==
// @name         Amazon Seller ASIN Scraper
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Amazonセラーストアページ(/s?me=...)の出品ASIN一覧を全ページ抜き出し、asin-toolsサーバー(8766)の/check-asinsへ直接送信してlist.json未登録分を自動処理する（seller-chase発想の転換：競合セラーの出品ASINを仕入れ候補の種にする、2026-10-09新設）。新規追加分の型番・価格・pmaxを画面に一覧表示（10-10追加）。実行前にサーバー起動を確認し、未起動ならスクレイピング前に警告して中断する（10-10追加・サーバー起動忘れで中途半端に終わる事故防止）。Amazon Offer Sellers Scraperからの自動巡回（芋づる式）に対応：localStorageの共有状態を見て、対象セラーのページなら自動的にスクレイピング→送信→次のセラーへ遷移する（10-10追加）。
// @match        https://www.amazon.co.jp/s?me=*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/amazon_seller_scraper.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/amazon_seller_scraper.user.js
// ==/UserScript==

(function () {
    'use strict';

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function scrapeDoc(doc) {
        const items = [];
        doc.querySelectorAll('div[data-asin]').forEach(el => {
            const asin = el.getAttribute('data-asin');
            if (!asin) return;
            const titleEl = el.querySelector('h2 span, h2');
            const priceEl = el.querySelector('.a-price .a-offscreen');
            items.push({
                asin,
                title: titleEl ? titleEl.textContent.trim() : '',
                price: priceEl ? priceEl.textContent.trim() : '',
            });
        });
        return items;
    }

    function getSellerIdFromUrl() {
        return new URL(location.href).searchParams.get('me');
    }

    // 2026-10-10：Amazon Offer Sellers Scraper（別スクリプト）が見つけたセラー一覧を
    // 自動で芋づる式に深掘りするための共有状態。同一オリジン(amazon.co.jp)のlocalStorageを
    // 2本のスクリプト間で共有する（バイヤーチェイスのautoPipelineと同じ考え方）。
    // キー名・状態の形はamazon_offer_sellers_scraper.user.js側と完全に一致させること。
    const DEEP_DIVE_LS_KEY   = 'amazonSellerDeepDiveWalk';
    const DEEP_DIVE_STALE_MS = 2 * 60 * 60 * 1000; // 2時間より古い状態は放棄済みとみなす

    function loadDeepDiveState() {
        try {
            const raw = localStorage.getItem(DEEP_DIVE_LS_KEY);
            if (!raw) return null;
            const state = JSON.parse(raw);
            if (!state.active || Date.now() - state.startedAt > DEEP_DIVE_STALE_MS) return null;
            return state;
        } catch (e) { return null; }
    }
    function saveDeepDiveState(state) { localStorage.setItem(DEEP_DIVE_LS_KEY, JSON.stringify(state)); }
    function clearDeepDiveState() { localStorage.removeItem(DEEP_DIVE_LS_KEY); }

    function mountUI() {
        const sellerId  = getSellerIdFromUrl();
        const walkState = loadDeepDiveState();
        const current   = walkState ? walkState.queue[walkState.currentIndex] : null;
        const inWalk    = !!(current && sellerId && String(current.sellerId) === String(sellerId));

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'position:fixed;bottom:70px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:280px;white-space:pre-wrap;';
        document.body.appendChild(statusEl);

        const resultsEl = document.createElement('div');
        resultsEl.style.cssText = 'position:fixed;bottom:115px;right:20px;z-index:99999;background:rgba(0,0,0,0.9);color:#fff;padding:10px 12px;border-radius:6px;font-size:12px;display:none;max-width:340px;max-height:320px;overflow-y:auto;line-height:1.5;';
        document.body.appendChild(resultsEl);

        function updateStatus(msg, isWarning) {
            statusEl.style.display = 'block';
            statusEl.style.background = isWarning ? 'rgba(180,30,30,0.92)' : 'rgba(0,0,0,0.78)';
            statusEl.textContent = msg;
        }

        function pingServer() {
            return new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'GET', url: 'http://localhost:8766/',
                    timeout: 2000,
                    onload: () => resolve(true),   // 404でも応答があれば起動している
                    onerror: () => resolve(false),
                    ontimeout: () => resolve(false),
                });
            });
        }

        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        function showResults(newItems) {
            if (!newItems || newItems.length === 0) {
                resultsEl.style.display = 'none';
                return;
            }
            const sorted = [...newItems].sort((a, b) => (b.pmax || 0) - (a.pmax || 0));
            resultsEl.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">新規登録 ' + sorted.length + '件</div>' +
                sorted.map(it => {
                    const model = escapeHtml(it.model || '(型番不明)');
                    const title = escapeHtml((it.title || '').slice(0, 28));
                    const pmax = it.pmax != null ? it.pmax + '円' : '-';
                    const price = it.price != null ? it.price + '円' : '-';
                    const flag = it.brand_restricted ? ' 🚫規制' : '';
                    return '<div style="border-top:1px solid rgba(255,255,255,0.15);padding:4px 0;">' +
                        '<b>' + model + '</b> ' + flag + '<br>' + title + '<br>価格' + price + ' / pmax' + pmax +
                        '</div>';
                }).join('');
            resultsEl.style.display = 'block';
        }

        async function scrapeAllPages() {
            const seen = new Map();
            const url = new URL(location.href);
            let page = 1;
            let emptyStreak = 0;
            while (page <= 50 && emptyStreak < 2) {
                url.searchParams.set('page', String(page));
                const res = await fetch(url.toString(), { credentials: 'include' });
                const html = await res.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const items = scrapeDoc(doc);
                if (items.length === 0) {
                    emptyStreak++;
                } else {
                    emptyStreak = 0;
                    items.forEach(it => seen.set(it.asin, it));
                }
                updateStatus(page + 'ページ目まで取得 (' + seen.size + '件)');
                page++;
                await sleep(1500);
            }
            return [...seen.values()];
        }

        // 2026-10-10：サーバー側はGoogleスプレッドシート/SP-APIの処理を済ませてから応答する
        // ため、保存（SP-API処理）自体は成功したのに応答だけ届かない既知の無害なケース
        // （ConnectionAbortedError）がある。本当にサーバー未起動なら接続エラーはほぼ即時に
        // 返るのに対し、このケースは数秒後に発生するため、経過時間で区別する
        // （バイヤーチェイスv6.6と同じ教訓）。
        const LIKELY_SAVED_AFTER_MS = 2000;
        function sendToCheckAsins(asins, source) {
            const startedAt = Date.now();
            return new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'POST', url: 'http://localhost:8766/check-asins',
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ asins, source }),
                    timeout: 300000, // ASIN数次第で時間がかかるため長めに取る
                    onload: res => { try { resolve(JSON.parse(res.responseText)); } catch (e) { resolve(null); } },
                    onerror: () => resolve(Date.now() - startedAt >= LIKELY_SAVED_AFTER_MS ? { ok: true, uncertain: true } : null),
                    ontimeout: () => resolve(Date.now() - startedAt >= LIKELY_SAVED_AFTER_MS ? { ok: true, uncertain: true } : null),
                });
            });
        }

        // 手動ボタン・自動巡回の両方から呼ぶ共通処理。
        async function runScrapeAndCheck(source) {
            updateStatus('サーバー確認中...');
            const serverUp = await pingServer();
            if (!serverUp) {
                updateStatus('⚠️ asin-toolsサーバー(8766)が起動していません。先に起動してからやり直してください（今回はスクレイピングを行いません）', true);
                return { ok: false, reason: 'server_down' };
            }
            updateStatus('取得中...');
            const items = await scrapeAllPages();
            const asinList = items.map(it => it.asin);
            GM_setClipboard(asinList.join('\n'));
            updateStatus(items.length + '件のASINを取得。list.jsonと照合して新規分を処理中...（時間がかかります）');
            const result = await sendToCheckAsins(asinList, source);
            if (result && result.ok && result.uncertain) {
                updateStatus('完了（おそらく成功）：取得' + items.length + '件のASINを送信しましたが、応答が届かず詳細は確認できませんでした（ASIN一覧はクリップボードにコピー済み）');
                showResults(null);
                return { ok: true, items, uncertain: true };
            } else if (result && result.ok) {
                updateStatus(
                    '完了！ 取得' + items.length + '件 / 新規' + result.new + '件を処理 / 既知' + result.already_known + '件はスキップ' +
                    '\n（ASIN一覧はクリップボードにもコピー済み）'
                );
                showResults(result.results);
                return { ok: true, items, result };
            } else {
                updateStatus('完了: ' + items.length + '件のASINをコピーしました。ただしサーバーへの送信に失敗しました（起動中に落ちた可能性があります）', true);
                showResults(null);
                return { ok: false, reason: 'send_failed', items };
            }
        }

        if (inWalk) {
            // 2026-10-10：Amazon Offer Sellers Scraperからの自動巡回中。ボタンは出さず、
            // このセラーのスクレイピング→送信を自動で行い、終わったら次のセラーへ遷移する。
            updateStatus(`🔗芋づる巡回中 (${walkState.currentIndex + 1}/${walkState.queue.length})：${current.sellerName}`);
            (async () => {
                const source = 'セラー芋づる:' + current.sellerName;
                const outcome = await runScrapeAndCheck(source);
                if (!outcome.ok) {
                    // 失敗時は状態を進めず巡回を停止（サーバー起動確認後、ページ再読み込みで
                    // 同じセラーから再開できる）。
                    return;
                }
                walkState.currentIndex++;
                if (walkState.currentIndex >= walkState.queue.length) {
                    clearDeepDiveState();
                    updateStatus(statusEl.textContent + '\n\n🔗芋づる巡回、全セラー完了！');
                } else {
                    saveDeepDiveState(walkState);
                    const next = walkState.queue[walkState.currentIndex];
                    setTimeout(() => {
                        location.href = `https://www.amazon.co.jp/s?me=${next.sellerId}`;
                    }, 1200);
                }
            })();
            return; // 通常のボタンは出さない
        }

        // --- 通常の手動ボタン ---
        const btn = document.createElement('button');
        btn.textContent = 'ASIN一覧を抜き出す';
        btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 20px;background:#FF9900;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn);

        btn.onclick = async () => {
            btn.disabled = true;
            showResults(null);
            const source = 'Amazon出品者追跡:' + (sellerId || '不明');
            await runScrapeAndCheck(source);
            btn.disabled = false;
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
