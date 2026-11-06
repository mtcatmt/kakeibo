import * as L from './ledger.js';
import { columnChart, lineChart, yen } from './charts.js';

const APP_VERSION = '1.3.0';
const DEMO = new URLSearchParams(location.search).has('demo');

// ---------------------------------------------------------------- 状態
let state;
let storageOk = true;
const today = () => L.todayStr();
const ui = {
  tab: 'input',
  mode: 'expense',
  draft: null,
  editingId: null,
  histMonth: L.monthOf(L.todayStr()),
  chartBy: 'month',
  chartKey: { month: L.monthOf(L.todayStr()), year: L.yearOf(L.todayStr()) },
  bannerHidden: false,
};

// ---------------------------------------------------------------- 保存（IndexedDB）
const DB_NAME = 'kakeibo';
const STORE = 'kv';
let dbp;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const q = db.transaction(STORE).objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbSet(key, val) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function save() {
  if (DEMO || !storageOk) return;
  try {
    await idbSet('state', state);
  } catch (e) {
    toast('保存に失敗しました：' + e.message);
  }
}
async function commit(fn) {
  fn(state);
  await save();
  render();
}

// ---------------------------------------------------------------- 補助
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const acc = (id) => state.accounts.find((a) => a.id === id);
const accName = (id) => acc(id)?.name ?? '（削除された科目）';
const accsOf = (...types) => state.accounts.filter((a) => types.includes(a.type) && !a.archived);
const monthLabel = (ym) => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;
const periodLabel = (key, by) => (by === 'year' ? `${key}年` : monthLabel(key));
const shortLabel = (key, by) => (by === 'year' ? key : `${Number(key.slice(5, 7))}月`);
const dateLabel = (d) => {
  const dt = new Date(d + 'T00:00:00');
  return `${dt.getMonth() + 1}月${dt.getDate()}日（${'日月火水木金土'[dt.getDay()]}）`;
};
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// 費用の科目の色：「その他」は灰色、残りは並び順に8色
function expenseColor(id) {
  if (id === 'other_exp') return 'var(--s-other)';
  const list = state.accounts.filter((a) => a.type === 'expense' && a.id !== 'other_exp');
  const i = list.findIndex((a) => a.id === id);
  return i >= 0 && i < 8 ? `var(--s${i + 1})` : 'var(--s-other)';
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = action.run;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 3200);
}

function linesText(lines) {
  const dr = lines.filter((l) => l.side === 'dr').map((l) => `${accName(l.acc)} ${yen(l.amount)}`).join('、');
  const cr = lines.filter((l) => l.side === 'cr').map((l) => `${accName(l.acc)} ${yen(l.amount)}`).join('、');
  return `借方 ${dr} ／ 貸方 ${cr}`;
}

// ---------------------------------------------------------------- 入力画面
const MODES = [
  ['expense', '支出'],
  ['income', '収入'],
  ['transfer', '振替'],
  ['journal', '仕訳'],
];

function newDraft(mode) {
  const last = state.settings.last || {};
  const base = { date: ui.draft?.date || today(), memo: '' };
  switch (mode) {
    case 'expense':
      return { ...base, amount: '', acc: null, from: last.expenseFrom || 'cash' };
    case 'income':
      return { ...base, amount: '', acc: null, to: last.incomeTo || 'bank' };
    case 'transfer':
      return { ...base, amount: '', from: last.transferFrom || 'bank', to: last.transferTo || 'card' };
    default:
      return {
        ...base,
        lines: [
          { side: 'dr', acc: '', amount: '' },
          { side: 'cr', acc: '', amount: '' },
        ],
      };
  }
}

// 選択肢の並び。最後に、その場で科目を追加するボタンを置く（types は追加できる区分）
function chips(field, types, selected, withColor = false) {
  return (
    `<div class="chips" data-group="${field}">` +
    accsOf(...types)
      .map(
        (a) =>
          `<button type="button" class="chip${a.id === selected ? ' on' : ''}" data-act="pick" data-field="${field}" data-val="${a.id}">` +
          (withColor ? `<span class="sw" style="background:${expenseColor(a.id)}"></span>` : '') +
          `${esc(a.name)}</button>`,
      )
      .join('') +
    `<button type="button" class="chip chip-add" data-act="add-acc-inline" data-field="${field}" data-types="${types.join(',')}">＋ 追加</button>` +
    '</div>'
  );
}

// 科目を追加する。問題があればその内容を、なければ追加した科目を返す
async function addAccount(type, name) {
  name = (name || '').trim();
  if (!name) return { error: '科目の名前を入力してください' };
  if (state.accounts.some((a) => a.type === type && a.name === name)) return { error: `${L.TYPE_LABEL[type]}に同じ名前の科目があります` };
  const account = { id: L.uid(), name, type, archived: false };
  await commit((s) => s.accounts.push(account));
  return { account };
}

const TYPE_HINT = { asset: '現金・口座・電子マネーなど', liability: 'クレジットカード・借入など' };

function addAccountSheet(field, types) {
  const typeField =
    types.length > 1
      ? `<label class="field"><span class="field-label">区分</span><select name="acctype">${types.map((t) => `<option value="${t}">${L.TYPE_LABEL[t]}（${TYPE_HINT[t] || ''}）</option>`).join('')}</select></label>`
      : `<input type="hidden" name="acctype" value="${types[0]}"><p class="hint">区分：${L.TYPE_LABEL[types[0]]}</p>`;
  openSheet(`
    <h2>科目の追加</h2>
    <form id="acc-form">
      <label class="field"><span class="field-label">名前</span><input name="accname" autocomplete="off" placeholder="例：PayPay"></label>
      ${typeField}
      <p class="hint">名前の変更・非表示・削除は、設定画面の「勘定科目」からできます。</p>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-act="close-sheet">閉じる</button>
        <button type="submit" class="primary">追加</button>
      </div>
    </form>`);
  const form = $('#acc-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    const r = await addAccount(f.acctype.value, f.accname.value);
    if (r.error) return toast(r.error);
    ui.draft[field] = r.account.id; // 追加した科目を選んだ状態にする
    closeSheet();
    render();
    toast(`${L.TYPE_LABEL[r.account.type]}の科目「${r.account.name}」を追加しました`);
  });
}

function accountOptions(selected, types = L.TYPE_ORDER) {
  return (
    `<option value="">科目を選ぶ</option>` +
    types
      .map(
        (t) =>
          `<optgroup label="${L.TYPE_LABEL[t]}">` +
          state.accounts
            .filter((a) => a.type === t && (!a.archived || a.id === selected))
            .map((a) => `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`)
            .join('') +
          '</optgroup>',
      )
      .join('')
  );
}

function viewInput() {
  const d = ui.draft;
  const m = ui.mode;
  let body = '';
  if (m !== 'journal') {
    body += `<label class="amount"><span>¥</span><input id="f-amount" data-field="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(d.amount)}"></label>`;
  }
  if (m === 'expense') {
    body += `<div class="field-label">科目</div>${chips('acc', ['expense'], d.acc, true)}`;
    body += `<div class="field-label">支払元</div>${chips('from', ['asset', 'liability'], d.from)}`;
  } else if (m === 'income') {
    body += `<div class="field-label">科目</div>${chips('acc', ['income'], d.acc)}`;
    body += `<div class="field-label">入金先</div>${chips('to', ['asset'], d.to)}`;
  } else if (m === 'transfer') {
    body += `<div class="field-label">移動元</div>${chips('from', ['asset', 'liability'], d.from)}`;
    body += `<div class="field-label">移動先</div>${chips('to', ['asset', 'liability'], d.to)}`;
    body += `<p class="hint">カードの引き落とし：移動元＝銀行口座、移動先＝クレジットカード<br>貸与奨学金の受け取り：移動元＝奨学金（返済あり）、移動先＝銀行口座</p>`;
  } else {
    body +=
      `<div class="jrows">` +
      d.lines
        .map(
          (l, i) => `<div class="jrow" data-i="${i}">
            <select data-jfield="side" aria-label="借方か貸方か"><option value="dr"${l.side === 'dr' ? ' selected' : ''}>借方</option><option value="cr"${l.side === 'cr' ? ' selected' : ''}>貸方</option></select>
            <select data-jfield="acc" aria-label="勘定科目">${accountOptions(l.acc)}</select>
            <input data-jfield="amount" inputmode="numeric" autocomplete="off" placeholder="金額" value="${esc(l.amount)}" aria-label="金額">
            <button type="button" class="icon-btn" data-act="jdel" data-i="${i}" aria-label="この行を削除"${d.lines.length <= 2 ? ' disabled' : ''}>×</button>
          </div>`,
        )
        .join('') +
      `</div><button type="button" class="ghost" data-act="jadd">行を追加</button><p class="jsum" id="jsum"></p>`;
  }
  body += `<div class="row2">
      <label class="field"><span class="field-label">日付</span><input type="date" data-field="date" value="${esc(d.date)}"></label>
      <label class="field"><span class="field-label">メモ</span><input type="text" data-field="memo" value="${esc(d.memo)}" placeholder="任意"></label>
    </div>
    <p class="preview" id="preview"></p>
    <button type="button" class="primary" data-act="save">${ui.editingId ? '変更を保存' : '保存'}</button>`;

  return `
    <header class="top"><h1>${ui.editingId ? '仕訳の編集' : '入力'}</h1>
      ${ui.editingId ? '<button type="button" class="link" data-act="cancel-edit">編集をやめる</button>' : ''}</header>
    <div class="seg" role="tablist">${MODES.map(([k, lb]) => `<button type="button" role="tab" aria-selected="${k === m}" class="${k === m ? 'on' : ''}" data-act="mode" data-val="${k}">${lb}</button>`).join('')}</div>
    <section class="card form">${body}</section>`;
}

// 入力中の内容から仕訳の行を作る。作れなければ { error }
function draftLines() {
  const d = ui.draft;
  if (ui.mode === 'journal') {
    const lines = d.lines.map((l) => ({ side: l.side, acc: l.acc, amount: L.parseAmount(l.amount) }));
    if (lines.some((l) => !l.acc)) return { error: '勘定科目を選んでください', lines };
    if (lines.some((l) => !l.amount)) return { error: '金額は1円以上の整数で入力してください', lines };
    return { lines };
  }
  const amount = L.parseAmount(d.amount);
  if (!amount) return { error: '金額を入力してください' };
  if (ui.mode !== 'transfer' && !d.acc) return { error: '科目を選んでください' };
  if (ui.mode === 'expense' && !d.from) return { error: '支払元を選んでください' };
  if (ui.mode === 'income' && !d.to) return { error: '入金先を選んでください' };
  if (ui.mode === 'transfer') {
    if (!d.from || !d.to) return { error: '移動元と移動先を選んでください' };
    if (d.from === d.to) return { error: '移動元と移動先が同じです' };
  }
  return { lines: L.buildSimpleLines(ui.mode, d, amount) };
}

function updatePreview() {
  const p = $('#preview');
  if (!p) return;
  if (ui.mode === 'journal') {
    let dr = 0, cr = 0;
    for (const l of ui.draft.lines) {
      const v = L.parseAmount(l.amount) || 0;
      if (l.side === 'dr') dr += v; else cr += v;
    }
    const diff = dr - cr;
    $('#jsum').innerHTML = `借方の合計 ${yen(dr)} ／ 貸方の合計 ${yen(cr)}` +
      (diff ? `<br><span class="warn">差額 ${yen(Math.abs(diff))}（${diff > 0 ? '貸方' : '借方'}が不足）</span>` : '');
  }
  const r = draftLines();
  p.textContent = r.error ? '' : '仕訳：' + linesText(r.lines);
}

async function saveEntry() {
  const r = draftLines();
  if (r.error) return toast(r.error);
  const d = ui.draft;
  const old = ui.editingId ? state.entries.find((e) => e.id === ui.editingId) : null;
  const keepKind = old && ['recurring', 'opening', 'valuation'].includes(old.kind) ? old.kind : null;
  const entry = {
    ...(old || {}),
    id: old ? old.id : L.uid(),
    date: d.date,
    memo: (d.memo || '').trim(),
    kind: keepKind || ui.mode,
    lines: r.lines,
    createdAt: old ? old.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  const err = L.validateEntry(entry, state.accounts);
  if (err) return toast(err);

  const wasEditing = !!old;
  await commit((s) => {
    if (old) s.entries[s.entries.indexOf(old)] = entry;
    else s.entries.push(entry);
    const last = s.settings.last;
    if (ui.mode === 'expense') last.expenseFrom = d.from;
    if (ui.mode === 'income') last.incomeTo = d.to;
    if (ui.mode === 'transfer') Object.assign(last, { transferFrom: d.from, transferTo: d.to });
    if (wasEditing) {
      ui.editingId = null;
      ui.tab = 'history';
      ui.histMonth = L.monthOf(entry.date);
      ui.draft = newDraft(ui.mode);
    } else {
      const keep = { date: d.date };
      if (ui.mode === 'expense') keep.from = d.from;
      ui.draft = { ...newDraft(ui.mode), ...keep };
    }
  });
  toast((wasEditing ? '変更しました：' : '保存しました：') + linesText(entry.lines));
}

function startEdit(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  const dr = e.lines.filter((l) => l.side === 'dr');
  const cr = e.lines.filter((l) => l.side === 'cr');
  const two = dr.length === 1 && cr.length === 1;
  let mode = 'journal';
  // 自動入力の仕訳は、借方が費用なら支出、資産（積立）なら振替の画面で開く
  const k = e.kind === 'recurring' ? L.recurringKind({ debit: dr[0]?.acc, credit: cr[0]?.acc }, state.accounts) : e.kind;
  if (two && ['expense', 'income', 'transfer'].includes(k)) mode = k;
  ui.mode = mode;
  ui.editingId = id;
  const base = { date: e.date, memo: e.memo || '' };
  if (mode === 'expense') ui.draft = { ...base, amount: String(dr[0].amount), acc: dr[0].acc, from: cr[0].acc };
  else if (mode === 'income') ui.draft = { ...base, amount: String(dr[0].amount), acc: cr[0].acc, to: dr[0].acc };
  else if (mode === 'transfer') ui.draft = { ...base, amount: String(dr[0].amount), from: cr[0].acc, to: dr[0].acc };
  else ui.draft = { ...base, lines: e.lines.map((l) => ({ side: l.side, acc: l.acc, amount: String(l.amount) })) };
  closeSheet();
  ui.tab = 'input';
  render();
}

// ---------------------------------------------------------------- 履歴画面
function describe(e) {
  const types = (l) => acc(l.acc)?.type;
  let exp = 0, inc = 0;
  for (const l of e.lines) {
    const t = types(l);
    if (t === 'expense') exp += L.signedAmount(l, t);
    if (t === 'income') inc += L.signedAmount(l, t);
  }
  const names = (side, pred = () => true) =>
    [...new Set(e.lines.filter((l) => l.side === side && pred(l)).map((l) => accName(l.acc)))].join('・');
  const total = L.lineTotals(e.lines).dr;
  if (exp !== 0 && inc === 0) {
    const exps = e.lines.filter((l) => types(l) === 'expense');
    return {
      title: [...new Set(exps.map((l) => accName(l.acc)))].join('・'),
      sub: names('cr', (l) => types(l) !== 'expense'),
      amount: -exp,
      cls: 'out',
      color: exps.length ? expenseColor(exps[0].acc) : null,
    };
  }
  if (inc !== 0 && exp === 0) {
    return { title: names('cr', (l) => types(l) === 'income'), sub: names('dr'), amount: inc, cls: 'in' };
  }
  if (e.kind === 'valuation') {
    const a = e.lines.find((l) => acc(l.acc)?.type === 'asset');
    const v = a ? L.signedAmount(a, 'asset') : 0;
    return { title: '評価額の更新', sub: a ? accName(a.acc) : '', amount: v, cls: v >= 0 ? 'in' : 'out' };
  }
  if (e.kind === 'opening') return { title: '開始残高', sub: names('dr') + ' ' + names('cr'), amount: total, cls: 'neutral' };
  if (exp === 0 && inc === 0) return { title: `${names('cr')} → ${names('dr')}`, sub: '振替', amount: total, cls: 'neutral' };
  return { title: '仕訳', sub: `収益 ${yen(inc)} ／ 費用 ${yen(exp)}`, amount: inc - exp, cls: inc - exp >= 0 ? 'in' : 'out' };
}

const KIND_LABEL = { expense: '支出', income: '収入', transfer: '振替', journal: '仕訳', recurring: '自動入力', opening: '開始残高', valuation: '評価額の更新' };

function monthNav(key, by, act) {
  return `<div class="pnav">
    <button type="button" class="icon-btn" data-act="${act}" data-val="-1" aria-label="前へ">‹</button>
    <div class="pnav-label">${periodLabel(key, by)}</div>
    <button type="button" class="icon-btn" data-act="${act}" data-val="1" aria-label="次へ">›</button>
  </div>`;
}

function statRow(sum) {
  const diff = sum.incomeTotal - sum.expenseTotal;
  return `<div class="stats">
    <div class="stat"><div class="stat-label">収入</div><div class="stat-value">${yen(sum.incomeTotal)}</div></div>
    <div class="stat"><div class="stat-label">支出</div><div class="stat-value">${yen(sum.expenseTotal)}</div></div>
    <div class="stat"><div class="stat-label">差額</div><div class="stat-value ${diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${yen(diff)}</div></div>
  </div>`;
}

function viewHistory() {
  const m = ui.histMonth;
  const sum = L.summarize(state, 'month').get(m) || L.emptySummary();
  const list = state.entries
    .filter((e) => L.monthOf(e.date) === m)
    .sort((a, b) => (a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : a.date < b.date ? 1 : -1));
  let html = '';
  let cur = null;
  for (const e of list) {
    if (e.date !== cur) {
      if (cur) html += '</ul>';
      cur = e.date;
      html += `<h3 class="day">${dateLabel(e.date)}</h3><ul class="entries">`;
    }
    const d = describe(e);
    const sign = d.cls === 'out' ? '−' : d.cls === 'in' ? '+' : '';
    html += `<li><button type="button" class="entry" data-act="detail" data-id="${e.id}">
      <span class="sw ${d.color ? '' : 'sw-none'}" style="${d.color ? `background:${d.color}` : ''}"></span>
      <span class="entry-main"><span class="entry-title">${esc(d.title)}${e.kind === 'recurring' ? '<span class="badge">自動入力</span>' : ''}</span>
      <span class="entry-sub">${esc([d.sub, e.memo].filter(Boolean).join('　'))}</span></span>
      <span class="entry-amt ${d.cls}">${sign}${yen(Math.abs(d.amount))}</span></button></li>`;
  }
  if (cur) html += '</ul>';
  if (!list.length) html = '<p class="empty">この月の記録はありません</p>';
  return `<header class="top"><h1>履歴</h1></header>
    ${monthNav(m, 'month', 'hist-nav')}
    ${statRow(sum)}
    <section class="card list">${html}</section>`;
}

function showDetail(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  const dr = e.lines.filter((l) => l.side === 'dr');
  const cr = e.lines.filter((l) => l.side === 'cr');
  const rows = [];
  for (let i = 0; i < Math.max(dr.length, cr.length); i++) {
    rows.push(`<tr><td>${dr[i] ? esc(accName(dr[i].acc)) : ''}</td><td class="num">${dr[i] ? yen(dr[i].amount) : ''}</td>
      <td>${cr[i] ? esc(accName(cr[i].acc)) : ''}</td><td class="num">${cr[i] ? yen(cr[i].amount) : ''}</td></tr>`);
  }
  openSheet(`
    <h2>${dateLabel(e.date)}　${KIND_LABEL[e.kind] || '仕訳'}</h2>
    ${e.memo ? `<p>${esc(e.memo)}</p>` : ''}
    <table class="jtable"><thead><tr><th colspan="2">借方</th><th colspan="2">貸方</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <div class="sheet-actions">
      <button type="button" class="danger" data-act="delete" data-id="${e.id}">削除</button>
      <button type="button" class="ghost" data-act="close-sheet">閉じる</button>
      <button type="button" class="primary" data-act="edit" data-id="${e.id}">編集</button>
    </div>`);
}

// ---------------------------------------------------------------- グラフ画面
const NW_COLOR = 'var(--s7)';
const EXP_COLOR = 'var(--s1)';
const INC_COLOR = 'var(--s2)';

function tableView(headers, rows) {
  return `<details class="tview"><summary>表で見る</summary><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

function chartData() {
  const by = ui.chartBy;
  const key = ui.chartKey[by];
  const keys = L.periodKeysEnding(key, by, by === 'year' ? 5 : 12);
  const sums = L.summarize(state, by);
  const get = (k) => sums.get(k) || L.emptySummary();
  return {
    by, key, keys, get,
    exp: keys.map((k) => get(k).expenseTotal),
    inc: keys.map((k) => get(k).incomeTotal),
    nw: L.netWorthSeries(state, keys, by),
    sel: keys.length - 1,
  };
}

function viewCharts() {
  const c = chartData();
  const { by, key, keys } = c;
  const cur = c.get(key);
  const prev = c.get(L.prevPeriod(key, by));
  const prevName = by === 'year' ? '前年' : '前月';

  // 残高（今日の時点）
  const bal = L.balances(state, today());
  const nwNow = L.netWorth(state, today());
  const balRows = (type) =>
    state.accounts
      .filter((a) => a.type === type && (!a.archived || bal[a.id] !== 0))
      .map((a) => `<tr><td>${esc(a.name)}</td><td class="num">${yen(bal[a.id])}</td></tr>`)
      .join('');

  // 科目別の支出
  const expAccs = state.accounts.filter((a) => a.type === 'expense');
  const items = expAccs
    .map((a) => ({ a, v: cur.expense[a.id] || 0, p: prev.expense[a.id] || 0 }))
    .filter((x) => x.v !== 0 || x.p !== 0);
  const total = cur.expenseTotal;
  const positive = items.filter((x) => x.v > 0);
  const posTotal = positive.reduce((s, x) => s + x.v, 0);
  const seg = posTotal
    ? `<div class="segbar" role="img" aria-label="科目別の支出の割合">` +
      positive
        .map((x) => {
          const pct = (x.v / posTotal) * 100;
          const label = pct >= 12 ? `${Math.round(pct)}%` : '';
          const color = expenseColor(x.a.id);
          const ink = color === 'var(--s4)' ? 'var(--s4-ink)' : '#fff';
          return `<div class="segbar-part" style="flex:${x.v} 1 0;background:${color}" title="${esc(x.a.name)} ${yen(x.v)}（${Math.round(pct)}%）"><span style="color:${ink}">${label}</span></div>`;
        })
        .join('') +
      '</div>'
    : '';
  const rows = items
    .map((x) => {
      const d = x.v - x.p;
      const share = total > 0 ? Math.round((x.v / total) * 100) + '%' : '';
      const dcls = d > 0 ? 'up' : d < 0 ? 'down' : '';
      const dtxt = d === 0 ? '±0' : `${d > 0 ? '▲' : '▼'}${yen(Math.abs(d))}`;
      return `<tr><td><span class="sw" style="background:${expenseColor(x.a.id)}"></span>${esc(x.a.name)}</td>
        <td class="num">${yen(x.v)}</td><td class="num muted">${share}</td><td class="num delta ${dcls}">${dtxt}</td></tr>`;
    })
    .join('');

  const diff = cur.incomeTotal - cur.expenseTotal;
  const lb = (k) => periodLabel(k, by);

  return `<header class="top"><h1>グラフ</h1></header>
    <div class="seg">
      <button type="button" class="${by === 'month' ? 'on' : ''}" data-act="chart-by" data-val="month">月別</button>
      <button type="button" class="${by === 'year' ? 'on' : ''}" data-act="chart-by" data-val="year">年別</button>
    </div>
    ${monthNav(key, by, 'chart-nav')}

    <section class="card">
      <h2>総支出</h2>
      <p class="caption">${lb(key)}：<b>${yen(cur.expenseTotal)}</b>（${prevName} ${yen(prev.expenseTotal)}）</p>
      <div class="chart" id="ch-exp"></div>
      ${tableView(['期間', '総支出'], keys.map((k, i) => [lb(k), yen(c.exp[i])]))}
    </section>

    <section class="card">
      <h2>科目別の支出</h2>
      <p class="caption">${lb(key)}の合計 <b>${yen(total)}</b>。右端の列は${prevName}からの増減</p>
      ${seg}
      ${rows ? `<table class="cat"><tbody>${rows}</tbody></table>` : '<p class="empty">支出の記録はありません</p>'}
    </section>

    <section class="card">
      <h2>収入と支出</h2>
      <div class="legend"><span><span class="sw" style="background:${INC_COLOR}"></span>収入</span><span><span class="sw" style="background:${EXP_COLOR}"></span>支出</span></div>
      <div class="chart" id="ch-io"></div>
      <p class="caption">${lb(key)}：収入 ${yen(cur.incomeTotal)} − 支出 ${yen(cur.expenseTotal)} ＝ <b class="${diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${yen(diff)}</b></p>
      ${tableView(['期間', '収入', '支出', '差額'], keys.map((k, i) => [lb(k), yen(c.inc[i]), yen(c.exp[i]), yen(c.inc[i] - c.exp[i])]))}
    </section>

    <section class="card">
      <h2>純資産の推移</h2>
      <p class="caption">資産の残高の合計 − 負債の残高の合計。各${by === 'year' ? '年' : '月'}の末日の値</p>
      <div class="chart" id="ch-nw"></div>
      ${tableView(['期間', '純資産'], keys.map((k, i) => [lb(k), yen(c.nw[i])]))}
    </section>

    <section class="card">
      <h2>今日の残高</h2>
      <div class="hero"><div class="stat-label">純資産</div><div class="hero-value ${nwNow < 0 ? 'neg' : ''}">${yen(nwNow)}</div></div>
      <table class="bal"><thead><tr><th colspan="2">資産</th></tr></thead><tbody>${balRows('asset')}</tbody></table>
      <table class="bal"><thead><tr><th colspan="2">負債</th></tr></thead><tbody>${balRows('liability')}</tbody></table>
      ${bal.valuation ? `<p class="hint">純資産のうち、評価差額（これまでの値上がり額の累計）：${yen(bal.valuation)}</p>` : ''}
      <button type="button" class="ghost" data-act="valuation">評価額を更新</button>
    </section>`;
}

function drawCharts() {
  if (ui.tab !== 'charts') return;
  const c = chartData();
  const labels = c.keys.map((k) => shortLabel(k, c.by));
  const onSelect = (i) => {
    ui.chartKey[c.by] = c.keys[i];
    render();
  };
  const el = (id) => document.getElementById(id);
  columnChart(el('ch-exp'), {
    labels, selected: c.sel, onSelect,
    series: [{ name: '総支出', color: EXP_COLOR, values: c.exp }],
    ariaLabel: '期間ごとの総支出の縦棒グラフ',
  });
  columnChart(el('ch-io'), {
    labels, selected: c.sel, onSelect,
    series: [
      { name: '収入', color: INC_COLOR, values: c.inc },
      { name: '支出', color: EXP_COLOR, values: c.exp },
    ],
    ariaLabel: '期間ごとの収入と支出の縦棒グラフ',
  });
  lineChart(el('ch-nw'), {
    labels, values: c.nw, color: NW_COLOR, selected: c.sel, onSelect, name: '純資産',
    ariaLabel: '期間の末日ごとの純資産の折れ線グラフ',
  });
}

// ---------------------------------------------------------------- 設定画面
function viewSettings() {
  const st = state.settings;
  const days = L.daysSince(st.lastBackupAt);
  const freqText = (r) => (r.freq === 'yearly' ? `毎年${r.month}月${r.day}日` : `毎月${r.day}日`);
  const recurring = [...state.recurring]
    .sort((a, b) => Number(b.active) - Number(a.active))
    .map(
      (r) => `<li><button type="button" class="entry" data-act="rec-edit" data-id="${r.id}">
        <span class="entry-main"><span class="entry-title">${esc(r.name)}<span class="badge">${REC_KIND[L.recurringKind(r, state.accounts)].label}</span>${r.active ? '' : '<span class="badge off">停止中</span>'}</span>
        <span class="entry-sub">${freqText(r)}　借方 ${esc(accName(r.debit))} ／ 貸方 ${esc(accName(r.credit))}</span></span>
        <span class="entry-amt">${r.amount ? yen(r.amount) : '金額未設定'}</span></button></li>`,
    )
    .join('');
  const accountsHtml = L.TYPE_ORDER.map(
    (t) => `<h3 class="day">${L.TYPE_LABEL[t]}</h3><ul class="accs">` +
      state.accounts
        .filter((a) => a.type === t)
        .map(
          (a) => `<li class="${a.archived ? 'archived' : ''}"><span>${t === 'expense' ? `<span class="sw" style="background:${expenseColor(a.id)}"></span>` : ''}${esc(a.name)}${a.archived ? '（非表示）' : ''}</span>
          <span class="acc-btns">
            <button type="button" class="link" data-act="acc-rename" data-id="${a.id}">名前</button>
            ${a.id === 'opening' ? '' : `<button type="button" class="link" data-act="acc-archive" data-id="${a.id}">${a.archived ? '表示' : '非表示'}</button>`}
            ${a.id === 'opening' || L.accountInUse(state, a.id) ? '' : `<button type="button" class="link danger-text" data-act="acc-delete" data-id="${a.id}">削除</button>`}
          </span></li>`,
        )
        .join('') +
      '</ul>',
  ).join('');

  return `<header class="top"><h1>設定</h1></header>
    ${isStandalone() || DEMO ? '' : '<p class="notice">この画面はブラウザのタブで開いています。ホーム画面のアイコンから開いた場合とはデータが別々に保存されます。ふだんはホーム画面のアイコンから開いてください。</p>'}

    <section class="card">
      <h2>バックアップ</h2>
      <p>前回のバックアップ：${st.lastBackupAt ? `${new Date(st.lastBackupAt).toLocaleDateString('ja-JP')}（${days}日前）` : 'まだありません'}</p>
      <div class="btn-row">
        <button type="button" class="primary" data-act="export">書き出す</button>
        <button type="button" class="ghost" data-act="import">ファイルから復元</button>
      </div>
      <p class="hint">「書き出す」を押すと共有メニューが開きます。「"ファイル"に保存」からGoogleドライブを選ぶか、メールやDropboxに送って保存してください。</p>
      <label class="field inline"><span>前回のバックアップから
        <select data-setting="backupDays">${[3, 7, 14, 30].map((n) => `<option value="${n}"${n === st.backupDays ? ' selected' : ''}>${n}</option>`).join('')}</select>
        日たったら画面上部に表示する</span></label>
      <input type="file" id="import-file" accept=".json,application/json,text/plain" hidden>
    </section>

    <section class="card">
      <h2>開始残高</h2>
      <p class="hint">使い始める日の各口座の残高を入れます。資産は「借方 資産／貸方 開始残高」、負債は「借方 開始残高／貸方 負債」の仕訳になります。クレジットカードは、まだ引き落とされていない利用額を入れます。</p>
      <div class="row2">
        <label class="field"><span class="field-label">勘定科目</span><select id="op-acc">${accountOptions('', ['asset', 'liability'])}</select></label>
        <label class="field"><span class="field-label">金額</span><input id="op-amount" inputmode="numeric" placeholder="0"></label>
      </div>
      <label class="field"><span class="field-label">日付</span><input id="op-date" type="date" value="${today()}"></label>
      <button type="button" class="ghost" data-act="opening">開始残高を記録</button>
    </section>

    <section class="card">
      <h2>自動入力（固定費・積立・収入）</h2>
      <p class="hint">毎月・毎年決まった日の入出金を登録すると、アプリを開いたときに、期日を過ぎた分の仕訳を自動で作ります。金額がその月だけ違った場合は、履歴からその仕訳を編集してください。</p>
      <ul class="entries">${recurring}</ul>
      <button type="button" class="ghost" data-act="rec-add">追加</button>
    </section>

    <section class="card">
      <h2>評価額の更新</h2>
      <p class="hint">NISAなどの今の評価額を入れると、帳簿の残高との差額を「評価差額」（純資産）として記録します。月に1回程度の更新を想定しています。</p>
      <button type="button" class="ghost" data-act="valuation">評価額を更新</button>
    </section>

    <section class="card">
      <h2>勘定科目</h2>
      ${accountsHtml}
      <div class="row2 add-acc">
        <select id="new-acc-type">${L.TYPE_ORDER.filter((t) => t !== 'equity').map((t) => `<option value="${t}">${L.TYPE_LABEL[t]}</option>`).join('')}</select>
        <input id="new-acc-name" placeholder="新しい科目の名前">
      </div>
      <button type="button" class="ghost" data-act="acc-add">科目を追加</button>
      <p class="hint">仕訳で使っている科目は削除できません。使わなくなった科目は「非表示」にすると、入力画面に出なくなります。</p>
    </section>

    <section class="card">
      <h2>データ</h2>
      <p>仕訳 ${state.entries.length}件。データはこの端末のこのアプリの中にだけ保存されています。</p>
      <p id="offline-status" class="hint"></p>
      <p id="persist-status" class="hint"></p>
      <button type="button" class="danger" data-act="wipe">すべてのデータを削除</button>
      <p class="hint">版 ${APP_VERSION}${DEMO ? '（デモ表示：変更は保存されません）' : ''}</p>
    </section>`;
}

// 自動入力の種類ごとの、借方・貸方の欄の名前と、作られる仕訳の説明
const REC_KIND = {
  expense: { label: '支出', debit: '借方：費用の科目', credit: '貸方：支払元', note: '例：通信費・サブスクリプション' },
  income: { label: '収入', debit: '借方：入金先', credit: '貸方：収益の科目', note: '例：バイトの給料、奨学金（返済なし）' },
  transfer: { label: '振替', debit: '借方：移動先', credit: '貸方：移動元', note: '例：NISA積立（移動元 クレジットカード → 移動先 NISA）、奨学金（返済あり）（移動元 奨学金（返済あり） → 移動先 銀行口座）' },
};

function recurringForm(r) {
  const isNew = !r;
  r = r || {
    id: L.uid(), name: '', amount: 0, freq: 'monthly', month: 1, day: 1,
    debit: 'subsc', credit: 'card', startMonth: L.monthOf(today()), lastMonth: null, active: true,
  };
  const kind = L.recurringKind(r, state.accounts);
  openSheet(`
    <h2>${isNew ? '自動入力の追加' : '自動入力の編集'}</h2>
    <form id="rec-form" data-id="${r.id}" data-new="${isNew}">
      <div class="seg" id="rec-kind">${Object.entries(REC_KIND).map(([k, v]) => `<button type="button" data-kind="${k}" class="${k === kind ? 'on' : ''}">${v.label}</button>`).join('')}</div>
      <p class="hint" id="rec-note"></p>
      <label class="field"><span class="field-label">名前</span><input name="name" value="${esc(r.name)}" required></label>
      <label class="field"><span class="field-label">金額</span><input name="amount" inputmode="numeric" value="${r.amount || ''}" placeholder="0"></label>
      <div class="row2">
        <label class="field"><span class="field-label">間隔</span><select name="freq"><option value="monthly"${r.freq === 'monthly' ? ' selected' : ''}>毎月</option><option value="yearly"${r.freq === 'yearly' ? ' selected' : ''}>毎年</option></select></label>
        <label class="field" id="rec-month-field"${r.freq === 'yearly' ? '' : ' hidden'}><span class="field-label">月</span><select name="month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${i + 1 === Number(r.month) ? ' selected' : ''}>${i + 1}月</option>`).join('')}</select></label>
        <label class="field"><span class="field-label">日</span><select name="day">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}"${i + 1 === Number(r.day) ? ' selected' : ''}>${i + 1}日</option>`).join('')}</select></label>
      </div>
      <p class="hint">月の日数より大きい日（例：31日）は、その月の末日になります。</p>
      <label class="field"><span class="field-label" id="rec-debit-label"></span><select name="debit"></select></label>
      <label class="field"><span class="field-label" id="rec-credit-label"></span><select name="credit"></select></label>
      <p class="preview" id="rec-preview"></p>
      <label class="field"><span class="field-label">開始月</span><input name="startMonth" type="month" value="${esc(r.startMonth || L.monthOf(today()))}"></label>
      ${r.lastMonth ? `<p class="hint">${monthLabel(r.lastMonth)}分まで作成済み</p>` : ''}
      <label class="check"><input type="checkbox" name="active"${r.active || !r.amount ? ' checked' : ''}> 自動入力する</label>
      <div class="sheet-actions">
        ${isNew ? '' : `<button type="button" class="danger" data-act="rec-delete" data-id="${r.id}">削除</button>`}
        <button type="button" class="ghost" data-act="close-sheet">閉じる</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>`);
  const form = $('#rec-form');
  const f = form.elements;
  f.freq.addEventListener('change', () => ($('#rec-month-field').hidden = f.freq.value !== 'yearly'));
  let curKind = kind;
  // 種類に合わせて借方・貸方の選択肢を入れ替える。今の選択が新しい種類でも使えるなら残す
  const setKind = (k) => {
    curKind = k;
    const sides = L.RECURRING_SIDES[k];
    const keep = (id, types) => (types.includes(acc(id)?.type) ? id : '');
    const d = keep(f.debit.value || r.debit, sides.debit);
    const c = keep(f.credit.value || r.credit, sides.credit);
    f.debit.innerHTML = accountOptions(d, sides.debit);
    f.credit.innerHTML = accountOptions(c, sides.credit);
    $('#rec-debit-label').textContent = REC_KIND[k].debit;
    $('#rec-credit-label').textContent = REC_KIND[k].credit;
    $('#rec-note').textContent = REC_KIND[k].note;
    form.querySelectorAll('#rec-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    updateRecPreview();
  };
  const updateRecPreview = () => {
    const amount = L.parseAmount(f.amount.value);
    $('#rec-preview').textContent =
      f.debit.value && f.credit.value && amount
        ? '作られる仕訳：' + linesText([{ acc: f.debit.value, side: 'dr', amount }, { acc: f.credit.value, side: 'cr', amount }])
        : '';
  };
  form.querySelectorAll('#rec-kind button').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
  form.addEventListener('input', updateRecPreview);
  form.addEventListener('change', updateRecPreview);
  f.debit.innerHTML = accountOptions(r.debit, L.RECURRING_SIDES[kind].debit);
  f.credit.innerHTML = accountOptions(r.credit, L.RECURRING_SIDES[kind].credit);
  setKind(kind);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = L.parseAmount(f.amount.value);
    const active = f.active.checked;
    if (!f.name.value.trim()) return toast('名前を入力してください');
    if (active && !amount) return toast('自動入力するには金額が必要です');
    if (!f.debit.value || !f.credit.value) return toast('借方と貸方の科目を選んでください');
    if (f.debit.value === f.credit.value) return toast('借方と貸方に同じ科目は選べません');
    if (!/^\d{4}-\d{2}$/.test(f.startMonth.value)) return toast('開始月を入力してください');
    const data = {
      name: f.name.value.trim(),
      amount: amount || 0,
      freq: f.freq.value,
      month: Number(f.month.value),
      day: Number(f.day.value),
      debit: f.debit.value,
      credit: f.credit.value,
      startMonth: f.startMonth.value,
      active,
    };
    let created = [];
    await commit((s) => {
      const ex = s.recurring.find((x) => x.id === r.id);
      if (ex) Object.assign(ex, data);
      else s.recurring.push({ ...r, ...data });
      created = L.generateRecurring(s, today());
    });
    closeSheet();
    toast(created.length ? `保存しました。期日を過ぎた${created.length}件の仕訳を作りました` : '保存しました');
  });
}

// ---------------------------------------------------------------- 評価額の更新
function valuationSheet() {
  const assets = accsOf('asset');
  const def = assets.find((a) => a.id === 'nisa') || assets[0];
  if (!state.accounts.some((a) => a.id === 'valuation')) {
    state.accounts.push({ id: 'valuation', name: '評価差額', type: 'equity', archived: false });
  }
  openSheet(`
    <h2>評価額の更新</h2>
    <form id="val-form">
      <label class="field"><span class="field-label">勘定科目</span><select name="acc">${assets.map((a) => `<option value="${a.id}"${a.id === def?.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span class="field-label">日付</span><input name="date" type="date" value="${today()}"></label>
      <p class="hint" id="val-book"></p>
      <label class="field"><span class="field-label">今の評価額（証券会社のアプリに出る金額）</span><input name="market" inputmode="numeric" autocomplete="off" placeholder="0"></label>
      <p class="preview" id="val-preview"></p>
      <p class="hint">売るときは、先に評価額を売却額に更新してから、入力画面の「振替」で NISA（投資信託）→ 入金先 に移してください。</p>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-act="close-sheet">閉じる</button>
        <button type="submit" class="primary">記録</button>
      </div>
    </form>`);
  const form = $('#val-form');
  const f = form.elements;
  const calc = () => {
    const book = L.balances(state, f.date.value || today())[f.acc.value] || 0;
    const market = L.parseAmount(f.market.value) ?? (f.market.value.trim() === '0' ? 0 : null);
    const lines = market == null ? null : L.buildValuationLines(f.acc.value, book, market);
    return { book, market, lines };
  };
  const update = () => {
    const { book, market, lines } = calc();
    $('#val-book').textContent = `帳簿の残高（${f.date.value}時点）：${yen(book)}`;
    $('#val-preview').textContent =
      market == null ? '' : lines ? `差額 ${market - book > 0 ? '+' : '−'}${yen(Math.abs(market - book))}　仕訳：${linesText(lines)}` : '帳簿の残高と同じなので、記録する仕訳はありません';
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { market, lines } = calc();
    if (market == null) return toast('評価額を入力してください');
    if (!lines) return toast('帳簿の残高と同じなので、記録する仕訳はありません');
    const entry = { id: L.uid(), date: f.date.value, memo: `評価額 ${yen(market)}`, kind: 'valuation', lines, createdAt: Date.now() };
    const err = L.validateEntry(entry, state.accounts);
    if (err) return toast(err);
    await commit((s) => s.entries.push(entry));
    closeSheet();
    toast('記録しました：' + linesText(lines));
  });
}

// ---------------------------------------------------------------- バックアップ
function exportBackup() {
  const payload = JSON.stringify({ app: 'kakeibo', schema: L.SCHEMA, exportedAt: new Date().toISOString(), state });
  const name = `kakeibo-backup-${today()}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  const done = async () => {
    state.settings.lastBackupAt = new Date().toISOString();
    await save();
    render();
    toast('バックアップを書き出しました');
  };
  // 共有メニューはタップの直後に呼ぶ必要があるので、ここより前で await しない
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).then(done, (e) => {
      if (e.name !== 'AbortError') toast('共有メニューを開けませんでした：' + e.message);
    });
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    done();
  }
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('JSONとして読み込めませんでした');
  }
  const s = data && data.state ? data.state : data;
  const err = L.validateState(s);
  if (err) return toast('このファイルは使えません：' + err);
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP') : '日時不明';
  if (!confirm(`${when}に書き出されたバックアップ（仕訳${s.entries.length}件）で、今のデータ（仕訳${state.entries.length}件）を置き換えます。よろしいですか？`)) return;
  state = L.migrate(s);
  await save();
  render();
  toast('バックアップから復元しました');
}

// ---------------------------------------------------------------- シートと上部の表示
function openSheet(html) {
  const d = $('#sheet');
  $('#sheet-body').innerHTML = html;
  if (!d.open) d.showModal();
}
function closeSheet() {
  const d = $('#sheet');
  if (d.open) d.close();
}

function renderBanner() {
  const b = $('#banner');
  const st = state.settings;
  const days = L.daysSince(st.lastBackupAt);
  const need = state.entries.length > 0 && (days == null || days >= st.backupDays);
  if (!need || ui.bannerHidden || DEMO) {
    b.hidden = true;
    return;
  }
  b.innerHTML = `<span>${days == null ? 'まだバックアップを取っていません' : `前回のバックアップから${days}日たっています`}</span>
    <button type="button" data-act="export">書き出す</button>
    <button type="button" class="icon-btn" data-act="hide-banner" aria-label="今回は閉じる">×</button>`;
  b.hidden = false;
}

// ---------------------------------------------------------------- 描画とイベント
const VIEWS = { input: viewInput, history: viewHistory, charts: viewCharts, settings: viewSettings };

function render() {
  $('#view').innerHTML = VIEWS[ui.tab]();
  document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  renderBanner();
  if (ui.tab === 'input') updatePreview();
  if (ui.tab === 'charts') drawCharts();
  if (ui.tab === 'settings' && navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => {
      const el = $('#persist-status');
      if (el) el.textContent = p ? 'このデータは、端末の容量が不足しても自動では削除されない設定になっています。' : '端末の容量が不足すると、ブラウザがこのデータを削除する場合があります。バックアップを定期的に取ってください。';
    });
  }
  if (ui.tab === 'settings') showOfflineStatus();
}

// オフラインで開くためのファイルが端末に保存されているかを表示する
async function showOfflineStatus() {
  const el = $('#offline-status');
  if (!el) return;
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    el.textContent = 'オフライン：このブラウザはオフラインでの起動に対応していません。';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = (await caches.keys()).filter((k) => k.startsWith('kakeibo-'));
    let ok = false;
    if (reg && reg.active && keys.length) {
      const c = await caches.open(keys[keys.length - 1]);
      ok = !!(await c.match('./index.html')) && !!(await c.match('./app.js'));
    }
    el.textContent = ok
      ? `オフライン：準備完了（${keys[keys.length - 1]}）。インターネットにつながっていなくても開けます。`
      : 'オフライン：準備ができていません。インターネットにつながった状態でホーム画面のアイコンから開き、数秒待ってから設定画面を開き直してください。';
    el.classList.toggle('warn', !ok);
  } catch (e) {
    el.textContent = 'オフライン：状態を確認できませんでした（' + e.message + '）';
  }
}

const ACTIONS = {
  tab: (el) => {
    ui.tab = el.dataset.tab;
    window.scrollTo(0, 0);
    render();
  },
  mode: (el) => {
    ui.mode = el.dataset.val;
    ui.draft = newDraft(ui.mode);
    render();
  },
  pick: (el) => {
    ui.draft[el.dataset.field] = el.dataset.val;
    el.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === el));
    updatePreview();
  },
  jadd: () => {
    ui.draft.lines.push({ side: 'dr', acc: '', amount: '' });
    render();
  },
  jdel: (el) => {
    ui.draft.lines.splice(Number(el.dataset.i), 1);
    render();
  },
  save: () => saveEntry(),
  'cancel-edit': () => {
    ui.editingId = null;
    ui.draft = newDraft(ui.mode);
    render();
  },
  'hist-nav': (el) => {
    ui.histMonth = L.addMonths(ui.histMonth, Number(el.dataset.val));
    render();
  },
  detail: (el) => showDetail(el.dataset.id),
  edit: (el) => startEdit(el.dataset.id),
  delete: async (el) => {
    if (!confirm('この仕訳を削除しますか？')) return;
    await commit((s) => (s.entries = s.entries.filter((e) => e.id !== el.dataset.id)));
    closeSheet();
    toast('削除しました');
  },
  'close-sheet': () => closeSheet(),
  'chart-by': (el) => {
    ui.chartBy = el.dataset.val;
    render();
  },
  'chart-nav': (el) => {
    const by = ui.chartBy;
    const k = ui.chartKey[by];
    ui.chartKey[by] = Number(el.dataset.val) < 0 ? L.prevPeriod(k, by) : L.nextPeriod(k, by);
    render();
  },
  export: () => exportBackup(),
  import: () => $('#import-file').click(),
  'hide-banner': () => {
    ui.bannerHidden = true;
    renderBanner();
  },
  opening: async () => {
    const a = acc($('#op-acc').value);
    const amount = L.parseAmount($('#op-amount').value);
    const date = $('#op-date').value;
    if (!a) return toast('勘定科目を選んでください');
    if (!amount) return toast('金額を入力してください');
    const entry = { id: L.uid(), date, memo: '開始残高', kind: 'opening', lines: L.buildOpeningLines(a, amount), createdAt: Date.now() };
    const err = L.validateEntry(entry, state.accounts);
    if (err) return toast(err);
    await commit((s) => s.entries.push(entry));
    toast('記録しました：' + linesText(entry.lines));
  },
  'rec-add': () => recurringForm(null),
  valuation: () => valuationSheet(),
  'rec-edit': (el) => recurringForm(state.recurring.find((r) => r.id === el.dataset.id)),
  'rec-delete': async (el) => {
    if (!confirm('この固定費の設定を削除しますか？（すでに作られた仕訳は残ります）')) return;
    await commit((s) => (s.recurring = s.recurring.filter((r) => r.id !== el.dataset.id)));
    closeSheet();
  },
  'acc-rename': async (el) => {
    const a = acc(el.dataset.id);
    const name = prompt('新しい名前', a.name);
    if (!name || !name.trim()) return;
    await commit(() => (a.name = name.trim()));
  },
  'acc-archive': async (el) => {
    const a = acc(el.dataset.id);
    await commit(() => (a.archived = !a.archived));
  },
  'acc-delete': async (el) => {
    const a = acc(el.dataset.id);
    if (!confirm(`科目「${a.name}」を削除しますか？`)) return;
    await commit((s) => (s.accounts = s.accounts.filter((x) => x.id !== a.id)));
  },
  'acc-add': async () => {
    const r = await addAccount($('#new-acc-type').value, $('#new-acc-name').value);
    if (r.error) return toast(r.error);
    toast(`${L.TYPE_LABEL[r.account.type]}の科目「${r.account.name}」を追加しました`);
  },
  'add-acc-inline': (el) => addAccountSheet(el.dataset.field, el.dataset.types.split(',')),
  wipe: async () => {
    if (!confirm('すべての仕訳・科目・設定を削除して、最初の状態に戻します。先にバックアップを書き出しましたか？')) return;
    if (!confirm('本当に削除しますか？この操作は取り消せません。')) return;
    state = L.defaultState();
    ui.draft = newDraft(ui.mode);
    await save();
    render();
    toast('すべてのデータを削除しました');
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el);
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.field && ui.tab === 'input') {
    ui.draft[t.dataset.field] = t.value;
    updatePreview();
  } else if (t.dataset.jfield) {
    const i = Number(t.closest('.jrow').dataset.i);
    ui.draft.lines[i][t.dataset.jfield] = t.value;
    updatePreview();
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.jfield) {
    const i = Number(t.closest('.jrow').dataset.i);
    ui.draft.lines[i][t.dataset.jfield] = t.value;
    updatePreview();
  } else if (t.dataset.setting) {
    await commit((s) => (s.settings[t.dataset.setting] = Number(t.value)));
  } else if (t.id === 'import-file' && t.files[0]) {
    await importBackup(t.files[0]);
    t.value = '';
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 150);
});

// 日付が変わってから再び開いたときにも固定費を作る
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state) return;
  const created = L.generateRecurring(state, today());
  if (created.length) {
    await save();
    render();
    toast(`固定費の仕訳を${created.length}件作りました`);
  } else {
    renderBanner();
  }
});

// ---------------------------------------------------------------- デモ用データ（?demo を付けて開いたときだけ。保存しない）
function demoState() {
  const s = L.defaultState();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const end = L.monthOf(today());
  const start = L.addMonths(end, -13);
  const push = (date, kind, lines, memo = '') => s.entries.push({ id: L.uid(), date, kind, lines, memo, createdAt: 0 });
  push(`${start}-01`, 'opening', L.buildOpeningLines(s.accounts.find((a) => a.id === 'bank'), 180000));
  push(`${start}-01`, 'opening', L.buildOpeningLines(s.accounts.find((a) => a.id === 'cash'), 12000));
  const cats = ['food', 'food', 'food', 'transport', 'daily', 'mountain', 'play', 'book', 'study', 'other_exp'];
  for (let i = 0; i <= 13; i++) {
    const ym = L.addMonths(start, i);
    const lastDay = ym === end ? Number(today().slice(8, 10)) : L.daysInMonth(ym);
    let cardUse = 0;
    for (let j = 0; j < 22; j++) {
      const day = 1 + Math.floor(rnd() * lastDay);
      const acc0 = cats[Math.floor(rnd() * cats.length)];
      const base = { food: 900, transport: 600, daily: 800, mountain: 6000, play: 2500, book: 1500, study: 2000, other_exp: 1000 }[acc0];
      const amt = Math.round((base * (0.4 + rnd() * 1.4)) / 10) * 10;
      const from = rnd() < 0.5 ? 'card' : rnd() < 0.5 ? 'cash' : 'emoney';
      if (from === 'card') cardUse += amt;
      push(`${ym}-${L.pad2(day)}`, 'expense', L.buildSimpleLines('expense', { acc: acc0, from }, amt));
    }
    if (lastDay >= 25) {
      push(`${ym}-25`, 'income', L.buildSimpleLines('income', { acc: 'job1', to: 'bank' }, 52000 + Math.round(rnd() * 20) * 1000));
      push(`${ym}-15`, 'income', L.buildSimpleLines('income', { acc: 'job2', to: 'bank' }, 15000 + Math.round(rnd() * 10) * 1000));
      push(`${ym}-11`, 'transfer', L.buildSimpleLines('transfer', { from: 'loan_sch', to: 'bank' }, 30000));
      push(`${ym}-20`, 'transfer', L.buildSimpleLines('transfer', { from: 'bank', to: 'emoney' }, 5000));
      push(`${ym}-27`, 'transfer', L.buildSimpleLines('transfer', { from: 'bank', to: 'card' }, cardUse));
    }
  }
  Object.assign(s.recurring[0], { amount: 2970, day: 5, startMonth: start, active: true });
  Object.assign(s.recurring[1], { amount: 3400, day: 12, startMonth: start, active: true });
  Object.assign(s.recurring[2], { amount: 5900, freq: 'yearly', month: 4, day: 1, startMonth: start, active: true });
  L.generateRecurring(s, today());
  s.settings.lastBackupAt = new Date(Date.now() - 3 * 86400000).toISOString();
  return s;
}

// ---------------------------------------------------------------- 起動
async function init() {
  if (DEMO) {
    state = L.defaultState();
    state = demoState();
  } else {
    let stored = null;
    try {
      dbp = openDB();
      stored = await idbGet('state');
    } catch (e) {
      storageOk = false;
      toast('データの保存場所を開けませんでした。この状態では入力が保存されません：' + (e && e.message));
    }
    state = stored ? L.migrate(stored) : L.defaultState();
    const created = L.generateRecurring(state, today());
    if (!stored || created.length) await save();
    if (created.length) setTimeout(() => toast(`固定費の仕訳を${created.length}件作りました`), 300);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  const hashTab = location.hash.slice(1);
  if (VIEWS[hashTab]) ui.tab = hashTab;
  ui.draft = newDraft(ui.mode);
  render();

  if ('serviceWorker' in navigator && !DEMO && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('新しい版のアプリを読み込みました', { label: '再読み込み', run: () => location.reload() });
    });
  }
}

init();
