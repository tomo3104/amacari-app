// ==UserScript==
// @name         Amazon Offer Sellers Scraper
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Amazonの「他の出品者から購入」ページ(/gp/offer-listing/ASIN)から、そのASINを現在販売している他セラーの一覧を抜き出す（競合発見ループの輪を広げる用、2026-10-09新設）。見つけたセラーをasin-toolsサーバー(8766)の/track-amazon-sellersへ送り定点観測（同じセラーが別ASINでも繰り返し出てくるほど、メルカリ仕入れ→Amazon販売の濃厚候補という仮説、2026-10-10追加）。見つけた全セラーのストアページへ自動巡回し、amazon_seller_scraper.user.jsに出品ASIN抜き出し→list.json登録まで行わせる芋づる式の全自動深掘りに対応（2026-10-10追加）。
// @match        https://www.amazon.co.jp/gp/offer-listing/*
// @match        https://www.amazon.co.jp/*/gp/offer-listing/*
// @match        https://www.amazon.co.jp/dp/*
// @match        https://www.amazon.co.jp/*/dp/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    function getAsinFromUrl() {
        const m = location.pathname.match(/\/(?:gp\/offer-listing|dp)\/([A-Z0-9]{10})/);
        return m ? m[1] : null;
    }

    // 2026-10-09：調査の結果、1オファーごとに aod-offer-heading（コンディション）→
    // aod-offer-shipsFrom（発送元）→ aod-offer-soldBy（セラー名＋プロフィールリンク）が
    // この順でDOM上に出現することが判明。出現順に走査して1オファーずつ組み立てる。
    function scrapeOffers() {
        const nodes = document.querySelectorAll('[id="aod-offer-heading"], [id="aod-offer-shipsFrom"], [id="aod-offer-soldBy"]');
        const offers = [];
        let current = null;
        nodes.forEach(el => {
            if (el.id === 'aod-offer-heading') {
                current = { condition: el.textContent.trim(), shipsFrom: '', sellerId: null, sellerName: '' };
                offers.push(current);
            } else if (!current) {
                return;
            } else if (el.id === 'aod-offer-shipsFrom') {
                current.shipsFrom = el.textContent.replace('出荷元', '').trim();
            } else if (el.id === 'aod-offer-soldBy') {
                const a = el.querySelector('a[href*="seller="]');
                if (a) {
                    const m = a.href.match(/seller=([A-Z0-9]{10,})/);
                    current.sellerId = m ? m[1] : null;
                    current.sellerName = a.textContent.trim();
                } else {
                    current.sellerName = el.textContent.replace('販売元', '').trim();
                }
            }
        });
        return offers;
    }

    function buildReport() {
        const offers = scrapeOffers();
        const fbaNew = offers.filter(o => o.condition.includes('新品') && o.shipsFrom === 'Amazon' && o.sellerId);
        const seen = new Map();
        for (const o of fbaNew) {
            if (!seen.has(o.sellerId)) seen.set(o.sellerId, o.sellerName);
        }

        const lines = [];
        lines.push(`全オファー数: ${offers.length} / 新品・FBA(出荷元Amazon)のセラー数: ${seen.size}`);
        lines.push('');
        lines.push('sellerId\tsellerName\tストアURL');
        for (const [id, name] of seen) {
            lines.push(`${id}\t${name}\thttps://www.amazon.co.jp/s?me=${id}`);
        }
        const sellers = [...seen].map(([sellerId, sellerName]) => ({ sellerId, sellerName }));
        return { report: lines.join('\n'), sellers };
    }

    // 2026-10-10：amacari-tools/server.pyの/collect-items・/check-asinsと同じく、
    // サーバー側はGoogleスプレッドシートへの読み書きを済ませてから応答するため、保存自体は
    // 成功したのに応答だけ届かない（ConnectionAbortedError、既知の無害なパターン）ことがある。
    // 本当にサーバー未起動なら接続エラーはほぼ即時に返るのに対し、このケースは数秒後に
    // 発生するため、経過時間で区別する（バイヤーチェイスv6.6と同じ教訓）。
    const LIKELY_SAVED_AFTER_MS = 2000;
    function trackAmazonSellers(sellers, asin) {
        if (sellers.length === 0) return Promise.resolve({ ok: true, results: [] });
        const startedAt = Date.now();
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST', url: 'http://localhost:8766/track-amazon-sellers',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ sellers, asin }),
                timeout: 30000,
                onload: res => {
                    try { resolve({ ok: true, ...JSON.parse(res.responseText) }); }
                    catch (e) { resolve({ ok: false }); }
                },
                onerror: () => resolve({ ok: Date.now() - startedAt >= LIKELY_SAVED_AFTER_MS, unknown: true }),
                ontimeout: () => resolve({ ok: Date.now() - startedAt >= LIKELY_SAVED_AFTER_MS, unknown: true }),
            });
        });
    }

    // 2026-10-10：見つけたセラーのストアページへ自動で巡回し、amazon_seller_scraper.user.js
    // 側にそのまま出品ASIN抜き出し→list.json登録までやらせる（芋づる式の深掘りを全自動化）。
    // 両スクリプトはamazon.co.jp上の同一オリジンなので、localStorageで状態を共有できる。
    // キー名・状態の形はamazon_seller_scraper.user.js側と完全に一致させること。
    const DEEP_DIVE_LS_KEY     = 'amazonSellerDeepDiveWalk';
    const DEEP_DIVE_NAV_DELAY_MS = 1200;

    function startDeepDiveWalk(sellers, originAsin) {
        const state = {
            active: true,
            startedAt: Date.now(),
            originAsin,
            queue: sellers.map(s => ({ sellerId: s.sellerId, sellerName: s.sellerName })),
            currentIndex: 0,
        };
        localStorage.setItem(DEEP_DIVE_LS_KEY, JSON.stringify(state));
        const first = state.queue[0];
        setTimeout(() => {
            location.href = `https://www.amazon.co.jp/s?me=${first.sellerId}`;
        }, DEEP_DIVE_NAV_DELAY_MS);
    }

    function mountUI() {
        const btn = document.createElement('button');
        btn.textContent = '他セラー一覧を抽出';
        btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;padding:12px 20px;background:#FF6F00;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.6);';
        document.body.appendChild(btn);

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'position:fixed;top:70px;right:20px;z-index:2147483647;background:rgba(0,0,0,0.9);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
        document.body.appendChild(statusEl);

        const resultsEl = document.createElement('div');
        resultsEl.style.cssText = 'position:fixed;top:115px;right:20px;z-index:2147483647;background:rgba(0,0,0,0.92);color:#fff;padding:10px 12px;border-radius:6px;font-size:12px;display:none;max-width:360px;max-height:320px;overflow-y:auto;line-height:1.5;';
        document.body.appendChild(resultsEl);

        function updateStatus(msg) {
            statusEl.style.display = 'block';
            statusEl.textContent = msg;
        }

        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        // 2026-10-10：出現回数2回以上＝今回より前の別ASINでも見つかったセラー＝
        // メルカリ仕入れ→Amazon販売の濃厚候補とみなして強調表示する。
        const FREQUENT_THRESHOLD = 2;
        function showTrackResults(results) {
            if (!results || results.length === 0) { resultsEl.style.display = 'none'; return; }
            const sorted = [...results].sort((a, b) => b.count - a.count);
            resultsEl.innerHTML = sorted.map(r => {
                const mark = r.count >= FREQUENT_THRESHOLD ? '🔥' : '';
                return `<div style="border-top:1px solid rgba(255,255,255,0.15);padding:4px 0;">${mark}累計${r.count}回目　${escapeHtml(r.sellerId)}　${escapeHtml(r.sellerName)}</div>`;
            }).join('');
            resultsEl.style.display = 'block';
        }

        btn.onclick = async () => {
            const { report, sellers } = buildReport();
            GM_setClipboard(report);
            updateStatus('調査結果をコピーしました（' + report.length + '文字）\n定点観測サーバーへ送信中...');
            console.log(report);
            const asin = getAsinFromUrl();
            const trackResult = await trackAmazonSellers(sellers, asin);
            let msg = '調査結果をコピーしました（' + report.length + '文字）\n';
            if (trackResult.ok && trackResult.results) {
                const frequent = trackResult.results.filter(r => r.count >= FREQUENT_THRESHOLD);
                msg += `定点観測に記録済み（濃厚候補🔥${frequent.length}件 / 今回${trackResult.results.length}件）`;
                showTrackResults(trackResult.results);
            } else {
                msg += '⚠️ 定点観測サーバー(8766)への送信に失敗しました（起動確認を）。クリップボードのコピーは完了済み';
                showTrackResults(null);
            }
            if (sellers.length > 0) {
                // 2026-10-10：せっかく見つけたセラー一覧をここで終わらせず、各セラーの
                // ストアページへ自動巡回して出品ASINも抜き出す（芋づる式の深掘り）。
                msg += `\n続けて${sellers.length}セラーのASIN抜き出しへ自動移動します...`;
                updateStatus(msg);
                startDeepDiveWalk(sellers, asin);
            } else {
                updateStatus(msg);
            }
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
