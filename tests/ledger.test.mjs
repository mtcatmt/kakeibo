// 実行: node --test tests/ledger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../ledger.js';

function withEntries(entries) {
  const s = L.defaultState();
  s.entries = entries.map((e, i) => ({ id: 'e' + i, memo: '', kind: 'journal', ...e }));
  return s;
}

test('簡単入力の支出は 借方 費用／貸方 支払元 になる', () => {
  const lines = L.buildSimpleLines('expense', { acc: 'food', from: 'card' }, 1200);
  assert.deepEqual(lines, [
    { acc: 'food', side: 'dr', amount: 1200 },
    { acc: 'card', side: 'cr', amount: 1200 },
  ]);
});

test('貸借が一致しない仕訳は拒否される', () => {
  const s = L.defaultState();
  const err = L.validateEntry(
    { date: '2026-11-01', lines: [{ acc: 'food', side: 'dr', amount: 100 }, { acc: 'cash', side: 'cr', amount: 90 }] },
    s.accounts,
  );
  assert.match(err, /一致しません/);
});

test('残高・純資産・月別集計', () => {
  const s = withEntries([
    { date: '2026-10-01', lines: L.buildOpeningLines({ id: 'bank', type: 'asset' }, 100000) },
    { date: '2026-10-01', lines: L.buildOpeningLines({ id: 'loan_sch', type: 'liability' }, 30000) },
    { date: '2026-10-05', lines: L.buildSimpleLines('expense', { acc: 'food', from: 'card' }, 1200) },
    { date: '2026-10-20', lines: L.buildSimpleLines('income', { acc: 'job1', to: 'bank' }, 50000) },
    // カード引き落とし（11月）：負債の減少であり、費用ではない
    { date: '2026-11-10', lines: L.buildSimpleLines('transfer', { from: 'bank', to: 'card' }, 1200) },
    // 貸与奨学金の受け取り：負債の増加
    { date: '2026-11-15', lines: L.buildSimpleLines('transfer', { from: 'loan_sch', to: 'bank' }, 20000) },
  ]);
  const bal = L.balances(s);
  assert.equal(bal.bank, 100000 + 50000 - 1200 + 20000);
  assert.equal(bal.card, 0);
  assert.equal(bal.loan_sch, 50000);
  // 純資産 = 資産 168,800 − 負債 50,000
  assert.equal(L.netWorth(s), 118800);
  assert.equal(L.netWorth(s, '2026-10-31'), 100000 - 30000 - 1200 + 50000);

  const m = L.summarize(s, 'month');
  assert.equal(m.get('2026-10').expenseTotal, 1200);
  assert.equal(m.get('2026-10').incomeTotal, 50000);
  // 11月は振替だけなので、支出も収入も 0
  assert.equal(m.get('2026-11').expenseTotal, 0);
  assert.equal(m.get('2026-11').incomeTotal, 0);
});

test('固定費：月末の日付の調整と、2回目の実行で重複しないこと', () => {
  const s = L.defaultState();
  const r = s.recurring[0];
  Object.assign(r, { amount: 3000, day: 31, startMonth: '2026-01', active: true });
  const c1 = L.generateRecurring(s, '2026-03-30');
  assert.deepEqual(c1.map((e) => e.date), ['2026-01-31', '2026-02-28']);
  assert.equal(r.lastMonth, '2026-02');
  const c2 = L.generateRecurring(s, '2026-03-31');
  assert.deepEqual(c2.map((e) => e.date), ['2026-03-31']);
  assert.equal(L.generateRecurring(s, '2026-03-31').length, 0);
  assert.equal(s.entries.length, 3);
});

test('固定費：毎年', () => {
  const s = L.defaultState();
  const r = s.recurring[2];
  Object.assign(r, { amount: 5900, freq: 'yearly', month: 6, day: 15, startMonth: '2025-01', active: true });
  const c = L.generateRecurring(s, '2026-11-06');
  assert.deepEqual(c.map((e) => e.date), ['2025-06-15', '2026-06-15']);
  assert.equal(L.generateRecurring(s, '2026-12-31').length, 0);
});

test('期間キーと金額の解析', () => {
  assert.deepEqual(L.periodKeysEnding('2026-02', 'month', 3), ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(L.periodKeysEnding('2026', 'year', 2), ['2025', '2026']);
  assert.equal(L.parseAmount('１，２００円'), 1200);
  assert.equal(L.parseAmount('¥3,000'), 3000);
  assert.equal(L.parseAmount('12.5'), null);
  assert.equal(L.parseAmount('0'), null);
});
