// ==UserScript==
// @name         バイヤーチェイス (Mercari Buyer Chase)
// @namespace    http://tampermonkey.net/
// @version      6.8
// @description  せどらーと思われる購入者の評価履歴からセラー一覧を抽出し(Step1)、各セラーのSOLD商品一覧を取得する(Step2)。Step1→2を自動連鎖させ全セラーを自動巡回する機能も搭載（2026-10-09新設・命名「バイヤーチェイス」に変更）。評価履歴はpager_idでMap蓄積（上書きバグ防止）。サーバー(8765)未起動時の送信失敗を検知して巡回を停止する機能（v6.5）が、保存自体は成功したのに応答だけ届かない既知の無害なケース（ConnectionAbortedError）まで失敗と誤判定していたため、経過時間で両者を区別するよう修正（v6.6）。巡回状態の失効時間を30分→2時間に延長（v6.7）。巡回中にページがハング（ボタン消滅のまま停止）する事象のコンソールにReactハイドレーションエラーが出ていたため、UI構築をdocument-start直後ではなく500ms遅延させ、メルカリ側Reactとの競合を避けるよう変更（2026-10-10）。
// @match        https://jp.mercari.com/user/reviews/*
// @match        https://jp.mercari.com/user/profile/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 2026-10-09：/reviews/history を自前でfetchするとHTTP 400になった（ページ自身が
    // 付与している認証ヘッダー類が再現できていないと思われる）。そのため自前で呼び直す
    // のではなく、ページ自身が成功させた本物の通信を横取りして使う
    // （mercari_auto_collector.user.jsのテンプレート捕捉と同じ発想）。Step1はこの方式。
    const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // 2026-10-10：以前は`capturedReviews = json`で毎回上書きしていたため、もし複数回
    // /reviews/historyへの通信が発生した場合に古い分が失われる作りだった。pager_idを
    // キーにしたMapで蓄積するよう修正（capturedItemsBySellerと同じ考え方）。
    // ただし検証の結果、このページは評価履歴をスクロールしても追加の通信を発生させない
    // （タブ切り替え等の追加読み込み手段も無い）ことが判明。つまり1回のロード分が
    // 取得できる全データであり、その中に「買った側」の評価が無ければ、このアカウントの
    // 取得可能な評価履歴には買った証拠が無いということ（スクロールしても増えないのは
    // バグではなく仕様。2026-10-10検証済み）。
    const capturedReviewsByPagerId = new Map(); // pager_id -> entry

    // 2026-10-09：items/get_itemsも自前fetchはHTTP 400だったため、/reviews/historyと
    // 同じく横取り方式にする。seller_idごと・item idごとにMapで蓄積し、ページをスクロール
    // して追加で読み込まれた分も取り逃さないようにする（1回のロードでは30件しか来ない）。
    const capturedItemsBySeller = new Map(); // sellerId -> Map(itemId -> item)

    function recordReviews(json) {
        const entries = (json && json.data) || [];
        for (const e of entries) {
            const key = e.pager_id != null ? e.pager_id : JSON.stringify(e);
            capturedReviewsByPagerId.set(key, e);
        }
    }

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
            recordReviews(json);
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
    // 2026-10-10：30分だと、セラー数が多い巡回は正常処理中でも合計時間がこれを超えて
    // 「放棄済み」と誤判定される恐れがある（startedAtは巡回開始時刻で、アイドル時間では
    // なく巡回全体の経過時間を見ているため）。デバッグ等で長時間放置した場合の救済も兼ねて
    // 2時間に延長。
    const WALK_STALE_MS = 2 * 60 * 60 * 1000; // 2時間より古い状態は放棄済みとみなす
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

    // 2026-10-10：サーバー（amacari-tools:8765）が起動していなくても、以前は送信の成否を
    // 確認せずに「送信済み」と表示してしまっていた（実際は接続エラーで何も記録されていなかった）。
    // GM_xmlhttpRequestのonload/onerrorを見て実際の成否を返すよう修正。
    function pingServer() {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET', url: 'http://localhost:8765/',
                timeout: 2000,
                onload: () => resolve(true),
                onerror: () => resolve(false),
                ontimeout: () => resolve(false),
            });
        });
    }

    // 2026-10-09追加：既存のクローラーコレクトと同じ/collect-items（amacari-tools:8765）に
    // そのまま流し込む。新しい受け口を作らず、mercariシート→型番候補検出→Amazon価格チェックの
    // 既存パイプラインにそのまま乗せる。1人処理するごとに随時送信する（最後にまとめて送ると
    // 巡回が途中で止まった時に全部失われる、クローラーコレクトで実際に起きた事故と同じ教訓）。
    //
    // 2026-10-10：サーバー側はGoogleスプレッドシートへの読み書きを済ませてから応答を返す
    // 作りのため、「保存（collect完了のログ）は成功したが、応答を返す前にクライアント側の
    // 接続が切れて結果だけ届かない」ケースがある（ConnectionAbortedError、既知の無害な
    // パターン。CLAUDE.md参照）。本当にサーバーが起動していない場合は接続エラーがほぼ
    // 即時（数百ms以内）に返るのに対し、このケースはスプレッドシートの複数回の通信が
    // 終わるまでの数秒〜十数秒後に発生する。この経過時間で両者を区別し、十分待った後の
    // エラーは「おそらく保存自体は成功している」と判断して成功扱いにする
    // （そうしないと保存できているのに巡回を止めてしまう誤判定になる）。
    const LIKELY_SAVED_AFTER_MS = 2000;
    function sendToCollectItems(sellerName, sold) {
        if (sold.length === 0) return Promise.resolve(true); // 送る物が無いのは失敗ではない
        const itemList = sold.map(it => ({
            name: it.name, price: Number(it.price) || 0,
            url: `https://jp.mercari.com/item/${it.id}`,
            source: 'バイヤーチェイス:' + sellerName,
        }));
        const startedAt = Date.now();
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST', url: 'http://localhost:8765/collect-items',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ items: itemList }),
                timeout: 30000,
                onload: res => resolve(res.status >= 200 && res.status < 300),
                onerror: () => resolve(Date.now() - startedAt >= LIKELY_SAVED_AFTER_MS),
                ontimeout: () => resolve(Date.now() - startedAt >= LIKELY_SAVED_AFTER_MS),
            });
        });
    }

    async function runWalkStep(state) {
        const current = state.queue[state.currentIndex];
        const itemsMap = await waitForSellerItems(String(current.id), WAIT_PER_SELLER_MS);
        const sold = [...itemsMap.values()]
            .filter(it => it.status === 'sold_out')
            .sort((a, b) => b.created - a.created);
        const sendOk = await sendToCollectItems(current.name, sold);
        if (!sendOk) {
            // 2026-10-10：送信失敗時はcurrentIndexを進めず・ページ遷移もしない（巡回を停止）。
            // サーバーを起動してこのページを再読み込みすれば、同じセラーからやり直せる。
            return { done: false, failed: true, sellerName: current.name };
        }
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
                    updateStatus0('巡回完了！mercariシートへ送信済み＋クリップボードにもコピーしました（' + r.report.length + '文字）');
                    console.log(r.report);
                } else if (r.failed) {
                    updateStatus0(`⚠️ 送信失敗（${r.sellerName}）。amacari-toolsサーバー(8765)が起動しているか確認し、起動してからこのページを再読み込みしてください（巡回はこのセラーで停止中・やり直せば続きから再開します）`);
                }
            });
            return; // 通常のStep1/2ボタンは出さない（遷移中なので）
        }

        // --- Step1ボタン ---
        const btn1 = document.createElement('button');
        btn1.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;background:#9C27B0;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btn1);

        setInterval(() => {
            const n = capturedReviewsByPagerId.size;
            btn1.textContent = n > 0 ? `Step1: セラー一覧を抽出してコピー（捕捉${n}件）` : 'Step1: 評価データ待機中...（更新待ち）';
        }, 500);

        btn1.onclick = () => {
            if (capturedReviewsByPagerId.size === 0) { updateStatus0('まだ評価データを捕まえていません。ページを更新してもう一度お試しください'); return; }
            const raw = [...capturedReviewsByPagerId.values()];
            const report = buildReviewReport(raw);
            GM_setClipboard(report);
            updateStatus0('Step1完了！クリップボードにコピーしました（' + report.length + '文字）');
            console.log(report);
        };

        // --- Step1→2自動連鎖ボタン（評価履歴から全セラーを自動巡回） ---
        const btnWalk = document.createElement('button');
        btnWalk.textContent = 'Step1→2: 全セラーを自動巡回';
        btnWalk.style.cssText = 'position:fixed;top:75px;right:20px;z-index:99999;padding:12px 20px;background:#E65100;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
        document.body.appendChild(btnWalk);

        btnWalk.onclick = async () => {
            if (capturedReviewsByPagerId.size === 0) { updateStatus0('まだ評価データを捕まえていません。ページを更新してもう一度お試しください'); return; }
            const asBuyer = [...capturedReviewsByPagerId.values()].filter(e => e.subject === 'buyer');
            const bySeller = new Map();
            for (const e of asBuyer) {
                if (!bySeller.has(e.user.id)) bySeller.set(e.user.id, { id: e.user.id, name: e.user.name });
            }
            const queue = [...bySeller.values()];
            if (queue.length === 0) { updateStatus0(`セラーが見つかりませんでした（捕捉${capturedReviewsByPagerId.size}件中、買い手評価0件）。このページで取得できる評価履歴に買った側としての評価が含まれていない対象です`); return; }
            updateStatus0('サーバー確認中...');
            const serverUp = await pingServer();
            if (!serverUp) {
                updateStatus0('⚠️ amacari-toolsサーバー(8765)が起動していません。先に起動してからやり直してください（今回は巡回を開始しません）');
                return;
            }
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

        btn2.onclick = async () => {
            if (!userId) { updateStatus0('ユーザーIDがURLから取得できません'); return; }
            const itemsMap = capturedItemsBySeller.get(userId);
            if (!itemsMap || itemsMap.size === 0) {
                updateStatus0('まだ商品データを捕まえていません。ページを更新してから少し待ってお試しください');
                return;
            }
            const items = [...itemsMap.values()];
            const sold = items.filter(it => it.status === 'sold_out').sort((a, b) => b.created - a.created);
            const sellerName = (sold[0] && sold[0].seller && sold[0].seller.name) || userId;
            const report = buildSoldReport(userId, itemsMap);
            GM_setClipboard(report);
            updateStatus0('送信中...');
            const sendOk = await sendToCollectItems(sellerName, sold);
            if (sendOk) {
                updateStatus0('Step2完了！mercariシートへ送信＋クリップボードにコピーしました（' + report.length + '文字）');
            } else {
                updateStatus0('⚠️ mercariシートへの送信に失敗しました（amacari-toolsサーバー(8765)が起動しているか確認してください）。クリップボードへのコピーは完了済み（' + report.length + '文字）');
            }
            console.log(report);
        };
    }

    // 2026-10-10：@run-at document-startで即座にdocument.bodyへボタン・表示用divを
    // 追加していたため、メルカリ側のReactアプリがまだハイドレーション（サーバー生成HTMLと
    // クライアント側の組み立てを一致させる処理）を完了する前にDOMを変更してしまい、
    // Reactのハイドレーションエラー（コンソールに"Minified React error #418"）を
    // 誘発していた可能性が高い（巡回中にページが実質固まって進まなくなる症状と一致）。
    // DOMContentLoaded後にも少し待ってからUIを構築するよう変更し、競合の可能性を減らす。
    function mountUIDelayed() {
        setTimeout(mountUI, 500);
    }
    if (document.body) {
        mountUIDelayed();
    } else {
        document.addEventListener('DOMContentLoaded', mountUIDelayed);
    }
})();
