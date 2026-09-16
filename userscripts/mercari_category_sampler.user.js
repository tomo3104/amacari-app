// ==UserScript==
// @name         メルカリ カテゴリ有効性サンプラー
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  候補カテゴリごとに実際の出品タイトルをサンプル取得し、型番らしき文字列を含む比率をスコアリングする（新規メーカー発掘のカテゴリ版・2026-09-17新設）
// @match        https://jp.mercari.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_sampler.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_category_sampler.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 2026-09-17：asin-tools/asin_check.pyのmodel_pattern/EXCLUDE_WORDSと同じロジックをJS移植。
    // 「型番らしき文字列」の判定基準を型番収集ルート本体と一致させることで、
    // ここでのスコアがそのまま実運用時の型番抽出率の見込みになるようにする。
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

    // 2026-09-17：候補カテゴリ一覧（クローラーコレクトの分析・仕分けで決定した「型番が
    // 出そうな枝」のみ）。IDはcatcrawl_result.json（mercari_category_tree_crawler.user.js
    // の収集結果）から抽出したもの。
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

    const NAME_SEL  = 'span[data-testid="thumbnail-item-name"]';
    const ITEM_SEL  = 'div.merItemThumbnail[itemtype="ITEM_TYPE_MERCARI"]';

    // ===== UI =====
    const container = document.createElement('div');
    container.style.cssText = `
        position:fixed; bottom:180px; right:20px; z-index:99999;
        display:flex; flex-direction:column; align-items:flex-end; gap:8px;
    `;
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        background:rgba(0,0,0,0.78); color:#fff; padding:6px 14px;
        border-radius:6px; font-size:13px; display:none; max-width:320px;
    `;
    const btn = document.createElement('button');
    btn.textContent = '📊 カテゴリ検証';
    btn.style.cssText = `
        padding:12px 20px; background:#8e24aa; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    container.appendChild(statusEl);
    container.appendChild(btn);
    document.body.appendChild(container);

    const logPanel = document.createElement('div');
    logPanel.style.cssText = `
        position:fixed; bottom:280px; right:20px; z-index:99998;
        width:420px; max-height:400px; overflow-y:auto;
        background:rgba(0,0,0,0.9); color:#d0d0d0; padding:10px 14px;
        border-radius:8px; font-size:12px; font-family:monospace;
        display:none; line-height:1.6; box-shadow:0 2px 10px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(logPanel);

    function addLog(msg, color) {
        const line = document.createElement('div');
        line.textContent = msg;
        if (color) line.style.color = color;
        logPanel.appendChild(line);
        logPanel.scrollTop = logPanel.scrollHeight;
        logPanel.style.display = 'block';
    }
    function updateStatus(msg) { statusEl.style.display = 'block'; statusEl.textContent = msg; }

    // 2026-09-17修正：manufacturersシートで実際に稼働確認済みのURL形式に合わせる
    // （配列ブラケット記法%5B%5Dは不要で、item_types=mercariが必要だった）。
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

    // 2026-09-17：メルカリの検索結果はNext.jsのクライアントサイド描画のため、fetch()で
    // 取得した生HTMLには商品が入っていない（サーバーはナビゲーションリクエストにのみ
    // 描画済みデータを返すため）。mercari_desc_model_finder.user.jsのfetchItemDescと
    // 同じ「隠しiframeで実際にナビゲートさせてから、描画済みDOMをポーリングで待つ」
    // 方式に統一する。
    function sampleCategory(cat) {
        const url = buildUrl(cat.id);
        return new Promise(resolve => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:390px;height:844px;border:none;visibility:hidden;pointer-events:none;';
            document.body.appendChild(iframe);

            let done = false;
            const finish = (sample, hit, failed) => {
                if (done) return;
                done = true;
                try { iframe.remove(); } catch (_) {}
                const rate = (!failed && sample > 0) ? Math.round((hit / sample) * 1000) / 10 : null;
                resolve({ ...cat, sample, hit, rate, failed });
            };

            const hardTimer = setTimeout(() => finish(0, 0, true), 10000);

            iframe.onload = () => {
                let tries = 0;
                const poll = setInterval(() => {
                    let items;
                    try {
                        const doc = iframe.contentDocument;
                        if (!doc || !doc.body) return;
                        items = doc.querySelectorAll(ITEM_SEL);
                    } catch (e) {
                        clearInterval(poll);
                        clearTimeout(hardTimer);
                        finish(0, 0, true);
                        return;
                    }
                    if (items.length > 0) {
                        clearInterval(poll);
                        clearTimeout(hardTimer);
                        let sample = 0, hit = 0;
                        items.forEach(el => {
                            const nameEl = el.querySelector(NAME_SEL);
                            if (!nameEl) return;
                            const name = nameEl.textContent.trim();
                            if (!name) return;
                            sample++;
                            if (hasModelLikeToken(name)) hit++;
                        });
                        finish(sample, hit, false);
                        return;
                    }
                    if (++tries > 45) { // 45 × 200ms = 9秒（該当カテゴリに出品が0件の場合もここに来る）
                        clearInterval(poll);
                        clearTimeout(hardTimer);
                        finish(0, 0, false); // 取得失敗ではなく「0件」として扱う
                    }
                }, 200);
            };
            iframe.onerror = () => { clearTimeout(hardTimer); finish(0, 0, true); };
            iframe.src = url;
        });
    }

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        logPanel.innerHTML = '';
        const results = [];
        for (let i = 0; i < CANDIDATES.length; i++) {
            const cat = CANDIDATES[i];
            updateStatus(`検証中... (${i + 1}/${CANDIDATES.length}) ${cat.name}`);
            const r = await sampleCategory(cat);
            results.push(r);
            const rateStr = r.failed ? '取得失敗' : (r.sample === 0 ? '0件' : `${r.rate}%`);
            addLog(`[${i + 1}/${CANDIDATES.length}] ${cat.name} (ID:${cat.id}): ${r.hit}/${r.sample}件 → ${rateStr}`,
                   r.failed ? '#ff8888' : (r.rate === null ? '#999' : (r.rate >= 30 ? '#88ff88' : (r.rate >= 10 ? '#ffcc66' : '#ff8888'))));
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
        results.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
        addLog('----- 結果（型番らしき比率の高い順） -----', '#88ccff');
        results.forEach(r => {
            const rateStr = r.failed ? '取得失敗' : (r.sample === 0 ? '0件' : `${r.rate}%`);
            addLog(`${r.name}: ${rateStr} (${r.hit}/${r.sample}件)`);
        });
        updateStatus('完了！コンソールに詳細結果を出力しました');
        console.log('[カテゴリ検証結果]', JSON.stringify(results, null, 2));
        try {
            await navigator.clipboard.writeText(JSON.stringify(results, null, 2));
            addLog('→ 結果をクリップボードにコピーしました', '#88ccff');
        } catch (e) { /* noop */ }
        btn.disabled = false;
    });
})();
