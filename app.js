// GAS Web AppのデプロイURL（/exec で終わるもの）に置き換えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbz6W83NlKgz8ieDfRrXL2AfaPWo4xFqv_8vr5NT1-NQglc1tuOC50uT-CWEHrG95c64/exec";

function gasUrl(action, params) {
  const usp = new URLSearchParams(Object.assign({ action }, params || {}));
  return `${GAS_URL}?${usp.toString()}`;
}

// GASはCORSプリフライト(OPTIONS)を処理できないため、
// POSTは text/plain で送ってブラウザに preflight を発生させない
function gasPost(action, body) {
  return fetch(gasUrl(action), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const state = {
  cards: [],
  sort: "new",
  lastRejected: null,   // 巻き戻し用：直前に却下したカード
  pendingReject: null,  // 理由選択待ちのカード
  pendingRejectSource: "amacari", // 理由選択待ちカードの種類："amacari" or "furima"
  skipStack: [],        // 後回し（上スワイプ）したカードのスタック：下スワイプで呼び戻す
  swipeBlocked: false,  // 理由選択中はスワイプ不可
  totalCount: 0,        // 読み込み時点の精査待ち件数（進捗表示の分母）

  // フリマウォッチ監視タブ用
  furimaCards: [],
  furimaLastRejected: null,
  furimaSkipStack: [],
  furimaTotalCount: 0,
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
  statsView: document.getElementById("stats-view"),
  statsMonthlyList: document.getElementById("stats-monthly-list"),
  statsDailyList: document.getElementById("stats-daily-list"),
  statsEmpty: document.getElementById("stats-empty"),
  furimaView: document.getElementById("furima-view"),
  furimaStack: document.getElementById("furima-card-stack"),
  furimaEmpty: document.getElementById("furima-empty-message"),
  furimaProgressLabel: document.getElementById("furima-progress-label"),
  furimaUndoBtn: document.getElementById("furima-undo-btn"),
  modal: document.getElementById("reason-modal"),
  reasonGrid: document.querySelector(".reason-grid"),
  otherInput: document.getElementById("reason-other-input"),
  otherText: document.getElementById("reason-other-text"),
  otherSubmit: document.getElementById("reason-other-submit"),
};

// ---------- データ取得 ----------

async function loadCards() {
  els.empty.textContent = "読み込み中…";
  els.empty.style.display = "block";
  try {
    const res = await fetch(gasUrl("cards", { sort: state.sort }));
    const data = await res.json();
    state.cards = data.cards || [];
    state.skipStack = [];
    state.totalCount = state.cards.length;
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
    const res = await fetch(gasUrl("archive"));
    const data = await res.json();
    renderArchive(data.items || []);
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
    const res = await fetch(gasUrl("rejected"));
    const data = await res.json();
    renderRejected(data.items || []);
  } catch (e) {
    els.archiveEmpty.textContent = "読み込みに失敗しました。";
  }
}

async function loadStats() {
  els.statsEmpty.textContent = "読み込み中…";
  els.statsEmpty.style.display = "block";
  els.statsMonthlyList.innerHTML = "";
  els.statsDailyList.innerHTML = "";
  try {
    const res = await fetch(gasUrl("purchasedStats"));
    const data = await res.json();
    renderStats(data.items || []);
  } catch (e) {
    els.statsEmpty.textContent = "読み込みに失敗しました。";
  }
}

async function loadFurimaCards() {
  els.furimaEmpty.textContent = "読み込み中…";
  els.furimaEmpty.style.display = "block";
  try {
    const res = await fetch(gasUrl("furimaCards"));
    const data = await res.json();
    state.furimaCards = data.cards || [];
    state.furimaSkipStack = [];
    state.furimaTotalCount = state.furimaCards.length;
    renderFurimaStack();
  } catch (e) {
    els.furimaEmpty.textContent = "読み込みに失敗しました。GAS_URLの設定を確認してください。";
  }
}

// ---------- カードのレンダリング ----------

function renderStack() {
  els.stack.querySelectorAll(".card").forEach(c => c.remove());

  const done = Math.max(state.totalCount - state.cards.length, 0);
  els.progressLabel.textContent = `${done} / ${state.totalCount}`;

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
    const depthFromTop = visible.length - 1 - i;
    el.style.zIndex = String(100 - depthFromTop);
    el.style.transform = `scale(${1 - depthFromTop * 0.04}) translateY(${depthFromTop * 10}px)`;
    if (depthFromTop === 0) attachSwipe(el, card);
    els.stack.appendChild(el);
  });
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

function buildCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";

  const thumb = card.image_url
    ? `<img class="card-thumb" src="${escapeAttr(card.image_url)}" alt="">`
    : `<div class="card-thumb"></div>`;

  el.innerHTML = `
    <div class="swipe-flag flag-like">仕入れ対象</div>
    <div class="swipe-flag flag-nope">却下</div>
    <div class="swipe-flag flag-skip">あとで</div>
    <div class="swipe-flag flag-back">戻る</div>
    ${thumb}
    <div class="card-body">
      ${formatPastJudgment(card)}
      <p class="card-name">${escapeHtml(card.name)}</p>
      <p class="card-sub">
        型番：${escapeHtml(card.model)}<button class="copy-btn" data-copy="${escapeAttr(card.model)}" aria-label="型番をコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
        ／ ASIN：${escapeHtml(card.asin)}<button class="copy-btn" data-copy="${escapeAttr(card.asin)}" aria-label="ASINをコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
      </p>
      <div class="card-highlight">
        <div class="highlight-box highlight-margin">
          <span class="label">実利益率</span>
          <span class="value">${formatPercent(card.real_margin)}</span>
        </div>
        <div class="highlight-box highlight-roi">
          <span class="label">ROI</span>
          <span class="value">${formatPercent(card.roi)}</span>
        </div>
      </div>
      <div class="card-grid">
        <div><span>Amazon価格</span>${formatYen(card.amazon_price)}</div>
        <div><span>メルカリ価格</span>${formatYen(card.mercari_price)}</div>
        <div><span>実利益額</span>${formatYen(card.real_profit)}</div>
        <div><span>仕入上限</span>${formatYen(card.pmax)}</div>
        <div class="card-grid-wide"><span>Amazonランク</span>${formatRank(card.rank)}</div>
      </div>
      <div class="card-keepa">
        <p class="keepa-label">Keepa（90日）</p>
        <div class="keepa-graph-wrap">
          <img class="keepa-graph" src="${'https://graph.keepa.com/pricehistory.png?asin='+encodeURIComponent(card.asin)+'&domain=5&amazon=1&new=1&used=1&salesrank=1&range=90&width=800&cAmazon=f5a623&cNew=4fc3f7&cUsed=aaaaaa&cSales=8e44ad&cFont=1b2733&cBackground=ffffff'}" alt="Keepaグラフ" loading="lazy">
          <button class="keepa-reload-btn" aria-label="グラフ再読込" title="グラフ再読込">🔄</button>
        </div>
      </div>
      <div class="card-links">
        <a class="link-btn link-amazon" href="https://www.amazon.co.jp/dp/${encodeURIComponent(card.asin)}" target="_blank" rel="noopener">Amazon</a>
        <a class="link-btn link-mercari" href="${escapeAttr(card.mercari_url)}" target="_blank" rel="noopener">メルカリ</a>
        <a class="link-btn link-monotracer" href="https://www.mono-tracer.com/#/product/${encodeURIComponent(card.asin)}" target="_blank" rel="noopener">モノトレ</a>
        <a class="link-btn link-keepa" href="https://graph.keepa.com/pricehistory.png?asin=${encodeURIComponent(card.asin)}&domain=5&amazon=1&new=1&used=1&salesrank=1&range=180&width=1500&height=600&cAmazon=f5a623&cNew=4fc3f7&cUsed=aaaaaa&cSales=8e44ad&cFont=1b2733&cBackground=ffffff" target="_blank" rel="noopener">Keepa</a>
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

  const thumb = card.image_url
    ? `<img class="card-thumb" src="${escapeAttr(card.image_url)}" alt="">`
    : `<div class="card-thumb"></div>`;

  const links = [
    `<a class="link-btn link-mercari" href="${escapeAttr(card.url)}" target="_blank" rel="noopener">商品ページ</a>`,
  ];
  if (card.asin) {
    links.push(`<a class="link-btn link-amazon" href="https://www.amazon.co.jp/dp/${encodeURIComponent(card.asin)}" target="_blank" rel="noopener">Amazon</a>`);
    links.push(`<a class="link-btn link-monotracer" href="https://www.mono-tracer.com/#/product/${encodeURIComponent(card.asin)}" target="_blank" rel="noopener">モノトレ</a>`);
    links.push(`<a class="link-btn link-keepa" href="https://graph.keepa.com/pricehistory.png?asin=${encodeURIComponent(card.asin)}&domain=5&amazon=1&new=1&used=1&salesrank=1&range=180&width=1500&height=600&cAmazon=f5a623&cNew=4fc3f7&cUsed=aaaaaa&cSales=8e44ad&cFont=1b2733&cBackground=ffffff" target="_blank" rel="noopener">Keepa</a>`);
  }

  el.innerHTML = `
    <div class="swipe-flag flag-like">仕入れ対象</div>
    <div class="swipe-flag flag-nope">却下</div>
    <div class="swipe-flag flag-skip">あとで</div>
    <div class="swipe-flag flag-back">戻る</div>
    ${thumb}
    <div class="card-body">
      <p class="card-name">${escapeHtml(card.name)}</p>
      <p class="card-sub">サービス：${escapeHtml(card.service)}${card.asin ? ` ／ ASIN：${escapeHtml(card.asin)}` : ""}</p>
      <div class="card-highlight">
        <div class="highlight-box highlight-margin">
          <span class="label">実利益率</span>
          <span class="value">${formatPercent(card.margin)}</span>
        </div>
      </div>
      <div class="card-grid">
        <div><span>価格</span>${formatYen(card.price)}</div>
        <div><span>上限価格</span>${formatYen(card.limit_price)}</div>
        <div><span>差額</span>${formatYen(card.diff)}</div>
      </div>
      <div class="card-links">
        ${links.join("\n")}
      </div>
    </div>
  `;
  return el;
}

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

els.stack.addEventListener("click", async e => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  e.stopPropagation();
  const text = btn.dataset.copy || "";
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1200);
  } catch (e) {
    alert("コピーに失敗しました。");
  }
});

// ---------- スワイプ操作 ----------

function attachSwipe(el, card, source) {
  source = source || "amacari";
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  let axis = null; // "x" or "y" - 最初の動きで方向を決め、以後はその軸だけにスライドを制限する

  const likeFlag = el.querySelector(".flag-like");
  const nopeFlag = el.querySelector(".flag-nope");
  const skipFlag = el.querySelector(".flag-skip");
  const backFlag = el.querySelector(".flag-back");
  const flags = [likeFlag, nopeFlag, skipFlag, backFlag];

  const AXIS_LOCK_THRESHOLD = 8;

  function onStart(x, y) {
    dragging = true;
    startX = x; startY = y;
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
      if (dx < 0) state.swipeBlocked = true; // 左スワイプ確定→理由選択まで次をブロック
      finishSwipe(el, card, dx > 0 ? "right" : "left", source);
    } else if (absY > absX && absY > threshold) {
      finishVerticalSwipe(el, card, dy < 0 ? "up" : "down", source);
    } else {
      el.style.transform = "";
      flags.forEach(f => f.style.opacity = 0);
    }
  }

  el.addEventListener("pointerdown", e => {
    if (e.target.closest(".copy-btn, .keepa-reload-btn, .link-btn")) return;
    if (state.swipeBlocked) return; // 理由選択中はスワイプ不可
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
  const flyX = direction === "right" ? window.innerWidth : -window.innerWidth;
  el.style.transform = `translateX(${flyX}px)`;
  el.style.opacity = "0";

  setTimeout(() => {
    el.remove();
    if (isFurima) {
      state.furimaCards = state.furimaCards.filter(c => c.row !== card.row);
    } else {
      state.cards = state.cards.filter(c => c.row !== card.row);
    }
    if (direction === "right") {
      judge(card, "仕入れ対象", "", source);
    } else {
      openReasonModal(card, source);
    }
    isFurima ? renderFurimaStack() : renderStack();
  }, 220);
}

// 上スワイプ＝後回し（末尾に送る）／下スワイプ＝直前に後回しにした1件を呼び戻す
// シートへの書き込みは行わず、画面内の表示順だけを変える
function finishVerticalSwipe(el, card, direction, source) {
  source = source || "amacari";
  const isFurima = source === "furima";
  const flyY = direction === "up" ? -window.innerHeight : window.innerHeight;
  el.style.transform = `translateY(${flyY}px)`;
  el.style.opacity = "0";

  setTimeout(() => {
    el.remove();
    const cardsKey = isFurima ? "furimaCards" : "cards";
    const skipKey = isFurima ? "furimaSkipStack" : "skipStack";
    if (direction === "up") {
      state[cardsKey] = state[cardsKey].filter(c => c.row !== card.row);
      state[cardsKey].push(card);
      state[skipKey].push(card);
    } else {
      const prev = state[skipKey].pop();
      if (prev) {
        state[cardsKey] = state[cardsKey].filter(c => c.row !== prev.row);
        state[cardsKey].unshift(prev);
      }
    }
    isFurima ? renderFurimaStack() : renderStack();
  }, 220);
}

// ---------- 判定の送信 ----------

async function judge(card, judgment, reason, source) {
  source = source || "amacari";
  const isFurima = source === "furima";
  try {
    await gasPost(isFurima ? "furimaJudge" : "judge", { row: card.row, judgment, reason });
    if (judgment === "却下") {
      if (isFurima) {
        state.furimaLastRejected = card;
        els.furimaUndoBtn.disabled = false;
      } else {
        state.lastRejected = card;
        els.undoBtn.disabled = false;
      }
    }
  } catch (e) {
    alert("判定の保存に失敗しました。通信状況を確認してください。");
  }
}

async function undoLastReject(source) {
  source = source || "amacari";
  const isFurima = source === "furima";
  const card = isFurima ? state.furimaLastRejected : state.lastRejected;
  if (!card) return;
  const btn = isFurima ? els.furimaUndoBtn : els.undoBtn;
  btn.disabled = true;
  try {
    await gasPost(isFurima ? "furimaUndo" : "undo", { row: card.row });
    if (isFurima) {
      state.furimaLastRejected = null;
      state.furimaCards.unshift(card);
      renderFurimaStack();
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
  closeReasonModal();
  if (card) judge(card, "却下", btn.dataset.reason, source);
});

els.otherSubmit.addEventListener("click", () => {
  const card = state.pendingReject;
  const source = state.pendingRejectSource;
  const text = els.otherText.value.trim() || "その他";
  closeReasonModal();
  if (card) judge(card, "却下", text, source);
});

// ---------- アーカイブ ----------

function renderArchive(items) {
  if (items.length === 0) {
    els.archiveEmpty.textContent = "アーカイブされた商品はまだありません。";
    els.archiveEmpty.style.display = "block";
    return;
  }
  els.archiveEmpty.style.display = "none";
  els.archiveList.innerHTML = items.map(item => `
    <li class="archive-item" data-row="${item.row}">
      ${item.image_url ? `<img class="archive-thumb" src="${escapeAttr(item.image_url)}" alt="">` : `<div class="archive-thumb"></div>`}
      <div class="archive-info">
        <p class="name">${escapeHtml(item.name)}</p>
        <p class="meta">実利益率 ${formatPercent(item.real_margin)} ／ ROI ${formatPercent(item.roi)} ／ ${escapeHtml(item.judgment)}</p>
      </div>
      <div class="archive-actions">
        <a class="link-mercari" href="${escapeAttr(item.mercari_url)}" target="_blank" rel="noopener">メルカリで見る</a>
        <a class="link-monotracer" href="https://www.mono-tracer.com/#/product/${encodeURIComponent(item.asin)}" target="_blank" rel="noopener">モノトレ</a>
        <a class="link-keepa" href="https://graph.keepa.com/pricehistory.png?asin=${encodeURIComponent(item.asin)}&domain=5&amazon=1&new=1&used=1&salesrank=1&range=180&width=1500&height=600&cAmazon=f5a623&cNew=4fc3f7&cUsed=aaaaaa&cSales=8e44ad&cFont=1b2733&cBackground=ffffff" target="_blank" rel="noopener">Keepa</a>
        ${item.judgment === "購入済み"
          ? `<button class="done" disabled>購入済み</button>`
          : `<button data-action="purchased">購入済みにする</button>
             <button data-action="reject-archive">却下に戻す</button>`}
      </div>
    </li>
  `).join("");
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
        <a class="link-mercari" href="${escapeAttr(item.mercari_url)}" target="_blank" rel="noopener">メルカリで見る</a>
        <button data-action="restore">やっぱり仕入れ対象</button>
        ${item.is_auto ? `<button data-action="confirm" data-reason="${escapeAttr(item.reason)}">却下のままでOK</button>` : ""}
      </div>
    </li>
  `).join("");
}

// ---------- 実績集計 ----------

function aggregateBy(items, keyFn) {
  const map = new Map();
  items.forEach(item => {
    const key = keyFn(item.date);
    if (!key) return;
    if (!map.has(key)) map.set(key, { key, count: 0, sales: 0, cost: 0, profit: 0 });
    const a = map.get(key);
    a.count += 1;
    a.sales += num(item.amazon_price);
    a.cost += num(item.mercari_price);
    a.profit += num(item.real_profit);
  });
  return Array.from(map.values()).sort((a, b) => a.key < b.key ? 1 : -1);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function renderStatRow(agg, label) {
  const margin = agg.sales ? agg.profit / agg.sales * 100 : 0;
  const roi = agg.cost ? agg.profit / agg.cost * 100 : 0;
  return `
    <li class="stats-row">
      <div class="stats-row-head">
        <span class="stats-date">${escapeHtml(label)}</span>
        <span class="stats-count">${agg.count}件</span>
      </div>
      <div class="stats-row-grid">
        <div><span>見込売上</span>¥${agg.sales.toLocaleString()}</div>
        <div><span>見込仕入額</span>¥${agg.cost.toLocaleString()}</div>
        <div><span>見込実利益</span>¥${agg.profit.toLocaleString()}</div>
        <div><span>実利益率</span>${margin.toFixed(1)}%</div>
        <div><span>ROI</span>${roi.toFixed(1)}%</div>
      </div>
    </li>
  `;
}

function renderStats(items) {
  if (items.length === 0) {
    els.statsEmpty.textContent = "購入済みの商品はまだありません。";
    els.statsEmpty.style.display = "block";
    return;
  }
  els.statsEmpty.style.display = "none";

  const monthly = aggregateBy(items, date => date.slice(0, 7));
  const daily = aggregateBy(items, date => date.slice(0, 10));

  els.statsMonthlyList.innerHTML = monthly.map(agg =>
    renderStatRow(agg, agg.key.replace("-", "年") + "月")
  ).join("");
  els.statsDailyList.innerHTML = daily.map(agg => renderStatRow(agg, agg.key)).join("");
}

els.archiveList.addEventListener("click", async e => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const li = btn.closest(".archive-item");
  const row = Number(li.dataset.row);
  const action = btn.dataset.action;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "更新中…";
  try {
    if (action === "purchased") {
      await gasPost("purchased", { row });
    } else if (action === "reject-archive") {
      await gasPost("judge", { row, judgment: "却下", reason: "キャンセル" });
    }
    loadArchive();
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
    } else if (action === "confirm") {
      await gasPost("confirmAutoRejected", { row, reason });
    }
    loadRejected();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert("更新に失敗しました。");
  }
});

els.archiveModeSelect.addEventListener("change", loadArchive);

// ---------- タブ切り替え ----------

const VIEWS = {
  review: { el: els.reviewView, load: loadCards },
  archive: { el: els.archiveView, load: loadArchive },
  stats: { el: els.statsView, load: loadStats },
  furima: { el: els.furimaView, load: loadFurimaCards },
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

els.undoBtn.addEventListener("click", () => undoLastReject("amacari"));
els.furimaUndoBtn.addEventListener("click", () => undoLastReject("furima"));

document.getElementById("reason-cancel-btn").addEventListener("click", () => {
  const isFurima = state.pendingRejectSource === "furima";
  closeReasonModal();
  isFurima ? renderFurimaStack() : renderStack();
});

// ---------- ユーティリティ ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }

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

// ---------- 起動 ----------

if ("serviceWorker" in navigator) {
  // PWAとして必要最小限：オフラインキャッシュは行わずホーム画面追加対応のみ
}

loadCards();
