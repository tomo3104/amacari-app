// ==UserScript==
// @name         メルカリ カテゴリ有効性サンプラー
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  候補カテゴリごとに実際の出品タイトルをサンプル取得し、型番らしき文字列を含む比率をスコアリングする（新規メーカー発掘のカテゴリ版・2026-09-17新設）
// @match        https://jp.mercari.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_sampler.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_sampler.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 2026-09-17：検索結果一覧は隠しiframeでは商品グリッドが描画されないと判明
    // （フィルターUI等の外枠だけは読めるが、仮想スクロール的な一覧本体は非表示iframe
    // だとレンダリングされない）。mercari_category_tree_crawler.user.jsと同じ
    // 「実際にタブを遷移させながら1件ずつ処理する」方式に作り直した。

    const MODEL_PATTERN = /\b(?=[A-Z][A-Z0-9\-_/.]{5,24}(?<![-_/.])\b)(?=.*\d)[A-Z][A-Z0-9\-_/.]{5,24}\b/g;
    const EXCLUDE_WORDS = [
        "SONY", "BUFFALO", "ELECOM", "IRIS", "PANASONIC", "SANWA", "HORI", "TDK",
        "OHYAMA", "I-O", "INZONE", "LUCA", "SUPPLY", "MINISTATION", "NATIONAL",
        "IODATA", "IO-DATA", "DUALSHOCK", "BIANCA", "TSUYORON", "NESTOUT",
        "DVD-R", "BD-R", "BD-RE", "MICROSDHC",
        "GB", "TB", "MB", "W",
        "25GB", "50GB", "100GB", "200GB", "300GB",
        "1TB", "2TB", "4TB",
        "PS5", "3DS", "SWITCH", "PREMIER",
        "EYEWEAR", "SHAVER", "ENELOOP", "MASTER", "CYBER-SHOT", "DUALSENSE",
        "CHARGING", "MINIDV", "COOKING", "KITCHEN", "TV-NAVI",
    ];

    function isExcluded(word) {
        const w = word.replace(/\s/g, '').replace(/　/g, '').toUpperCase();
        return EXCLUDE_WORDS.some(ex => w.startsWith(ex));
    }
    function hasModelLikeToken(title) {
        const matches = title.match(MODEL_PATTERN) || [];
        return matches.some(m => m.length >= 6 && !isExcluded(m));
    }

    const CANDIDATES = [
        { id: '7',    name: 'スマホ・タブレット・パソコン' },
        { id: '3888', name: 'テレビ・オーディオ・カメラ' },
        { id: '4136', name: '生活家電・空調' },
        { id: '1318', name: '車・バイク・自転車' },
        { id: '5597', name: 'DIY・工具' },
        { id: '76',   name: 'テレビゲーム' },
        { id: '79',   name: '楽器・機材' },
        { id: '7378', name: 'ラジコン・ドローン' },
        { id: '779',  name: 'アマチュア無線' },
        { id: '1184', name: 'ゴルフ＞クラブ' },
        { id: '1153', name: 'トレーニング・エクササイズ' },
        { id: '104',  name: 'スノーボード' },
        { id: '1216', name: 'スキー' },
        { id: '2634', name: 'アウトドア・釣り・旅行用品' },
        { id: '1237', name: '美容家電' },
        { id: '3135', name: 'マッサージ' },
        { id: '3150', name: '健康管理・計測計' },
        { id: '3301', name: '車椅子' },
        { id: '3381', name: '電動カート' },
        { id: '3282', name: '介護用ベッド・寝具' },
        { id: '5497', name: '防犯・セーフティ' },
        { id: '10840', name: '発電機・ポータブル電源' },
        { id: '530',  name: '調理器具' },
        { id: '503',  name: 'チャイルドシート' },
        { id: '501',  name: 'ベビーカー・バギー' },
    ];

    const NAME_SEL = 'span[data-testid="thumbnail-item-name"]';
    // 2026-09-17修正：itemtype="ITEM_TYPE_MERCARI"属性が現在のDOMには存在しないと判明
    // （mercari_auto_collector.user.js側のセレクタが既に古くなっていた可能性）。
    // クラス名のみで判定する。
    const ITEM_SEL = 'div.merItemThumbnail';

    const QUEUE_KEY   = 'catsample_queue';
    const RESULT_KEY  = 'catsample_result';
    const RUNNING_KEY = 'catsample_running';
    const CURRENT_KEY = 'catsample_current';

    const POLL_INTERVAL_MS      = 300;
    const STABLE_TICKS_REQUIRED = 4;    // 1200ms間、件数が変化しなければ安定とみなす
    const MAX_WAIT_MS           = 8000;
    const INITIAL_DELAY_MS      = 600;
    const NAV_DELAY_MS          = 800;

    function getQueue()  { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } }
    function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
    function getResult()  { try { return JSON.parse(localStorage.getItem(RESULT_KEY) || '[]'); } catch (e) { return []; } }
    function setResult(r) { localStorage.setItem(RESULT_KEY, JSON.stringify(r)); }

    function buildUrl(catId) {
        return 'https://jp.mercari.com/search'
            + '?exclude_keyword=' + encodeURIComponent('開封済み　破れ　ダメージ')
            + '&price_min=1500&price_max=15000'
            + '&item_condition_id=1'
            + '&shipping_payer_id=2'
            + '&status=sold_out'
            + '&sort=created_time&order=desc'
            + '&item_types=mercari'
            + '&category_id=' + encodeURIComponent(catId);
    }

    function showStatus(msg, showCopyButton) {
        let el = document.getElementById('catsample-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'catsample-status';
            el.style.cssText = [
                'position:fixed', 'top:20px', 'right:320px', 'z-index:2147483647',
                'background:#4a148c', 'color:#fff', 'padding:12px 16px', 'border-radius:10px',
                'font-size:13px', 'box-shadow:0 4px 16px rgba(0,0,0,.5)', 'max-width:280px',
                'line-height:1.5', 'white-space:pre-line',
            ].join(';');
            document.body.appendChild(el);
        }
        el.textContent = msg;
        if (showCopyButton) {
            const btn = document.createElement('button');
            btn.textContent = '📋 結果をコピー';
            btn.style.cssText = [
                'display:block', 'margin-top:8px', 'padding:7px 14px', 'width:100%',
                'background:#2e7d32', 'color:#fff', 'border:none', 'border-radius:6px',
                'cursor:pointer', 'font-weight:bold', 'font-size:12px',
            ].join(';');
            btn.onclick = () => {
                const sorted = getResult().slice().sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
                navigator.clipboard.writeText(JSON.stringify(sorted, null, 2))
                    .then(() => { btn.textContent = '✅ コピーしました'; })
                    .catch(() => { btn.textContent = '⚠ コピー失敗'; });
            };
            el.appendChild(btn);
        }
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '停止・リセット';
        stopBtn.style.cssText = [
            'display:block', 'margin-top:6px', 'padding:6px 14px', 'width:100%',
            'background:#616161', 'color:#fff', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-size:11px',
        ].join(';');
        stopBtn.onclick = resetAll;
        el.appendChild(stopBtn);
    }

    function resetAll() {
        localStorage.removeItem(QUEUE_KEY);
        localStorage.removeItem(RESULT_KEY);
        localStorage.removeItem(RUNNING_KEY);
        localStorage.removeItem(CURRENT_KEY);
        const el = document.getElementById('catsample-status');
        if (el) el.remove();
        addStartButton();
    }

    function showStuckPrompt(current) {
        showStatus(`⏸ 検証は「${current.name}」(ID:${current.id})のページで止まっています。\n\n下のボタンでそのページへ移動すると続きから再開します。`);
        const el = document.getElementById('catsample-status');
        const goBtn = document.createElement('button');
        goBtn.textContent = '▶ そのページへ移動して再開';
        goBtn.style.cssText = [
            'display:block', 'margin-top:8px', 'padding:7px 14px', 'width:100%',
            'background:#1565c0', 'color:#fff', 'border:none', 'border-radius:6px',
            'cursor:pointer', 'font-weight:bold', 'font-size:12px',
        ].join(';');
        goBtn.onclick = () => { location.href = buildUrl(current.id); };
        el.insertBefore(goBtn, el.querySelector('button'));
    }

    function startSampling() {
        setQueue(CANDIDATES.slice());
        setResult([]);
        localStorage.setItem(RUNNING_KEY, 'true');
        const btn = document.getElementById('catsample-start-btn');
        if (btn) btn.remove();
        goNext();
    }

    function goNext() {
        const queue = getQueue();
        if (queue.length === 0) {
            finish();
            return;
        }
        const next = queue.shift();
        setQueue(queue);
        localStorage.setItem(CURRENT_KEY, JSON.stringify(next));
        showStatus(`検証中... 残り${queue.length + 1}件\n次: ${next.name}`);
        setTimeout(() => { location.href = buildUrl(next.id); }, NAV_DELAY_MS);
    }

    function finish() {
        localStorage.removeItem(RUNNING_KEY);
        localStorage.removeItem(CURRENT_KEY);
        const results = getResult().slice().sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
        const lines = results.map(r => {
            const rateStr = r.sample === 0 ? '0件' : `${r.rate}%`;
            return `${r.name}: ${rateStr} (${r.hit}/${r.sample})`;
        });
        showStatus(`✅ 完了！全${results.length}件\n\n` + lines.join('\n'), true);
        console.log('[カテゴリ検証結果]', JSON.stringify(results, null, 2));
    }

    // 現在のページから型番らしき比率を計測し、キューを進める
    function processCurrentPage(cat) {
        showStatus(`検証中...\n${cat.name} の描画待ち`);
        let stableTicks = 0;
        let lastCount = -1;
        const startTime = Date.now();
        setTimeout(() => {
            const poll = setInterval(() => {
                const items = document.querySelectorAll(ITEM_SEL);
                const count = items.length;
                if (count === lastCount) {
                    stableTicks++;
                } else {
                    stableTicks = 0;
                    lastCount = count;
                }
                const elapsed = Date.now() - startTime;
                if (stableTicks >= STABLE_TICKS_REQUIRED || elapsed >= MAX_WAIT_MS) {
                    clearInterval(poll);
                    let sample = 0, hit = 0;
                    items.forEach(el => {
                        const nameEl = el.querySelector(NAME_SEL);
                        if (!nameEl) return;
                        const name = nameEl.textContent.trim();
                        if (!name) return;
                        sample++;
                        if (hasModelLikeToken(name)) hit++;
                    });
                    const rate = sample > 0 ? Math.round((hit / sample) * 1000) / 10 : null;
                    const results = getResult();
                    results.push({ ...cat, sample, hit, rate });
                    setResult(results);
                    goNext();
                }
            }, POLL_INTERVAL_MS);
        }, INITIAL_DELAY_MS);
    }

    function addStartButton() {
        if (document.getElementById('catsample-start-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'catsample-start-btn';
        btn.textContent = '📊 カテゴリ検証';
        btn.style.cssText = `
            position:fixed; bottom:180px; right:20px; z-index:99999;
            padding:12px 20px; background:#8e24aa; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        btn.onclick = startSampling;
        document.body.appendChild(btn);
    }

    // ===== 起動時の状態判定 =====
    if (localStorage.getItem(RUNNING_KEY) === 'true' && localStorage.getItem(CURRENT_KEY)) {
        let current;
        try { current = JSON.parse(localStorage.getItem(CURRENT_KEY)); } catch (e) { current = null; }
        const urlMatches = current && location.href.includes('category_id=' + current.id) && location.pathname.startsWith('/search');
        if (current && urlMatches) {
            processCurrentPage(current);
        } else if (current) {
            showStuckPrompt(current);
        }
    } else {
        addStartButton();
    }
})();
