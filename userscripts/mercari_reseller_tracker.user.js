// ==UserScript==
// @name         Mercari Reseller Tracker
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  せどらーと思われる購入者の評価履歴からセラー一覧を抽出し(Step1)、各セラーのSOLD商品一覧を取得する(Step2)。Step1→2を自動連鎖させ全セラーを自動巡回する機能も搭載（2026-10-09新設）。
// @match        https://jp.mercari.com/user/reviews/*
// @match        https://jp.mercari.com/user/profile/*
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 2026-10-09：/reviews/history を自前でfetchするとHTTP 400になった（ページ自身が
    // 付与している認証ヘッダー類が再現できていないと思われる）。そのため自前で呼び直す
    // のではなく、ページ自身が成功させた本物の通信を横取りして使う
    // （mercari_auto_collector.user.jsのテンプレート捕捉と同じ発想）。Step1はこの方式。
    const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    let capturedReviews = null;

    // 2026-10-09：items/get_itemsも自前fetchはHTTP 400だったため、/reviews/historyと
    // 同じく横取り方式にする。seller_idごと・item idごとにMapで蓄積し、ページをスクロール
    // して追加で読み込まれた分も取り逃さないようにする（1回のロードでは30件しか来ない）。
    const capturedItemsBySeller = new Map(); // sellerId -> Map(itemId -> item)

    function recordItems(json) {
        const items = (json && json.data) || [];
        for (const it of items) {
            const sid = it.seller && String(it.seller.id);
            if (!sid) continue;
            if (!capturedItemsBySeller.has(sid)) capturedItemsBySeller.set(sid, new Map());
            capturedItemsBySeller.get(sid).set(it.id, it);
        }
    }

    function handleResponse(url, json) {
        if (url.includes('/reviews/history')) {
            capturedReviews = json;
        } else if (url.includes('/items/get_items')) {
            recordItems(json);
        }
    }

    // 2026-10-09追加：1人のセラーを見つけた時にスクロール操作なしで直近分を一気に取れるよう、
    // ページ自身が発行するitems/get_items通信のlimitを横取り時に100へ書き換える。認証ヘッダー等は
    // ページが用意したものがそのまま使われるため、呼び先を変えずに済み400にならない。
    function bumpLimitIfNeeded(url) {
        if (url.includes('/items/get_items') && /limit=\d+/.test(url)) {
            return url.replace(/limit=\d+/, 'limit=100');
        }
        return url;
    }

    const origFetch = _uw.fetch;
    _uw.fetch = async function (...args) {
        try {
            const origUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            const newUrl = bumpLimitIfNeeded(origUrl);
            if (newUrl !== origUrl) {
                args[0] = (typeof args[0] === 'string') ? newUrl : new Request(newUrl, args[0]);
            }
        } catch (e) {}
        const res = await origFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            if (url.includes('/reviews/history') || url.includes('/items/get_items')) {
                res.clone().json().then(json => handleResponse(url, json)).catch(() => {});
            }
        } catch (e) {}
        return res;
    };

    const OrigXHR = _uw.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            _url = bumpLimitIfNeeded(url);
            return origOpen.call(xhr, method, _url, ...rest);
        };
        xhr.addEventListener('loadend', function () {
            try {
                if (_url.includes('/reviews/history') || _url.includes('/items/get_items')) {
                    handleResponse(_url, JSON.parse(xhr.responseText));
                }
            } catch (e) {}
        });
        return xhr;
    }
    _uw.XMLHttpRequest = PatchedXHR;

    function formatDate(unixSec) {
        return new Date(unixSec * 1000).toISOString().slice(0, 10);
    }

    function getUserIdFromUrl() {
        const m = location.pathname.match(/\/user\/(?:reviews|profile)\/(\d+)/);
        return m ? m[1] : null;
    }

    // ========== Step1→2自動連鎖：複数セラーを自動巡回 ==========
    // ページ遷移するとスクリプトの状態（変数）は全て消えるため、進行状況と結果を
    // localStorageに保存しながら1人ずつプロフィールページへ自動遷移する
    // （mercari_auto_collector.user.jsのautoPipeline連鎖と同じ考え方）。
    const LS_KEY = 'mercariResellerWalk';
    const WALK_STALE_MS = 30 * 60 * 1000; // 30分より古い状態は放棄済みとみなす
    const WAIT_PER_SELLER_MS = 8000;
    const NAV_DELAY_MS = 800;

    function loadWalkState() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return null;
            const state = JSON.parse(raw);
            if (!state.active || Date.now() - state.startedAt > WALK_STALE_MS) return null;
            return state;
        } catch (e) { return null; }
    }
    function saveWalkState(state) {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
    }
    function clearWalkState() {
        localStorage.removeItem(LS_KEY);
    }

    function buildCombinedSoldReport(results) {
        const lines = [];
        const totalItems = results.reduce((a, r) => a + r.items.length, 0);
        lines.push(`巡回セラー数: ${results.length} / SOLD商品合計: ${totalItems}件`);
        lines.push('');
        lines.push('日付\tsellerId\tsellerName\t商品名\t価格\tブランド');
        for (const r of results) {
            for (const it of r.items) {
                lines.push(`${it.date}\t${r.sellerId}\t${r.sellerName}\t${it.name}\t${it.price}\t${it.brand}`);
            }
        }
        return lines.join('\n');
    }

    async function waitForSellerItems(sellerId, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const m = capturedItemsBySeller.get(sellerId);
            if (m && m.size > 0) return m;
            await new Promise(r => setTimeout(r, 400));
        }
        return capturedItemsBySeller.get(sellerId) || new Map();
    }

    async function runWalkStep(state) {
        const current = state.queue[state.currentIndex];
        const itemsMap = await waitForSellerItems(String(current.id), WAIT_PER_SELLER_MS);
        const sold = [...itemsMap.values()]
            .filter(it => it.status === 'sold_out')
            .sort((a, b) => b.created - a.created);
        state.results.push({
            sellerId: current.id,
            sellerName: current.name,
            items: sold.map(it => ({
                date: formatDate(it.created), name: it.name, price: it.price,
                brand: (it.item_brand && it.item_brand.name) || '',
            })),
        });
        state.currentIndex++;

        if (state.currentIndex >= state.queue.length) {
            const report = buildCombinedSoldReport(state.results);
            clearWalkState();
            GM_setClipboard(report);
            return { done: true, report };
        }
        saveWalkState(state);
        const next = state.queue[state.currentIndex];
        setTimeout(() => {
            location.href = `https://jp.mercari.com/user/profile/${next.id}`;
        }, NAV_DELAY_MS);
        return { done: false, progress: `${state.currentIndex}/${state.queue.length}` };
    }

    // ========== Step1: 評価履歴→セラー一覧 ==========
    function buildReviewReport(entries) {
        const asBuyer = entries.filter(e => e.subject === 'buyer');
        const bySeller = new Map();
        for (const e of asBuyer) {
            const sid = e.user.id;
            if (!bySeller.has(sid)) {
                bySeller.set(sid, { id: sid, name: e.user.name, count: 0, lastCreated: 0 });
            }
            const s = bySeller.get(sid);
            s.count++;
            if (e.created > s.lastCreated) s.lastCreated = e.created;
        }
        const sellers = [...bySeller.values()].sort((a, b) => b.lastCreated - a.lastCreated);

        const lines = [];
        lines.push(`取得件数: ${entries.length}件（うち買い手として受けた評価: ${asBuyer.length}件）`);
        lines.push(`ユニークなセラー数: ${sellers.length}`);
        lines.push('（注：createdは実際の取引日ではなく評価公開バッチの日付のため目安程度）');
        lines.push('');
        lines.push('sellerId\tsellerName\t取引回数\t直近評価日\tストアURL');
        for (const s of sellers) {
            lines.push(`${s.id}\t${s.name}\t${s.count}\t${formatDate(s.lastCreated)}\thttps://jp.mercari.com/user/profile/${s.id}`);
        }
        return lines.join('\n');
    }

    // ========== Step2: セラーのSOLD一覧取得（横取りしたデータから組み立てる） ==========
    function buildSoldReport(sellerId, itemsMap) {
        const items = itemsMap ? [...itemsMap.values()] : [];
        const sold = items.filter(it => it.status === 'sold_out').sort((a, b) => b.created - a.created);
        const lines = [];
        lines.push(`セラーID: ${sellerId}`);
        lines.push(`取得件数: ${items.length}件（うちSOLD: ${sold.length}件）`);
        lines.push('');
        lines.push('日付\t商品名\t価格\tブランド');
        for (const it of sold) {
            lines.push(`${formatDate(it.created)}\t${it.name}\t${it.price}\t${(it.item_brand && it.item_brand.name) || ''}`);
        }
        return lines.join('\n');
    }

    function mountUI() {
        const userId = getUserIdFromUrl();

        const statusEl0 = document.createElement('div');
        statusEl0.style.cssText = 'position:fixed;top:195px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
        document.body.appendChild(statusEl0);
        function updateStatus0(msg) {
            statusEl0.style.display = 'block';
            statusEl0.textContent = msg;
        }

        // --- 巡回中なら、UIを出さずに自動進行だけ行う ---
        const walkState = loadWalkState();
        if (walkState && userId && String(walkState.queue[walkState.currentIndex].id) === userId) {
            updateStatus0(`自動巡回中... (${walkState.currentIndex + 1}/${walkState.queue.length}) ${walkState.queue[walkState.currentIndex].name}`);
            runWalkStep(walkState).then(r => {
                if (r.done) {
                    updateStatus0('巡回完了！クリップボードにコピーしました（' + r.report.length + '文字）');
                    console.log(r.report);
                }
            });
            return; // 通常のStep1/2ボタンは出さない（遷移中なので）
        }

        // --- Step1ボタン ---
        const btn1 = document.createElement('button');
        btn1.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn1);

        setInterval(() => {
            btn1.textContent = capturedReviews ? 'Step1: セラー一覧を抽出してコピー' : 'Step1: 評価データ待機中...（更新待ち）';
        }, 500);

        btn1.onclick = () => {
            if (!capturedReviews) { updateStatus0('まだ評価データを捕まえていません。ページを更新してもう一度お試しください'); return; }
            const report = buildReviewReport(capturedReviews.data || []);
            GM_setClipboard(report);
            updateStatus0('Step1完了！クリップボードにコピーしました（' + report.length + '文字）');
            console.log(report);
        };

        // --- Step1→2自動連鎖ボタン（評価履歴から全セラーを自動巡回） ---
        const btnWalk = document.createElement('button');
        btnWalk.textContent = 'Step1→2: 全セラーを自動巡回';
        btnWalk.style.cssText = 'position:fixed;top:75px;right:20px;z-index:99999;padding:12px 20px;background:#E65100;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btnWalk);

        btnWalk.onclick = () => {
            if (!capturedReviews) { updateStatus0('まだ評価データを捕まえていません。ページを更新してもう一度お試しください'); return; }
            const asBuyer = (capturedReviews.data || []).filter(e => e.subject === 'buyer');
            const bySeller = new Map();
            for (const e of asBuyer) {
                if (!bySeller.has(e.user.id)) bySeller.set(e.user.id, { id: e.user.id, name: e.user.name });
            }
            const queue = [...bySeller.values()];
            if (queue.length === 0) { updateStatus0('セラーが見つかりませんでした'); return; }
            saveWalkState({ active: true, startedAt: Date.now(), queue, currentIndex: 0, results: [] });
            updateStatus0(`自動巡回開始... (0/${queue.length})`);
            setTimeout(() => {
                location.href = `https://jp.mercari.com/user/profile/${queue[0].id}`;
            }, NAV_DELAY_MS);
        };

        // --- Step2ボタン（セラーのプロフィールページでも使えるよう常に表示） ---
        const btn2 = document.createElement('button');
        btn2.style.cssText = 'position:fixed;top:130px;right:20px;z-index:99999;padding:12px 20px;background:#00897B;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn2);

        setInterval(() => {
            const n = userId && capturedItemsBySeller.has(userId) ? capturedItemsBySeller.get(userId).size : 0;
            btn2.textContent = 'Step2: SOLD一覧を抽出してコピー(' + n + '件捕捉)';
        }, 500);

        btn2.onclick = () => {
            if (!userId) { updateStatus0('ユーザーIDがURLから取得できません'); return; }
            const itemsMap = capturedItemsBySeller.get(userId);
            if (!itemsMap || itemsMap.size === 0) {
                updateStatus0('まだ商品データを捕まえていません。ページを更新してから少し待ってお試しください');
                return;
            }
            const report = buildSoldReport(userId, itemsMap);
            GM_setClipboard(report);
            updateStatus0('Step2完了！クリップボードにコピーしました（' + report.length + '文字）');
            console.log(report);
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
