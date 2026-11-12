// 帳簿の計算（画面に依存しない部分）。Node.js からも読み込んでテストできる。

// データ形式の版。2：収益の「その他」を追加。3：NISA・評価差額・NISA積立を追加。4：収入・奨学金の自動入力を追加
export const SCHEMA = 4;

export const TYPE_LABEL = {
  asset: '資産',
  liability: '負債',
  equity: '純資産',
  expense: '費用',
  income: '収益',
};
export const TYPE_ORDER = ['asset', 'liability', 'equity', 'expense', 'income'];

// 借方に記入すると残高が増える区分
const NORMAL_DEBIT = { asset: true, expense: true, liability: false, equity: false, income: false };

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const pad2 = (n) => String(n).padStart(2, '0');

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export const monthOf = (date) => date.slice(0, 7);
export const yearOf = (date) => date.slice(0, 4);

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}
export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
export const lastDayOf = (ym) => `${ym}-${pad2(daysInMonth(ym))}`;

export function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000);
}

// 版4で加える収入・奨学金の自動入力（id, 名前, 借方, 貸方）
const INCOME_RECURRING = [
  ['r_job1', 'バイト①', 'bank', 'job1'],
  ['r_job2', 'バイト②', 'bank', 'job2'],
  ['r_grant', '奨学金（返済なし）', 'bank', 'grant_sch'],
  ['r_loan', '奨学金（返済あり）', 'bank', 'loan_sch'],
];

export function defaultState() {
  const a = (id, name, type) => ({ id, name, type, archived: false });
  const r = (id, name, debit = 'subsc', credit = 'card') => ({
    id, name, amount: 0, freq: 'monthly', month: 1, day: 1,
    debit, credit, startMonth: null, lastMonth: null, active: false,
  });
  return {
    schema: SCHEMA,
    accounts: [
      a('cash', '現金', 'asset'),
      a('bank', '銀行口座', 'asset'),
      a('emoney', '電子マネー', 'asset'),
      a('nisa', 'NISA（投資信託）', 'asset'),
      a('card', 'クレジットカード', 'liability'),
      a('loan_sch', '奨学金（返済あり）', 'liability'),
      a('opening', '開始残高', 'equity'),
      a('valuation', '評価差額', 'equity'),
      a('food', '食費', 'expense'),
      a('transport', '交通費', 'expense'),
      a('daily', '日用品', 'expense'),
      a('mountain', '山', 'expense'),
      a('play', '遊び', 'expense'),
      a('book', '本', 'expense'),
      a('study', '学習', 'expense'),
      a('subsc', '通信・サブスク', 'expense'),
      a('other_exp', 'その他', 'expense'),
      a('job1', 'バイト①', 'income'),
      a('job2', 'バイト②', 'income'),
      a('grant_sch', '奨学金（返済なし）', 'income'),
      a('allowance', '小遣い', 'income'),
      a('other_inc', 'その他', 'income'),
    ],
    entries: [],
    recurring: [r('r_tel', '通信費'), r('r_claude', 'Claude'), r('r_prime', 'Amazon Prime'), r('r_nisa', 'NISA積立', 'nisa'), ...INCOME_RECURRING.map((x) => r(...x))],
    settings: { backupDays: 7, lastBackupAt: null, last: {} },
  };
}

export function migrate(s) {
  const d = defaultState();
  const from = s.schema || 1;
  // 版1→2：収益の「その他」を1回だけ追加する（あとで削除した場合に戻さないよう、版で判定する）
  if (from < 2 && !s.accounts.some((a) => a.type === 'income' && a.name === 'その他')) {
    s.accounts.push({ id: 'other_inc', name: 'その他', type: 'income', archived: false });
  }
  // 版2→3：NISA・評価差額の科目と、NISA積立の固定費を1回だけ追加する
  if (from < 3) {
    const def = d.accounts;
    for (const id of ['nisa', 'valuation']) {
      if (!s.accounts.some((a) => a.id === id)) s.accounts.push({ ...def.find((a) => a.id === id) });
    }
    if (!s.recurring.some((x) => x.id === 'r_nisa')) s.recurring.push({ ...d.recurring.find((x) => x.id === 'r_nisa') });
  }
  // 版3→4：収入・奨学金の自動入力を1回だけ追加する（科目が残っているものだけ）
  if (from < 4) {
    const ids = new Set(s.accounts.map((a) => a.id));
    for (const x of d.recurring.filter((x) => INCOME_RECURRING.some((y) => y[0] === x.id))) {
      if (!s.recurring.some((y) => y.id === x.id) && ids.has(x.debit) && ids.has(x.credit)) s.recurring.push({ ...x });
    }
  }
  s.schema = Math.max(from, SCHEMA);
  s.settings = { ...d.settings, ...(s.settings || {}) };
  s.settings.last = s.settings.last || {};
  for (const r of s.recurring) {
    r.freq = r.freq || 'monthly';
    r.month = r.month || 1;
  }
  return s;
}

export function validateState(s) {
  if (!s || typeof s !== 'object') return '形式が違います';
  if (!Array.isArray(s.accounts) || !Array.isArray(s.entries) || !Array.isArray(s.recurring)) {
    return '勘定科目・仕訳・固定費のいずれかが見つかりません';
  }
  const ids = new Set(s.accounts.map((a) => a.id));
  for (const e of s.entries) {
    if (!Array.isArray(e.lines)) return `仕訳 ${e.id} の行が見つかりません`;
    for (const l of e.lines) if (!ids.has(l.acc)) return `仕訳 ${e.id} に存在しない勘定科目があります`;
  }
  return null;
}

export function lineTotals(lines) {
  let dr = 0, cr = 0;
  for (const l of lines) {
    if (l.side === 'dr') dr += l.amount; else cr += l.amount;
  }
  return { dr, cr };
}

// 仕訳として正しいかを調べる。問題があればその内容を、なければ null を返す。
export function validateEntry(entry, accounts) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) return '日付を入力してください';
  const ids = new Set(accounts.map((a) => a.id));
  const lines = entry.lines || [];
  if (lines.length < 2) return '仕訳には2行以上が必要です';
  for (const l of lines) {
    if (!ids.has(l.acc)) return '勘定科目を選んでください';
    if (!Number.isInteger(l.amount) || l.amount <= 0) return '金額は1円以上の整数で入力してください';
    if (l.side !== 'dr' && l.side !== 'cr') return '借方・貸方の指定がありません';
  }
  if (!lines.some((l) => l.side === 'dr') || !lines.some((l) => l.side === 'cr')) {
    return '借方と貸方の両方が必要です';
  }
  const { dr, cr } = lineTotals(lines);
  if (dr !== cr) return `借方の合計（${dr}）と貸方の合計（${cr}）が一致しません`;
  return null;
}

// 簡単入力から仕訳の行を作る
export function buildSimpleLines(mode, f, amount) {
  switch (mode) {
    case 'expense': // 借方 費用 ／ 貸方 支払元
      return [{ acc: f.acc, side: 'dr', amount }, { acc: f.from, side: 'cr', amount }];
    case 'income': // 借方 入金先 ／ 貸方 収益
      return [{ acc: f.to, side: 'dr', amount }, { acc: f.acc, side: 'cr', amount }];
    case 'transfer': // 借方 移動先 ／ 貸方 移動元
      return [{ acc: f.to, side: 'dr', amount }, { acc: f.from, side: 'cr', amount }];
    default:
      throw new Error('unknown mode ' + mode);
  }
}

// 開始残高の仕訳。資産なら 借方 資産／貸方 開始残高、負債なら 借方 開始残高／貸方 負債。
export function buildOpeningLines(account, amount, openingId = 'opening') {
  return account.type === 'liability'
    ? [{ acc: openingId, side: 'dr', amount }, { acc: account.id, side: 'cr', amount }]
    : [{ acc: account.id, side: 'dr', amount }, { acc: openingId, side: 'cr', amount }];
}

// 評価額の更新の仕訳。帳簿の残高 book を評価額 market に合わせる差額を、純資産の「評価差額」で受ける。
// 値上がり：借方 資産／貸方 評価差額、値下がり：借方 評価差額／貸方 資産。差額が0なら null。
export function buildValuationLines(assetId, book, market, valuationId = 'valuation') {
  const diff = market - book;
  if (diff === 0) return null;
  const amount = Math.abs(diff);
  return diff > 0
    ? [{ acc: assetId, side: 'dr', amount }, { acc: valuationId, side: 'cr', amount }]
    : [{ acc: valuationId, side: 'dr', amount }, { acc: assetId, side: 'cr', amount }];
}

// 行の金額を、その勘定科目の残高が増える向きを正として返す
export function signedAmount(line, type) {
  const v = line.side === 'dr' ? line.amount : -line.amount;
  return NORMAL_DEBIT[type] ? v : -v;
}

function typeMap(state) {
  return new Map(state.accounts.map((a) => [a.id, a.type]));
}

// upto（YYYY-MM-DD）までの各勘定科目の残高
export function balances(state, upto = null) {
  const types = typeMap(state);
  const bal = Object.fromEntries(state.accounts.map((a) => [a.id, 0]));
  for (const e of state.entries) {
    if (upto && e.date > upto) continue;
    for (const l of e.lines) bal[l.acc] += signedAmount(l, types.get(l.acc));
  }
  return bal;
}

// 純資産 = 資産の残高の合計 − 負債の残高の合計
export function netWorth(state, upto = null) {
  const bal = balances(state, upto);
  let v = 0;
  for (const a of state.accounts) {
    if (a.type === 'asset') v += bal[a.id];
    else if (a.type === 'liability') v -= bal[a.id];
  }
  return v;
}

export const periodKeyOf = (date, by) => (by === 'year' ? yearOf(date) : monthOf(date));

// 期間（月または年）ごとの、費用・収益の科目別合計
export function summarize(state, by = 'month') {
  const types = typeMap(state);
  const out = new Map();
  for (const e of state.entries) {
    const k = periodKeyOf(e.date, by);
    let s = out.get(k);
    if (!s) {
      s = { expense: {}, income: {}, expenseTotal: 0, incomeTotal: 0 };
      out.set(k, s);
    }
    for (const l of e.lines) {
      const t = types.get(l.acc);
      if (t !== 'expense' && t !== 'income') continue;
      const v = signedAmount(l, t);
      s[t][l.acc] = (s[t][l.acc] || 0) + v;
      if (t === 'expense') s.expenseTotal += v; else s.incomeTotal += v;
    }
  }
  return out;
}

export const emptySummary = () => ({ expense: {}, income: {}, expenseTotal: 0, incomeTotal: 0 });

// key で終わる n 個の期間キー（古い順）
export function periodKeysEnding(key, by, n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    keys.push(by === 'year' ? String(Number(key) - i) : addMonths(key, -i));
  }
  return keys;
}

export const periodEnd = (key, by) => (by === 'year' ? `${key}-12-31` : lastDayOf(key));
export const prevPeriod = (key, by) => (by === 'year' ? String(Number(key) - 1) : addMonths(key, -1));
export const nextPeriod = (key, by) => (by === 'year' ? String(Number(key) + 1) : addMonths(key, 1));

export function netWorthSeries(state, keys, by) {
  return keys.map((k) => netWorth(state, periodEnd(k, by)));
}

// 自動入力の種類。借方が費用なら支出、貸方が収益なら収入、それ以外（資産・負債の間の移動）は振替
export const RECURRING_SIDES = {
  expense: { debit: ['expense'], credit: ['asset', 'liability'] },
  income: { debit: ['asset'], credit: ['income'] },
  transfer: { debit: ['asset', 'liability'], credit: ['asset', 'liability'] },
};
export function recurringKind(r, accounts) {
  const t = (id) => accounts.find((a) => a.id === id)?.type;
  if (t(r.debit) === 'expense') return 'expense';
  if (t(r.credit) === 'income') return 'income';
  return 'transfer';
}

export function recurringDate(r, ym) {
  return `${ym}-${pad2(Math.min(r.day, daysInMonth(ym)))}`;
}

// 期日を過ぎた固定費の仕訳を作って state.entries に加え、作った仕訳を返す
export function generateRecurring(state, today, now = Date.now()) {
  const created = [];
  const curYm = monthOf(today);
  for (const r of state.recurring) {
    if (!r.active || !(r.amount > 0) || !r.startMonth) continue;
    let ym = r.lastMonth ? addMonths(r.lastMonth, 1) : r.startMonth;
    while (ym <= curYm) {
      if (r.freq === 'yearly' && Number(ym.slice(5, 7)) !== Number(r.month)) {
        ym = addMonths(ym, 1);
        continue;
      }
      const date = recurringDate(r, ym);
      if (date > today) break;
      created.push({
        id: uid(),
        date,
        memo: r.name,
        kind: 'recurring',
        recurringId: r.id,
        lines: [
          { acc: r.debit, side: 'dr', amount: r.amount },
          { acc: r.credit, side: 'cr', amount: r.amount },
        ],
        createdAt: now,
      });
      r.lastMonth = ym;
      ym = addMonths(ym, 1);
    }
  }
  state.entries.push(...created);
  return created;
}

export function accountInUse(state, id) {
  return (
    state.entries.some((e) => e.lines.some((l) => l.acc === id)) ||
    state.recurring.some((r) => r.debit === id || r.credit === id)
  );
}

// 計算式（+ − × ÷ と括弧）の値を返す。数は0以上の整数だけ。式として正しくなければ null。
// 例：「3000÷3」→ 1000、「1200+800×2」→ 2800（掛け算・割り算を先に計算する）
export function evalExpr(src) {
  const tokens = String(src).match(/\d+|[-+*/()]|\S/g) || [];
  let i = 0;
  const peek = () => tokens[i];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = tokens[i++] === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      if (tokens[i++] === '*') v *= factor();
      else {
        const d = factor();
        if (d === 0) throw new Error('0で割れません');
        v /= d;
      }
    }
    return v;
  }
  function factor() {
    const t = tokens[i++];
    if (t === '(') {
      const v = expr();
      if (tokens[i++] !== ')') throw new Error('括弧');
      return v;
    }
    if (/^\d+$/.test(t || '')) return Number(t);
    throw new Error('式');
  }
  try {
    const v = expr();
    return i === tokens.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// 全角数字・カンマ・円記号を含む入力を整数にする。不正なら null。
// 計算式も受け付け、結果の1円未満は四捨五入する（例：「1000÷3」→ 333）。
export function parseAmount(str) {
  if (str == null) return null;
  const s = String(str)
    .replace(/[０-９（）＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[−ー－]/g, '-')
    .replace(/[×xX＊]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/[,，¥￥円\s]/g, '');
  if (!/^[\d+\-*/()]+$/.test(s)) return null;
  const v = /^\d+$/.test(s) ? Number(s) : evalExpr(s);
  if (v == null) return null;
  const n = Math.round(v);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

// 立替を含む支出の仕訳。total のうち advance 円が立替（ほかの人の分）。
// 借方 費用（自分の分）・借方 立替金（ほかの人の分）／貸方 支払元（全額）。全額が立替なら費用の行は作らない。
export const ADVANCE_NAME = '立替金';
export function buildAdvanceLines(f, total, advance) {
  const own = total - advance;
  return [
    ...(own > 0 ? [{ acc: f.acc, side: 'dr', amount: own }] : []),
    { acc: f.advAcc, side: 'dr', amount: advance },
    { acc: f.from, side: 'cr', amount: total },
  ];
}
