import * as L from './ledger.js';
import * as C from './calendar.js';
import { columnChart, lineChart, yen } from './charts.js';

const APP_VERSION = '1.13.0';
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
  hist: { q: '', acc: '', src: '', all: true, open: false }, // 履歴の検索・絞り込み（all：すべての月から探す）
  chartBy: 'month',
  chartKey: { month: L.monthOf(L.todayStr()), year: L.yearOf(L.todayStr()) },
  bannerHidden: false,
  cal: { view: 'month', month: L.monthOf(L.todayStr()), week: C.startOfWeek(L.todayStr()), q: '' }, // カレンダーの表示
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
const ADV_NEW = '__adv_new__'; // 立替金の科目がまだないときの仮のid（保存するときに科目を作る）
const accName = (id) => (id === ADV_NEW ? L.ADVANCE_NAME : acc(id)?.name ?? '（削除された科目）');
// 立替に使う資産の科目（名前に「立替」を含むもの）。なければ ADV_NEW
const advanceAccId = () => (state.accounts.find((a) => a.type === 'asset' && !a.archived && a.name.includes('立替')) || {}).id || ADV_NEW;
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
// 費用の科目の色。選べる色は --s1〜--s16 と灰色（s-other）
const PALETTE = [...Array.from({ length: 16 }, (_, i) => `s${i + 1}`), 's-other'];
const LIGHT_COLORS = ['s4', 's12', 's14']; // 上に白い文字を置くと読みにくい色

// 色の名前（s1 など）。科目に色が選ばれていればそれを、なければ並び順で --s1〜--s8 を使い、9つ目以降と「その他」は灰色
function colorKey(id) {
  const a = acc(id);
  if (a?.color && PALETTE.includes(a.color)) return a.color;
  if (id === 'other_exp') return 's-other';
  const list = state.accounts.filter((x) => x.type === 'expense' && x.id !== 'other_exp');
  const i = list.findIndex((x) => x.id === id);
  return i >= 0 && i < 8 ? `s${i + 1}` : 's-other';
}
const expenseColor = (id) => `var(--${colorKey(id)})`;

// まだほかの費用の科目に使われていない色のうち最初のもの（すべて使われていれば s9 から順に）
function unusedColor(exceptId = null) {
  const used = new Set(state.accounts.filter((a) => a.type === 'expense' && a.id !== exceptId).map((a) => colorKey(a.id)));
  return PALETTE.find((k) => k !== 's-other' && !used.has(k)) || 's9';
}

// 色の選択肢。name を持つ hidden の input に選んだ色を入れる
function swatchPicker(selected, name = 'acccolor') {
  return `<input type="hidden" name="${name}" value="${selected}">
    <div class="swatches" role="radiogroup" aria-label="色">${PALETTE.map(
      (k) => `<button type="button" role="radio" aria-checked="${k === selected}" aria-label="${k === 's-other' ? '灰色' : `色${k.slice(1)}`}" class="swatch${k === selected ? ' on' : ''}" data-color="${k}" style="background:var(--${k})"></button>`,
    ).join('')}</div>`;
}
// 色の選択肢をクリックで切り替える（root はフォームなど）
function bindSwatches(root, onPick = () => {}) {
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('.swatch');
    if (!b) return;
    const box = b.parentElement;
    box.querySelectorAll('.swatch').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-checked', String(x === b));
    });
    box.previousElementSibling.value = b.dataset.color;
    onPick(b.dataset.color);
  });
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

// 予定の欄の初期値（何も選んでいない）
const NO_EVENT = { eventId: null, newEvent: '', newEventOpen: false, newEventCat: null }; // newEventCat：選んだ種類（null なら科目で決める）

// 立替欄の初期値。割り勘の人数と、割り勘か金額の指定かは、前回の入力を使う
function advDefaults() {
  const last = state.settings.last || {};
  return { advOn: false, advMode: last.advMode || 'split', people: last.people || 2, adv: '', advAcc: null };
}

function newDraft(mode) {
  const last = state.settings.last || {};
  const base = { date: ui.draft?.date || today(), memo: '', ...NO_EVENT };
  switch (mode) {
    case 'expense':
      return { ...base, amount: '', acc: null, from: last.expenseFrom || 'cash', ...advDefaults() };
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
async function addAccount(type, name, color = null) {
  name = (name || '').trim();
  if (!name) return { error: '科目の名前を入力してください' };
  if (state.accounts.some((a) => a.type === type && a.name === name)) return { error: `${L.TYPE_LABEL[type]}に同じ名前の科目があります` };
  const account = { id: L.uid(), name, type, archived: false };
  if (type === 'expense') account.color = PALETTE.includes(color) ? color : unusedColor(); // 色を選ばなければ、まだ使っていない色
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
      <div id="acc-color"${types[0] === 'expense' ? '' : ' hidden'}><span class="field-label">色（入力画面・履歴・グラフで使う）</span>${swatchPicker(unusedColor())}</div>
      <p class="hint">名前の変更・非表示・削除は、設定画面の「勘定科目」からできます。</p>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-act="close-sheet">閉じる</button>
        <button type="submit" class="primary">追加</button>
      </div>
    </form>`);
  const form = $('#acc-form');
  bindSwatches(form);
  form.elements.acctype.addEventListener?.('change', (ev) => ($('#acc-color').hidden = ev.target.value !== 'expense'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    const r = await addAccount(f.acctype.value, f.accname.value, f.acccolor.value);
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
    body += amountField('amount', '金額');
  }
  if (m === 'expense') {
    body += `<div class="field-label">科目</div>${chips('acc', ['expense'], d.acc, true)}`;
    body += `<div class="field-label">支払元</div>${chips('from', ['asset', 'liability'], d.from)}`;
    if (d.advOn) {
      const split = d.advMode === 'split';
      body += `<div class="adv">
          <div class="adv-head"><span class="field-label">うち立替（ほかの人の分）</span><button type="button" class="link" data-act="adv-toggle">立替をやめる</button></div>
          <div class="seg seg-sm">
            <button type="button" class="${split ? 'on' : ''}" data-act="adv-mode" data-val="split">割り勘</button>
            <button type="button" class="${split ? '' : 'on'}" data-act="adv-mode" data-val="amount">金額を指定</button>
          </div>
          ${
            split
              ? `<div class="stepper"><span class="stepper-label">人数（自分を含む）</span>
                  <button type="button" class="icon-btn" data-act="people" data-val="-1" aria-label="1人減らす"${d.people <= 2 ? ' disabled' : ''}>−</button>
                  <span class="stepper-val">${d.people}人</span>
                  <button type="button" class="icon-btn" data-act="people" data-val="1" aria-label="1人増やす"${d.people >= 30 ? ' disabled' : ''}>＋</button></div>`
              : `${amountField('adv', '立替の金額', 'amount-sm')}
                <div class="btn-row adv-quick"><button type="button" class="chip" data-act="adv-set" data-val="all">全額</button></div>`
          }
          <p class="hint" id="adv-note"></p>
        </div>`;
    } else {
      body += `<button type="button" class="chip chip-add adv-open" data-act="adv-toggle">＋ 立替を含める（割り勘・ほかの人の分もまとめて払った）</button>`;
    }
  } else if (m === 'income') {
    body += `<div class="field-label">科目</div>${chips('acc', ['income'], d.acc)}`;
    body += `<div class="field-label">入金先</div>${chips('to', ['asset'], d.to)}`;
  } else if (m === 'transfer') {
    body += `<div class="field-label">移動元</div>${chips('from', ['asset', 'liability'], d.from)}`;
    body += `<div class="field-label">移動先</div>${chips('to', ['asset', 'liability'], d.to)}`;
    body += `<p class="hint">カードの引き落とし：移動元＝銀行口座、移動先＝クレジットカード<br>貸与奨学金の受け取り：移動元＝奨学金（返済あり）、移動先＝銀行口座<br>立て替えた分が返ってきた：移動元＝${esc(accName(advanceAccId()))}、移動先＝受け取った現金・口座など</p>`;
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
    ${eventPickAllowed() ? `<div id="ev-pick">${eventPicker()}</div>` : ''}
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
  if (ui.mode === 'expense' && d.advOn) {
    const split = d.advMode === 'split';
    const adv = split ? L.splitAdvance(amount, d.people) : L.parseAmount(d.adv);
    if (!adv) return { error: split ? '金額が少ないため、立替の金額が0円になります' : '立替の金額を入力してください' };
    if (adv > amount) return { error: '立替の金額が支払った金額を超えています' };
    if (adv < amount && !d.acc) return { error: '科目を選んでください' };
    if (!d.from) return { error: '支払元を選んでください' };
    return { lines: L.buildAdvanceLines({ ...d, advAcc: d.advAcc || advanceAccId() }, amount, adv), own: amount - adv, adv };
  }
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
  const note = $('#adv-note');
  if (note) {
    const name = accName(ui.draft.advAcc || advanceAccId());
    const n = ui.draft.people;
    const who = ui.draft.advMode === 'split' ? `（${n - 1}人分、1人あたり ${yen(Math.floor(L.parseAmount(ui.draft.amount) / n))}）` : '';
    note.textContent = r.adv
      ? `自分の分 ${yen(r.own)} を支出に、立替 ${yen(r.adv)}${who}を「${name}」（資産）に記録します。返ってきたら振替で、移動元＝${name}。`
      : '';
  }
}

// 金額欄。タップすると電卓が開く（iPhoneのキーボードは出さない）
function amountField(field, label, cls = '') {
  const n = L.parseAmount(ui.draft[field]);
  return `<button type="button" class="amount ${cls}" data-act="calc" data-field="${field}" aria-label="${label}（電卓で入力）">
    <span class="amount-yen">¥</span><span class="amount-val${n ? '' : ' ph'}">${n ? n.toLocaleString('ja-JP') : '0'}</span>
    <span class="calc-hint" aria-hidden="true">＋−×÷</span></button>`;
}

let calcCtl = null; // 表示中の電卓の操作（パソコンのキーボードから押す）

// 電卓。決定すると、計算結果（1円未満は四捨五入）を入力欄に入れる
function calcSheet(field) {
  const n0 = L.parseAmount(ui.draft[field]);
  let expr = n0 ? String(n0) : '';
  let fresh = !!expr; // 開いた直後に数字を押したら、元の金額を置き換える
  const ops = '+-*/';
  const show = (x) => x.replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−').replace(/\+/g, '＋');
  const keys = ['C', 'back', '/', '*', '7', '8', '9', '-', '4', '5', '6', '+', '1', '2', '3', '00', '0', '.'];
  const label = { C: 'C', back: '⌫', '/': '÷', '*': '×', '-': '−', '+': '＋' };
  openSheet(`
    <h2>電卓</h2>
    <div class="calc-disp"><div class="calc-expr" id="calc-expr"></div><div class="calc-res" id="calc-res"></div></div>
    <div class="calc-keys" id="calc-keys">
      ${keys.map((k) => `<button type="button" data-key="${k}" class="${/\d/.test(k) || k === '.' ? '' : 'op'}" aria-label="${k === 'back' ? '1文字消す' : k}">${label[k] || k}</button>`).join('')}
      <button type="button" data-key="ok" class="ok">決定</button>
    </div>
    <p class="hint">1円未満は四捨五入します。</p>
    <div class="sheet-actions"><button type="button" class="ghost" data-act="close-sheet">閉じる</button></div>`);
  const trimmed = () => expr.replace(/[-+*/.]+$/, '');
  const curNum = () => expr.split(/[-+*/]/).at(-1);
  const fmt = (v) => (Number.isInteger(v) ? yen(v) : `${v.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}（${yen(Math.round(v))}）`);
  const update = () => {
    $('#calc-expr').textContent = show(expr) || '0';
    const t = trimmed();
    const v = L.evalExpr(t);
    $('#calc-res').textContent = v == null || !/[-+*/.]/.test(t) ? '' : '＝ ' + fmt(v);
  };
  const press = (k) => {
    if (k === 'C') expr = '';
    else if (k === 'back') expr = expr.slice(0, -1);
    else if (ops.includes(k)) {
      if (!expr) return;
      expr = expr.replace(/[-+*/.]+$/, '') + k;
    } else if (k === '.') {
      if (fresh) expr = '0.';
      else if (curNum().includes('.')) return;
      else expr += curNum() ? '.' : '0.';
    } else if (k === 'ok') {
      const n = L.parseAmount(trimmed());
      if (!n) return toast('計算結果が1円以上になる式を入力してください');
      ui.draft[field] = String(n);
      closeSheet();
      render();
      return;
    } else {
      if (fresh) expr = '';
      if (k === '00' && !curNum()) return;
      if (curNum() === '0') expr = expr.slice(0, -1); // 先頭の0は置き換える
      expr += k;
    }
    fresh = false;
    update();
  };
  $('#calc-keys').onclick = (ev) => {
    const k = ev.target.closest('[data-key]')?.dataset.key;
    if (k) press(k);
  };
  calcCtl = { press };
  $('#sheet').addEventListener('close', () => (calcCtl = null), { once: true });
  update();
}

async function saveEntry() {
  let r = draftLines();
  if (r.error) return toast(r.error);
  const d = ui.draft;
  if (r.lines.some((l) => l.acc === ADV_NEW)) {
    // 立替金の科目がまだないので、資産の科目として作ってから仕訳を作り直す
    const a = await addAccount('asset', L.ADVANCE_NAME);
    if (a.error) return toast(a.error);
    r = draftLines();
  }
  const old = ui.editingId ? state.entries.find((e) => e.id === ui.editingId) : null;
  const keepKind = old && ['recurring', 'opening', 'valuation'].includes(old.kind) ? old.kind : null;
  // つなぐ予定。新しい予定名が入っていれば、同じ日に同じ名前の予定にするか、保存のときに作る
  let evId = null;
  let newEv = null;
  if (!keepKind) {
    const title = d.newEventOpen ? (d.newEvent || '').trim() : '';
    if (title) {
      const same = C.findSameEvent(state.calendar, d.date, title);
      if (same) evId = same.id;
      else {
        newEv = C.newEvent({ title, date: d.date, cat: newEventCat(r.lines), src: 'ledger' });
        evId = newEv.id;
      }
    } else if (d.eventId && state.calendar.events.some((x) => x.id === d.eventId && C.occursOn(x, d.date))) evId = d.eventId;
  }
  const entry = {
    ...(old || {}),
    id: old ? old.id : L.uid(),
    date: d.date,
    memo: (d.memo || '').trim(),
    // 全額が立替の支出は、費用を含まないので振替として扱う
    kind: keepKind || (ui.mode === 'expense' && r.adv && !r.own ? 'transfer' : ui.mode),
    lines: r.lines,
    createdAt: old ? old.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  if (!keepKind) {
    if (evId) entry.eventId = evId;
    else delete entry.eventId;
  }
  const err = L.validateEntry(entry, state.accounts);
  if (err) return toast(err);

  const wasEditing = !!old;
  await commit((s) => {
    if (newEv) C.addEvent(s.calendar, newEv);
    if (old) s.entries[s.entries.indexOf(old)] = entry;
    else s.entries.push(entry);
    const last = s.settings.last;
    if (ui.mode === 'expense') last.expenseFrom = d.from;
    if (ui.mode === 'income') last.incomeTo = d.to;
    if (ui.mode === 'transfer') Object.assign(last, { transferFrom: d.from, transferTo: d.to });
    if (ui.mode === 'expense' && r.adv) Object.assign(last, { advMode: d.advMode, people: d.people });
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
  toast((wasEditing ? '変更しました：' : '保存しました：') + linesText(entry.lines) + (newEv ? `（予定「${newEv.title}」を作りました）` : ''));
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
  // 立替を含む支出（借方 費用・立替金／貸方 支払元）は、支出の画面で立替欄を開いた状態にする
  const tp = (l) => acc(l.acc)?.type;
  const advLine = e.kind === 'expense' && dr.length === 2 && cr.length === 1 ? dr.find((l) => tp(l) === 'asset') : null;
  const ownLine = advLine ? dr.find((l) => l !== advLine && tp(l) === 'expense') : null;
  if (advLine && ownLine) {
    ui.mode = 'expense';
    ui.editingId = id;
    // 割り勘の式（支払額×（人数−1）÷人数の切り捨て）に合う人数があれば、割り勘として開く
    const total = cr[0].amount;
    let people = 0;
    for (let n = 2; n <= 30 && !people; n++) if (L.splitAdvance(total, n) === advLine.amount) people = n;
    ui.draft = {
      date: e.date, memo: e.memo || '', eventId: e.eventId || null, newEvent: '', newEventOpen: false, newEventCat: null, amount: String(total), acc: ownLine.acc, from: cr[0].acc,
      advOn: true, advMode: people ? 'split' : 'amount', people: people || 2, adv: String(advLine.amount), advAcc: advLine.acc,
    };
    closeSheet();
    ui.tab = 'input';
    render();
    return;
  }
  ui.mode = mode;
  ui.editingId = id;
  const base = { date: e.date, memo: e.memo || '', ...NO_EVENT, eventId: e.eventId || null };
  if (mode === 'expense') ui.draft = { ...base, amount: String(dr[0].amount), acc: dr[0].acc, from: cr[0].acc, ...advDefaults() };
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

// 履歴の一覧の1行（カレンダーの日の詳細でも使う）
function entryRow(e) {
  const d = describe(e);
  const sign = d.cls === 'out' ? '−' : d.cls === 'in' ? '+' : '';
  return `<li><button type="button" class="entry" data-act="detail" data-id="${e.id}">
      <span class="sw ${d.color ? '' : 'sw-none'}" style="${d.color ? `background:${d.color}` : ''}"></span>
      <span class="entry-main"><span class="entry-title">${esc(d.title)}${e.kind === 'recurring' ? '<span class="badge">自動入力</span>' : ''}</span>
      <span class="entry-sub">${esc([d.sub, e.memo].filter(Boolean).join('　'))}</span></span>
      <span class="entry-amt ${d.cls}">${sign}${yen(Math.abs(d.amount))}</span></button></li>`;
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

const histFiltered = () => !!(ui.hist.q.trim() || ui.hist.acc || ui.hist.src);

// 履歴の一覧（検索・絞り込みの条件があれば、その結果）
function histBody() {
  const h = ui.hist;
  const filtered = histFiltered();
  const allMonths = filtered && h.all;
  const m = ui.histMonth;
  const list = (filtered ? L.filterEntries(state, h) : state.entries)
    .filter((e) => allMonths || L.monthOf(e.date) === m)
    .sort((a, b) => (a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : a.date < b.date ? 1 : -1));
  const sum = filtered
    ? [...L.summarize({ ...state, entries: list }, 'year').values()].reduce(
        (t, x) => ({ incomeTotal: t.incomeTotal + x.incomeTotal, expenseTotal: t.expenseTotal + x.expenseTotal }),
        { incomeTotal: 0, expenseTotal: 0 },
      )
    : L.summarize(state, 'month').get(m) || L.emptySummary();
  let html = '';
  let cur = null;
  for (const e of list) {
    if (e.date !== cur) {
      if (cur) html += '</ul>';
      cur = e.date;
      const year = allMonths && L.yearOf(e.date) !== L.yearOf(today()) ? `${L.yearOf(e.date)}年` : '';
      html += `<h3 class="day">${year}${dateLabel(e.date)}</h3><ul class="entries">`;
    }
    html += entryRow(e);
  }
  if (cur) html += '</ul>';
  if (!list.length) html = `<p class="empty">${filtered ? '条件に合う記録はありません' : 'この月の記録はありません'}</p>`;
  const scope = filtered
    ? `<div class="hscope">
        <div class="seg seg-sm">
          <button type="button" class="${h.all ? 'on' : ''}" data-act="hist-all" data-val="1">すべての月</button>
          <button type="button" class="${h.all ? '' : 'on'}" data-act="hist-all" data-val="0">月ごと</button>
        </div>
        <span class="hcount">${list.length}件</span>
        <button type="button" class="link" data-act="hist-clear">条件を消す</button>
      </div>`
    : '';
  return `${scope}${allMonths ? '' : monthNav(m, 'month', 'hist-nav')}${statRow(sum)}<section class="card list">${html}</section>`;
}

function renderHistBody() {
  const el = $('#hist-body');
  if (el) el.innerHTML = histBody();
}

function viewHistory() {
  const h = ui.hist;
  const nSel = (h.acc ? 1 : 0) + (h.src ? 1 : 0);
  const opts = (types, sel) =>
    '<option value="">すべて</option>' +
    types
      .map(
        (t) =>
          `<optgroup label="${L.TYPE_LABEL[t]}">` +
          state.accounts
            .filter((a) => a.type === t)
            .map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${esc(a.name)}${a.archived ? '（非表示）' : ''}</option>`)
            .join('') +
          '</optgroup>',
      )
      .join('');
  return `<header class="top"><h1>履歴</h1></header>
    <div class="hsearch">
      <input type="search" data-hist="q" value="${esc(h.q)}" placeholder="メモ・科目名・金額で検索" autocomplete="off" enterkeyhint="search" aria-label="検索">
      <button type="button" class="hfilter-btn${h.open || nSel ? ' on' : ''}" data-act="hist-filter" aria-expanded="${h.open}">絞り込み${nSel ? `（${nSel}）` : ''}</button>
    </div>
    ${
      h.open
        ? `<div class="hfilters">
            <label class="field"><span class="field-label">科目（費用・収益）</span><select data-hist="acc">${opts(['expense', 'income'], h.acc)}</select></label>
            <label class="field"><span class="field-label">支払元・入金先（資産・負債）</span><select data-hist="src">${opts(['asset', 'liability'], h.src)}</select></label>
          </div>`
        : ''
    }
    <div id="hist-body">${histBody()}</div>`;
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
    ${linkedEventLine(e)}
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
          const ink = LIGHT_COLORS.includes(colorKey(x.a.id)) ? 'var(--s4-ink)' : '#fff';
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
            ${t === 'expense' ? `<button type="button" class="link" data-act="acc-color" data-id="${a.id}">色</button>` : ''}
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
      <h2>予定の種類</h2>
      <ul class="accs">${C.sortedCats(state.calendar)
        .map(
          (c) => `<li><span><span class="sw" style="background:${catColor(c)}"></span>${esc(c.name)}</span>
          <span class="acc-btns">
            <button type="button" class="link" data-act="cat-color" data-id="${c.id}" data-from="settings">色</button>
            <button type="button" class="link" data-act="cat-rename" data-id="${c.id}" data-from="settings">名前</button>
            ${c.id === C.UNCAT ? '' : `<button type="button" class="link danger-text" data-act="cat-delete" data-id="${c.id}" data-from="settings">削除</button>`}
          </span></li>`,
        )
        .join('')}</ul>
      <button type="button" class="ghost" data-act="cat-add" data-from="settings">種類を追加</button>
      <p class="hint">カレンダーの予定の色に使います。削除した種類の予定は「未分類」になります。並べ替えと、費用の科目との対応は、カレンダーの「種類・取り込み」からできます。</p>
    </section>

    ${DEMO ? '' : `<section class="card">
      <h2>ロック（4桁の番号）</h2>
      ${lock
        ? `<p>オン：アプリを開いたときに番号を聞きます。</p>
          <label class="field inline"><span>ほかのアプリに切り替えてからロックするまで
            <select data-lock="after">${LOCK_AFTER.map(([v, lb]) => `<option value="${v}"${v === lock.after ? ' selected' : ''}>${lb}</option>`).join('')}</select></span></label>
          <div class="btn-row">
            <button type="button" class="ghost" data-act="pin-change">番号を変更</button>
            <button type="button" class="ghost" data-act="pin-off">ロックをやめる</button>
          </div>`
        : `<p>オフ</p><button type="button" class="ghost" data-act="pin-set">番号を設定</button>`}
      <p class="hint">この番号は、この端末でアプリの画面を開くのを止めるためのもので、保存されたデータそのものは暗号化されません。番号はバックアップのファイルには含まれません。番号を忘れた場合は、ロック画面の「忘れた場合」から、データをすべて削除して解除します（バックアップがあれば復元できます）。</p>
    </section>`}

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
  // 共有メニューはタップの直後に呼ぶ必要があるので、ここより前で await しない。
  // パソコン（指で操作しない端末）の共有画面にはファイル保存の項目がないので、ダウンロードにする
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
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
  // カレンダーを付ける前のバックアップ（calendar がない）なら、今の予定を残す
  const hasCal = !!(s.calendar && Array.isArray(s.calendar.events));
  const nEv = state.calendar.events.length;
  const msg = hasCal
    ? `${when}に書き出されたバックアップ（仕訳${s.entries.length}件・予定${s.calendar.events.length}件）で、今のデータ（仕訳${state.entries.length}件・予定${nEv}件）を置き換えます。よろしいですか？`
    : `${when}に書き出されたバックアップ（仕訳${s.entries.length}件）で、今の家計簿のデータ（仕訳${state.entries.length}件）を置き換えます。このバックアップには予定が含まれていないため、今の予定（${nEv}件）はそのまま残します。よろしいですか？`;
  if (!confirm(msg)) return;
  const keepCal = state.calendar;
  state = L.migrate(s);
  if (!hasCal) state.calendar = keepCal;
  C.ensureCalendar(state);
  await save();
  render();
  toast('バックアップから復元しました');
}

// ---------------------------------------------------------------- ロック（4桁の番号）
// 番号は帳簿のデータ（state）とは別のキーに保存し、バックアップのファイルには含めない。
// アプリの画面を開くのを止めるためのもので、端末に保存されたデータそのものは暗号化しない。
const PIN_LEN = 4;
const LOCK_AFTER = [[0, 'すぐ'], [1, '1分'], [5, '5分'], [15, '15分']];
let lock = null; // { salt, hash, after }。after：ほかのアプリに切り替えてからロックするまでの分数
let locked = false;
let hiddenAt = null;
let padCtl = null; // 表示中の番号入力画面の操作（キーを押す・閉じる）

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
async function hashPin(pin, salt) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`))));
}
const checkPin = async (p) => ((await hashPin(p, lock.salt)) === lock.hash ? null : '番号が違います');

async function saveLock(next) {
  await idbSet('lock', next);
  lock = next;
}

// ロック画面を出している間は、後ろの画面を操作・読み上げできないようにする
function cover(on) {
  $('#lock').hidden = !on;
  document.body.classList.toggle('locked', on);
  for (const e of document.querySelectorAll('#view, .tabbar, #banner, #toast')) e.inert = on;
  if (on) {
    closeSheet();
    document.activeElement?.blur();
  }
}

// 番号の入力画面を出す。4桁が入ったら check に渡し、エラー文が返ればやり直し、null なら閉じて番号を返す。
// cancel：「キャンセル」で null を返す。forgot：「忘れた場合」を押したときの処理（true を返したら閉じる）
function askPin({ title, check = async () => null, cancel = false, forgot = null }) {
  return new Promise((resolve) => {
    const el = $('#lock');
    let entered = '';
    let busy = false;
    const left = cancel
      ? '<button type="button" class="key-text" data-key="cancel">キャンセル</button>'
      : forgot
        ? '<button type="button" class="key-text" data-key="forgot">忘れた場合</button>'
        : '<span></span>';
    el.innerHTML = `<div class="lock-box">
      <p class="lock-msg">${esc(title)}</p>
      <div class="lock-dots" aria-hidden="true">${'<span></span>'.repeat(PIN_LEN)}</div>
      <p class="lock-err" role="alert"></p>
      <div class="keypad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-key="${n}">${n}</button>`).join('')}
        ${left}
        <button type="button" data-key="0">0</button>
        <button type="button" class="key-back" data-key="back" aria-label="1文字消す">⌫</button>
      </div></div>`;
    const dots = el.querySelector('.lock-dots');
    const errEl = el.querySelector('.lock-err');
    const update = (err) => {
      dots.querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', i < entered.length));
      errEl.textContent = err;
    };
    const finish = (v) => {
      padCtl = null;
      el.onclick = null;
      cover(false);
      resolve(v);
    };
    const press = async (k) => {
      if (busy) return;
      if (k === 'cancel') return cancel && finish(null);
      if (k === 'forgot') {
        if (forgot && (await forgot())) finish(null);
        return;
      }
      if (k === 'back') entered = entered.slice(0, -1);
      else if (entered.length < PIN_LEN) entered += k;
      update('');
      if (entered.length < PIN_LEN) return;
      busy = true;
      await new Promise((r) => setTimeout(r, 120)); // 4つ目の丸が埋まったのを見せてから判定する
      const err = await check(entered);
      busy = false;
      if (err == null) return finish(entered);
      entered = '';
      update(err);
      dots.classList.remove('shake');
      void dots.offsetWidth; // 揺れのアニメーションを最初からやり直す
      dots.classList.add('shake');
    };
    el.onclick = (ev) => {
      const b = ev.target.closest('[data-key]');
      if (b) press(b.dataset.key);
    };
    padCtl = { press, close: () => finish(null) };
    cover(true);
  });
}

async function lockNow() {
  if (!lock || locked) return;
  locked = true;
  padCtl?.close(); // 番号の設定・変更の途中なら、それをやめてからロックする
  await askPin({ title: '番号を入力', check: checkPin, forgot: forgotPin });
  locked = false;
}

async function setPin(doneMsg = '番号を設定しました') {
  if (!storageOk) return toast('データの保存場所を開けないため、番号を設定できません');
  if (!window.crypto?.subtle) return toast('このページではロックを使えません（https のアドレスで開いてください）');
  const p1 = await askPin({ title: '新しい番号（4桁）を入力', cancel: true });
  if (!p1) return;
  const p2 = await askPin({ title: '確認のため、もう一度入力', cancel: true, check: async (p) => (p === p1 ? null : '1回目の番号と違います') });
  if (!p2) return;
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  try {
    await saveLock({ salt, hash: await hashPin(p1, salt), after: lock ? lock.after : 1 });
  } catch (e) {
    return toast('番号を保存できませんでした：' + e.message);
  }
  render();
  toast(doneMsg);
}

// 番号を忘れたとき：番号を通さずに開く方法を作らないため、データをすべて削除して解除する
async function forgotPin() {
  if (!confirm('番号を解除するには、この端末の家計簿のデータ（仕訳・科目・設定・予定）をすべて削除します。バックアップのファイルがあれば、削除のあと設定画面の「ファイルから復元」で戻せます。削除しますか？')) return false;
  if (!confirm('本当に削除しますか？この操作は取り消せません。')) return false;
  state = C.ensureCalendar(L.defaultState());
  ui.editingId = null;
  ui.draft = newDraft(ui.mode);
  ui.tab = 'settings';
  await save();
  try {
    await saveLock(null);
  } catch {
    lock = null;
  }
  render();
  toast('データと番号を削除しました。バックアップがあれば「ファイルから復元」で戻せます');
  return true;
}

// ---------------------------------------------------------------- カレンダー
const MONTH_LANES = 3; // 月表示のマスに出す段の数
const catOf = (ev) => state.calendar.cats.find((c) => c.id === ev.cat) || state.calendar.cats.find((c) => c.id === C.UNCAT);
const catColor = (cat) => `var(--${cat.color})`;
const catInk = (cat) => (LIGHT_COLORS.includes(cat.color) || cat.color === 's-other' ? 'var(--s4-ink)' : '#fff');
// 予定名。先頭の時間の部分を太字にする
const titleHtml = (title) => {
  const [t, rest] = C.splitTitle(title);
  return (t ? `<b>${esc(t)}</b>` : '') + esc(rest);
};
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const dayKind = (d) => (C.holidayName(d) || C.weekday(d) === 0 ? 'sun' : C.weekday(d) === 6 ? 'sat' : '');

// 予定ごとの、つながっている記録の金額（予定のid → { expense, income, n }）
function eventSums() {
  const m = new Map();
  for (const e of state.entries) {
    if (!e.eventId) continue;
    const a = C.entryAmounts(e, state.accounts);
    const x = m.get(e.eventId) || { expense: 0, income: 0, n: 0 };
    m.set(e.eventId, { expense: x.expense + a.expense, income: x.income + a.income, n: x.n + 1 });
  }
  return m;
}

// 予定の1行（週表示・日の詳細・検索で使う）。
// 左の線：一日の予定は種類の色で塗り、一日の一部の予定（開始時刻がある）は薄い色に枠
function eventRow(ev, sums, { back = '', withDate = false } = {}) {
  const cat = catOf(ev);
  const s = sums.get(ev.id);
  const timed = C.isTimed(ev);
  const period = C.isMultiDay(ev) ? `${md(ev.date)}〜${md(ev.end)}` : '';
  const when = withDate ? `${L.yearOf(ev.date)}年${dateLabel(ev.date)}` : '';
  // 時刻：TimeTreeから取り込んだ時刻はここに出す（予定名の先頭の時間は、予定名の中で太字になる）
  const clock = !timed ? (period ? '' : '終日') : ev.time ? C.timeLabel(ev.time) : '';
  const sub = [when, clock, cat.name, period, (ev.memo || '').split('\n')[0]].filter(Boolean).join('　');
  const amt = s && (s.expense || s.income) ? `<span class="entry-amt ${s.expense ? '' : 'in'}">${s.expense ? '−' + yen(s.expense) : '+' + yen(s.income)}</span>` : '';
  return `<li><button type="button" class="entry cev" data-act="cal-edit" data-id="${ev.id}" data-back="${back}">
    <span class="cev-bar${timed ? ' part' : ''}" style="--c:${catColor(cat)}"></span>
    <span class="entry-main"><span class="entry-title">${titleHtml(ev.title)}</span><span class="entry-sub">${esc(sub)}</span></span>${amt}</button></li>`;
}

function viewCalendar() {
  return `<header class="top"><h1>カレンダー</h1><button type="button" class="link" data-act="cal-manage">種類・取り込み</button></header>
    <div class="hsearch">
      <input type="search" data-cal="q" value="${esc(ui.cal.q)}" placeholder="予定名・メモで検索" autocomplete="off" enterkeyhint="search" aria-label="予定を検索">
    </div>
    <div id="cal-body">${calBody()}</div>`;
}

function renderCalBody() {
  const el = $('#cal-body');
  if (el) {
    el.innerHTML = calBody();
    bindCalendar(false);
  }
}

const MONTH_CHUNK = 6; // 端に近づいたときに足す月の数

// 月表示で並べる月の範囲。見ている月が範囲の外なら、その前後6か月にする
function monthRange() {
  const c = ui.cal;
  if (!c.range || c.month < c.range.from || c.month > c.range.to) {
    c.range = { from: L.addMonths(c.month, -MONTH_CHUNK), to: L.addMonths(c.month, MONTH_CHUNK) };
    c.scrollTop = null;
  }
  const out = [];
  for (let m = c.range.from; m <= c.range.to; m = L.addMonths(m, 1)) out.push(m);
  return out;
}

function calBody() {
  const c = ui.cal;
  if (c.q.trim()) {
    const list = C.searchEvents(state.calendar, c.q);
    const sums = eventSums();
    return `<div class="hscope"><span class="hcount">${list.length}件（新しい順）</span><button type="button" class="link" data-act="cal-clear">検索をやめる</button></div>
      <section class="card list">${list.length ? `<ul class="entries">${list.map((ev) => eventRow(ev, sums, { withDate: true })).join('')}</ul>` : '<p class="empty">見つかりませんでした</p>'}</section>`;
  }
  const month = c.view === 'month';
  const seg = `<div class="seg seg-sm cal-seg">
      <button type="button" class="${month ? 'on' : ''}" data-act="cal-view" data-val="month">月</button>
      <button type="button" class="${month ? '' : 'on'}" data-act="cal-view" data-val="week">週</button>
    </div>`;
  if (!month) {
    return `<div class="cal-bar">${seg}<span class="cal-label"></span><button type="button" class="chip" data-act="cal-today">今日</button></div>
      <div class="pnav">
        <button type="button" class="icon-btn" data-act="cal-nav" data-val="-1" aria-label="前の週">‹</button>
        <div class="pnav-label">${weekLabel(c.week)}</div>
        <button type="button" class="icon-btn" data-act="cal-nav" data-val="1" aria-label="次の週">›</button>
      </div>
      ${weekList(c.week)}`;
  }
  return `<div class="cal-bar">${seg}<span class="cal-label" id="mlabel">${monthLabel(c.month)}</span><button type="button" class="chip" data-act="cal-today">今日</button></div>
    <div class="mhead">${[...'日月火水木金土'].map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="mlist" id="mlist">${monthRange().map(monthBlock).join('')}</div>`;
}

function weekLabel(ws) {
  const we = C.addDays(ws, 6);
  const m1 = Number(ws.slice(5, 7)), m2 = Number(we.slice(5, 7));
  const y = L.yearOf(ws) !== L.yearOf(today()) ? `${L.yearOf(ws)}年` : '';
  return `${y}${m1}月${Number(ws.slice(8))}日〜${m1 === m2 ? '' : m2 + '月'}${Number(we.slice(8))}日`;
}

// 月表示の1か月分。その月の日だけマスを出し、予定は種類の色の帯で、入りきらない分は「+2」のように数で出す
function monthBlock(ym) {
  const t = today();
  const last = L.lastDayOf(ym);
  let html = `<section class="mblock" data-ym="${ym}"><h3 class="mtitle${L.monthOf(t) === ym ? ' now' : ''}">${monthLabel(ym)}</h3><div class="mgrid">`;
  for (let ws = C.startOfWeek(`${ym}-01`); ws <= last; ws = C.addDays(ws, 7)) {
    const inMonth = (c) => L.monthOf(C.addDays(ws, c)) === ym;
    const items = C.layoutWeek(state.calendar, ws);
    // その日に、段に入りきらない予定があるか
    const more = Array.from({ length: 7 }, (_, c) => inMonth(c) && items.some((x) => x.lane >= MONTH_LANES && x.col <= c && c < x.col + x.span));
    const shown = (x, c) => inMonth(c) && (x.lane < MONTH_LANES - 1 || (x.lane === MONTH_LANES - 1 && !more[c]));
    html += '<div class="mweek">';
    for (let c = 0; c < 7; c++) {
      const d = C.addDays(ws, c);
      if (!inMonth(c)) {
        html += `<span class="mday blank" style="grid-column:${c + 1}"></span>`;
        continue;
      }
      const hol = C.holidayName(d);
      const cls = ['mday', d === t ? 'today' : '', dayKind(d)].filter(Boolean).join(' ');
      html += `<button type="button" class="${cls}" style="grid-column:${c + 1}" data-act="cal-day" data-date="${d}" aria-label="${dateLabel(d)}${hol ? ' ' + hol : ''}"${hol ? ` title="${esc(hol)}"` : ''}><span class="mnum">${Number(d.slice(8))}</span></button>`;
    }
    for (const x of items) {
      // 段に入る日だけを、続いた区間ごとの帯にする
      let c = x.col;
      while (c < x.col + x.span) {
        if (!shown(x, c)) {
          c++;
          continue;
        }
        let e = c;
        while (e + 1 < x.col + x.span && shown(x, e + 1)) e++;
        const cat = catOf(x.ev);
        const cont = C.addDays(ws, c) > x.ev.date; // 前の日から続いている
        // 一日の予定は種類の色で塗って白い文字、一日の一部の予定（開始時刻がある）は薄い色に種類の色の文字
        const part = C.isTimed(x.ev);
        const look = part ? `--c:${catColor(cat)}` : `background:${catColor(cat)};color:${catInk(cat)}`;
        html += `<span class="mbar${cont ? ' cont' : ''}${part ? ' part' : ''}" style="grid-column:${c + 1} / span ${e - c + 1};grid-row:${x.lane + 2};${look}">${titleHtml(x.ev.title)}</span>`;
        c = e + 1;
      }
    }
    for (let c = 0; c < 7; c++) {
      if (!more[c]) continue;
      const n = items.filter((x) => x.col <= c && c < x.col + x.span && !shown(x, c)).length;
      html += `<span class="mmore" style="grid-column:${c + 1};grid-row:${MONTH_LANES + 1}">+${n}</span>`;
    }
    html += '</div>';
  }
  return html + '</div></section>';
}

// 週表示：7日分を縦に並べる
function weekList(ws) {
  const sums = eventSums();
  const t = today();
  let html = '<section class="card list wk">';
  for (let i = 0; i < 7; i++) {
    const d = C.addDays(ws, i);
    const hol = C.holidayName(d);
    const evs = C.eventsOn(state.calendar, d);
    html += `<div class="wday${d === t ? ' today' : ''}">
      <div class="wday-head">
        <button type="button" class="wday-date ${dayKind(d)}" data-act="cal-day" data-date="${d}">${dateLabel(d)}${hol ? `<span class="hol">${esc(hol)}</span>` : ''}</button>
        <button type="button" class="link" data-act="cal-add" data-date="${d}" aria-label="${dateLabel(d)}に予定を追加">＋</button>
      </div>
      ${evs.length ? `<ul class="entries">${evs.map((ev) => eventRow(ev, sums)).join('')}</ul>` : ''}
    </div>`;
  }
  return html + '</section>';
}

// 月表示：月を縦に並べた欄の中でスクロールする。上下の端に近づいたら、前後の月を足す。
// entered：ほかの画面からカレンダーに来たとき（見ている月の先頭までスクロールする）
function bindCalendar(entered) {
  const list = $('#mlist');
  document.body.classList.toggle('cal-fixed', !!list);
  if (!list) return;
  sizeMonthList();
  const c = ui.cal;
  if (entered || c.scrollTo || c.scrollTop == null) scrollToMonth(c.scrollTo || c.month);
  else list.scrollTop = c.scrollTop;
  c.scrollTo = null;
  let ticking = false;
  list.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      onMonthScroll(list);
    });
  }, { passive: true });
}

// 欄の高さ：画面の下のタブの上まで
function sizeMonthList() {
  const list = $('#mlist');
  if (!list) return;
  const bottom = $('.tabbar').getBoundingClientRect().top;
  list.style.height = Math.max(240, bottom - list.getBoundingClientRect().top) + 'px';
}

function scrollToMonth(ym) {
  const list = $('#mlist');
  const el = list && list.querySelector(`.mblock[data-ym="${ym}"]`);
  if (!el) return;
  list.scrollTop = el.offsetTop;
  ui.cal.scrollTop = list.scrollTop;
}

function onMonthScroll(list) {
  const c = ui.cal;
  // 上下の端に近づいたら月を足す。上に足したときは、見ている位置がずれないように戻す
  const near = list.clientHeight;
  if (list.scrollTop < near) {
    const from = L.addMonths(c.range.from, -MONTH_CHUNK);
    const months = [];
    for (let m = from; m < c.range.from; m = L.addMonths(m, 1)) months.push(m);
    const h = list.scrollHeight;
    list.insertAdjacentHTML('afterbegin', months.map(monthBlock).join(''));
    list.scrollTop += list.scrollHeight - h;
    c.range.from = from;
  } else if (list.scrollTop + list.clientHeight > list.scrollHeight - near) {
    const to = L.addMonths(c.range.to, MONTH_CHUNK);
    const months = [];
    for (let m = L.addMonths(c.range.to, 1); m <= to; m = L.addMonths(m, 1)) months.push(m);
    list.insertAdjacentHTML('beforeend', months.map(monthBlock).join(''));
    c.range.to = to;
  }
  c.scrollTop = list.scrollTop;
  // いちばん上に見えている月を、上の見出しに出す
  let cur = null;
  for (const b of list.children) {
    if (b.offsetTop <= list.scrollTop + 40) cur = b;
    else break;
  }
  if (cur && cur.dataset.ym !== c.month) {
    c.month = cur.dataset.ym;
    const lb = $('#mlabel');
    if (lb) lb.textContent = monthLabel(c.month);
  }
}

// 日の詳細：その日の予定と、家計簿の記録・支出の合計
function daySheet(d) {
  const hol = C.holidayName(d);
  const sums = eventSums();
  const evs = C.eventsOn(state.calendar, d);
  const entries = state.entries.filter((e) => e.date === d).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const total = C.sumAmounts(entries, state.accounts);
  openSheet(`
    <h2>${L.yearOf(d) !== L.yearOf(today()) ? L.yearOf(d) + '年' : ''}${dateLabel(d)}${hol ? `<span class="hol">${esc(hol)}</span>` : ''}</h2>
    <h3 class="day">予定</h3>
    ${evs.length ? `<ul class="entries">${evs.map((ev) => eventRow(ev, sums, { back: d })).join('')}</ul>` : '<p class="empty">予定はありません</p>'}
    <button type="button" class="ghost" data-act="cal-add" data-date="${d}" data-back="${d}">＋ 予定を追加</button>
    <h3 class="day day-sum"><span>家計簿</span>${total.expense ? `<span>支出 ${yen(total.expense)}</span>` : ''}</h3>
    ${entries.length ? `<ul class="entries">${entries.map(entryRow).join('')}</ul>` : '<p class="empty">記録はありません</p>'}
    <div class="sheet-actions"><button type="button" class="ghost" data-act="close-sheet">閉じる</button></div>`);
  $('#sheet-body').scrollTop = 0;
}

// 予定の追加・編集。back：閉じたあとに戻る日の詳細の日付
// draft：種類を追加して戻ってきたときの、入力途中の値
function eventForm(ev, { date = today(), back = '', draft = null } = {}) {
  const isNew = !ev;
  const cal = state.calendar;
  const e = { ...(ev || { title: '', date, end: null, cat: C.UNCAT, memo: '' }), ...(draft || {}) };
  const cats = C.sortedCats(cal);
  // 一日の予定か、一日の一部の予定か。自分で選んでいなければ（spanTouched）、予定名の時間に合わせて変える
  const autoPart = (title) => C.autoTimed({ ...e, title });
  const part = draft && 'part' in draft ? draft.part : C.isTimed(e);
  let spanTouched = draft && 'spanTouched' in draft ? draft.spanTouched : typeof e.allDay === 'boolean';
  let linked = '';
  if (!isNew) {
    const list = C.linkedEntries(state, ev.id);
    const sum = C.sumAmounts(list, state.accounts);
    const parts = [sum.expense ? `支出 ${yen(sum.expense)}` : '', sum.income ? `収入 ${yen(sum.income)}` : ''].filter(Boolean).join('・');
    linked = `<h3 class="day day-sum"><span>つながっている家計簿の記録</span>${parts ? `<span>${parts}</span>` : ''}</h3>
      ${list.length ? `<ul class="entries">${list.map((x) => entryRow(x).replace('<span class="entry-sub">', `<span class="entry-sub">${md(x.date)}　`)).join('')}</ul>` : '<p class="hint">ありません。入力画面の「予定」でこの予定を選ぶと、ここに出ます。</p>'}`;
  }
  const src = ev?.src === 'timetree' ? `<p class="hint">TimeTreeから取り込んだ予定です（${ev.time ? `時刻 ${C.timeLabel(ev.time)}` : '終日'}）。</p>` : '';
  let rep = '';
  if (!isNew) {
    const list = C.seriesOf(cal, ev);
    const after = list.filter((x) => x.date >= ev.date).length;
    if (list.length > 1) rep = `<p class="hint">繰り返しの予定です（全${list.length}件のうち、この日以降${after}件）。削除するときに、この予定だけ・この日以降・すべてを選べます。</p>`;
  }
  openSheet(`
    <h2>${isNew ? '予定の追加' : '予定の編集'}</h2>
    <form id="ev-form">
      <label class="field"><span class="field-label">予定名</span><input name="title" value="${esc(e.title)}" autocomplete="off" placeholder="例：13-面接　1930-22 飲み会"></label>
      <input type="hidden" name="part" value="${part ? '1' : ''}">
      <div class="seg seg-sm ev-span" id="ev-span" role="radiogroup" aria-label="一日の予定か、一日の一部の予定か">
        <button type="button" role="radio" data-part="" aria-checked="${!part}" class="${part ? '' : 'on'}">一日の予定</button>
        <button type="button" role="radio" data-part="1" aria-checked="${part}" class="${part ? 'on' : ''}">一日の一部の予定</button>
      </div>
      <p class="hint" id="ev-span-note"></p>
      <input type="hidden" name="cat" value="${e.cat}">
      <span class="field-label">種類</span>
      <div class="chips" id="ev-cats">${cats.map((c) => `<button type="button" class="chip${c.id === e.cat ? ' on' : ''}" data-cat="${c.id}"><span class="sw" style="background:${catColor(c)}"></span>${esc(c.name)}</button>`).join('')}<button type="button" class="chip chip-add" id="ev-cat-add">＋ 追加</button></div>
      <div class="row2">
        <label class="field"><span class="field-label">日付</span><input type="date" name="date" value="${e.date}" required></label>
        <label class="field"><span class="field-label">終了日（任意）</span><input type="date" name="end" value="${e.end || ''}"></label>
      </div>
      <label class="field"><span class="field-label">メモ</span><textarea name="memo" rows="3" placeholder="任意">${esc(e.memo)}</textarea></label>
      ${isNew ? `<div class="row2">
        <label class="field"><span class="field-label">繰り返し</span><select name="rep">${['', 'weekly', 'monthly', 'bizday'].map((v) => `<option value="${v}"${v === (e.rep || '') ? ' selected' : ''}>${repLabel(v, e.date)}</option>`).join('')}</select></label>
        <label class="field" id="ev-count"${e.rep ? '' : ' hidden'}><span class="field-label">回数</span><input name="count" type="number" inputmode="numeric" min="1" max="${C.MAX_REPEAT}" value="${esc(e.count || 4)}"></label>
      </div>
      <label class="field inline" id="ev-biz"${e.rep === 'bizday' ? '' : ' hidden'}><span>毎月の第<input name="bizN" type="number" inputmode="numeric" min="1" max="23" value="${esc(e.bizN || C.businessDayIndex(e.date) || 1)}" aria-label="第何営業日">営業日（土日・祝日を除いて数える）</span></label>
      <p class="hint" id="ev-rep-note"${e.rep ? '' : ' hidden'}></p>` : ''}
      ${rep}${src}${linked}
      <div class="sheet-actions">
        ${isNew ? '' : `<button type="button" class="danger" data-act="cal-delete" data-id="${ev.id}" data-back="${back}">削除</button>`}
        <button type="button" class="ghost" data-act="cal-back" data-back="${back}">閉じる</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>`);
  $('#sheet-body').scrollTop = 0;
  const form = $('#ev-form');
  const f = form.elements;
  // 種類の「＋ 追加」：入力途中の値をとっておき、追加したらその種類を選んだ状態で開き直す
  $('#ev-cat-add').addEventListener('click', () => {
    const vals = { title: f.title.value, cat: f.cat.value, date: f.date.value, end: f.end.value || null, memo: f.memo.value, part: !!f.part.value, spanTouched };
    if (isNew) Object.assign(vals, { rep: f.rep.value, count: f.count.value, bizN: f.bizN.value });
    catAddSheet({
      onDone: (c) => eventForm(ev, { back, draft: { ...vals, cat: c.id } }),
      onCancel: () => eventForm(ev, { back, draft: vals }),
    });
  });
  $('#ev-cats').addEventListener('click', (x) => {
    const b = x.target.closest('[data-cat]');
    if (!b) return;
    f.cat.value = b.dataset.cat;
    form.querySelectorAll('#ev-cats .chip').forEach((c) => c.classList.toggle('on', c === b));
  });
  // 一日の予定・一日の一部の予定
  const setSpan = (p) => {
    f.part.value = p ? '1' : '';
    form.querySelectorAll('#ev-span button').forEach((b) => {
      const on = !!b.dataset.part === p;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    $('#ev-span-note').textContent =
      (p ? 'カレンダーでは種類の色を薄くした帯で出します。' : 'カレンダーでは種類の色で塗った帯で出します。') +
      (spanTouched ? '' : '予定名の先頭に「13-」「1930-22」のように時間を書くと「一日の一部の予定」に変わり、その日の中で時刻の順に入ります。');
  };
  $('#ev-span').addEventListener('click', (x) => {
    const b = x.target.closest('[data-part]');
    if (!b) return;
    spanTouched = true;
    setSpan(!!b.dataset.part);
  });
  f.title.addEventListener('input', () => setSpan(spanTouched ? !!f.part.value : autoPart(f.title.value.trim())));
  setSpan(part);
  // 繰り返し：選んだ日付に合わせて選択肢の名前を変え、作られる日付の最初の数回を出す
  const repDates = () => C.repeatDates(f.date.value, f.rep.value, Number(f.count.value) || 1, Number(f.bizN.value));
  let bizTouched = !!e.bizN; // 第何営業日を自分で変えていなければ、日付に合わせる
  const updateRep = () => {
    if (!f.rep) return;
    const v = f.rep.value;
    if (C.isDate(f.date.value)) {
      [...f.rep.options].forEach((o) => (o.textContent = repLabel(o.value, f.date.value)));
      if (!bizTouched) f.bizN.value = C.businessDayIndex(f.date.value) || 1;
    }
    $('#ev-count').hidden = !v;
    $('#ev-biz').hidden = v !== 'bizday';
    const note = $('#ev-rep-note');
    note.hidden = !v;
    if (!v || !C.isDate(f.date.value)) return;
    const ds = repDates();
    const shown = ds.slice(0, 3).map((x) => `${L.yearOf(x) !== L.yearOf(f.date.value) ? L.yearOf(x) + '年' : ''}${dateLabel(x)}`).join('、');
    note.textContent = ds.length
      ? `${shown}${ds.length > 3 ? ` …（全${ds.length}件）` : ''}。${v === 'bizday' ? '日付より前の回は作りません。' : ''}作ったあとは、1件ずつの予定になります。`
      : 'この条件に当たる日がありません。';
  };
  f.rep?.addEventListener('change', updateRep);
  f.date.addEventListener('input', updateRep);
  f.count?.addEventListener('input', updateRep);
  f.bizN?.addEventListener('input', () => {
    bizTouched = true;
    updateRep();
  });
  updateRep();
  form.addEventListener('submit', async (x) => {
    x.preventDefault();
    const title = f.title.value.trim();
    const d = f.date.value;
    const end = f.end.value || null;
    if (!title) return toast('予定名を入力してください');
    if (!C.isDate(d)) return toast('日付を入力してください');
    if (end && end < d) return toast('終了日が日付より前になっています');
    if (isNew && f.rep.value && !repDates().length) return toast('繰り返しの条件に当たる日がありません');
    const data = { title, cat: f.cat.value, memo: f.memo.value.trim() };
    const part = !!f.part.value;
    let msg = '保存しました';
    await commit((s) => {
      const c = s.calendar;
      if (isNew) {
        const span = end ? C.diffDays(d, end) : 0;
        const dates = f.rep.value ? repDates() : [d];
        if (!dates.length) return;
        const series = dates.length > 1 ? L.uid() : null; // 繰り返しで作った予定のまとまり（削除で「この日以降」「すべて」を選べる）
        for (const day of dates) {
          const x = C.newEvent({ ...data, date: day, end: span ? C.addDays(day, span) : null, series });
          C.setTimed(x, part);
          C.addEvent(c, x);
        }
        if (dates.length > 1) msg = `予定を${dates.length}件作りました`;
      } else {
        const moved = ev.date !== d || C.lastDay(ev) !== (end && end > d ? end : d);
        Object.assign(ev, data, { date: d, end: end && end > d ? end : null });
        C.setTimed(ev, part);
        if (moved) C.placeEvent(c, ev); // 日付を変えたら、新しい日の並び順に入れる
      }
    });
    calBack(back);
    toast(msg);
  });
  if (isNew) f.title.focus();
}

// 繰り返しの選択肢の名前（選んだ日付に合わせる）
function repLabel(v, d) {
  if (!v) return 'しない';
  if (!C.isDate(d)) return { weekly: '毎週', monthly: '毎月', bizday: '毎月の営業日' }[v];
  if (v === 'weekly') return `毎週${'日月火水木金土'[C.weekday(d)]}曜日`;
  if (v === 'monthly') return `毎月${Number(d.slice(8))}日`;
  return '毎月の営業日';
}

function calBack(back) {
  if (back) daySheet(back);
  else closeSheet();
}

// 繰り返しの予定を削除する範囲を選ぶ
function seriesDeleteSheet(ev, back) {
  const cal = state.calendar;
  const all = C.seriesOf(cal, ev);
  const after = C.seriesTargets(cal, ev, 'after');
  const ids = new Set(all.map((x) => x.id));
  const linked = state.entries.some((e) => ids.has(e.eventId));
  const btn = (scope, label) => `<button type="button" class="danger" data-act="cal-delete-series" data-scope="${scope}" data-id="${ev.id}" data-back="${back}">${label}</button>`;
  openSheet(`
    <h2>繰り返しの予定の削除</h2>
    <p>「${titleHtml(ev.title)}」は繰り返しの予定です（全${all.length}件）。${md(ev.date)}の予定を開いています。</p>
    <div class="del-scope">
      ${btn('one', 'この予定だけ')}
      ${after.length > 1 && after.length < all.length ? btn('after', `この日以降（${after.length}件）`) : ''}
      ${btn('all', `すべて（${all.length}件）`)}
    </div>
    ${linked ? '<p class="hint">つながっている家計簿の記録は消えず、つながりだけ外れます。</p>' : ''}
    <div class="sheet-actions"><button type="button" class="ghost" data-act="cal-edit" data-id="${ev.id}" data-back="${back}">戻る</button></div>`);
  $('#sheet-body').scrollTop = 0;
}

// 種類の管理・科目との対応・TimeTreeの取り込み
function calManageSheet() {
  const cal = state.calendar;
  const cats = C.sortedCats(cal);
  const opts = (sel) => `<option value="">（なし）</option>` + cats.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const exps = state.accounts.filter((a) => a.type === 'expense' && (!a.archived || cal.accCat[a.id]));
  const imports = [...cal.imports].sort((a, b) => b.at - a.at);
  openSheet(`
    <h2>予定の種類</h2>
    <ul class="accs">${cats
      .map(
        (c, i) => `<li><span><span class="sw" style="background:${catColor(c)}"></span>${esc(c.name)}</span>
        <span class="acc-btns">
          <button type="button" class="link" data-act="cat-move" data-id="${c.id}" data-val="-1" aria-label="上へ"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="link" data-act="cat-move" data-id="${c.id}" data-val="1" aria-label="下へ"${i === cats.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="link" data-act="cat-color" data-id="${c.id}">色</button>
          <button type="button" class="link" data-act="cat-rename" data-id="${c.id}">名前</button>
          ${c.id === C.UNCAT ? '' : `<button type="button" class="link danger-text" data-act="cat-delete" data-id="${c.id}">削除</button>`}
        </span></li>`,
      )
      .join('')}</ul>
    <button type="button" class="ghost" data-act="cat-add">種類を追加</button>
    <p class="hint">削除した種類の予定は「未分類」になります。</p>

    <h2 class="sheet-h2">費用の科目と種類</h2>
    <p class="hint">入力画面の「＋ 新しい予定」で作った予定の種類を、支出の科目で決めます。収入・振替のときや、対応がないときは「未分類」。</p>
    <table class="cat"><tbody>${exps
      .map((a) => `<tr><td><span class="sw" style="background:${expenseColor(a.id)}"></span>${esc(a.name)}</td><td><select class="acccat" data-acccat="${a.id}" aria-label="${esc(a.name)}の予定の種類">${opts(cal.accCat[a.id])}</select></td></tr>`)
      .join('')}</tbody></table>

    <h2 class="sheet-h2">TimeTreeから取り込む</h2>
    <p class="hint">timetree-exporter で書き出した .ics ファイルを選びます。同じファイルを2回読んでも、同じ予定は重複しません。</p>
    <button type="button" class="ghost" data-act="ics-pick">.ics ファイルを選ぶ</button>
    <input type="file" id="ics-file" accept=".ics,text/calendar" hidden>
    ${imports.length ? `<h3 class="day">取り込んだファイル</h3><ul class="accs">${imports
      .map((x) => `<li><span>${esc(x.name)}　<span class="muted">${new Date(x.at).toLocaleDateString('ja-JP')}・${x.count}件</span></span>
        <span class="acc-btns"><button type="button" class="link danger-text" data-act="ics-undo" data-id="${x.id}">まとめて削除</button></span></li>`)
      .join('')}</ul>` : ''}
    <div class="sheet-actions"><button type="button" class="ghost" data-act="close-sheet">閉じる</button></div>`);
}

async function readIcsFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    return toast('ファイルを読み込めませんでした：' + e.message);
  }
  if (!/BEGIN:VEVENT/.test(text)) return toast('予定が見つかりませんでした（.ics のファイルを選んでください）');
  const items = C.parseICS(text, { until: C.addDays(today(), 365) }); // 繰り返しは取り込む日の1年後まで
  importSheet(file.name, items);
}

// 取り込みの確認：件数と期間、ラベル→種類、名前で決める決まり
function importSheet(name, items) {
  const cal = state.calendar;
  const plan = C.planImport(cal, items);
  const labelMap = C.defaultLabelMap(cal, plan.fresh);
  const keys = Object.keys(labelMap);
  const cats = C.sortedCats(cal);
  const catOpts = (sel, none) => (none ? `<option value="">${none}</option>` : '') + cats.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const fmt = (d) => `${L.yearOf(d)}年${md(d)}`;
  const draw = () => {
    const counts = new Map();
    for (const it of plan.fresh) {
      const c = C.catForImport(cal, it, labelMap);
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    $('#imp-preview').textContent = plan.fresh.length
      ? '種類ごとの件数：' + cats.filter((c) => counts.get(c.id)).map((c) => `${c.name} ${counts.get(c.id)}`).join('・')
      : '';
    $('#imp-rules').innerHTML = cal.rules.length
      ? cal.rules.map((r, i) => `<li><span>名前に「${esc(r.text)}」→ ${esc(cal.cats.find((c) => c.id === r.cat)?.name || '')}</span><span class="acc-btns"><button type="button" class="link danger-text" data-rule-del="${i}">削除</button></span></li>`).join('')
      : '<li><span class="muted">決まりはありません</span></li>';
  };
  openSheet(`
    <h2>TimeTreeから取り込む</h2>
    <p>${esc(name)}</p>
    <p>${plan.fresh.length ? `予定 <b>${plan.fresh.length}件</b>（${fmt(plan.from)}〜${fmt(plan.to)}）を取り込みます。` : '新しく取り込む予定はありません。'}${plan.dup ? `すでに取り込んだ${plan.dup}件は除きます。` : ''}</p>
    <p class="hint">繰り返しの予定は、今日から1年後までを1件ずつの予定にします。時刻は予定名に付けず、その日の中の並び順にだけ使います。</p>
    ${keys.length ? `<h3 class="day">ラベル → 種類</h3><table class="cat"><tbody>${keys
      .map((k) => `<tr><td>${/^#[0-9a-f]{6}/i.test(k) ? `<span class="sw" style="background:${esc(k.slice(0, 7))}"></span>色 ${esc(k)}` : esc(k)}</td><td><select class="acccat" data-label="${esc(k)}">${catOpts(labelMap[k], '名前で決める')}</select></td></tr>`)
      .join('')}</tbody></table>` : ''}
    <h3 class="day">名前で決める（ラベルで決まらない予定）</h3>
    <ul class="accs" id="imp-rules"></ul>
    <div class="row2 add-rule"><input id="rule-text" placeholder="名前に含む文字（例：バイト）" autocomplete="off"><select id="rule-cat">${catOpts(cats[0]?.id)}</select></div>
    <button type="button" class="ghost" id="rule-add">決まりを追加</button>
    <p class="hint">どれにも当たらない予定は「未分類」になります。</p>
    <p class="preview" id="imp-preview"></p>
    <div class="sheet-actions">
      <button type="button" class="ghost" data-act="cal-manage">戻る</button>
      <button type="button" class="primary" id="imp-go"${plan.fresh.length ? '' : ' disabled'}>取り込む</button>
    </div>`);
  const body = $('#sheet-body');
  body.scrollTop = 0;
  body.querySelectorAll('[data-label]').forEach((s) => s.addEventListener('change', () => {
    labelMap[s.dataset.label] = s.value;
    draw();
  }));
  $('#imp-rules').addEventListener('click', async (x) => {
    const b = x.target.closest('[data-rule-del]');
    if (!b) return;
    await commit((s) => s.calendar.rules.splice(Number(b.dataset.ruleDel), 1));
    draw();
  });
  $('#rule-add').addEventListener('click', async () => {
    const text = $('#rule-text').value.trim();
    if (!text) return toast('名前に含む文字を入力してください');
    await commit((s) => s.calendar.rules.push({ text, cat: $('#rule-cat').value }));
    $('#rule-text').value = '';
    draw();
  });
  $('#imp-go').addEventListener('click', async () => {
    let rec;
    await commit((s) => (rec = C.applyImport(s.calendar, plan.fresh, { name, labelMap })));
    calManageSheet();
    toast(`${rec.count}件の予定を取り込みました`);
  });
  draw();
}

// 種類を追加する。問題があればその内容を、なければ追加した種類を返す。「未分類」はいちばん下のままにする
async function addCat(name, color) {
  name = (name || '').trim();
  if (!name) return { error: '種類の名前を入力してください' };
  if (state.calendar.cats.some((c) => c.name === name)) return { error: '同じ名前の種類があります' };
  const cat = { id: L.uid(), name, color: PALETTE.includes(color) ? color : unusedCatColor(), order: 0 };
  await commit((s) => {
    const c = s.calendar;
    const order = Math.max(-1, ...c.cats.filter((x) => x.id !== C.UNCAT).map((x) => x.order));
    for (const x of c.cats) if (x.order > order) x.order++;
    cat.order = order + 1;
    c.cats.push(cat);
  });
  return { cat };
}

// まだほかの種類に使われていない色のうち最初のもの
function unusedCatColor() {
  const used = new Set(state.calendar.cats.map((c) => c.color));
  return PALETTE.find((k) => k !== 's-other' && !used.has(k)) || 's9';
}

// 種類の追加の画面（名前と色）。onDone(追加した種類)、onCancel()
function catAddSheet({ onDone, onCancel }) {
  openSheet(`
    <h2>予定の種類の追加</h2>
    <form id="cat-form">
      <label class="field"><span class="field-label">名前</span><input name="catname" autocomplete="off" placeholder="例：サークル"></label>
      <span class="field-label">色</span>
      ${swatchPicker(unusedCatColor(), 'catcolor')}
      <p class="hint">名前・色の変更と削除は、設定画面の「予定の種類」か、カレンダーの「種類・取り込み」からできます。</p>
      <div class="sheet-actions">
        <button type="button" class="ghost" id="cat-cancel">戻る</button>
        <button type="submit" class="primary">追加</button>
      </div>
    </form>`);
  $('#sheet-body').scrollTop = 0;
  const form = $('#cat-form');
  bindSwatches(form);
  $('#cat-cancel').addEventListener('click', onCancel);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await addCat(form.elements.catname.value, form.elements.catcolor.value);
    if (r.error) return toast(r.error);
    onDone(r.cat);
    toast(`予定の種類「${r.cat.name}」を追加しました`);
  });
  form.elements.catname.focus();
}

// 種類の操作が終わったあと：設定画面からならシートを閉じ、カレンダーからなら種類の管理に戻る
function catBack(from, sheetOpen = true) {
  if (from === 'settings') {
    if (sheetOpen) closeSheet();
  } else calManageSheet();
}

// ---- 入力画面の「予定」の1行
// 自動入力（固定費）・開始残高・評価額の仕訳は予定につながない
function eventPickAllowed() {
  if (!ui.editingId) return true;
  const e = state.entries.find((x) => x.id === ui.editingId);
  return !(e && ['recurring', 'opening', 'valuation'].includes(e.kind));
}

function eventPicker() {
  const d = ui.draft;
  const evs = C.isDate(d.date) ? C.eventsOn(state.calendar, d.date) : [];
  if (d.eventId && !evs.some((e) => e.id === d.eventId)) d.eventId = null; // 日付を変えて、その日の予定でなくなった
  return `<div class="field-label">予定</div><div class="chips">${evs
    .map((ev) => `<button type="button" class="chip ev-chip${ev.id === d.eventId ? ' on' : ''}" data-act="ev-pick" data-id="${ev.id}"><span class="sw" style="background:${catColor(catOf(ev))}"></span><span class="ev-chip-t">${titleHtml(ev.title)}</span></button>`)
    .join('')}<button type="button" class="chip chip-add${d.newEventOpen ? ' on-add' : ''}" data-act="ev-new">＋ 新しい予定</button></div>
    ${d.newEventOpen ? newEventFields() : ''}`;
}

// 新しい予定の名前と種類（色）。種類を選ばなければ、費用の科目との対応で決まる（選ばれた状態で表示する）
function newEventFields() {
  const d = ui.draft;
  const cur = newEventCat(draftLines().lines);
  const auto = !d.newEventCat;
  return `<div class="ev-new">
      <input type="text" data-field="newEvent" value="${esc(d.newEvent)}" placeholder="予定名（例：13-面接）" autocomplete="off" aria-label="新しい予定の名前">
      <div class="chips ev-cats" role="radiogroup" aria-label="新しい予定の種類">${C.sortedCats(state.calendar)
        .map((c) => `<button type="button" role="radio" aria-checked="${c.id === cur}" class="chip chip-sm${c.id === cur ? ' on' : ''}" data-act="ev-cat" data-id="${c.id}"><span class="sw" style="background:${catColor(c)}"></span>${esc(c.name)}</button>`)
        .join('')}<button type="button" class="chip chip-sm chip-add" data-act="ev-cat-add">＋ 追加</button></div>
      <p class="hint">${auto ? '種類は科目から自動で選んでいます。タップで変えられます。' : '種類を選びました。もう一度タップすると、科目から自動で選ぶのに戻ります。'}保存すると、この日の予定としてカレンダーに作り、この記録とつなぎます。同じ日に同じ名前の予定があれば、それにつなぎます。</p>
    </div>`;
}

// 新しい予定の種類：選んだ種類があればそれ、なければ仕訳の費用の科目との対応（lines がなければ入力中の科目から）
function newEventCat(lines) {
  const d = ui.draft;
  if (d.newEventCat && state.calendar.cats.some((c) => c.id === d.newEventCat)) return d.newEventCat;
  if (!lines) {
    const accId = ui.mode === 'expense' ? d.acc : ui.mode === 'journal' ? d.lines.find((l) => l.side === 'dr' && acc(l.acc)?.type === 'expense')?.acc : null;
    lines = accId ? [{ acc: accId, side: 'dr', amount: 1 }] : [];
  }
  return C.catForLines(state.calendar, lines, state.accounts);
}

function renderEventPicker() {
  const el = $('#ev-pick');
  if (el) el.innerHTML = eventPicker();
}

// 仕訳の詳細に出す、つながっている予定の1行
function linkedEventLine(e) {
  const ev = e.eventId && state.calendar.events.find((x) => x.id === e.eventId);
  if (!ev) return '';
  const d = C.occursOn(ev, e.date) ? e.date : ev.date;
  return `<button type="button" class="ev-link" data-act="cal-goto" data-date="${d}"><span class="sw" style="background:${catColor(catOf(ev))}"></span>予定：${titleHtml(ev.title)}<span class="ev-link-go">›</span></button>`;
}

const CAL_ACTIONS = {
  'cal-view': (el) => {
    ui.cal.view = el.dataset.val;
    // 月と週を切り替えたら、見ていた期間に合わせる
    if (ui.cal.view === 'week') {
      const t = today();
      ui.cal.week = C.startOfWeek(L.monthOf(t) === ui.cal.month ? t : `${ui.cal.month}-01`);
    } else {
      ui.cal.month = L.monthOf(C.addDays(ui.cal.week, 3));
      ui.cal.scrollTo = ui.cal.month;
    }
    renderCalBody();
  },
  'cal-nav': (el) => {
    ui.cal.week = C.addDays(ui.cal.week, 7 * Number(el.dataset.val));
    renderCalBody();
  },
  'cal-today': () => {
    ui.cal.week = C.startOfWeek(today());
    if (ui.cal.view === 'month') {
      ui.cal.month = L.monthOf(today());
      ui.cal.scrollTo = ui.cal.month;
    }
    renderCalBody();
  },
  'cal-clear': () => {
    ui.cal.q = '';
    render();
  },
  'cal-day': (el) => daySheet(el.dataset.date),
  'cal-add': (el) => eventForm(null, { date: el.dataset.date, back: el.dataset.back || '' }),
  'cal-edit': (el) => {
    const ev = state.calendar.events.find((x) => x.id === el.dataset.id);
    if (ev) eventForm(ev, { back: el.dataset.back || '' });
  },
  'cal-back': (el) => calBack(el.dataset.back),
  'cal-delete': async (el) => {
    const ev = state.calendar.events.find((x) => x.id === el.dataset.id);
    if (!ev) return;
    if (C.seriesOf(state.calendar, ev).length > 1) return seriesDeleteSheet(ev, el.dataset.back || '');
    const n = C.linkedEntries(state, ev.id).length;
    if (!confirm(`予定「${ev.title}」を削除しますか？${n ? `つながっている家計簿の記録（${n}件）は消えず、つながりだけ外れます。` : ''}`)) return;
    await commit((s) => C.removeEvents(s, [ev.id]));
    calBack(el.dataset.back);
    toast('予定を削除しました');
  },
  // 繰り返しの予定の削除（この予定だけ・この日以降・すべて）。選ぶ画面が確認を兼ねる
  'cal-delete-series': async (el) => {
    const ev = state.calendar.events.find((x) => x.id === el.dataset.id);
    if (!ev) return;
    const ids = C.seriesTargets(state.calendar, ev, el.dataset.scope);
    await commit((s) => C.removeEvents(s, ids));
    calBack(el.dataset.back);
    toast(ids.length > 1 ? `予定を${ids.length}件削除しました` : '予定を削除しました');
  },
  'cal-goto': (el) => {
    const d = el.dataset.date;
    ui.tab = 'calendar';
    Object.assign(ui.cal, { q: '', month: L.monthOf(d), week: C.startOfWeek(d), scrollTo: L.monthOf(d) });
    window.scrollTo(0, 0);
    render();
    daySheet(d);
  },
  'cal-manage': () => calManageSheet(),
  'cat-add': (el) => {
    const back = () => catBack(el.dataset.from);
    catAddSheet({ onDone: back, onCancel: back });
  },
  'cat-rename': async (el) => {
    const c = state.calendar.cats.find((x) => x.id === el.dataset.id);
    const name = prompt('新しい名前', c.name);
    if (!name || !name.trim()) return;
    if (state.calendar.cats.some((x) => x !== c && x.name === name.trim())) return toast('同じ名前の種類があります');
    await commit(() => (c.name = name.trim()));
    catBack(el.dataset.from, false);
  },
  'cat-move': async (el) => {
    const list = C.sortedCats(state.calendar);
    const i = list.findIndex((x) => x.id === el.dataset.id);
    const j = i + Number(el.dataset.val);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await commit(() => list.forEach((x, k) => (x.order = k)));
    calManageSheet();
  },
  'cat-delete': async (el) => {
    const c = state.calendar.cats.find((x) => x.id === el.dataset.id);
    const n = state.calendar.events.filter((e) => e.cat === c.id).length;
    if (!confirm(`種類「${c.name}」を削除しますか？${n ? `この種類の予定（${n}件）は「未分類」になります。` : ''}`)) return;
    await commit((s) => C.removeCat(s.calendar, c.id));
    catBack(el.dataset.from, false);
  },
  'cat-color': (el) => {
    const c = state.calendar.cats.find((x) => x.id === el.dataset.id);
    const from = el.dataset.from || '';
    openSheet(`
      <h2>色の変更</h2>
      <form id="color-form">
        <p class="color-preview"><span class="sw" id="color-sw" style="background:${catColor(c)}"></span>${esc(c.name)}</p>
        ${swatchPicker(c.color)}
        <div class="sheet-actions">
          ${from === 'settings' ? '<button type="button" class="ghost" data-act="close-sheet">閉じる</button>' : '<button type="button" class="ghost" data-act="cal-manage">戻る</button>'}
          <button type="submit" class="primary">保存</button>
        </div>
      </form>`);
    const form = $('#color-form');
    bindSwatches(form, (k) => ($('#color-sw').style.background = `var(--${k})`));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const k = form.elements.acccolor.value;
      await commit(() => (c.color = k));
      catBack(from);
      toast(`「${c.name}」の色を変更しました`);
    });
  },
  'ics-pick': () => $('#ics-file').click(),
  'ics-undo': async (el) => {
    const rec = state.calendar.imports.find((x) => x.id === el.dataset.id);
    const n = state.calendar.events.filter((e) => e.importId === rec.id).length;
    if (!confirm(`「${rec.name}」から取り込んだ予定（${n}件）をまとめて削除しますか？つながっている家計簿の記録は消えず、つながりだけ外れます。`)) return;
    await commit((s) => C.removeImport(s, rec.id));
    calManageSheet();
    toast(`${n}件の予定を削除しました`);
  },
  'ev-pick': (el) => {
    const d = ui.draft;
    d.eventId = d.eventId === el.dataset.id ? null : el.dataset.id; // もう一度タップすると外れる
    Object.assign(d, { newEventOpen: false, newEvent: '', newEventCat: null });
    renderEventPicker();
  },
  'ev-cat': (el) => {
    const d = ui.draft;
    d.newEventCat = d.newEventCat === el.dataset.id ? null : el.dataset.id;
    renderEventPicker();
  },
  'ev-cat-add': () =>
    catAddSheet({
      onDone: (c) => {
        ui.draft.newEventCat = c.id; // 追加した種類を選んだ状態にする
        closeSheet();
        render();
      },
      onCancel: () => closeSheet(),
    }),
  'ev-new': () => {
    const d = ui.draft;
    d.newEventOpen = !d.newEventOpen;
    if (d.newEventOpen) d.eventId = null;
    else Object.assign(d, { newEvent: '', newEventCat: null });
    renderEventPicker();
    if (d.newEventOpen) $('#ev-pick input')?.focus();
  },
};

// デモ用の予定（?demo のときだけ）
function demoEvents(s, rnd) {
  const cal = s.calendar;
  const add = (title, date, cat, extra = {}) => C.addEvent(cal, C.newEvent({ title, date, cat, ...extra }));
  const end = C.addDays(today(), 30);
  for (let d = C.startOfWeek(`${L.addMonths(L.monthOf(today()), -2)}-01`); d <= end; d = C.addDays(d, 1)) {
    const w = C.weekday(d);
    if (w === 1 || w === 4) add('17-22 バイト', d, 'c_job', { series: 'demo-job' });
    if (w === 2) add('1-2限 統計', d, 'c_univ', { series: 'demo-stat' });
    if (w === 3) add('1030-12 ゼミ', d, 'c_univ', { series: 'demo-seminar' });
  }
  add('献血', C.addDays(today(), 4), 'c_play');
  add('大学', C.addDays(today(), 5), 'c_univ', { src: 'timetree', time: { start: 9 * 60, end: 18 * 60 } }); // TimeTreeから取り込んだ時刻つきの予定
  // 山と遊びの支出に、予定をつないでおく
  const titles = { mountain: ['山（丹沢）', '高尾山', '山（奥多摩）'], play: ['8-映画', '1930- 飲み会', 'カラオケ'] };
  for (const e of s.entries) {
    const l = e.lines.find((x) => titles[x.acc] && x.side === 'dr');
    if (!l || rnd() < 0.3) continue;
    const t = titles[l.acc][Math.floor(rnd() * 3)];
    const ev = C.findSameEvent(cal, e.date, t) || add(t, e.date, cal.accCat[l.acc], { src: 'ledger' });
    e.eventId = ev.id;
  }
  const trip = C.addDays(today(), -12);
  add('旅行（京都）', trip, 'c_play', { end: C.addDays(trip, 2), memo: '新幹線\n宿：駅の近く' });
  add('13-面接', C.addDays(today(), 2), C.UNCAT);
  add('合宿', C.addDays(today(), 9), 'c_mount', { end: C.addDays(today(), 11) });
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
const VIEWS = { input: viewInput, history: viewHistory, calendar: viewCalendar, charts: viewCharts, settings: viewSettings };

let lastTab = null; // 前に描いた画面（カレンダーに来たときを知るため）
function render() {
  const entered = lastTab !== ui.tab;
  lastTab = ui.tab;
  $('#view').innerHTML = VIEWS[ui.tab]();
  document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  renderBanner();
  if (ui.tab === 'input') updatePreview();
  if (ui.tab === 'charts') drawCharts();
  if (ui.tab === 'calendar') bindCalendar(entered);
  else document.body.classList.remove('cal-fixed');
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
  ...CAL_ACTIONS,
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
    if (el.dataset.field === 'acc' && ui.draft.newEventOpen && !ui.draft.newEventCat) renderEventPicker(); // 新しい予定の種類は科目で決まる
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
  'adv-toggle': () => {
    ui.draft.advOn = !ui.draft.advOn;
    render();
  },
  'adv-set': () => {
    const total = L.parseAmount(ui.draft.amount);
    if (!total) return toast('先に支払った金額を入力してください');
    ui.draft.adv = String(total);
    render();
  },
  'adv-mode': (el) => {
    ui.draft.advMode = el.dataset.val;
    render();
  },
  people: (el) => {
    ui.draft.people = Math.min(30, Math.max(2, ui.draft.people + Number(el.dataset.val)));
    render();
  },
  'hist-filter': () => {
    ui.hist.open = !ui.hist.open;
    render();
  },
  'hist-all': (el) => {
    ui.hist.all = el.dataset.val === '1';
    renderHistBody();
  },
  'hist-clear': () => {
    Object.assign(ui.hist, { q: '', acc: '', src: '', all: true });
    render();
  },
  calc: (el) => calcSheet(el.dataset.field),
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
  'acc-color': (el) => {
    const a = acc(el.dataset.id);
    const cur = colorKey(a.id);
    openSheet(`
      <h2>色の変更</h2>
      <form id="color-form">
        <p class="color-preview"><span class="sw" id="color-sw" style="background:var(--${cur})"></span>${esc(a.name)}</p>
        ${swatchPicker(cur)}
        <div class="sheet-actions">
          <button type="button" class="ghost" data-act="close-sheet">閉じる</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>`);
    const form = $('#color-form');
    bindSwatches(form, (k) => ($('#color-sw').style.background = `var(--${k})`));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const k = form.elements.acccolor.value;
      await commit(() => (a.color = k));
      closeSheet();
      toast(`「${a.name}」の色を変更しました`);
    });
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
  'pin-set': () => setPin(),
  'pin-change': async () => {
    if (await askPin({ title: '今の番号を入力', cancel: true, check: checkPin })) setPin('番号を変更しました');
  },
  'pin-off': async () => {
    if (!(await askPin({ title: '今の番号を入力', cancel: true, check: checkPin }))) return;
    try {
      await saveLock(null);
    } catch (e) {
      return toast('保存できませんでした：' + e.message);
    }
    render();
    toast('ロックをやめました');
  },
  wipe: async () => {
    if (!confirm('すべての仕訳・科目・設定・予定を削除して、最初の状態に戻します。先にバックアップを書き出しましたか？')) return;
    if (!confirm('本当に削除しますか？この操作は取り消せません。')) return;
    state = C.ensureCalendar(L.defaultState());
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
  if (t.dataset.hist === 'q') {
    ui.hist.q = t.value;
    renderHistBody();
  } else if (t.dataset.cal === 'q') {
    ui.cal.q = t.value;
    renderCalBody();
  } else if (t.dataset.field && ui.tab === 'input') {
    ui.draft[t.dataset.field] = t.value;
    if (t.dataset.field === 'date') renderEventPicker(); // 日付を変えたら、並ぶ予定もその日のものにする
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
  } else if (t.dataset.hist === 'acc' || t.dataset.hist === 'src') {
    ui.hist[t.dataset.hist] = t.value;
    render();
  } else if (t.dataset.setting) {
    await commit((s) => (s.settings[t.dataset.setting] = Number(t.value)));
  } else if (t.dataset.lock === 'after' && lock) {
    try {
      await saveLock({ ...lock, after: Number(t.value) });
    } catch (e) {
      toast('保存できませんでした：' + e.message);
    }
  } else if (t.id === 'import-file' && t.files[0]) {
    await importBackup(t.files[0]);
    t.value = '';
  } else if (t.dataset.acccat) {
    await commit((s) => {
      if (t.value) s.calendar.accCat[t.dataset.acccat] = t.value;
      else delete s.calendar.accCat[t.dataset.acccat];
    });
  } else if (t.id === 'ics-file' && t.files[0]) {
    await readIcsFile(t.files[0]);
    t.value = '';
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawCharts();
    sizeMonthList();
  }, 150);
});

// 番号入力画面では、パソコンのキーボードの数字・Backspace・Esc も使える
// 電卓では、パソコンのキーボードの数字・記号・Enter・Backspace も使える（Esc は画面を閉じる）
document.addEventListener('keydown', (ev) => {
  if (!calcCtl || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const map = { Enter: 'ok', '=': 'ok', Backspace: 'back', Delete: 'C', c: 'C', x: '*' };
  const k = /^[\d.+\-*/]$/.test(ev.key) ? ev.key : map[ev.key];
  if (!k) return;
  ev.preventDefault();
  calcCtl.press(k);
});

document.addEventListener('keydown', (ev) => {
  if (!padCtl || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = /^\d$/.test(ev.key) ? ev.key : ev.key === 'Backspace' ? 'back' : ev.key === 'Escape' ? 'cancel' : null;
  if (!k) return;
  ev.preventDefault();
  padCtl.press(k);
});

// ほかのアプリから戻ったときのロックと、日付が変わってから再び開いたときの固定費の作成
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    if (lock && lock.after === 0) lockNow();
    return;
  }
  if (lock && hiddenAt != null && Date.now() - hiddenAt >= lock.after * 60000) lockNow();
  hiddenAt = null;
  if (!state) return;
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
  demoEvents(C.ensureCalendar(s), rnd);
  return s;
}

// ---------------------------------------------------------------- 起動
async function init() {
  if (DEMO) {
    state = demoState();
  } else {
    let stored = null;
    try {
      dbp = openDB();
      stored = await idbGet('state');
      lock = (await idbGet('lock')) || null;
    } catch (e) {
      storageOk = false;
      toast('データの保存場所を開けませんでした。この状態では入力が保存されません：' + (e && e.message));
    }
    state = C.ensureCalendar(stored ? L.migrate(stored) : L.defaultState());
    const created = L.generateRecurring(state, today());
    if (!stored || created.length) await save();
    if (created.length) setTimeout(() => toast(`固定費の仕訳を${created.length}件作りました`), 300);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  const hashTab = location.hash.slice(1);
  if (VIEWS[hashTab]) ui.tab = hashTab;
  ui.draft = newDraft(ui.mode);
  if (lock) lockNow();
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
