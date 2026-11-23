// GAS Web AppのデプロイURL（/exec で終わるもの）に置き換えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbz6W83NlKgz8ieDfRrXL2AfaPWo4xFqv_8vr5NT1-NQglc1tuOC50uT-CWEHrG95c64/exec";

// 2026-09-12追加：GASのWebアプリは同一URLへのGETリクエストをGoogle側で
// キャッシュすることがあり、「リロードしても件数が変わらない」原因になっていた
// （RTタブでシミュレーション上21件残るはずが実際には1件しか表示されない、
// という食い違いから発覚）。毎回ユニークなクエリパラメータを付けてキャッシュを回避する。
function gasUrl(action, params) {
  const usp = new URLSearchParams(Object.assign({ action, _: Date.now() }, params || {}));
  return `${GAS_URL}?${usp.toString()}`;
}

// GASはCORSプリフライト(OPTIONS)を処理できないため、
// POSTは text/plain で送ってブラウザに preflight を発生させない
//
// 2026-08-31追加：スマホでのスワイプ中に画面ロック・回線切替（WiFi⇔4G）等で
// fetch自体が失敗するケースがあり、以前はリトライなしで即「保存に失敗しました」
// 表示になっていた。writeJudgment側は毎回シートの現在値を読んでから書き込む
// 作りのため多重送信しても壊れない。ここで最大2回まで自動再送してから諦める。
async function gasPost(action, body, attempt) {
  attempt = attempt || 1;
  try {
    return await fetch(gasUrl(action), {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 500 * attempt));
      return gasPost(action, body, attempt + 1);
    }
    throw err;
  }
}

// 2026-09-22追加：書き込み(gasPost)にはリトライがあるのに、読み込み（カード取得等の
// GET）には無く、スマホでの回線切替の一瞬の途切れだけで各タブが即「読み込みに失敗
// しました」になっていた。同じ理由・同じリトライ回数で読み込み側にも追加する。
//
// 2026-09-22さらに修正：上記のリトライはfetch()自体が例外を投げた場合（DNS・接続
// 拒否等）しか拾えておらず、「fetch自体は成功したがGAS側が実行エラーのHTMLページを
// 返した／レスポンスがJSONとして壊れている」ケースは1回目の失敗で即座に諦めていた
// （呼び出し側でres.json()する際にSyntaxErrorになるが、それはgasFetchの外）。
// これがリトライ追加後も「読み込みに失敗しました」が変わらず頻発していた原因と考え、
// fetch＋レスポンス検証＋JSONパースまでを丸ごとリトライ対象にし、パース済みデータを
// 直接返す形に変更した（呼び出し側の`res.json()`は不要になる）。
async function gasFetch(action, params, attempt) {
  attempt = attempt || 1;
  try {
    const res = await fetch(gasUrl(action, params));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 500 * attempt));
      return gasFetch(action, params, attempt + 1);
    }
    throw err;
  }
}

const state = {
  cards: [],
  sort: "rank",
  lastRejected: null,   // 巻き戻し用：直前に却下したカード
  pendingReject: null,  // 理由選択待ちのカード
  pendingRejectSource: "amacari", // 理由選択待ちカードの種類："amacari" or "furima"
  pendingPurchase: null,  // 仕入れ状況選択待ちのカード（2026-09-02追加：右スワイプ時に仕入確定/仕入候補/キャンセルを選ばせる）
  pendingPurchaseSource: "amacari",
  skipStack: [],        // 後回し（上スワイプ）したカードのスタック：下スワイプで呼び戻す
  swipeBlocked: false,  // 理由選択中はスワイプ不可
  pendingAsinFix: null, // ASIN修正待ちのカード
  totalCount: 0,        // 読み込み時点の精査待ち件数（進捗表示の分母）

  // フリマウォッチ監視タブ用
  furimaCards: [],
  furimaLastRejected: null,
  furimaSkipStack: [],
  furimaTotalCount: 0,
  furimaAccount: "",

  // 発掘（説明文リサーチ）タブ用
  descCards: [],
  descLastRejected: null,
  descSkipStack: [],
  descTotalCount: 0,

  // リアルタイムリサーチタブ用
  rtCards: [],
  rtLastRejected: null,
  rtSkipStack: [],
  rtTotalCount: 0,

  // リピート検索タブ用
  rsCards: [],
  rsLastRejected: null,
  rsSkipStack: [],
  rsTotalCount: 0,
};

const els = {
  stack: document.getElementById("card-stack"),
  empty: document.getElementById("empty-message"),
  sortSelect: document.getElementById("sort-select"),
  undoBtn: document.getElementById("undo-btn"),
  progressLabel: document.getElementById("progress-label"),
  tabs: document.querySelectorAll(".tab"),
  reviewView: document.getElementById("review-view"),
  archiveView: document.getElementById("archive-view"),
  archiveList: document.getElementById("archive-list"),
  archiveEmpty: document.getElementById("archive-empty"),
  archiveModeSelect: document.getElementById("archive-mode-select"),
  autoRejectedList: document.getElementById("auto-rejected-list"),
  furimaView: document.getElementById("furima-view"),
  furimaStack: document.getElementById("furima-card-stack"),
  furimaEmpty: document.getElementById("furima-empty-message"),
  furimaProgressLabel: document.getElementById("furima-progress-label"),
  furimaUndoBtn: document.getElementById("furima-undo-btn"),
  furimaAccountSelect: document.getElementById("furima-account-select"),
  descView: document.getElementById("desc-view"),
  descStack: document.getElementById("desc-card-stack"),
  descEmpty: document.getElementById("desc-empty-message"),
  descProgressLabel: document.getElementById("desc-progress-label"),
  descUndoBtn: document.getElementById("desc-undo-btn"),
  rtView: document.getElementById("rt-view"),
  rtStack: document.getElementById("rt-card-stack"),
  rtEmpty: document.getElementById("rt-empty-message"),
  rtProgressLabel: document.getElementById("rt-progress-label"),
  rtUndoBtn: document.getElementById("rt-undo-btn"),
  rsView: document.getElementById("rs-view"),
  rsStack: document.getElementById("rs-card-stack"),
  rsEmpty: document.getElementById("rs-empty-message"),
  rsProgressLabel: document.getElementById("rs-progress-label"),
  rsUndoBtn: document.getElementById("rs-undo-btn"),
  asinFixModal: document.getElementById("asin-fix-modal"),
  asinFixOld: document.getElementById("asin-fix-old"),
  asinFixNew: document.getElementById("asin-fix-new"),
  asinFixPrice: document.getElementById("asin-fix-price"),
  modal: document.getElementById("reason-modal"),
  reasonGrid: document.querySelector(".reason-grid"),
  otherInput: document.getElementById("reason-other-input"),
  otherText: document.getElementById("reason-other-text"),
  otherSubmit: document.getElementById("reason-other-submit"),
};

// ---------- 位置の保存・復元（localStorage） ----------

const POS_KEY = "amacari_pos";

function savePosition() {
  if (state.cards.length === 0) {
    localStorage.removeItem(POS_KEY);
    return;
  }
  localStorage.setItem(POS_KEY, JSON.stringify({
    row: state.cards[0].row,
    sort: state.sort,
    total: state.totalCount,
  }));
}

function restorePosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (!saved || saved.sort !== state.sort) return;
    const idx = state.cards.findIndex(c => c.row === saved.row);
    if (idx > 0) {
      state.cards = [...state.cards.slice(idx), ...state.cards.slice(0, idx)];
      state.totalCount = Math.max(saved.total, state.cards.length);
    }
  } catch (_) {}
}

// ---------- データ取得 ----------

async function loadCards() {
  els.empty.textContent = "読み込み中…";
  els.empty.style.display = "block";
  try {
    const data = await gasFetch("cards", { sort: state.sort });
    state.cards = data.cards || [];
    state.skipStack = [];
    state.totalCount = state.cards.length;
    restorePosition();
    renderStack();
  } catch (e) {
    els.empty.textContent = "読み込みに失敗しました。GAS_URLの設定を確認してください。";
  }
}

async function loadArchive() {
  if (els.archiveModeSelect.value === "rejected") {
    return loadRejected();
  }
  els.autoRejectedList.classList.add("hidden");
  els.archiveList.classList.remove("hidden");
  els.archiveEmpty.textContent = "読み込み中…";
  els.archiveEmpty.style.display = "block";
  els.archiveList.innerHTML = "";
  try {
    const data = await gasFetch("archive");
    renderArchive(data.items || [], data.autoMatched || []);
    if ((data.autoMatched || []).length) refreshPendingPurchaseBadge();
  } catch (e) {
    els.archiveEmpty.textContent = "読み込みに失敗しました。";
  }
}

async function loadRejected() {
  els.archiveList.classList.add("hidden");
  els.autoRejectedList.classList.remove("hidden");
  els.archiveEmpty.textContent = "読み込み中…";
  els.archiveEmpty.style.display = "block";
  els.autoRejectedList.innerHTML = "";
  try {
    const data = await gasFetch("rejected");
    renderRejected(data.items || []);
  } catch (e) {
    els.archiveEmpty.textContent = "読み込みに失敗しました。";
  }
}

// 2026-11-04追加：furima_hitsに複数アカウント（プレミアム用・サルベージリピート用等）が
// 混在するようになったため、「アカウント」列でFRタブを絞り込めるようにする。
// シートに実在するアカウント値はgasFetchの都度サーバーから返してもらい、
// プルダウンに動的に反映する（A/B/C等、どの値を使うかはTampermonkey側の運用次第のため）。
function renderFurimaAccountOptions(accounts) {
  const sel = els.furimaAccountSelect;
  const current = sel.value;
  const existing = new Set(Array.from(sel.options).map(o => o.value));
  accounts.forEach(a => {
    if (existing.has(a)) return;
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    sel.appendChild(opt);
  });
  if (Array.from(sel.options).some(o => o.value === current)) {
    sel.value = current;
  }
}

async function loadFurimaCards() {
  els.furimaEmpty.textContent = "読み込み中…";
  els.furimaEmpty.style.display = "block";
  try {
    const data = await gasFetch("furimaCards", { account: state.furimaAccount || "" });
    state.furimaCards = data.cards || [];
    renderFurimaAccountOptions(data.accounts || []);
    state.furimaSkipStack = [];
    state.furimaTotalCount = state.furimaCards.length;
    renderFurimaStack();
  } catch (e) {
    els.furimaEmpty.textContent = "読み込みに失敗しました。GAS_URLの設定を確認してください。";
  }
}

async function loadDescCards() {
  els.descEmpty.textContent = "読み込み中…";
  els.descEmpty.style.display = "block";
  try {
    const data = await gasFetch("descCards");
    state.descCards = data.cards || [];
    state.descSkipStack = [];
    state.descTotalCount = state.descCards.length;
    renderDescStack();
  } catch (e) {
    els.descEmpty.textContent = "読み込みに失敗しました。";
  }
}

async function loadRtCards() {
  els.rtEmpty.textContent = "読み込み中…";
  els.rtEmpty.style.display = "block";
  try {
    const data = await gasFetch("rtCards");
    state.rtCards = data.cards || [];
    state.rtSkipStack = [];
    state.rtTotalCount = state.rtCards.length;
    renderRtStack();
  } catch (e) {
    els.rtEmpty.textContent = "読み込みに失敗しました。";
  }
}

async function loadRsCards() {
  els.rsEmpty.textContent = "読み込み中…";
  els.rsEmpty.style.display = "block";
  try {
    const data = await gasFetch("rsCards");
    state.rsCards = data.cards || [];
    state.rsSkipStack = [];
    state.rsTotalCount = state.rsCards.length;
    renderRsStack();
  } catch (e) {
    els.rsEmpty.textContent = "読み込みに失敗しました。";
  }
}

function renderDescStack() {
  els.descStack.querySelectorAll(".card").forEach(c => c.remove());
  const done = Math.max(state.descTotalCount - state.descCards.length, 0);
  els.descProgressLabel.textContent = `${done} / ${state.descTotalCount}`;
  if (state.descCards.length === 0) {
    els.descEmpty.textContent = "判定待ちの商品はありません。";
    els.descEmpty.style.display = "block";
    return;
  }
  els.descEmpty.style.display = "none";
  const visible = state.descCards.slice(0, 3).reverse();
  visible.forEach((card, i) => {
    const el = buildCardEl(card);
    hydrateItemPhotos(el);
    const depthFromTop = visible.length - 1 - i;
    el.style.zIndex = String(100 - depthFromTop);
    el.style.transform = `scale(${1 - depthFromTop * 0.04}) translateY(${depthFromTop * 10}px)`;
    if (depthFromTop === 0) attachSwipe(el, card, "desc");
    els.descStack.appendChild(el);
  });
}

function renderRtStack() {
  els.rtStack.querySelectorAll(".card").forEach(c => c.remove());
  const done = Math.max(state.rtTotalCount - state.rtCards.length, 0);
  // 2026-11-20追加：RTタブにも優先精査（Code.gs getRtCards）
  const priorityLeft = state.rtCards.filter(c => c.priority).length;
  els.rtProgressLabel.textContent = `${done} / ${state.rtTotalCount}` + (priorityLeft ? `（優先 残${priorityLeft}）` : "");
  updatePriorityBadge(priorityLeft, "rt-priority-badge", false);
  updatePriorityJumpBtn("rt-priority-jump-btn", state.rtCards, priorityLeft);
  if (state.rtCards.length === 0) {
    els.rtEmpty.textContent = "判定待ちの商品はありません。";
    els.rtEmpty.style.display = "block";
    return;
  }
  els.rtEmpty.style.display = "none";
  const visible = state.rtCards.slice(0, 3).reverse();
  visible.forEach((card, i) => {
    const el = buildCardEl(card);
    hydrateItemPhotos(el);
    const depthFromTop = visible.length - 1 - i;
    el.style.zIndex = String(100 - depthFromTop);
    el.style.transform = `scale(${1 - depthFromTop * 0.04}) translateY(${depthFromTop * 10}px)`;
    if (depthFromTop === 0) attachSwipe(el, card, "rt");
    els.rtStack.appendChild(el);
  });
}

function renderRsStack() {
  els.rsStack.querySelectorAll(".card").forEach(c => c.remove());
  const done = Math.max(state.rsTotalCount - state.rsCards.length, 0);
  els.rsProgressLabel.textContent = `${done} / ${state.rsTotalCount}`;
  if (state.rsCards.length === 0) {
    els.rsEmpty.textContent = "判定待ちの商品はありません。";
    els.rsEmpty.style.display = "block";
    return;
  }
  els.rsEmpty.style.display = "none";
  const visible = state.rsCards.slice(0, 3).reverse();
  visible.forEach((card, i) => {
    const el = buildCardEl(card);
    hydrateItemPhotos(el);
    const depthFromTop = visible.length - 1 - i;
    el.style.zIndex = String(100 - depthFromTop);
    el.style.transform = `scale(${1 - depthFromTop * 0.04}) translateY(${depthFromTop * 10}px)`;
    if (depthFromTop === 0) attachSwipe(el, card, "rs");
    els.rsStack.appendChild(el);
  });
}

// ---------- カードのレンダリング ----------

function renderStack() {
  els.stack.querySelectorAll(".card").forEach(c => c.remove());

  const done = Math.max(state.totalCount - state.cards.length, 0);
  // 2026-11-20追加：優先精査カードの残り件数も併記する
  const priorityLeft = state.cards.filter(c => c.priority).length;
  els.progressLabel.textContent = `${done} / ${state.totalCount}` + (priorityLeft ? `（優先 残${priorityLeft}）` : "");
  updatePriorityBadge(priorityLeft);
  updatePriorityJumpBtn("priority-jump-btn", state.cards, priorityLeft);

  if (state.cards.length === 0) {
    els.empty.textContent = "判定待ちの商品はありません。お疲れさまでした。";
    els.empty.style.display = "block";
    return;
  }
  els.empty.style.display = "none";

  // 上位3枚だけDOMに積む（下にいくほど後ろ）
  const visible = state.cards.slice(0, 3).reverse();
  visible.forEach((card, i) => {
    const el = buildCardEl(card);
    hydrateItemPhotos(el);
    const depthFromTop = visible.length - 1 - i;
    el.style.zIndex = String(100 - depthFromTop);
    el.style.transform = `scale(${1 - depthFromTop * 0.04}) translateY(${depthFromTop * 10}px)`;
    if (depthFromTop === 0) attachSwipe(el, card);
    els.stack.appendChild(el);
  });

  savePosition();
}

// 2026-11-21追加：クイックショップの「過去の販売数」（QS販売数係→qs_salesシート→Code.gs
// attachQsSales_でcard.qs）。モノトレを開かずに売れ行きを判断できるようにする。
// 色：月間平均2個未満=赤（売れてない）／5個以上=緑（よく売れる）／その間=黄。
const QS_RED_BELOW_ = 2;
const QS_GREEN_FROM_ = 5;
function formatQsLine(card) {
  const q = card.qs;
  if (!q) return `<div class="qs-line qs-none">📦 販売数：取得中</div>`;
  if (q.status !== "ok" || q.avg === null || q.avg === undefined) {
    return `<div class="qs-line qs-none">📦 販売数：クイックショップ表示なし</div>`;
  }
  const avg = Number(q.avg);
  const cls = avg < QS_RED_BELOW_ ? "qs-red" : avg >= QS_GREEN_FROM_ ? "qs-green" : "qs-mid";
  const recent = (q.m1 !== null && q.m1 !== undefined) ? `（直近1か月 ${q.m1}）` : "";
  // 2026-11-22：FBA出品者数・Amazon本体の有無と「売れる目安日数」（Code.gs turnoverDays_）も出す。
  // カートを取り合う実質のライバルはFBA出品者とAmazon本体なので、目安はそれで計算している。
  let sellers = "";
  if (q.new_sellers !== null && q.new_sellers !== undefined) {
    const fba = (q.fba_sellers !== null && q.fba_sellers !== undefined)
      ? `（FBA ${q.fba_sellers}人${q.amazon_seller ? "・Amazon本体あり" : ""}）` : "";
    sellers = `／新品${q.new_sellers}人${fba}`;
  }
  const days = (q.days !== null && q.days !== undefined) ? `<br>⏱ 売れる目安 <b>約${q.days}日</b>` : "";
  return `<div class="qs-line ${cls}">📦 月平均 <b>${avg}</b>個${recent}${sellers}${days}</div>`;
}

// 2026-11-21追加：上スワイプ（後回し）で優先カードを通り過ぎた時に、残っている
// 優先カードを一度に先頭へ戻すボタン。優先カードが残っていて先頭が優先でない時だけ出す。
function updatePriorityJumpBtn(btnId, cards, priorityLeft) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const show = priorityLeft > 0 && cards.length > 0 && !cards[0].priority;
  btn.classList.toggle("hidden", !show);
  if (show) btn.textContent = `⭐ 優先カードに戻る（残${priorityLeft}）`;
}

function jumpToPriority(source) {
  const isRt = source === "rt";
  const cardsKey = isRt ? "rtCards" : "cards";
  const skipKey  = isRt ? "rtSkipStack" : "skipStack";
  const cards = state[cardsKey];
  // 優先カードを今の並び順のまま先頭へ（通常カード同士の順番も保つ）
  state[cardsKey] = cards.filter(c => c.priority).concat(cards.filter(c => !c.priority));
  // 先頭に戻した優先カードは後回しスタックからも外す（下スワイプで二重に呼ばれないように）
  state[skipKey] = state[skipKey].filter(c => !c.priority);
  if (isRt) renderRtStack(); else renderStack();
}

// 2026-11-20追加：ARタブに優先精査の残り件数バッジを出す。ホーム画面に追加した
// PWAで対応端末なら、アプリアイコンにも同じ件数を出す（非対応なら何もしない）。
// 2026-11-20：RTタブ用にバッジIDを指定できるようにした。アプリアイコンの数字はARのみ。
function updatePriorityBadge(count, badgeId = "ar-priority-badge", setAppIcon = true) {
  const badge = document.getElementById(badgeId);
  if (badge) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.toggle("hidden", count === 0);
  }
  if (!setAppIcon) return;
  try {
    if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count).catch(() => {});
    else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch (_) {}
}

function pastJudgmentClass(judgment) {
  if (judgment === "却下") return "reject";
  if (judgment === "購入済み") return "purchased";
  return "target"; // 仕入れ対象
}

function formatPastJudgment(card) {
  if (!card.past_judgment) return "";
  const reasonText = card.past_reason ? `（${escapeHtml(card.past_reason)}）` : "";
  return `<div class="past-judgment-badge past-judgment-${pastJudgmentClass(card.past_judgment)}">⚠ 過去に「${escapeHtml(card.past_judgment)}」と判定済み${reasonText}</div>`;
}

// 2026-11-19：インデックスプリント表示。メルカリの写真は
//   https://static.mercdn.net/item/detail/orig/photos/m{ID}_{N}.jpg
// で2枚目以降も取れる（thumb/系URLは_1しか無い）。シートには1枚目のURLしか
// 保存していないので、商品IDを抜き出して_1〜_MAXを並べ、存在しない番号は
// 403になったタイルをonerrorで消す。ラクマ/ヤフーはURLから他の写真を割り出せない
// ため従来どおり1枚表示。
const INDEX_PRINT_MAX = 8;

function mercariPhotoId(url) {
  const m = /static\.mercdn\.net\/.*\/(m\d+)_\d+\.jpg/.exec(url || "");
  return m ? m[1] : null;
}

// 縮小タイル1枚分。wsrv.nlで200px・webp・画質60に縮小し、失敗時は元画像直リンク→それも失敗ならタイル削除
// ヤフー系画像(auctions.c.yimg.jp)はwsrvが404を返すため、Yahoo自身の縮小プロキシ
// auc-pctr.c.yimg.jp（200px指定で約8KB）を使う。
function photoTileHtml(full) {
  let small;
  const yahooPath = /auctions\.c\.yimg\.jp\/(images\.auctions\.yahoo\.co\.jp\/[^?]+)/.exec(full);
  if (yahooPath) {
    full  = `https://auctions.c.yimg.jp/${yahooPath[1]}`;
    small = `https://auc-pctr.c.yimg.jp/i/auctions.c.yimg.jp/${yahooPath[1]}?w=200&h=200`;
  } else {
    small = `https://wsrv.nl/?url=${encodeURIComponent(full)}&w=200&h=200&fit=cover&output=webp&q=60`;
  }
  return `<img class="thumb-tile" src="${escapeAttr(small)}" data-full="${escapeAttr(full)}" data-fb="${escapeAttr(full)}" alt="" draggable="false" onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb='';}else{this.remove();}">`;
}

// 2026-11-19：PayPayフリマ・ラクマは画像URLから他の写真を導出できないため、
// GAS（action=itemPhotos）に商品ページを読ませて写真URL一覧をもらう。
// 返ってくるまでは1枚目だけ表示し、2枚以上取れたらグリッドを差し替える。
// GAS未デプロイ・取得失敗時は1枚表示のまま。
const OTHER_PLATFORM_PHOTO_RE = /paypayfleamarket\.yahoo\.co\.jp\/item\/|item\.fril\.jp\//;
const photoListCache = new Map();

function hydrateItemPhotos(el) {
  const grid = el.querySelector(".card-thumb-grid[data-item-url]");
  if (!grid) return;
  const url = grid.dataset.itemUrl;
  if (!photoListCache.has(url)) {
    photoListCache.set(url,
      fetch(`${GAS_URL}?action=itemPhotos&url=${encodeURIComponent(url)}`)
        .then(r => r.json())
        .then(d => Array.isArray(d.images) ? d.images : [])
        .catch(() => []));
  }
  photoListCache.get(url).then(images => {
    if (images.length < 2 || !grid.isConnected) return;
    grid.innerHTML = images.slice(0, INDEX_PRINT_MAX).map(photoTileHtml).join("");
  });
}

function buildThumbHtml(imageUrl, itemUrl) {
  if (!imageUrl) return `<div class="card-thumb"></div>`;
  const id = mercariPhotoId(imageUrl);
  if (!id) {
    if (itemUrl && OTHER_PLATFORM_PHOTO_RE.test(itemUrl)) {
      return `<div class="card-thumb-grid" data-item-url="${escapeAttr(itemUrl)}">${photoTileHtml(imageUrl)}</div>`;
    }
    return `<img class="card-thumb" src="${escapeAttr(imageUrl)}" alt="">`;
  }
  const tiles = [];
  // webp版（item/detail/webp/photos/…）はorig(JPEG)より3〜5割軽い（2026-11-19実測）
  // 2026-11-19追記：「視認できればいい」ので画像縮小プロキシwsrv.nlで200px・webp・
  // 画質60に落とす（1枚3〜6KB、webp直より約1/10）。存在しない番号はwsrvが404を返す。
  // wsrvが落ちている時はwebp直リンクにフォールバックし、それも失敗したらタイルを消す。
  // 拡大表示（タップ）は元のwebpを使う。
  for (let n = 1; n <= INDEX_PRINT_MAX; n++) {
    tiles.push(photoTileHtml(`https://static.mercdn.net/item/detail/webp/photos/${id}_${n}.jpg`));
  }
  return `<div class="card-thumb-grid">${tiles.join("")}</div>`;
}

function openPhotoViewer(src) {
  let ov = document.getElementById("photo-viewer");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "photo-viewer";
    ov.innerHTML = `<img alt="">`;
    ov.addEventListener("click", () => ov.classList.remove("open"));
    document.body.appendChild(ov);
  }
  ov.querySelector("img").src = src;
  ov.classList.add("open");
}

function buildCardEl(card) {
  const el = document.createElement("div");
  const isHot = Number(card.real_margin) >= 50;
  // 2026-09-11追加：server.py側のfind_matches()が付与する[お宝]タグ（ランク5万位
  // 以内かつ差益3000円以上、またはランク不明でも利益率40%以上かつ差益6000円以上）
  // を検出して専用バッジを表示する。RTタブの通知が多すぎて慣れが生じ、本当に
  // 良い商品を見逃していた問題への対応（Discord通知の絞り込みと同じ基準）。
  const isTreasure = (card.name || "").includes("[お宝]");
  el.className = [
    "card",
    isTreasure ? "card--treasure" : "",
    isHot ? "card--hot" : "",
    // 2026-11-21：優先精査カードが通常カードと見分けにくい（小さなラベルだけだった）
    // というユーザー指摘で、カード最上部の帯＋枠色＋背景色で一目で分かるようにした。
    card.priority ? "card--priority" : "",
    // 2026-11-22：高回転・薄利（Code.gs applyTurnoverRules_）は緑で区別（優先カードの次に並ぶ）
    (!card.priority && card.thin_fast) ? "card--thinfast" : "",
  ].filter(Boolean).join(" ");

  const thumb = buildThumbHtml(card.image_url, card.mercari_url);

  // 2026-11-14：フリマウォッチ監視タブ（buildFurimaCardEl）の表示方式に統一。
  // 現在のメルカリ価格から値切れた場合の見込み利益を実利益率・ROIの括弧内に
  // 併記する。card.pmaxは2026-09-11以降すでに純粋な損益分岐点（Amazon価格-FBA
  // 手数料、required_margin等の先引きなし）なので、そのまま損益分岐点として使える。
  // 2026-11-17：1割引き・2割引きの両方の見込みを並べて見られるよう拡張。
  const breakeven       = Number(card.pmax);
  const mercariPriceNum = Number(card.mercari_price);
  const amazonPriceNum  = Number(card.amazon_price);

  function negotiationAt(ratio) {
    const negotiatedPrice = Number.isFinite(mercariPriceNum) ? Math.floor(mercariPriceNum * ratio) : null;
    const profit = (Number.isFinite(breakeven) && negotiatedPrice !== null) ? breakeven - negotiatedPrice : null;
    const margin = (profit !== null && amazonPriceNum) ? Math.round((profit / amazonPriceNum * 100) * 10) / 10 : null;
    const roi    = (profit !== null && negotiatedPrice) ? Math.round((profit / negotiatedPrice * 100) * 10) / 10 : null;
    return { negotiatedPrice, profit, margin, roi };
  }

  const nego10 = negotiationAt(0.9); // 1割引き
  const nego20 = negotiationAt(0.8); // 2割引き

  // 2026-11-17：server.py側の「交渉次第」ルート（NEGOTIATION_ALL_ROUTES、交渉前の
  // 生価格では利益条件を満たさないが10%交渉できれば成立する候補）は、card.real_profit/
  // real_margin/roiに最初から10%交渉後の想定利益が入っている。商品名の「[交渉次第]」
  // タグで交渉前提だと分かるので、利益額・実利益率・ROIは常に「損益分岐点-価格」の
  // 生の実態値を表示するよう、card側の値を使わずここで算出し直す。
  const actualProfit = (Number.isFinite(breakeven) && Number.isFinite(mercariPriceNum)) ? breakeven - mercariPriceNum : null;
  const actualMargin = (actualProfit !== null && amazonPriceNum) ? Math.round((actualProfit / amazonPriceNum * 100) * 10) / 10 : null;
  const actualRoi    = (actualProfit !== null && mercariPriceNum) ? Math.round((actualProfit / mercariPriceNum * 100) * 10) / 10 : null;

  const marginTargetText = (nego10.margin === null && nego20.margin === null) ? "" :
    `<span class="value-target">（1割:${formatPercent(nego10.margin)} ／ 2割:${formatPercent(nego20.margin)}）</span>`;
  const roiTargetText = (nego10.roi === null && nego20.roi === null) ? "" :
    `<span class="value-target">（1割:${formatPercent(nego10.roi)} ／ 2割:${formatPercent(nego20.roi)}）</span>`;

  el.innerHTML = `
    ${isTreasure ? '<div class="treasure-badge">💎 お宝</div>' : ''}
    ${isHot ? '<div class="hot-badge">🔥 激熱</div>' : ''}
    <div class="swipe-flag flag-like">仕入れ対象</div>
    <div class="swipe-flag flag-nope">却下</div>
    <div class="swipe-flag flag-skip">あとで</div>
    <div class="swipe-flag flag-back">戻る</div>
    ${card.priority ? `<div class="priority-band">⭐ 優先精査<span class="priority-band-reason">${escapeHtml(card.priority_reason || "")}</span></div>`
      : card.thin_fast ? `<div class="thinfast-band">🔄 高回転・薄利<span class="priority-band-reason">約${escapeHtml(String(card.thin_fast_days))}日で売れる見込み</span></div>` : ""}
    ${thumb}
    <div class="card-body">
      ${formatPastJudgment(card)}
      <p class="card-name">${escapeHtml(card.name)}</p>
      <p class="card-sub">
        型番：${escapeHtml(card.model)}<button class="copy-btn" data-copy="${escapeAttr(card.model)}" aria-label="型番をコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
        ／ ASIN：${escapeHtml(card.asin)}<button class="copy-btn" data-copy="${escapeAttr(card.asin)}" aria-label="ASINをコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
        ／ 検知：${escapeHtml(formatHitTime(card.date))}
        ／ ランク：${formatRank(card.rank)}
      </p>
      ${formatQsLine(card)}
      <div class="card-highlight">
        <div class="highlight-box highlight-margin">
          <span class="label">実利益率</span>
          <span class="value">${formatPercent(actualMargin)}${marginTargetText}</span>
        </div>
        <div class="highlight-box highlight-roi">
          <span class="label">ROI</span>
          <span class="value">${formatPercent(actualRoi)}${roiTargetText}</span>
        </div>
      </div>
      <div class="card-grid">
        <div><span>Amazon価格</span><span class="price-val" data-price="${card.amazon_price}">${formatYen(card.amazon_price)}</span><button class="recheck-price-btn no-swipe" data-row="${card.row}" data-asin="${escapeAttr(card.asin)}" data-model="${escapeAttr(card.model)}" aria-label="価格を再調査">🔄</button></div>
        <div><span>交渉金額（1割）</span>${formatYen(nego10.negotiatedPrice)}</div>
        <div><span>損益分岐点</span>${formatYen(card.pmax)}</div>
        <div><span>交渉利益（1割）</span>${formatYen(nego10.profit)}</div>
        <div><span>価格</span>${formatYen(card.mercari_price)}</div>
        <div><span>交渉金額（2割）</span>${formatYen(nego20.negotiatedPrice)}</div>
        <div><span>利益額</span>${formatYen(actualProfit)}</div>
        <div><span>交渉利益（2割）</span>${formatYen(nego20.profit)}</div>
      </div>
      <div class="card-links">
        <a class="link-btn ${marketplaceInfo(card.mercari_url).cls}" href="${escapeAttr(card.mercari_url)}">${marketplaceInfo(card.mercari_url).label}</a>
        <a class="link-btn link-amazon" href="https://www.amazon.co.jp/dp/${encodeURIComponent(card.asin)}">Amazon</a>
        <a class="link-btn link-monotracer" href="https://www.mono-tracer.com/#/product/${encodeURIComponent(card.asin)}">モノトレ</a>
        <a class="link-btn link-keepa" href="https://keepa.com/#!product/5-${encodeURIComponent(card.asin)}">Keepa</a>
        <button class="link-btn link-asin-fix no-swipe" data-row="${card.row}">ASIN修正</button>
        <button class="link-btn link-check-restriction no-swipe" data-asin="${escapeAttr(card.asin)}">出品制限確認</button>
        <button class="link-btn link-report-model no-swipe" data-model="${escapeAttr(card.model)}" data-asin="${escapeAttr(card.asin)}" data-name="${escapeAttr(card.name)}" data-url="${escapeAttr(card.mercari_url)}">🚩型番通報</button>
      </div>
      <div class="card-keepa">
        <p class="keepa-label">Keepa（90日）</p>
        <div class="keepa-graph-wrap">
          <img class="keepa-graph" src="${'https://graph.keepa.com/pricehistory.png?asin='+encodeURIComponent(card.asin)+'&domain=5&amazon=1&new=1&used=1&salesrank=1&range=90&width=800&cAmazon=f5a623&cNew=4fc3f7&cUsed=aaaaaa&cSales=8e44ad&cFont=1b2733&cBackground=ffffff'}" alt="Keepaグラフ" loading="lazy">
          <button class="keepa-reload-btn" aria-label="グラフ再読込" title="グラフ再読込">🔄</button>
        </div>
      </div>
    </div>
  `;
  return el;
}

// ---------- フリマウォッチ監視タブ：カードのレンダリング ----------

function renderFurimaStack() {
  els.furimaStack.querySelectorAll(".card").forEach(c => c.remove());

  const done = Math.max(state.furimaTotalCount - state.furimaCards.length, 0);
  els.furimaProgressLabel.textContent = `${done} / ${state.furimaTotalCount}`;

  if (state.furimaCards.length === 0) {
    els.furimaEmpty.textContent = "判定待ちの商品はありません。お疲れさまでした。";
    els.furimaEmpty.style.display = "block";
    return;
  }
  els.furimaEmpty.style.display = "none";

  const visible = state.furimaCards.slice(0, 3).reverse();
  visible.forEach((card, i) => {
    const el = buildFurimaCardEl(card);
    hydrateItemPhotos(el);
    const depthFromTop = visible.length - 1 - i;
    el.style.zIndex = String(100 - depthFromTop);
    el.style.transform = `scale(${1 - depthFromTop * 0.04}) translateY(${depthFromTop * 10}px)`;
    if (depthFromTop === 0) attachSwipe(el, card, "furima");
    els.furimaStack.appendChild(el);
  });
}

function buildFurimaCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";

  const thumb = buildThumbHtml(card.image_url, card.url);

  const links = [
    `<a class="link-btn link-mercari" href="${escapeAttr(card.url)}">商品ページ</a>`,
  ];
  if (card.asin) {
    links.push(`<a class="link-btn link-amazon" href="https://www.amazon.co.jp/dp/${encodeURIComponent(card.asin)}">Amazon</a>`);
    links.push(`<a class="link-btn link-monotracer" href="https://www.mono-tracer.com/#/product/${encodeURIComponent(card.asin)}">モノトレ</a>`);
    links.push(`<a class="link-btn link-keepa" href="https://keepa.com/#!product/5-${encodeURIComponent(card.asin)}">Keepa</a>`);
    links.push(`<button class="link-btn link-check-restriction no-swipe" data-asin="${escapeAttr(card.asin)}">出品制限確認</button>`);
  }
  if (card.model) {
    links.push(`<button class="link-btn link-exclude-model no-swipe" data-model="${escapeAttr(card.model)}">🚫型番除外報告</button>`);
  }

  const modelLine = card.model
    ? `型番：${escapeHtml(card.model)}<button class="copy-btn" data-copy="${escapeAttr(card.model)}" aria-label="型番をコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button> ／ `
    : "";
  const asinLine = card.asin
    ? ` ／ ASIN：${escapeHtml(card.asin)}<button class="copy-btn" data-copy="${escapeAttr(card.asin)}" aria-label="ASINをコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>`
    : "";

  // 2026-11-17：AR/RT（buildCardEl）と同じ1割・2割の2段階表示に統一。
  // card.negotiated_price/max_profit/max_margin/max_roiはサーバー側で2割固定の
  // 値しか持っていないため、ここでも同じ考え方（card.breakeven・card.priceから
  // そのつど算出）に揃えて1割分も自前で計算する。
  const fPriceNum     = Number(card.price);
  const fBreakeven    = Number(card.breakeven);
  const fAmazonPrice  = Number(card.amazon_price);

  function fNegotiationAt(ratio) {
    const negotiatedPrice = Number.isFinite(fPriceNum) ? Math.floor(fPriceNum * ratio) : null;
    const profit = (Number.isFinite(fBreakeven) && negotiatedPrice !== null) ? fBreakeven - negotiatedPrice : null;
    const margin = (profit !== null && fAmazonPrice) ? Math.round((profit / fAmazonPrice * 100) * 10) / 10 : null;
    const roi    = (profit !== null && negotiatedPrice) ? Math.round((profit / negotiatedPrice * 100) * 10) / 10 : null;
    return { negotiatedPrice, profit, margin, roi };
  }

  const fNego10 = fNegotiationAt(0.9); // 1割引き
  const fNego20 = fNegotiationAt(0.8); // 2割引き

  const fMarginTargetText = (fNego10.margin === null && fNego20.margin === null) ? "" :
    `<span class="value-target">（1割:${formatPercent(fNego10.margin)} ／ 2割:${formatPercent(fNego20.margin)}）</span>`;
  const fRoiTargetText = (fNego10.roi === null && fNego20.roi === null) ? "" :
    `<span class="value-target">（1割:${formatPercent(fNego10.roi)} ／ 2割:${formatPercent(fNego20.roi)}）</span>`;

  el.innerHTML = `
    <div class="swipe-flag flag-like">仕入れ対象</div>
    <div class="swipe-flag flag-nope">却下</div>
    <div class="swipe-flag flag-skip">あとで</div>
    <div class="swipe-flag flag-back">戻る</div>
    ${thumb}
    <div class="card-body">
      <p class="card-name">${escapeHtml(card.name)}</p>
      <p class="card-sub">${modelLine}サービス：${escapeHtml(card.service)}${asinLine} ／ 検知：${escapeHtml(formatHitTime(card.date))}</p>
      <div class="card-highlight">
        <div class="highlight-box highlight-margin">
          <span class="label">実利益率</span>
          <span class="value">${formatPercent(card.margin)}${fMarginTargetText}</span>
        </div>
        <div class="highlight-box highlight-roi">
          <span class="label">ROI</span>
          <span class="value">${formatPercent(card.roi)}${fRoiTargetText}</span>
        </div>
      </div>
      <div class="card-grid">
        <div><span>Amazon価格</span><span class="price-val" data-price="${card.amazon_price}">${formatYen(card.amazon_price)}</span><button class="recheck-price-btn no-swipe" data-row="${card.row}" data-asin="${escapeAttr(card.asin)}" data-model="${escapeAttr(card.model)}" aria-label="価格を再調査">🔄</button></div>
        <div><span>交渉金額（1割）</span>${formatYen(fNego10.negotiatedPrice)}</div>
        <div><span>損益分岐点</span>${formatYen(card.breakeven)}</div>
        <div><span>交渉利益（1割）</span>${formatYen(fNego10.profit)}</div>
        <div><span>価格</span>${formatYen(card.price)}</div>
        <div><span>交渉金額（2割）</span>${formatYen(fNego20.negotiatedPrice)}</div>
        <div><span>利益額</span>${formatYen(card.real_profit)}</div>
        <div><span>交渉利益（2割）</span>${formatYen(fNego20.profit)}</div>
      </div>
      <div class="card-links">
        ${links.join("\n")}
      </div>
    </div>
  `;
  return el;
}

// ---------- Amazon価格インライン編集 ----------

function recalcWithNewPrice(card, newPrice) {
  // 2026-09-11：pmaxを純粋な損益分岐点（Amazon価格-手数料）に変更したため、
  // Amazon価格が変わった分はそのまま1:1でpmaxに反映される（旧×0.85は不要）。
  // diffがそのまま実利益額になるため、real_profit/real_marginの補正も不要。
  const pmax = Math.round(Number(card.pmax) + (newPrice - Number(card.amazon_price)));
  const mercariPrice = Number(card.mercari_price);
  const diff = Math.round(pmax - mercariPrice);
  const roi = mercariPrice ? Math.round(diff / mercariPrice * 1000) / 10 : 0;
  const margin = newPrice ? Math.round(diff / newPrice * 1000) / 10 : 0;
  const score = Math.round((roi * 0.5 + margin * 0.3 + newPrice / 1000 * 0.2) * 10) / 10;
  const real_profit = diff;
  const real_margin = margin;
  return { amazon_price: newPrice, pmax, diff, roi, margin, score, real_profit, real_margin };
}

// FRタブ用：breakeven（真の損益分岐点）はシートに直接保存されていないため、
// AR側のrecalcWithNewPriceと同じ考え方（価格差分をそのまま加算）で再構成する。
function recalcFurimaWithNewPrice(card, newPrice) {
  const breakeven = Math.round(Number(card.breakeven) + (newPrice - Number(card.amazon_price)));
  const price = Number(card.price);
  const realProfit = breakeven - price;
  const margin = newPrice ? Math.round(realProfit / newPrice * 1000) / 10 : 0;
  const roi = price ? Math.round(realProfit / price * 1000) / 10 : 0;
  // 2026-11-17：1割/2割の交渉金額・交渉利益はbuildFurimaCardElがbreakeven・price・
  // amazon_priceからそのつど算出するため、ここで持つ必要はなくなった。
  return { amazon_price: newPrice, breakeven, real_profit: realProfit, margin, roi };
}

// 2026-09-11：手入力での価格編集は「利益少ない」に見える商品をわざわざ調べ直す
// 手間が大きく結局そのまま却下されがちだったため廃止し、その場でSP-APIから
// 最新のAmazon価格を取得するボタンに置き換えた（GAS側でprice_recheck_queue
// シートにも積まれ、後でasin-tools/server.pyがlist.jsonへ反映する）。
els.stack.addEventListener("click", async e => {
  const btn = e.target.closest(".recheck-price-btn");
  if (!btn) return;
  e.stopPropagation();
  if (btn.disabled) return;
  const row = Number(btn.dataset.row);
  const asin = btn.dataset.asin;
  const model = btn.dataset.model;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await gasPost("recheckPrice", { asin, model });
    const data = await res.json();
    if (data.error || !data.price) {
      alert(data.error || "価格を取得できませんでした");
      return;
    }
    const card = state.cards.find(c => c.row === row);
    if (!card) return;
    const upd = recalcWithNewPrice(card, data.price);
    Object.assign(card, upd);
    await gasPost("updateAmazonPrice", { row, ...upd });
    renderStack();
  } catch (err) {
    alert("価格再調査に失敗しました: " + err);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// FRタブ用：recheckPrice自体はAR/FR共通（ASIN指定でSP-APIから最新価格を取得する
// だけの汎用action）だが、更新先の列構成が違うためupdateFurimaAmazonPriceで分ける。
els.furimaStack.addEventListener("click", async e => {
  const btn = e.target.closest(".recheck-price-btn");
  if (!btn) return;
  e.stopPropagation();
  if (btn.disabled) return;
  const row = Number(btn.dataset.row);
  const asin = btn.dataset.asin;
  const model = btn.dataset.model;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await gasPost("recheckPrice", { asin, model });
    const data = await res.json();
    if (data.error || !data.price) {
      alert(data.error || "価格を取得できませんでした");
      return;
    }
    const card = state.furimaCards.find(c => c.row === row);
    if (!card) return;
    const upd = recalcFurimaWithNewPrice(card, data.price);
    Object.assign(card, upd);
    await gasPost("updateFurimaAmazonPrice", { row, amazon_price: upd.amazon_price, margin: upd.margin });
    renderFurimaStack();
  } catch (err) {
    alert("価格再調査に失敗しました: " + err);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// ---------- Keepaグラフ再読込 ----------

els.stack.addEventListener("click", e => {
  const btn = e.target.closest(".keepa-reload-btn");
  if (!btn) return;
  e.stopPropagation();
  const img = btn.previousElementSibling;
  btn.disabled = true;
  btn.textContent = "…";
  img.style.opacity = "0.3";
  const restore = () => {
    img.style.opacity = "1";
    btn.textContent = "🔄";
    btn.disabled = false;
  };
  img.onload = restore;
  img.onerror = restore;
  img.src = img.src.split("&t=")[0] + "&t=" + Date.now();
});


// ---------- コピー操作 ----------

// navigator.clipboardが使えない/失敗する環境向けのフォールバック
// （iOSのホーム画面PWA=standaloneモードでnavigator.clipboardが使えないケースがあるため2026-08-17追加）
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

async function handleCopyClick(e) {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  e.stopPropagation();
  const text = btn.dataset.copy || "";
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) {
    ok = false;
  }
  if (!ok) ok = legacyCopy(text);

  if (ok) {
    // btn.textContentだとSVGアイコンの中身が拾えず空文字になり、元アイコンが消えて
    // 二度と表示されなくなるバグがあったため、innerHTMLで元のマークアップごと保存する
    const original = btn.innerHTML;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1200);
  } else {
    alert("コピーに失敗しました。");
  }
}

els.stack.addEventListener("click", handleCopyClick);
// 2026-10-27追加：desc/rtタブにも同じcopy-btnが元々あったが
// リスナーがels.stackにしか付いておらず動いていなかった既存バグも合わせて修正。
els.descStack.addEventListener("click", handleCopyClick);
els.rtStack.addEventListener("click", handleCopyClick);
els.rsStack.addEventListener("click", handleCopyClick);
els.furimaStack.addEventListener("click", handleCopyClick);

// ---------- スワイプ操作 ----------

function attachSwipe(el, card, source) {
  source = source || "amacari";
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  let axis = null; // "x" or "y" - 最初の動きで方向を決め、以後はその軸だけにスライドを制限する
  let tapTile = null; // インデックスプリントの写真上で押し始めたら記録（動かさず離したら拡大表示）

  const likeFlag = el.querySelector(".flag-like");
  const nopeFlag = el.querySelector(".flag-nope");
  const skipFlag = el.querySelector(".flag-skip");
  const backFlag = el.querySelector(".flag-back");
  const flags = [likeFlag, nopeFlag, skipFlag, backFlag];

  const AXIS_LOCK_THRESHOLD = 8;

  function onStart(x, y) {
    dragging = true;
    startX = x; startY = y;
    dx = 0; dy = 0;
    axis = null;
    el.classList.add("dragging");
  }

  function onMove(x, y) {
    if (!dragging) return;
    dx = x - startX;
    dy = y - startY;

    if (!axis && (Math.abs(dx) > AXIS_LOCK_THRESHOLD || Math.abs(dy) > AXIS_LOCK_THRESHOLD)) {
      axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    }

    const moveX = axis === "y" ? 0 : dx;
    const moveY = axis === "x" ? 0 : dy;
    el.style.transform = `translate(${moveX}px, ${moveY}px)`;

    flags.forEach(f => f.style.opacity = 0);
    if (axis === "x") {
      const ratio = Math.min(Math.abs(dx) / 120, 1);
      (dx > 0 ? likeFlag : nopeFlag).style.opacity = ratio;
    } else if (axis === "y") {
      const ratio = Math.min(Math.abs(dy) / 120, 1);
      (dy < 0 ? skipFlag : backFlag).style.opacity = ratio;
    }
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    const threshold = 100;
    const absX = Math.abs(dx), absY = Math.abs(dy);
    if (absX >= absY && absX > threshold) {
      // 2026-09-02修正：右スワイプも仕入れ状況モーダルが出るようになったため、
      // 左右どちらも選択が終わるまで次のスワイプをブロックする
      state.swipeBlocked = true;
      finishSwipe(el, card, dx > 0 ? "right" : "left", source);
    } else if (absY > absX && absY > threshold) {
      const dir = dy < 0 ? "up" : "down";
      if (dir === "down") {
        const skipKey = source === "furima" ? "furimaSkipStack" : source === "desc" ? "descSkipStack" : source === "rt" ? "rtSkipStack" : source === "rs" ? "rsSkipStack" : "skipStack";
        if (state[skipKey].length === 0) {
          // 後回しスタックが空 → キューの末尾カードを先頭に循環
          const cardsKey = source === "furima" ? "furimaCards" : source === "desc" ? "descCards" : source === "rt" ? "rtCards" : source === "rs" ? "rsCards" : "cards";
          if (state[cardsKey].length <= 1) {
            // カードが1枚以下 → バウンスだけ
            el.style.transform = "";
            flags.forEach(f => f.style.opacity = 0);
            el.classList.add("card--bounce");
            el.addEventListener("animationend", () => el.classList.remove("card--bounce"), { once: true });
            return;
          }
          finishVerticalSwipe(el, card, "down-loop", source);
          return;
        }
      }
      finishVerticalSwipe(el, card, dir, source);
    } else {
      el.style.transform = "";
      flags.forEach(f => f.style.opacity = 0);
      if (tapTile && absX < AXIS_LOCK_THRESHOLD && absY < AXIS_LOCK_THRESHOLD) {
        openPhotoViewer(tapTile.dataset.full || tapTile.src);
      }
    }
    tapTile = null;
  }

  el.addEventListener("pointerdown", e => {
    if (e.target.closest(".copy-btn, .keepa-reload-btn, .link-btn, .no-swipe")) return;
    if (state.swipeBlocked) return; // 理由選択中はスワイプ不可
    tapTile = e.target.closest(".thumb-tile");
    el.setPointerCapture(e.pointerId);
    onStart(e.clientX, e.clientY);
  });
  el.addEventListener("pointermove", e => onMove(e.clientX, e.clientY));
  el.addEventListener("pointerup", onEnd);
  el.addEventListener("pointercancel", onEnd);
}

function finishSwipe(el, card, direction, source) {
  source = source || "amacari";
  const isFurima = source === "furima";
  const isDesc   = source === "desc";
  const isRt     = source === "rt";
  const isRs     = source === "rs";
  const flyX = direction === "right" ? window.innerWidth : -window.innerWidth;
  el.style.transform = `translateX(${flyX}px)`;
  el.style.opacity = "0";

  setTimeout(() => {
    el.remove();
    if (isFurima) {
      state.furimaCards = state.furimaCards.filter(c => c.row !== card.row);
    } else if (isDesc) {
      state.descCards = state.descCards.filter(c => c.row !== card.row);
    } else if (isRt) {
      state.rtCards = state.rtCards.filter(c => c.row !== card.row);
    } else if (isRs) {
      state.rsCards = state.rsCards.filter(c => c.row !== card.row);
    } else {
      state.cards = state.cards.filter(c => c.row !== card.row);
    }
    if (direction === "right") {
      openPurchaseModal(card, source);
    } else {
      openReasonModal(card, source);
    }
    if (isFurima) renderFurimaStack();
    else if (isDesc) renderDescStack();
    else if (isRt) renderRtStack();
    else if (isRs) renderRsStack();
    else renderStack();
  }, 220);
}

// 上スワイプ＝後回し（末尾に送る）／下スワイプ＝後回しを呼び戻す or 末尾から循環
// シートへの書き込みは行わず、画面内の表示順だけを変える
function finishVerticalSwipe(el, card, direction, source) {
  source = source || "amacari";
  const isFurima = source === "furima";
  const isDesc   = source === "desc";
  const isRt     = source === "rt";
  const isRs     = source === "rs";
  const flyY = (direction === "up" || direction === "down-loop") ? -window.innerHeight : window.innerHeight;
  el.style.transform = `translateY(${flyY}px)`;
  el.style.opacity = "0";

  setTimeout(() => {
    el.remove();
    const cardsKey = isFurima ? "furimaCards" : isDesc ? "descCards" : isRt ? "rtCards" : isRs ? "rsCards" : "cards";
    const skipKey  = isFurima ? "furimaSkipStack" : isDesc ? "descSkipStack" : isRt ? "rtSkipStack" : isRs ? "rsSkipStack" : "skipStack";
    if (direction === "up") {
      state[cardsKey] = state[cardsKey].filter(c => c.row !== card.row);
      state[cardsKey].push(card);
      state[skipKey].push(card);
    } else if (direction === "down-loop") {
      const last = state[cardsKey][state[cardsKey].length - 1];
      state[cardsKey] = state[cardsKey].slice(0, -1);
      state[cardsKey].unshift(last);
    } else {
      const prev = state[skipKey].pop();
      if (prev) {
        state[cardsKey] = state[cardsKey].filter(c => c.row !== prev.row);
        state[cardsKey].unshift(prev);
      }
    }
    if (isFurima) renderFurimaStack();
    else if (isDesc) renderDescStack();
    else if (isRt) renderRtStack();
    else if (isRs) renderRsStack();
    else renderStack();
  }, 220);
}

// ---------- 出品制限確認 ----------

async function handleCheckRestrictionClick(e) {
  const btn = e.target.closest(".link-check-restriction");
  if (!btn) return;
  e.stopPropagation();
  const asin = btn.dataset.asin;
  if (!asin) { alert("ASINが取得できませんでした。"); return; }
  const original = btn.textContent;
  btn.textContent = "確認中…";
  btn.disabled = true;
  try {
    const data = await gasFetch("checkRestriction", { asin });
    if (!data.ok) {
      alert("確認に失敗しました：" + (data.error || "不明なエラー"));
    } else if (data.restricted) {
      alert(`⚠️ 出品制限あり\n理由：${data.reasonCode || "不明"}\n${data.message || ""}`);
    } else {
      alert("✅ 出品制限なし（出品可能）");
    }
  } catch (err) {
    alert("確認に失敗しました。通信状況を確認してください。");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

els.stack.addEventListener("click", handleCheckRestrictionClick);
els.rtStack.addEventListener("click", handleCheckRestrictionClick);
els.rsStack.addEventListener("click", handleCheckRestrictionClick);
els.descStack.addEventListener("click", handleCheckRestrictionClick);
els.furimaStack.addEventListener("click", handleCheckRestrictionClick);

// ---------- 型番通報 ----------
// 2026-09-14追加：精査中に「この型番はおかしい」と気づいても、後でまとめて
// 伝えようとすると忘れてしまうとの指摘を受け、その場でワンタップ記録できる
// ボタンを追加。判定操作とは独立で、押しても却下・仕入れ対象にはならない。
async function handleReportModelClick(e) {
  const btn = e.target.closest(".link-report-model");
  if (!btn) return;
  e.stopPropagation();
  const model = btn.dataset.model;
  const asin = btn.dataset.asin;
  const name = btn.dataset.name;
  const url = btn.dataset.url;
  const original = btn.textContent;
  btn.textContent = "送信中…";
  btn.disabled = true;
  try {
    await gasPost("reportModel", { model, asin, name, mercari_url: url });
    btn.textContent = "✅ 報告済み";
  } catch (err) {
    btn.textContent = "⚠ 失敗";
    btn.disabled = false;
    setTimeout(() => { btn.textContent = original; }, 2000);
  }
}

els.stack.addEventListener("click", handleReportModelClick);
els.rtStack.addEventListener("click", handleReportModelClick);
els.rsStack.addEventListener("click", handleReportModelClick);
els.descStack.addEventListener("click", handleReportModelClick);

// ---------- 型番除外報告（FRタブ専用） ----------
// 2026-09-16追加：FR（フリマウォッチ常時監視）タブでノイズ型番に気づいたら、
// reportModel（後日まとめて人力判断）とは別に、即座に除外を確定できるように
// する。押した型番はexport_frima.pyの次回CSV生成から自動的に除外される。
// 判定操作とは独立で、押しても却下・仕入れ対象にはならない。
async function handleExcludeFurimaModelClick(e) {
  const btn = e.target.closest(".link-exclude-model");
  if (!btn) return;
  e.stopPropagation();
  const model = btn.dataset.model;
  const original = btn.textContent;
  btn.textContent = "送信中…";
  btn.disabled = true;
  try {
    await gasPost("excludeFurimaModel", { model });
    btn.textContent = "✅ 除外済み";
  } catch (err) {
    btn.textContent = "⚠ 失敗";
    btn.disabled = false;
    setTimeout(() => { btn.textContent = original; }, 2000);
  }
}

els.furimaStack.addEventListener("click", handleExcludeFurimaModelClick);

// ---------- ASIN修正 ----------

els.stack.addEventListener("click", e => {
  const btn = e.target.closest(".link-asin-fix");
  if (!btn) return;
  e.stopPropagation();
  const row = Number(btn.dataset.row);
  const card = state.cards.find(c => c.row === row);
  if (!card) return;
  state.pendingAsinFix = card;
  els.asinFixOld.textContent = card.asin;
  els.asinFixNew.value = "";
  els.asinFixPrice.value = card.amazon_price || "";
  els.asinFixModal.classList.remove("hidden");
});

document.getElementById("asin-fix-submit").addEventListener("click", async () => {
  const card = state.pendingAsinFix;
  if (!card) return;
  const newAsin = els.asinFixNew.value.trim().toUpperCase();
  const newPrice = Math.round(Number(els.asinFixPrice.value));
  if (!newAsin || !newPrice) { alert("ASINとAmazon価格を両方入力してください"); return; }
  // 2026-09-11：pmaxを純粋な損益分岐点（Amazon価格-手数料）に変更
  const oldFee = Math.max(Math.round(Number(card.amazon_price) - Number(card.pmax)), 450);
  const newPmax = Math.round(newPrice - oldFee);
  await gasPost("saveAsinCorrection", {
    row: card.row, model: card.model,
    old_asin: card.asin, new_asin: newAsin,
    amazon_price: newPrice, pmax: newPmax,
  });
  state.cards = state.cards.filter(c => c.row !== card.row);
  state.pendingAsinFix = null;
  els.asinFixModal.classList.add("hidden");
  renderStack();
});

document.getElementById("asin-fix-cancel").addEventListener("click", () => {
  state.pendingAsinFix = null;
  els.asinFixModal.classList.add("hidden");
});

// ---------- 判定の送信 ----------

async function judge(card, judgment, reason, source) {
  source = source || "amacari";
  const isFurima = source === "furima";
  const isDesc   = source === "desc";
  const isRt     = source === "rt";
  const isRs     = source === "rs";
  const action = isFurima ? "furimaJudge" : isDesc ? "descJudge" : "judge";
  try {
    await gasPost(action, { row: card.row, judgment, reason });
    if (judgment === "却下") {
      if (isFurima) {
        state.furimaLastRejected = card;
        els.furimaUndoBtn.disabled = false;
      } else if (isDesc) {
        state.descLastRejected = card;
        els.descUndoBtn.disabled = false;
      } else if (isRt) {
        state.rtLastRejected = card;
        els.rtUndoBtn.disabled = false;
      } else if (isRs) {
        state.rsLastRejected = card;
        els.rsUndoBtn.disabled = false;
      } else {
        state.lastRejected = card;
        els.undoBtn.disabled = false;
      }
    }
    if (judgment === "仕入れ対象") refreshPendingPurchaseBadge();
  } catch (e) {
    alert("判定の保存に失敗しました。通信状況を確認してください。");
  }
}

async function undoLastReject(source) {
  source = source || "amacari";
  const isFurima = source === "furima";
  const isDesc   = source === "desc";
  const isRt     = source === "rt";
  const isRs     = source === "rs";
  const card   = isFurima ? state.furimaLastRejected : isDesc ? state.descLastRejected : isRt ? state.rtLastRejected : isRs ? state.rsLastRejected : state.lastRejected;
  if (!card) return;
  const btn    = isFurima ? els.furimaUndoBtn : isDesc ? els.descUndoBtn : isRt ? els.rtUndoBtn : isRs ? els.rsUndoBtn : els.undoBtn;
  const action = isFurima ? "furimaUndo" : isDesc ? "descUndo" : "undo";
  btn.disabled = true;
  try {
    await gasPost(action, { row: card.row });
    if (isFurima) {
      state.furimaLastRejected = null;
      state.furimaCards.unshift(card);
      renderFurimaStack();
    } else if (isDesc) {
      state.descLastRejected = null;
      state.descCards.unshift(card);
      renderDescStack();
    } else if (isRt) {
      state.rtLastRejected = null;
      state.rtCards.unshift(card);
      renderRtStack();
    } else if (isRs) {
      state.rsLastRejected = null;
      state.rsCards.unshift(card);
      renderRsStack();
    } else {
      state.lastRejected = null;
      state.cards.unshift(card);
      renderStack();
    }
  } catch (e) {
    alert("巻き戻しに失敗しました。");
    btn.disabled = false;
  }
}

// ---------- 却下理由モーダル ----------

function openReasonModal(card, source) {
  state.pendingReject = card;
  state.pendingRejectSource = source || "amacari";
  els.otherInput.classList.add("hidden");
  els.otherText.value = "";
  els.modal.classList.remove("hidden");
}

function closeReasonModal() {
  state.pendingReject = null;
  state.swipeBlocked = false;
  els.modal.classList.add("hidden");
}

els.reasonGrid.addEventListener("click", e => {
  const btn = e.target.closest(".reason-btn");
  if (!btn) return;
  if (btn.id === "reason-other-btn") {
    els.otherInput.classList.remove("hidden");
    els.otherText.focus();
    return;
  }
  const card = state.pendingReject;
  const source = state.pendingRejectSource;
  const reason = btn.dataset.reason;
  closeReasonModal();
  if (!card) return;
  judge(card, "却下", reason, source);
  // 2026-10-23追加：「価格変動」「不一致」は却下に加えて、後から自動で
  // 再調査できるようバックエンドのキュー／シートに積んでおく（バックグラウンド
  // 処理なのでここでは待たず、失敗してもconsoleログのみ）。
  if (reason === "価格変動") {
    gasPost("recheckPrice", { asin: card.asin, model: card.model }).catch(err => {
      console.error("価格再調査キューの登録に失敗:", err);
    });
  } else if (reason === "不一致") {
    gasPost("flagMismatchReview", {
      asin: card.asin, model: card.model, name: card.name, mercari_url: card.mercari_url,
    }).catch(err => {
      console.error("不一致再検証キューの登録に失敗:", err);
    });
  }
});

els.otherSubmit.addEventListener("click", () => {
  const card = state.pendingReject;
  const source = state.pendingRejectSource;
  const text = els.otherText.value.trim() || "その他";
  closeReasonModal();
  if (card) judge(card, "却下", text, source);
});

// ---------- 仕入れ状況モーダル（2026-09-02追加） ----------
// 右スワイプ直後に「仕入確定／仕入候補／キャンセル」を選ばせる。
// 「儲かりそうだが即決できない」商品が却下理由(利益少ない等)に紛れ込んでいた問題への対応。
// 仕入確定→即「購入済み」、仕入候補→「仕入れ対象」＋理由欄に「仕入候補」タグを付与し、
// 仕入候補タブ側で後から見分けられるようにする。既存のjudge()をそのまま使うため
// GAS側の変更は不要（judgment/reason列に書き込むだけの汎用APIのため）。

// 2026-11-22追加：仕入確定のとき、支払額・数量・出品者名（メルカリのみ手入力）を入れてもらい、
// 売上管理シートの今月のシートへ1行記録する（Code.gs recordPurchaseToSales_）。
// mode "archive"：仕入候補タブの「購入済みにする」から開いたとき（仕入候補ボタンは隠す）。
function cardListingUrl(card) { return card.mercari_url || card.url || ""; }
function cardPaidPrice(card) { return Number(card.mercari_price ?? card.price) || ""; }

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function openPurchaseModal(card, source, mode) {
  state.pendingPurchase = card;
  state.pendingPurchaseSource = source || "amacari";
  state.pendingPurchaseMode = mode || "swipe";
  const url = cardListingUrl(card);
  const isMercari = !/paypayfleamarket|fril\.jp/.test(url);
  document.getElementById("purchase-price").value = cardPaidPrice(card);
  document.getElementById("purchase-qty").value = 1;
  // 2026-11-23追加：仕入れ日（初期値は今日）。後からまとめて記録するときに実際に買った日へ変える
  const dateEl = document.getElementById("purchase-date");
  dateEl.value = todayYmd();
  dateEl.max = todayYmd();
  document.getElementById("purchase-seller").value = "";
  document.getElementById("purchase-seller-wrap").classList.toggle("hidden", !isMercari);
  const archive = state.pendingPurchaseMode === "archive";
  document.getElementById("purchase-title").textContent = archive ? "購入済みにして記録" : "仕入れの状況は？";
  document.getElementById("purchase-candidate-btn").classList.toggle("hidden", archive);
  document.getElementById("purchase-modal").classList.remove("hidden");
}

function closePurchaseModal() {
  state.pendingPurchase = null;
  state.swipeBlocked = false;
  document.getElementById("purchase-modal").classList.add("hidden");
}

let toastTimer = null;
function showToast(text, isError) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.toggle("is-error", !!isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), isError ? 8000 : 5000);
}

async function recordPurchase(card, source, input) {
  const body = {
    key: `${source}:${card.kind ? card.kind + ":" : ""}${card.row}:${card.asin}`,
    asin: card.asin,
    url: cardListingUrl(card),
    name: card.name,
    amazon_price: card.amazon_price,
    price: input.price,
    qty: input.qty,
    seller: input.seller,
    date: input.date,
  };
  try {
    const res = await gasPost("recordPurchase", body);
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || "記録に失敗しました");
    showToast(r.duplicate ? "売上管理シートには記録済みです" :
      `売上管理シート ${r.sheet}${r.created ? "（新しく作成）" : ""}${r.day ? `・${r.day}日` : ""} の${r.row}行目に記録・想定利益 ¥${Math.round(r.profit).toLocaleString()}`);
  } catch (e) {
    showToast(`売上管理シートへの記録に失敗：${e.message}。シートに手で記入してください`, true);
  }
}

function readPurchaseInputs(card) {
  const price = Number(document.getElementById("purchase-price").value) || cardPaidPrice(card);
  const qty = Math.max(1, Number(document.getElementById("purchase-qty").value) || 1);
  const seller = document.getElementById("purchase-seller").value.trim();
  const date = document.getElementById("purchase-date").value || todayYmd();
  return { price, qty, seller, date };
}

document.getElementById("purchase-confirm-btn").addEventListener("click", async () => {
  const card = state.pendingPurchase;
  const source = state.pendingPurchaseSource;
  const mode = state.pendingPurchaseMode;
  const input = card ? readPurchaseInputs(card) : null;
  closePurchaseModal();
  if (!card) return;
  if (mode === "archive") {
    const li = els.archiveList.querySelector(`.archive-item[data-key="${archiveKey(card)}"]`);
    try {
      await gasPost("purchased", { row: card.row, kind: card.kind || "hits", date: input.date });
      refreshPendingPurchaseBadge();
      if (li) {
        const group = li.closest(".archive-group");
        li.remove();
        if (group && !group.querySelector(".archive-item")) group.remove();
      }
    } catch (e) {
      alert("更新に失敗しました。");
      return;
    }
  } else {
    judge(card, "購入済み", "", source);
  }
  recordPurchase(card, source, input);
});

document.getElementById("purchase-candidate-btn").addEventListener("click", () => {
  const card = state.pendingPurchase;
  const source = state.pendingPurchaseSource;
  closePurchaseModal();
  if (card) judge(card, "仕入れ対象", "仕入候補", source);
});

document.getElementById("purchase-cancel-btn").addEventListener("click", () => {
  const card = state.pendingPurchase;
  const source = state.pendingPurchaseSource;
  const mode = state.pendingPurchaseMode;
  closePurchaseModal();
  if (!card || mode === "archive") return; // 仕入候補タブから開いたときは何もしない
  // 判定せずカードを山の先頭に戻す
  const cardsKey = source === "furima" ? "furimaCards" : source === "desc" ? "descCards" : source === "rt" ? "rtCards" : source === "rs" ? "rsCards" : "cards";
  state[cardsKey].unshift(card);
  if (source === "furima") renderFurimaStack();
  else if (source === "desc") renderDescStack();
  else if (source === "rt") renderRtStack();
  else if (source === "rs") renderRsStack();
  else renderStack();
});

// ---------- アーカイブ ----------

// 2026-11-22改善：値段・差益・経過日数を表示し、同じ商品（ASIN）をまとめ、
// 差益が大きく新しいものから並べる。先頭に合計（1商品1個として数えた見込み差益）を出す。
// 売上管理シートと照合して自動で購入済みにした分は、上にお知らせを出す（Code.gs reconcilePurchasesWithSales_）。
function archiveAgeDays(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((t - d) / 864e5);
}

function archiveAgeLabel(days) {
  if (days == null) return "";
  return days === 0 ? "今日" : `${days}日前`;
}

// 仕入候補はhits・furima_hits・desc_hitsの3シートから来るため、行番号だけでは区別できない
// （2026-11-23）。GASが返すkey（"furima:5268"等）を使い、無い古い応答ではhitsとみなす。
function archiveKey(item) { return item.key || `hits:${item.row}`; }
function archiveJudgeAction(item) {
  return item.kind === "furima" ? "furimaJudge" : item.kind === "desc" ? "descJudge" : "judge";
}

function archiveItemHtml(item) {
  const age = archiveAgeDays(item.date);
  const diff = Number(item.diff) || 0;
  const purchased = item.judgment === "購入済み";
  // 2026-11-23：フリマ・発掘の仕入候補も出すようになったので、どのタブの候補か分かるようにする
  const kindLabel = item.kind === "furima" ? "フリマ" : item.kind === "desc" ? "発掘" : "";
  return `
    <li class="archive-item${purchased ? " is-purchased" : ""}" data-key="${escapeAttr(archiveKey(item))}">
      ${item.image_url ? `<img class="archive-thumb" src="${escapeAttr(item.image_url)}" alt="">` : `<div class="archive-thumb"></div>`}
      <div class="archive-info">
        <p class="name">${kindLabel ? `<span class="archive-kind">${kindLabel}</span> ` : ""}${escapeHtml(item.name)}</p>
        <p class="archive-money">
          <span class="archive-price">${formatYen(item.mercari_price)}</span>
          <span class="archive-diff${diff >= 2000 ? " is-big" : ""}">差益 ${formatYen(item.diff)}</span>
          <span class="archive-age${age != null && age >= 8 ? " is-old" : ""}">${archiveAgeLabel(age)}</span>
        </p>
        <p class="meta">実利益率 ${formatPercent(item.real_margin)} ／ ROI ${formatPercent(item.roi)} ／ ${escapeHtml(item.judgment)}${item.reason === "売上管理シートで確認" ? "（売上管理シートで確認）" : ""}</p>
      </div>
      <div class="archive-actions">
        <a class="${marketplaceInfo(item.mercari_url).cls}" href="${escapeAttr(item.mercari_url)}">${marketplaceInfo(item.mercari_url).label}で見る</a>
        <a class="link-monotracer" href="https://www.mono-tracer.com/#/product/${encodeURIComponent(item.asin)}">モノトレ</a>
        <a class="link-keepa" href="https://keepa.com/#!product/5-${encodeURIComponent(item.asin)}">Keepa</a>
        ${purchased
          ? `<button class="done" disabled>購入済み</button>`
          : `<button data-action="purchased">購入済みにする</button>
             <button data-action="purchased-norecord">購入済み（シート記入済み）</button>
             <button data-action="not-purchased">結局買わなかった</button>
             <button data-action="reject-archive">却下に戻す</button>`}
      </div>
    </li>`;
}

function renderArchive(items, autoMatched = []) {
  if (items.length === 0) {
    els.archiveList.innerHTML = "";
    els.archiveEmpty.textContent = "アーカイブされた商品はまだありません。";
    els.archiveEmpty.style.display = "block";
    return;
  }
  els.archiveEmpty.style.display = "none";
  state.archiveItems = new Map(items.map(i => [archiveKey(i), i]));

  // 仕入れ対象を同じASINでまとめる（ASINが無いものは1件ずつ）
  const pending = items.filter(i => i.judgment !== "購入済み");
  const purchased = items.filter(i => i.judgment === "購入済み");
  const groups = new Map();
  pending.forEach(i => {
    const key = i.asin || archiveKey(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const list = Array.from(groups.values()).map(g => {
    g.sort((a, b) => (Number(a.mercari_price) || 0) - (Number(b.mercari_price) || 0));
    const best = Math.max(...g.map(i => Number(i.diff) || 0));
    const newest = g.reduce((s, i) => (i.date > s ? i.date : s), "");
    return { items: g, best, newest, age: archiveAgeDays(newest) };
  });
  // 差益が大きいものを上に。ただし8日以上前のもの（売れている可能性が高い）は下へ
  list.sort((a, b) => {
    const ao = a.age != null && a.age >= 8, bo = b.age != null && b.age >= 8;
    if (ao !== bo) return ao ? 1 : -1;
    if (b.best !== a.best) return b.best - a.best;
    return a.newest < b.newest ? 1 : -1;
  });

  const totalBest = list.reduce((s, g) => s + Math.max(0, g.best), 0);
  const fresh = list.filter(g => g.age == null || g.age < 8);
  const freshBest = fresh.reduce((s, g) => s + Math.max(0, g.best), 0);
  const summary = `
    <li class="archive-summary">
      <div class="archive-summary-main">候補 <strong>${list.length}商品</strong>（${pending.length}件）・見込み差益 <strong>${formatYen(totalBest)}</strong></div>
      <div class="archive-summary-sub">うち7日以内 ${fresh.length}商品・${formatYen(freshBest)}（同じ商品は1個として計算）</div>
    </li>`;
  const notice = autoMatched.length ? `
    <li class="archive-notice">✓ 売上管理シートと照合して <strong>${autoMatched.length}件</strong> を購入済みにしました
      <div class="archive-summary-sub">${autoMatched.map(m => escapeHtml(`${m.name.slice(0, 24)}（${m.bought.slice(5).replace("-", "/")}仕入れ）`)).join("、")}</div>
    </li>` : "";

  const groupHtml = g => {
    if (g.items.length === 1) return archiveItemHtml(g.items[0]);
    return `
      <li class="archive-group">
        <div class="archive-group-head">同じ商品 ${g.items.length}件 ・ 最安 ${formatYen(g.items[0].mercari_price)} ・ 最大差益 ${formatYen(g.best)}</div>
        <ul class="archive-list archive-group-list">${g.items.map(archiveItemHtml).join("")}</ul>
      </li>`;
  };

  const oldStart = list.findIndex(g => g.age != null && g.age >= 8);
  const body = list.map((g, i) =>
    (i === oldStart ? `<li class="archive-divider">8日以上前（売り切れている可能性が高い）</li>` : "") + groupHtml(g)
  ).join("");
  const purchasedHtml = purchased.length
    ? `<li class="archive-divider">購入済み（30日以内）</li>` + purchased.map(archiveItemHtml).join("")
    : "";
  els.archiveList.innerHTML = notice + summary + body + purchasedHtml;
}

function renderRejected(items) {
  if (items.length === 0) {
    els.archiveEmpty.textContent = "却下された商品はありません。";
    els.archiveEmpty.style.display = "block";
    return;
  }
  els.archiveEmpty.style.display = "none";
  els.autoRejectedList.innerHTML = items.map(item => `
    <li class="archive-item" data-row="${item.row}">
      ${item.image_url ? `<img class="archive-thumb" src="${escapeAttr(item.image_url)}" alt="">` : `<div class="archive-thumb"></div>`}
      <div class="archive-info">
        <p class="name">${escapeHtml(item.name)}</p>
        <p class="meta">実利益率 ${formatPercent(item.real_margin)} ／ ROI ${formatPercent(item.roi)} ／ 却下理由：${escapeHtml(item.reason)}${item.is_auto ? "（自動）" : ""}</p>
      </div>
      <div class="archive-actions">
        <a class="${marketplaceInfo(item.mercari_url).cls}" href="${escapeAttr(item.mercari_url)}">${marketplaceInfo(item.mercari_url).label}で見る</a>
        <button data-action="restore">やっぱり仕入れ対象</button>
        ${item.is_auto ? `<button data-action="confirm" data-reason="${escapeAttr(item.reason)}">却下のままでOK</button>` : ""}
      </div>
    </li>
  `).join("");
}

els.archiveList.addEventListener("click", async e => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const li = btn.closest(".archive-item");
  const item = (state.archiveItems || new Map()).get(li.dataset.key);
  if (!item) return;
  const row = item.row;
  const action = btn.dataset.action;
  if (action === "purchased") {
    // 2026-11-22：支払額などを入れてもらい、購入済み＋売上管理シートへの記録をまとめて行う
    openPurchaseModal(item, "archive", "archive");
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "更新中…";
  try {
    // 2026-11-23：フリマ・発掘の候補はそれぞれのシートへ書く（archiveJudgeAction）
    if (action === "purchased-norecord") {
      // 売上管理シートに手入力済みの商品用：購入済みにするだけで、シートには書かない
      // （「購入済みにする」は必ず1行書き足すため、手入力の行と二重になる）
      if (!confirm("売上管理シートには書かずに、購入済みにだけします。よろしいですか？")) {
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      await gasPost("purchased", { row, kind: item.kind || "hits" });
    } else if (action === "not-purchased") {
      await gasPost(archiveJudgeAction(item), { row, judgment: "却下", reason: "未購入", noLog: true });
    } else if (action === "reject-archive") {
      await gasPost(archiveJudgeAction(item), { row, judgment: "却下", reason: "キャンセル", noLog: true });
    }
    refreshPendingPurchaseBadge();
    // 2026-09-02修正：判定ごとに一覧全体をloadArchive()で読み直していたため、
    // 件数が増えるほど1件処理するたびに待たされていた。書き込みは既に成功しているので、
    // 該当行だけDOMから消せば十分（サーバーへの再問い合わせ・全件再描画は不要）。
    const group = li.closest(".archive-group");
    li.remove();
    if (group && !group.querySelector(".archive-item")) group.remove();
    if (!els.archiveList.querySelector(".archive-item")) {
      els.archiveEmpty.textContent = "アーカイブされた商品はまだありません。";
      els.archiveEmpty.style.display = "block";
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert("更新に失敗しました。");
  }
});

els.autoRejectedList.addEventListener("click", async e => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const li = btn.closest(".archive-item");
  const row = Number(li.dataset.row);
  const action = btn.dataset.action;
  const reason = btn.dataset.reason || "";
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "更新中…";
  try {
    if (action === "restore") {
      await gasPost("restoreRejected", { row });
      refreshPendingPurchaseBadge();
    } else if (action === "confirm") {
      await gasPost("confirmAutoRejected", { row, reason });
    }
    // 2026-09-02修正：archiveList側と同じ理由で、全件再読み込みではなく該当行の除去のみ
    li.remove();
    if (!els.autoRejectedList.children.length) {
      els.archiveEmpty.textContent = "却下された商品はありません。";
      els.archiveEmpty.style.display = "block";
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert("更新に失敗しました。");
  }
});

els.archiveModeSelect.addEventListener("change", loadArchive);

// ---------- タブ切り替え ----------

const VIEWS = {
  review:  { el: els.reviewView,  load: loadCards },
  archive: { el: els.archiveView, load: loadArchive },
  rt:      { el: els.rtView,      load: loadRtCards },
  rs:      { el: els.rsView,      load: loadRsCards },
  desc:    { el: els.descView,    load: loadDescCards },
  furima:  { el: els.furimaView,  load: loadFurimaCards },
  log:     { el: document.getElementById("log-view"), load: loadLog },
};

els.tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    els.tabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    Object.entries(VIEWS).forEach(([key, v]) => {
      v.el.classList.toggle("hidden", key !== view);
    });
    VIEWS[view].load();
  });
});

els.sortSelect.addEventListener("change", () => {
  state.sort = els.sortSelect.value;
  loadCards();
});

els.furimaAccountSelect.addEventListener("change", () => {
  state.furimaAccount = els.furimaAccountSelect.value;
  loadFurimaCards();
});

els.undoBtn.addEventListener("click", () => undoLastReject("amacari"));
document.getElementById("priority-jump-btn").addEventListener("click", () => jumpToPriority("amacari"));
document.getElementById("rt-priority-jump-btn").addEventListener("click", () => jumpToPriority("rt"));
els.furimaUndoBtn.addEventListener("click", () => undoLastReject("furima"));
els.descUndoBtn.addEventListener("click", () => undoLastReject("desc"));
els.rtUndoBtn.addEventListener("click", () => undoLastReject("rt"));
els.rsUndoBtn.addEventListener("click", () => undoLastReject("rs"));

document.getElementById("reason-cancel-btn").addEventListener("click", () => {
  const src = state.pendingRejectSource;
  closeReasonModal();
  if (src === "furima") renderFurimaStack();
  else if (src === "desc") renderDescStack();
  else if (src === "rt") renderRtStack();
  else if (src === "rs") renderRsStack();
  else renderStack();
});

// ---------- ユーティリティ ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }

// 2026-10-24追加：出品元URL(mercari_url)からマーケットプレイス名を判定する
// （フリマウォッチ/ラクマ追加時にリンクボタンが常に「メルカリ」固定表示だった抜けを修正）
function marketplaceInfo(url) {
  const u = url || "";
  if (u.includes("paypayfleamarket")) return { cls: "link-paypay", label: "PPフリマ" };
  if (u.includes("fril.jp"))          return { cls: "link-rakuma", label: "ラクマ" };
  return { cls: "link-mercari", label: "メルカリ" };
}

function formatYen(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? `¥${n.toLocaleString()}` : "−";
}

function formatPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? `${n}%` : "−";
}

function formatRank(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v !== null ? `${n.toLocaleString()}位` : "−";
}

// card.dateは"yyyy-MM-dd HH:mm"形式（Code.gs側で'Asia/Tokyo'指定でフォーマット済み）。
// RTタブは検知から即座に判定するため、何時何分にヒットしたかが判断材料になる。
function formatHitTime(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!m) return dateStr || "−";
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)} ${m[4]}`;
}

// ---------- ログ：目標ダッシュボード（2026-11-22作り直し） ----------
// 1日1万円から逆算して「今日なにをするか」を決める画面。集計は Code.gs getDashboard_。
//   1日の利益 ＝ 精査枚数 × 仕入れ率 × 1個あたりの利益
// 利益・仕入れ個数は売上管理シート（数日おきにまとめて記入）から数えるため、
// 1日あたりの値は「最後に記入した日まで」で割る（未記入の日で平均を下げない）。
// 精査枚数は review_log（スワイプごとの記録。11/15〜11/22は検知日ベースの推定）。

const DAILY_PROFIT_GOAL = 10000;
const DASH_ROUTE_ORDER = ["AR", "RT", "RR", "RS", "MR", "FR", "Amacari外"];
const DASH_ROUTE_LABEL = {
  AR: "AR 自動リサーチ", RT: "RT リアルタイム", RR: "RR リピート", RS: "RS リピート検索",
  MR: "MR 説明文", FR: "FR フリマ監視", "Amacari外": "Amacari外",
};
// 見直しの予定。日付の7日前から「見直しの提案」に出す
const DASH_REVIEW_SCHEDULE = [
  { date: "2026-12-06", text: "高回転・薄利のルール（[薄利]・売れる目安30日以内を緑表示）を見直す" },
];
// 却下理由が増えたときのヒント
const DASH_REASON_HINT = {
  "利益不足": "回転が良ければ薄利でも拾う方針です。利益より「売れる目安日数」で判断できているか確認を",
  "回転不良": "ランク帯ごとの必要利益率（profit_rules.py）を見直す候補です",
  "不一致": "型番の誤マッチが増えています。不一致再検証の結果を確認しましょう",
  "高値仕入": "pmax近くの出品が多いです。値下げ交渉で拾えるものがないか",
  "開封・状態不良": "収集の除外ワードに足せる言葉がないか確認を",
  "状態不明": "写真が少ない出品が多いです。画像インデックスで判断できるか確認を",
  "売切れ": "精査までの時間が長いと売り切れます。リアルタイム系を先に見ましょう",
};
const DASH_WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
const DASH_COLOR = { bar: "#2a78d6", barSoft: "#86b6ef", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", band: "#f0efec" };

let dashData = null;

async function loadLog(fresh) {
  const body = document.getElementById("dash-body");
  const updated = document.getElementById("dash-updated");
  if (!dashData) body.innerHTML = '<p class="log-loading">読み込み中…（集計に20秒ほどかかることがあります）</p>';
  updated.textContent = "読み込み中…";
  try {
    const data = await gasFetch("dashboard", fresh === true ? { fresh: "1" } : undefined);
    if (data.error) throw new Error(data.error);
    dashData = data;
    renderDashboard(data);
  } catch (e) {
    updated.textContent = "";
    if (!dashData) body.innerHTML = '<p class="log-loading">読み込みに失敗しました。</p>';
  }
}

document.getElementById("dash-refresh").addEventListener("click", () => loadLog(true));

// --- 日付・数値の小道具 ---
function dashAddDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dashDiffDays(from, to) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);
}
function dashMd(ymd) {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
}
function dashMdw(ymd) {
  return `${dashMd(ymd)}（${DASH_WEEKDAY[new Date(ymd + "T00:00:00Z").getUTCDay()]}）`;
}
function dashYen(v) { return `¥${Math.round(v || 0).toLocaleString()}`; }
function dashCompact(v) {
  if (Math.abs(v) >= 10000) return `${+(v / 10000).toFixed(1)}万`;
  return Math.round(v).toLocaleString();
}
function dashPct(v, digits = 1) { return `${(v * 100).toFixed(digits)}%`; }
function dashHours(h) {
  if (h == null) return "記録なし";
  if (h < 1) return `${Math.round(h * 60)}分前`;
  if (h < 48) return `${+h.toFixed(1)}時間前`;
  return `${Math.round(h / 24)}日前`;
}
function dashNiceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

// --- 集計（画面の数字はすべてここで作る） ---
function dashModel(d) {
  const today = d.today;
  const sales = d.sales || { days: [], months: [], lastEntryDate: "" };
  const reviews = d.reviews || { days: [], firstDate: "", reasons: { recent: {}, prior: {} }, sources: [] };
  const salesByDate = Object.fromEntries(sales.days.map(x => [x.date, x]));
  const revByDate = Object.fromEntries(reviews.days.map(x => [x.date, x]));
  const last = sales.lastEntryDate || "";

  const monthKey = today.slice(0, 7);
  const monthStart = `${monthKey}-01`;
  const thisMonth = sales.months.find(x => x.month === monthKey) || { count: 0, profit: 0 };
  const monthDays = last >= monthStart ? dashDiffDays(monthStart, last) + 1 : 0;
  const prevEnd = dashAddDays(monthStart, -1);
  const prevMonth = sales.months.find(x => x.month === prevEnd.slice(0, 7));
  const prevPerDay = prevMonth ? prevMonth.profit / Number(prevEnd.slice(8)) : null;

  const sumRange = (from, to) => {
    const r = { from, to, n: 0, rev: 0, cnt: 0, profit: 0 };
    for (let x = from; x <= to; x = dashAddDays(x, 1)) {
      r.n++;
      r.rev += (revByDate[x] || {}).total || 0;
      const s = salesByDate[x];
      if (s) { r.cnt += s.count; r.profit += s.profit; }
    }
    r.revPerDay = r.n ? r.rev / r.n : 0;
    r.rate = r.rev ? r.cnt / r.rev : 0;
    r.avg = r.cnt ? r.profit / r.cnt : 0;
    r.perDay = r.n ? r.profit / r.n : 0;
    return r;
  };

  // 逆算に使う期間：売上が記入済みで、精査の記録もある直近7日
  let win = null, prevWin = null;
  if (last && reviews.firstDate && last >= reviews.firstDate) {
    const from = [dashAddDays(last, -6), reviews.firstDate].sort().pop();
    win = sumRange(from, last);
    const pTo = dashAddDays(from, -1);
    const pFrom = dashAddDays(pTo, -(win.n - 1));
    if (pFrom >= reviews.firstDate) prevWin = sumRange(pFrom, pTo);
  }

  return {
    d, today, sales, reviews, salesByDate, revByDate, last,
    monthKey, monthStart, thisMonth, monthDays,
    monthPerDay: monthDays ? thisMonth.profit / monthDays : 0,
    prevPerDay, win, prevWin,
    todayReviews: (revByDate[today] || {}).total || 0,
    unenteredDays: last ? dashDiffDays(last, today) : null,
  };
}

function renderDashboard(d) {
  const m = dashModel(d);
  document.getElementById("dash-updated").textContent =
    `集計 ${d.generatedAt}（10分ごとに更新・↻で今すぐ）` + ((d.errors || []).length ? ` ／ 一部読めませんでした：${d.errors.join("、")}` : "");
  document.getElementById("dash-body").innerHTML = [
    dashHeroHtml(m),
    dashTodoHtml(m),
    dashLeverHtml(m),
    dashDailyHtml(m),
    dashPaceHtml(m),
    dashRouteHtml(m),
    dashProposalHtml(m),
    dashHealthHtml(m),
  ].join("");
  document.querySelectorAll("#dash-body .dash-chart").forEach(dashAttachTips);
}

// --- ① 目標（ヒーロー） ---
function dashHeroHtml(m) {
  const pct = m.monthPerDay / DAILY_PROFIT_GOAL;
  const delta = m.prevPerDay != null ? m.monthPerDay - m.prevPerDay : null;
  const range = m.monthDays
    ? `${dashMd(m.monthStart)}〜${dashMd(m.last)}（記入済み${m.monthDays}日）で ${dashYen(m.thisMonth.profit)}・${m.thisMonth.count}個`
    : "今月の記入はまだありません";
  return `
    <section class="dash-card dash-hero">
      <div class="dash-label">今月の1日あたり利益</div>
      <div class="dash-hero-row">
        <span class="dash-hero-value">${dashYen(m.monthPerDay)}</span>
        <span class="dash-hero-goal">／ 目標 ${dashYen(DAILY_PROFIT_GOAL)}</span>
      </div>
      <div class="dash-meter" role="img" aria-label="目標の${Math.round(pct * 100)}%">
        <div class="dash-meter-fill${pct >= 1 ? " is-done" : ""}" style="width:${Math.min(100, pct * 100).toFixed(1)}%"></div>
      </div>
      <div class="dash-hero-meta">
        <span>目標の <strong>${Math.round(pct * 100)}%</strong></span>
        ${delta != null ? `<span class="${delta >= 0 ? "dash-up" : "dash-down"}">${delta >= 0 ? "▲" : "▼"} 先月比 ${delta >= 0 ? "+" : "−"}${dashYen(Math.abs(delta))}/日</span>` : ""}
      </div>
      <p class="dash-sub">${range}</p>
    </section>`;
}

// --- ② 今日やること ---
function dashTodoHtml(m) {
  const items = [];
  (m.d.health || []).forEach(h => {
    if (h.key === "sales") return; // 売上管理シートの未記入は下で別に出す
    if (h.key === "backlog") {
      if (h.count > h.warnCount) items.push({ lv: "warn", text: `新型番の価格調査待ちが ${h.count.toLocaleString()}件 たまっています`, sub: `${h.note} を実行` });
      return;
    }
    if (h.hours == null || h.hours > h.warnHours) {
      items.push({ lv: "warn", text: `${h.label}が${h.hours == null ? "見つかりません" : `${dashHours(h.hours)}で止まっています`}`, sub: h.note });
    }
  });
  const c = m.d.cards || {};
  if (c.priorityCards > 0) {
    items.push({ lv: "do", text: `ARの優先カードが ${c.priorityCards}枚 あります。先に見ましょう`, sub: `優先カードの仕入れ率は7.7%（通常0.6%）・${(c.at || "").slice(5, 16)}時点` });
  }
  if (c.thinFastCards > 0) {
    items.push({ lv: "do", text: `緑の高回転・薄利カードが ${c.thinFastCards}枚 あります`, sub: "売れる目安30日以内。優先カードの次に" });
  }
  if (m.win && m.win.rate > 0 && m.win.avg > 0) {
    const need = Math.ceil(DAILY_PROFIT_GOAL / (m.win.rate * m.win.avg));
    const left = Math.max(0, need - m.todayReviews);
    items.push({
      lv: left > 0 ? "do" : "good",
      text: left > 0 ? `今日の精査はあと ${left.toLocaleString()}枚 が目安です` : "今日の精査は目安の枚数に届きました",
      sub: `今日 ${m.todayReviews.toLocaleString()}枚 ／ 目安 ${need.toLocaleString()}枚（今の仕入れ率と1個の利益で1万円に届く枚数）`,
    });
  }
  const p = m.d.pending || {};
  if (p.olderThan7 > 0) {
    items.push({ lv: "do", text: `仕入れ対象のまま7日以上たった商品が ${p.olderThan7}件 あります`, sub: "仕入候補タブで「購入済み」か「結局買わなかった」に整理" });
  }
  if (m.unenteredDays != null && m.unenteredDays >= 3) {
    items.push({ lv: "info", text: `売上管理シートが ${dashMd(dashAddDays(m.last, 1))}から${m.unenteredDays}日分 未記入です`, sub: "記入すると利益と逆算の数字が今に追いつきます" });
  }
  if (!items.length) items.push({ lv: "good", text: "やることは全部片付いています", sub: "" });

  const icon = { warn: "⚠", do: "▶", info: "ℹ", good: "✓" };
  return `
    <section class="dash-card">
      <h3 class="dash-title">今日やること</h3>
      <ul class="dash-todo">
        ${items.map(it => `
          <li class="dash-todo-item is-${it.lv}">
            <span class="dash-todo-icon" aria-hidden="true">${icon[it.lv]}</span>
            <div><div class="dash-todo-text">${escapeHtml(it.text)}</div>${it.sub ? `<div class="dash-todo-sub">${escapeHtml(it.sub)}</div>` : ""}</div>
          </li>`).join("")}
      </ul>
    </section>`;
}

// --- ③ 逆算（精査 × 仕入れ率 × 1個の利益） ---
function dashLeverHtml(m) {
  const w = m.win;
  if (!w || !w.rev) {
    return `<section class="dash-card"><h3 class="dash-title">逆算</h3><p class="dash-sub">精査の記録と売上管理シートの記入が重なる日がまだありません。</p></section>`;
  }
  const p = m.prevWin;
  const ch = (cur, prev) => (p && prev > 0 ? cur / prev - 1 : null);
  const levers = [
    { key: "rev", label: "精査", value: `${Math.round(w.revPerDay).toLocaleString()}<small>枚/日</small>`, change: ch(w.revPerDay, p && p.revPerDay) },
    { key: "rate", label: "仕入れ率", value: `${(w.rate * 100).toFixed(2)}<small>%</small>`, change: ch(w.rate, p && p.rate) },
    { key: "avg", label: "1個の利益", value: `${dashYen(w.avg)}`, change: ch(w.avg, p && p.avg) },
  ];
  // 前の期間より一番下がった数字を「改善ポイント」として目立たせる
  const worst = levers.filter(l => l.change != null && l.change < -0.05).sort((a, b) => a.change - b.change)[0];
  const pct = w.perDay / DAILY_PROFIT_GOAL;
  const g = w.perDay > 0 ? DAILY_PROFIT_GOAL / w.perDay : null;
  const f = g ? Math.sqrt(g) : null;
  const short = w.n < 7 ? "・データ蓄積中" : "";

  const leverBox = l => `
    <div class="dash-lever${worst && worst.key === l.key ? " is-down" : ""}">
      <div class="dash-lever-label">${l.label}</div>
      <div class="dash-lever-value">${l.value}</div>
      <div class="dash-lever-delta">${l.change == null ? "比較なし" : `${l.change >= 0 ? "▲" : "▼"} 前の期間 ${l.change >= 0 ? "+" : "−"}${Math.abs(Math.round(l.change * 100))}%`}</div>
    </div>`;

  let need = "";
  if (g && g > 1) {
    need = `
      <div class="dash-need">
        <div class="dash-need-head">1万円に届くには、どれか1つなら <strong>${g.toFixed(1)}倍</strong> に</div>
        <ul>
          <li><span>精査</span><b>${Math.ceil(w.revPerDay * g).toLocaleString()}枚/日</b></li>
          <li><span>仕入れ率</span><b>${(w.rate * g * 100).toFixed(2)}%</b></li>
          <li><span>1個の利益</span><b>${dashYen(w.avg * g)}</b></li>
        </ul>
        <p class="dash-sub">2つを少しずつなら、精査 ${Math.ceil(w.revPerDay * f).toLocaleString()}枚/日 と 仕入れ率 ${(w.rate * f * 100).toFixed(2)}%（各${f.toFixed(1)}倍）。優先カードを先に見ると、同じ枚数でも仕入れ率が上がります。</p>
      </div>`;
  } else if (g) {
    need = `<div class="dash-need"><div class="dash-need-head">この期間は目標ペースに届いています ✓</div></div>`;
  }

  return `
    <section class="dash-card">
      <h3 class="dash-title">逆算：1日の利益 ＝ 精査 × 仕入れ率 × 1個の利益</h3>
      <p class="dash-sub">${dashMd(w.from)}〜${dashMd(w.to)}（${w.n}日${short}）・精査 ${w.rev.toLocaleString()}枚 → 仕入れ ${w.cnt}個 → ${dashYen(w.profit)}${p ? ` ／ 比較：${dashMd(p.from)}〜${dashMd(p.to)}` : ""}</p>
      <div class="dash-eq">
        ${leverBox(levers[0])}<span class="dash-op">×</span>${leverBox(levers[1])}<span class="dash-op">×</span>${leverBox(levers[2])}
      </div>
      <div class="dash-eq-result">
        <span class="dash-op">＝</span><strong>${dashYen(w.perDay)}<small>/日</small></strong>
        <div class="dash-meter dash-meter-sm"><div class="dash-meter-fill${pct >= 1 ? " is-done" : ""}" style="width:${Math.min(100, pct * 100).toFixed(1)}%"></div></div>
        <span class="dash-eq-pct">目標の${Math.round(pct * 100)}%</span>
      </div>
      ${worst ? `<p class="dash-callout">▼ <b>${worst.label}</b>が前の期間より${Math.abs(Math.round(worst.change * 100))}%下がっています。ここを戻すのが一番の近道です。</p>` : ""}
      ${need}
    </section>`;
}

// --- ④ 日別の利益・精査枚数（棒グラフ） ---
function dashDailyHtml(m) {
  const days = [];
  for (let i = 27; i >= 0; i--) days.push(dashAddDays(m.today, -i));
  const profitItems = days.map((x, i) => {
    const s = m.salesByDate[x];
    const unentered = !m.last || x > m.last;
    return {
      value: s ? s.profit : 0,
      muted: unentered,
      label: i % 7 === 0 || i === days.length - 1 ? dashMd(x) : "",
      tip: unentered ? `${dashMdw(x)} 売上管理シート未記入` : `${dashMdw(x)} ${dashYen(s ? s.profit : 0)}・${s ? s.count : 0}個`,
    };
  });
  const revDays = days.filter(x => m.reviews.firstDate && x >= m.reviews.firstDate);
  const revItems = revDays.map((x, i) => {
    const r = m.revByDate[x] || { total: 0, targets: 0 };
    return {
      value: r.total,
      label: i % 7 === 0 || i === revDays.length - 1 ? dashMd(x) : "",
      tip: `${dashMdw(x)} 精査 ${r.total.toLocaleString()}枚・仕入れ対象 ${r.targets}枚`,
    };
  });
  return `
    <section class="dash-card">
      <h3 class="dash-title">日別の利益（直近4週間）</h3>
      <div class="dash-chart">
        ${dashBarSvg(profitItems, { goal: DAILY_PROFIT_GOAL, goalLabel: "目標 1万", yen: true })}
        <p class="dash-tip">棒をタップすると金額が出ます。灰色の帯は売上管理シートが未記入の日です。</p>
      </div>
      ${revItems.length ? `
      <h3 class="dash-title dash-title-gap">日別の精査枚数</h3>
      <div class="dash-chart">
        ${dashBarSvg(revItems, { height: 110, soft: true })}
        <p class="dash-tip">${dashMd(m.reviews.firstDate)}から記録（11/22までは検知日ベースの推定）。</p>
      </div>` : ""}
    </section>`;
}

// 縦棒グラフ（1系列）。items: [{value, label, tip, muted}]
function dashBarSvg(items, opt = {}) {
  const W = 340, H = opt.height || 150, padL = 34, padR = 8, padT = 16, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = dashNiceMax(Math.max(opt.goal || 0, ...items.map(x => x.value)) * 1.08);
  const y = v => padT + plotH - (v / maxV) * plotH;
  const n = items.length;
  const slot = plotW / n;
  const bw = Math.min(24, Math.max(3, slot * 0.68));
  const parts = [];
  // 未記入の帯
  const firstMuted = items.findIndex(x => x.muted);
  if (firstMuted >= 0) {
    const bx = padL + firstMuted * slot;
    parts.push(`<rect x="${bx}" y="${padT}" width="${padL + plotW - bx}" height="${plotH}" fill="${DASH_COLOR.band}" rx="4"/>`);
    parts.push(`<text x="${bx + 4}" y="${padT + 11}" class="dash-ax">未記入</text>`);
  }
  // 目盛り（0・半分・最大）
  [0, maxV / 2, maxV].forEach(v => {
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? "#c3c2b7" : DASH_COLOR.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 5}" y="${y(v) + 3.5}" text-anchor="end" class="dash-ax">${dashCompact(v)}</text>`);
  });
  items.forEach((it, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const h = Math.max(0, (it.value / maxV) * plotH);
    if (h > 0) {
      const r = Math.min(4, bw / 2, h);
      const top = padT + plotH - h, bot = padT + plotH;
      parts.push(`<path class="dash-bar" d="M${x},${bot}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${bot}Z" fill="${opt.soft ? DASH_COLOR.barSoft : DASH_COLOR.bar}"/>`);
    }
    if (it.label) parts.push(`<text x="${padL + i * slot + slot / 2}" y="${H - 5}" text-anchor="middle" class="dash-ax">${it.label}</text>`);
    parts.push(`<rect class="dash-hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent" data-tip="${escapeAttr(it.tip)}"/>`);
  });
  if (opt.goal) {
    const gy = y(opt.goal);
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${gy}" y2="${gy}" stroke="${DASH_COLOR.ink2}" stroke-width="1.5"/>`);
    parts.push(`<text x="${padL + 2}" y="${gy - 4}" class="dash-ax dash-ax-strong">${opt.goalLabel || ""}</text>`);
  }
  return `<svg class="dash-svg" viewBox="0 0 ${W} ${H}" role="img">${parts.join("")}</svg>`;
}

// --- ⑤ 今月の進み具合（累計の折れ線） ---
function dashPaceHtml(m) {
  const [yy, mm] = m.monthKey.split("-").map(Number);
  const dim = new Date(yy, mm, 0).getDate();
  const goalTotal = DAILY_PROFIT_GOAL * dim;
  let cum = 0;
  const pts = [{ day: 0, v: 0 }];
  for (let day = 1; day <= m.monthDays; day++) {
    const ymd = `${m.monthKey}-${String(day).padStart(2, "0")}`;
    cum += (m.salesByDate[ymd] || {}).profit || 0;
    pts.push({ day, v: cum, ymd });
  }
  const W = 340, H = 170, padL = 38, padR = 12, padT = 14, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = dashNiceMax(Math.max(goalTotal, cum) * 1.02);
  const x = dd => padL + (dd / dim) * plotW;
  const y = v => padT + plotH - (v / maxV) * plotH;
  const parts = [];
  [0, maxV / 2, maxV].forEach(v => {
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? "#c3c2b7" : DASH_COLOR.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 5}" y="${y(v) + 3.5}" text-anchor="end" class="dash-ax">${dashCompact(v)}</text>`);
  });
  [1, 8, 15, 22, 29].filter(dd => dd <= dim).forEach(dd => {
    parts.push(`<text x="${x(dd)}" y="${H - 5}" text-anchor="middle" class="dash-ax">${mm}/${dd}</text>`);
  });
  // 目標ペース（1日1万円の直線）
  parts.push(`<line x1="${x(0)}" y1="${y(0)}" x2="${x(dim)}" y2="${y(goalTotal)}" stroke="${DASH_COLOR.muted}" stroke-width="1.5"/>`);
  parts.push(`<text x="${x(dim) - 2}" y="${y(goalTotal) - 6}" text-anchor="end" class="dash-ax">目標ペース ${dashCompact(goalTotal)}</text>`);
  if (pts.length > 1) {
    const poly = pts.map(p => `${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    parts.push(`<polygon points="${x(0)},${y(0)} ${poly} ${x(pts[pts.length - 1].day)},${y(0)}" fill="${DASH_COLOR.bar}" opacity="0.1"/>`);
    parts.push(`<polyline points="${poly}" fill="none" stroke="${DASH_COLOR.bar}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    const e = pts[pts.length - 1];
    parts.push(`<circle cx="${x(e.day)}" cy="${y(e.v)}" r="4.5" fill="${DASH_COLOR.bar}" stroke="#fff" stroke-width="2"/>`);
    const anchor = e.day > dim * 0.7 ? "end" : "start";
    parts.push(`<text x="${x(e.day) + (anchor === "end" ? -8 : 8)}" y="${y(e.v) + 4}" text-anchor="${anchor}" class="dash-ax dash-ax-strong">${dashYen(e.v)}</text>`);
    pts.slice(1).forEach(p => {
      const goalAt = DAILY_PROFIT_GOAL * p.day;
      parts.push(`<rect class="dash-hit" x="${x(p.day - 0.5)}" y="${padT}" width="${plotW / dim}" height="${plotH}" fill="transparent" data-tip="${escapeAttr(`${dashMdw(p.ymd)}まで 累計 ${dashYen(p.v)}（目標ペース ${dashYen(goalAt)}・差 ${p.v - goalAt >= 0 ? "+" : "−"}${dashYen(Math.abs(p.v - goalAt))}）`)}"/>`);
    });
  }
  const lastGoal = DAILY_PROFIT_GOAL * m.monthDays;
  const gap = cum - lastGoal;
  return `
    <section class="dash-card">
      <h3 class="dash-title">今月の進み具合（累計）</h3>
      <div class="dash-chart">
        <svg class="dash-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="今月の累計利益と目標ペース">${parts.join("")}</svg>
        <p class="dash-tip">${m.monthDays ? `${dashMd(m.last)}時点で目標ペースより ${gap >= 0 ? "+" : "−"}${dashYen(Math.abs(gap))}。線をタップすると日ごとの累計が出ます。` : "今月の記入はまだありません。"}</p>
      </div>
      <div class="dash-legend"><span><i style="background:${DASH_COLOR.bar}"></i>実績（売上管理シートの想定利益）</span><span><i style="background:${DASH_COLOR.muted}"></i>目標ペース（1日1万円）</span></div>
    </section>`;
}

// --- ⑥ ルート別 ---
function dashRouteHtml(m) {
  if (!m.last) return "";
  const from = [dashAddDays(m.last, -27), m.reviews.firstDate || dashAddDays(m.last, -27)].sort().pop();
  const acc = {};
  const get = r => (acc[r] = acc[r] || { route: r, rev: 0, cnt: 0, profit: 0 });
  for (let x = from; x <= m.last; x = dashAddDays(x, 1)) {
    const s = m.salesByDate[x];
    if (s) Object.entries(s.routes || {}).forEach(([r, v]) => { const a = get(r); a.cnt += v.count; a.profit += v.profit; });
    const rv = m.revByDate[x];
    if (rv) Object.entries(rv.routes || {}).forEach(([r, v]) => { get(r).rev += v.total; });
  }
  const rows = DASH_ROUTE_ORDER.map(r => acc[r]).filter(a => a && (a.rev || a.cnt));
  Object.values(acc).forEach(a => { if (!DASH_ROUTE_ORDER.includes(a.route) && (a.rev || a.cnt)) rows.push(a); });
  if (!rows.length) return "";
  const maxP = Math.max(1, ...rows.map(a => a.profit));
  return `
    <section class="dash-card">
      <h3 class="dash-title">ルート別（${dashMd(from)}〜${dashMd(m.last)}）</h3>
      <div class="status-bar-chart">
        ${rows.map(a => `
          <div class="status-bar-row">
            <span class="status-bar-name">${escapeHtml(DASH_ROUTE_LABEL[a.route] || a.route)}</span>
            <div class="status-bar-track"><div class="status-bar-fill" style="width:${Math.round(a.profit / maxP * 100)}%"></div></div>
            <span class="status-bar-value">${dashYen(a.profit)}</span>
          </div>`).join("")}
      </div>
      <div class="rt-log-wrap dash-table">
        <table class="rt-log-table">
          <thead><tr><th>ルート</th><th>精査</th><th>仕入れ</th><th>仕入れ率</th><th>1個の利益</th></tr></thead>
          <tbody>
            ${rows.map(a => `
              <tr>
                <td>${escapeHtml(a.route)}</td>
                <td>${a.rev.toLocaleString()}</td>
                <td>${a.cnt}</td>
                <td>${a.rev ? dashPct(a.cnt / a.rev, 2) : "−"}</td>
                <td>${a.cnt ? dashYen(a.profit / a.cnt) : "−"}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="dash-sub">仕入れは売上管理シートのASINをAmacariの判定と突き合わせて振り分け。Amacariに判定が無いものは「Amacari外」。</p>
    </section>`;
}

// --- ⑦ 見直しの提案 ---
function dashProposalHtml(m) {
  const items = [];
  DASH_REVIEW_SCHEDULE.forEach(s => {
    const left = dashDiffDays(m.today, s.date);
    if (left <= 7) items.push({ title: `${dashMd(s.date)}の見直し予定${left > 0 ? `（あと${left}日）` : left === 0 ? "（今日）" : "（過ぎています）"}`, text: s.text });
  });

  // 却下理由の変化（直近7日 vs その前）
  const rc = m.reviews.reasons || { recent: {}, prior: {} };
  const sum = o => Object.values(o).reduce((s, v) => s + v, 0);
  const rT = sum(rc.recent), pT = sum(rc.prior);
  if (rT >= 30 && pT >= 30) {
    Object.keys(rc.recent).forEach(k => {
      const diff = rc.recent[k] / rT - (rc.prior[k] || 0) / pT;
      if (diff >= 0.08 && rc.recent[k] >= 10) {
        items.push({ title: `却下理由「${k}」が増えています（${dashPct((rc.prior[k] || 0) / pT, 0)} → ${dashPct(rc.recent[k] / rT, 0)}）`, text: DASH_REASON_HINT[k] || "この理由で落ちる商品を、収集やフィルタの段階で外せないか検討を" });
      }
    });
  }

  // 収集元：たくさん見たのに仕入れ対象ゼロ／当たりが多い
  const src = m.reviews.sources || [];
  const zero = src.filter(s => s.reviewed >= 60 && s.targets === 0).slice(0, 5);
  if (zero.length) {
    items.push({ title: "巡回から外す候補（30日で60枚以上見て仕入れ対象0）", text: zero.map(s => `${s.source}（${s.reviewed}枚）`).join("、") });
  }
  const good = src.filter(s => s.reviewed >= 20 && s.targets / s.reviewed >= 0.05)
    .sort((a, b) => b.targets / b.reviewed - a.targets / a.reviewed).slice(0, 5);
  if (good.length) {
    items.push({ title: "当たりが多い収集元（巡回を増やす候補）", text: good.map(s => `${s.source}（${dashPct(s.targets / s.reviewed, 0)}・${s.reviewed}枚中${s.targets}）`).join("、") });
  }

  // 却下理由の内訳（直近7日）
  const top = Object.entries(rc.recent).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxR = Math.max(1, ...top.map(t => t[1]));
  const reasonChart = top.length ? `
    <h3 class="dash-title dash-title-gap">却下理由（直近7日・手動）</h3>
    <div class="status-bar-chart">
      ${top.map(([k, v]) => `
        <div class="status-bar-row">
          <span class="status-bar-name">${escapeHtml(k)}</span>
          <div class="status-bar-track"><div class="status-bar-fill" style="width:${Math.round(v / maxR * 100)}%"></div></div>
          <span class="status-bar-value">${v}<span class="status-bar-pct">（${Math.round(v / rT * 100)}%）</span></span>
        </div>`).join("")}
    </div>` : "";

  return `
    <section class="dash-card">
      <h3 class="dash-title">見直しの提案</h3>
      ${items.length ? `<ul class="dash-proposals">${items.map(it => `<li><div class="dash-todo-text">${escapeHtml(it.title)}</div><div class="dash-todo-sub">${escapeHtml(it.text)}</div></li>`).join("")}</ul>`
        : `<p class="dash-sub">今のところ大きな変化はありません。データが増えると提案が出ます。</p>`}
      ${reasonChart}
    </section>`;
}

// --- ⑧ 稼働チェック ---
function dashHealthHtml(m) {
  const rows = (m.d.health || []).map(h => {
    let ok, detail;
    if (h.key === "backlog") {
      ok = h.count <= h.warnCount;
      detail = `${h.count.toLocaleString()}件（${h.warnCount.toLocaleString()}件を超えたら警告）`;
    } else {
      ok = h.hours != null && h.hours <= h.warnHours;
      detail = h.last ? `${h.last.slice(5).replace("-", "/")}（${dashHours(h.hours)}）` : "記録なし";
    }
    return `
      <li class="dash-health-item ${ok ? "is-ok" : "is-warn"}">
        <span class="dash-todo-icon" aria-hidden="true">${ok ? "✓" : "⚠"}</span>
        <div>
          <div class="dash-todo-text">${escapeHtml(h.label)} <span class="dash-health-state">${ok ? "正常" : "要確認"}</span></div>
          <div class="dash-todo-sub">${escapeHtml(detail)}${h.note ? `・${escapeHtml(h.note)}` : ""}</div>
        </div>
      </li>`;
  });
  return `
    <section class="dash-card">
      <h3 class="dash-title">稼働チェック</h3>
      <ul class="dash-todo">${rows.join("") || '<li class="dash-sub">データがありません</li>'}</ul>
    </section>`;
}

// グラフのタップ／ホバーで、その棒・日の値をグラフ下の行に出す
function dashAttachTips(chart) {
  const tip = chart.querySelector(".dash-tip");
  if (!tip) return;
  const base = tip.textContent;
  let active = null;
  const show = target => {
    const el = target && target.closest && target.closest("[data-tip]");
    if (active) active.classList.remove("is-active");
    active = el;
    if (el) { el.classList.add("is-active"); tip.textContent = el.getAttribute("data-tip"); tip.classList.add("is-on"); }
    else { tip.textContent = base; tip.classList.remove("is-on"); }
  };
  chart.addEventListener("pointerdown", e => show(e.target));
  chart.addEventListener("pointermove", e => { if (e.pointerType === "mouse") show(e.target); });
  chart.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") show(null); });
}

// ---------- 仕入候補バッジ（未購入の「仕入れ対象」件数） ----------
// 2026-11-08追加：実績タブを開かないと未購入のまま売れ残っている仕入れ対象に
// 気づけなかった（30日表示カットオフと合わさって忘れ去られる懸念）。タブを開く前から
// 件数が見えるようバッジ表示する。「購入済みにする」「結局買わなかった」等の明示的な
// アクションでカウントが減るだけで、日数による自動消滅はしない。

async function refreshPendingPurchaseBadge() {
  try {
    const data = await gasFetch("pendingPurchaseCount");
    const count = data.count || 0;
    const badge = document.getElementById("pending-purchase-badge");
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.toggle("hidden", count === 0);
  } catch (e) {
    // バッジ更新失敗は致命的ではないので握りつぶす
  }
}

// ---------- 起動 ----------

if ("serviceWorker" in navigator) {
  // PWAとして必要最小限：オフラインキャッシュは行わずホーム画面追加対応のみ
}

loadCards();
refreshPendingPurchaseBadge();
