// 帳簿の計算（画面に依存しない部分）。Node.js からも読み込んでテストできる。

// データ形式の版。2：収益の「その他」を追加
export const SCHEMA = 2;

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

export function defaultState() {
  const a = (id, name, type) => ({ id, name, type, archived: false });
  const r = (id, name) => ({
    id, name, amount: 0, freq: 'monthly', month: 1, day: 1,
    debit: 'subsc', credit: 'card', startMonth: null, lastMonth: null, active: false,
  });
  return {
    schema: SCHEMA,
    accounts: [
      a('cash', '現金', 'asset'),
      a('bank', '銀行口座', 'asset'),
      a('emoney', '電子マネー', 'asset'),
      a('card', 'クレジットカード', 'liability'),
      a('loan_sch', '奨学金（返済あり）', 'liability'),
      a('opening', '開始残高', 'equity'),
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
    recurring: [r('r_tel', '通信費'), r('r_claude', 'Claude'), r('r_prime', 'Amazon Prime')],
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

// 全角数字・カンマ・円記号を含む入力を整数にする。不正なら null。
export function parseAmount(str) {
  if (str == null) return null;
  const s = String(str)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，¥￥円\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}
