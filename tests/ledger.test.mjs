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

test('版1のデータを読み込むと収益の「その他」が1回だけ加わる', () => {
  const s = L.defaultState();
  s.schema = 1;
  s.accounts = s.accounts.filter((a) => a.id !== 'other_inc');
  L.migrate(s);
  assert.equal(s.schema, L.SCHEMA);
  assert.ok(s.accounts.some((a) => a.id === 'other_inc' && a.type === 'income'));
  // 削除したあとに再び読み込んでも戻らない
  s.accounts = s.accounts.filter((a) => a.id !== 'other_inc');
  L.migrate(s);
  assert.ok(!s.accounts.some((a) => a.id === 'other_inc'));
});

test('版2のデータを読み込むと NISA・評価差額・NISA積立が加わる', () => {
  const s = L.defaultState();
  s.schema = 2;
  s.accounts = s.accounts.filter((a) => a.id !== 'nisa' && a.id !== 'valuation');
  s.recurring = s.recurring.filter((r) => r.id !== 'r_nisa');
  L.migrate(s);
  assert.equal(s.accounts.find((a) => a.id === 'nisa').type, 'asset');
  assert.equal(s.accounts.find((a) => a.id === 'valuation').type, 'equity');
  assert.equal(s.recurring.find((r) => r.id === 'r_nisa').debit, 'nisa');
  const n = s.accounts.length;
  L.migrate(s);
  assert.equal(s.accounts.length, n);
});

test('NISA：クレカ積立・評価額の更新・純資産・支出への影響', () => {
  const s = L.defaultState();
  Object.assign(s.recurring.find((r) => r.id === 'r_nisa'), { amount: 30000, day: 1, startMonth: '2026-09', active: true });
  L.generateRecurring(s, '2026-11-06'); // 9月・10月・11月の3回
  let bal = L.balances(s);
  assert.equal(bal.nisa, 90000);
  assert.equal(bal.card, 90000);
  // 積立は資産の購入なので支出に数えない
  assert.equal(L.summarize(s, 'month').get('2026-10').expenseTotal, 0);
  // 評価額 95,000 → 差額 5,000 は評価差額（純資産）
  const up = L.buildValuationLines('nisa', bal.nisa, 95000);
  assert.deepEqual(up, [{ acc: 'nisa', side: 'dr', amount: 5000 }, { acc: 'valuation', side: 'cr', amount: 5000 }]);
  s.entries.push({ id: 'v1', date: '2026-11-06', kind: 'valuation', lines: up });
  bal = L.balances(s);
  assert.equal(bal.nisa, 95000);
  assert.equal(bal.valuation, 5000);
  assert.equal(L.netWorth(s), 95000 - 90000);
  // 収益・費用には入らない
  const m = L.summarize(s, 'month').get('2026-11');
  assert.equal(m.incomeTotal, 0);
  assert.equal(m.expenseTotal, 0);
  // 値下がり
  assert.deepEqual(L.buildValuationLines('nisa', 95000, 93000), [{ acc: 'valuation', side: 'dr', amount: 2000 }, { acc: 'nisa', side: 'cr', amount: 2000 }]);
  assert.equal(L.buildValuationLines('nisa', 95000, 95000), null);
});

test('収入・奨学金の自動入力', () => {
  const s = L.defaultState();
  const job = s.recurring.find((r) => r.id === 'r_job1');
  const loan = s.recurring.find((r) => r.id === 'r_loan');
  assert.equal(L.recurringKind(job, s.accounts), 'income');
  assert.equal(L.recurringKind(loan, s.accounts), 'transfer');
  assert.equal(L.recurringKind(s.recurring.find((r) => r.id === 'r_tel'), s.accounts), 'expense');
  assert.equal(L.recurringKind(s.recurring.find((r) => r.id === 'r_nisa'), s.accounts), 'transfer');
  Object.assign(job, { amount: 60000, day: 25, startMonth: '2026-10', active: true });
  Object.assign(loan, { amount: 30000, day: 11, startMonth: '2026-10', active: true });
  L.generateRecurring(s, '2026-11-06');
  const m = L.summarize(s, 'month');
  assert.equal(m.get('2026-10').incomeTotal, 60000); // 給料は収入。貸与奨学金は収入に入らない
  const bal = L.balances(s);
  // 11月分は25日・11日がまだ来ていないので、10月分だけ
  assert.equal(bal.bank, 60000 + 30000);
  assert.equal(bal.loan_sch, 30000); // 返済あり：負債が増える
  assert.equal(L.netWorth(s), 60000);
});

test('版3のデータを読み込むと収入・奨学金の自動入力が加わる', () => {
  const s = L.defaultState();
  s.schema = 3;
  s.recurring = s.recurring.filter((r) => !['r_job1', 'r_job2', 'r_grant', 'r_loan'].includes(r.id));
  s.accounts = s.accounts.filter((a) => a.id !== 'job2'); // 科目を削除していた場合は加えない
  L.migrate(s);
  const ids = s.recurring.map((r) => r.id);
  assert.ok(ids.includes('r_job1') && ids.includes('r_grant') && ids.includes('r_loan'));
  assert.ok(!ids.includes('r_job2'));
});

test('期間キーと金額の解析', () => {
  assert.deepEqual(L.periodKeysEnding('2026-02', 'month', 3), ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(L.periodKeysEnding('2026', 'year', 2), ['2025', '2026']);
  assert.equal(L.parseAmount('１，２００円'), 1200);
  assert.equal(L.parseAmount('¥3,000'), 3000);
  assert.equal(L.parseAmount('12.5'), null);
  assert.equal(L.parseAmount('0'), null);
});

test('金額欄の計算式', () => {
  assert.equal(L.parseAmount('3000÷3'), 1000);
  assert.equal(L.parseAmount('1200+800×2'), 2800);
  assert.equal(L.parseAmount('(1200+800)*2'), 4000);
  assert.equal(L.parseAmount('１０００－２００'), 800);
  assert.equal(L.parseAmount('1000/3'), 333); // 1円未満は四捨五入
  assert.equal(L.parseAmount('1000/0'), null);
  assert.equal(L.parseAmount('500-800'), null); // 0円以下
  assert.equal(L.parseAmount('1000+'), null);
  assert.equal(L.evalExpr('2*(3+4)'), 14);
});

test('立替を含む支出：自分の分は費用、ほかの人の分は立替金（資産）', () => {
  const s = L.defaultState();
  s.accounts.push({ id: 'adv', name: '立替金', type: 'asset', archived: false });
  const lines = L.buildAdvanceLines({ acc: 'food', from: 'card', advAcc: 'adv' }, 3000, 2000);
  assert.deepEqual(lines, [
    { acc: 'food', side: 'dr', amount: 1000 },
    { acc: 'adv', side: 'dr', amount: 2000 },
    { acc: 'card', side: 'cr', amount: 3000 },
  ]);
  assert.equal(L.validateEntry({ date: '2026-11-12', lines }, s.accounts), null);
  s.entries = [
    { id: 'a', date: '2026-11-12', kind: 'expense', lines },
    // 返金（現金）：振替 立替金 → 現金
    { id: 'b', date: '2026-11-13', kind: 'transfer', lines: L.buildSimpleLines('transfer', { from: 'adv', to: 'cash' }, 2000) },
  ];
  assert.equal(L.balances(s, '2026-11-12').adv, 2000);
  const bal = L.balances(s);
  assert.equal(bal.adv, 0);
  assert.equal(bal.cash, 2000);
  assert.equal(bal.card, 3000);
  assert.equal(L.summarize(s).get('2026-11').expenseTotal, 1000);
  // 全額が立替なら費用の行はない
  assert.deepEqual(L.buildAdvanceLines({ acc: null, from: 'cash', advAcc: 'adv' }, 500, 500), [
    { acc: 'adv', side: 'dr', amount: 500 },
    { acc: 'cash', side: 'cr', amount: 500 },
  ]);
});
