// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../calendar.js';
import * as L from '../ledger.js';

const cal0 = () => C.defaultCalendar(L.defaultState().accounts);
const T = (h, m = 0) => h * 60 + m;

test('予定名の時間の読み取り（要件の表）', () => {
  const cases = [
    ['19-', '19-', T(19), null],
    ['10-15', '10-15', T(10), T(15)],
    ['13-面接', '13-', T(13), null],
    ['1930-22 飲み会', '1930-22', T(19, 30), T(22)],
    ['930-バイト', '930-', T(9, 30), null],
    ['10-1530', '10-1530', T(10), T(15, 30)],
    ['9〜大学', '9〜', T(9), null],
  ];
  for (const [title, part, start, end] of cases) {
    const t = C.parseTime(title);
    assert.ok(t, title);
    assert.equal(title.slice(0, t.len), part, title);
    assert.equal(t.start, start, title);
    assert.equal(t.end, end, title);
  }
  assert.equal(C.parseTime('面接'), null);
  assert.equal(C.parseTime('1-2限 統計'), null);
});

test('時刻の書き方のいろいろと、時間として読まないもの', () => {
  assert.deepEqual(C.parseTime('19:30-22:00 映画'), { start: T(19, 30), end: T(22), len: 11 });
  assert.deepEqual(C.parseTime('19時-'), { start: T(19), end: null, len: 4 });
  assert.deepEqual(C.parseTime('19時30分〜21時 会議'), { start: T(19, 30), end: T(21), len: 10 });
  assert.equal(C.parseTime('25-27 夜行バス').start, T(25));
  assert.equal(C.parseTime('１９－２２ 全角').start, T(19)); // 全角の数字と記号
  assert.equal(C.parseTime('19 飲み会'), null); // 区切りがない
  assert.equal(C.parseTime('960-'), null); // 分が60以上
  assert.equal(C.parseTime('30-'), null); // 30時はない
  assert.equal(C.parseTime('12345-'), null);
  assert.equal(C.parseTime('3-4限'), null);
  assert.deepEqual(C.splitTitle('13-面接'), ['13-', '面接']);
  assert.deepEqual(C.splitTitle('面接'), ['', '面接']);
});

test('新しい予定は、開始時刻が遅い最初の予定の前に入る', () => {
  const cal = cal0();
  const add = (title) => C.addEvent(cal, C.newEvent({ title, date: '2026-11-19' }));
  add('10-授業');
  add('買い物'); // 時間なし → いちばん下
  add('18-バイト');
  add('13-面接'); // 18- の前
  add('8-朝練'); // いちばん上
  const names = C.eventsOn(cal, '2026-11-19').map((e) => e.title);
  assert.deepEqual(names, ['8-朝練', '10-授業', '買い物', '13-面接', '18-バイト']);
  // 並び順は 0, 1, 2… に振り直される
  assert.deepEqual(C.eventsOn(cal, '2026-11-19').map((e) => e.order), [0, 1, 2, 3, 4]);
});

test('何日も続く予定は、各日のいちばん上に開始日の早い順で出る', () => {
  const cal = cal0();
  C.addEvent(cal, C.newEvent({ title: '9-授業', date: '2026-11-20' }));
  C.addEvent(cal, C.newEvent({ title: '旅行', date: '2026-11-19', end: '2026-11-21' }));
  C.addEvent(cal, C.newEvent({ title: '合宿', date: '2026-11-20', end: '2026-11-22' }));
  assert.deepEqual(C.eventsOn(cal, '2026-11-20').map((e) => e.title), ['旅行', '合宿', '9-授業']);
  assert.deepEqual(C.eventsOn(cal, '2026-11-22').map((e) => e.title), ['合宿']);
  assert.equal(C.eventsOn(cal, '2026-11-23').length, 0);
  // 終了日が開始日と同じか前なら、1日の予定
  assert.equal(C.newEvent({ title: 'x', date: '2026-11-20', end: '2026-11-20' }).end, null);
});

test('月表示の帯の配置', () => {
  const cal = cal0();
  C.addEvent(cal, C.newEvent({ title: '旅行', date: '2026-11-14', end: '2026-11-17' })); // 前の週から続く
  C.addEvent(cal, C.newEvent({ title: 'A', date: '2026-11-16' }));
  C.addEvent(cal, C.newEvent({ title: 'B', date: '2026-11-18' }));
  const w = C.layoutWeek(cal, '2026-11-15');
  const by = Object.fromEntries(w.map((x) => [x.ev.title, x]));
  assert.deepEqual([by['旅行'].col, by['旅行'].span, by['旅行'].lane], [0, 3, 0]);
  assert.equal(by.A.lane, 1); // 旅行の下
  assert.equal(by.B.lane, 0); // 旅行が終わった日は上から
});

test('繰り返しの日付と検索', () => {
  assert.deepEqual(C.repeatDates('2026-01-31', 'monthly', 3), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(C.repeatDates('2026-11-19', 'weekly', 3), ['2026-11-19', '2026-11-26', '2026-12-03']);
  assert.equal(C.repeatDates('2026-11-19', 'weekly', 999).length, C.MAX_REPEAT);
  const cal = cal0();
  C.addEvent(cal, C.newEvent({ title: '山（丹沢）', date: '2025-05-01' }));
  C.addEvent(cal, C.newEvent({ title: '飲み会', date: '2026-05-01', memo: '山の仲間' }));
  C.addEvent(cal, C.newEvent({ title: '授業', date: '2026-06-01' }));
  assert.deepEqual(C.searchEvents(cal, '山').map((e) => e.title), ['飲み会', '山（丹沢）']);
  assert.deepEqual(C.searchEvents(cal, '  '), []);
});

test('state.calendar の用意と、ない予定を指す eventId の取り外し', () => {
  const s = L.defaultState();
  s.entries.push({ id: 'e1', date: '2026-11-19', kind: 'expense', memo: '', eventId: 'nope', lines: [] });
  C.ensureCalendar(s);
  assert.ok(Array.isArray(s.calendar.events));
  assert.ok(s.calendar.cats.some((c) => c.id === C.UNCAT));
  assert.equal(s.calendar.accCat.mountain, 'c_mount');
  assert.equal('eventId' in s.entries[0], false);
  // 種類を消すと、その種類の予定は未分類になる
  const ev = C.addEvent(s.calendar, C.newEvent({ title: '登山', date: '2026-11-19', cat: 'c_mount' }));
  C.removeCat(s.calendar, 'c_mount');
  assert.equal(ev.cat, C.UNCAT);
  assert.equal(s.calendar.accCat.mountain, undefined);
  // 予定を消すと、仕訳のつながりだけ外れる
  s.entries[0].eventId = ev.id;
  C.removeEvents(s, [ev.id]);
  assert.equal(s.entries.length, 1);
  assert.equal('eventId' in s.entries[0], false);
});

test('予定に出す金額：支出は費用の行（立替を除く）、収入は収益の行、振替は数えない', () => {
  const s = L.defaultState();
  s.accounts.push({ id: 'adv', name: '立替金', type: 'asset', archived: false });
  const ex = { lines: L.buildAdvanceLines({ acc: 'food', from: 'card', advAcc: 'adv' }, 3000, 2000) };
  const inc = { lines: L.buildSimpleLines('income', { acc: 'job1', to: 'bank' }, 5000) };
  const tr = { lines: L.buildSimpleLines('transfer', { from: 'bank', to: 'cash' }, 1000) };
  assert.deepEqual(C.sumAmounts([ex, inc, tr], s.accounts), { expense: 1000, income: 5000 });
  const cal = C.defaultCalendar(s.accounts);
  assert.equal(C.catForLines(cal, L.buildSimpleLines('expense', { acc: 'mountain', from: 'cash' }, 100), s.accounts), 'c_mount');
  assert.equal(C.catForLines(cal, inc.lines, s.accounts), C.UNCAT);
});

// 内閣府「国民の祝日について」の一覧
const H2026 = ['01-01', '01-12', '02-11', '02-23', '03-20', '04-29', '05-03', '05-04', '05-05', '05-06', '07-20', '08-11', '09-21', '09-22', '09-23', '10-12', '11-03', '11-23'];
const H2027 = ['01-01', '01-11', '02-11', '02-23', '03-21', '03-22', '04-29', '05-03', '05-04', '05-05', '07-19', '08-11', '09-20', '09-23', '10-11', '11-03', '11-23'];

test('祝日：2026年・2027年', () => {
  assert.deepEqual([...C.holidaysOf(2026).keys()].sort(), H2026.map((d) => `2026-${d}`));
  assert.deepEqual([...C.holidaysOf(2027).keys()].sort(), H2027.map((d) => `2027-${d}`));
  assert.equal(C.holidayName('2026-05-06'), '振替休日');
  assert.equal(C.holidayName('2026-09-22'), '国民の休日');
  assert.equal(C.holidayName('2027-03-22'), '振替休日');
  assert.equal(C.holidayName('2026-11-19'), null);
});

test('祝日：2019〜2021年の特別な日', () => {
  assert.deepEqual(['2019-04-30', '2019-05-01', '2019-05-02', '2019-05-06', '2019-10-22'].map(C.holidayName), ['国民の休日', '天皇の即位の日', '国民の休日', '振替休日', '即位礼正殿の儀の行われる日']);
  assert.equal(C.holidayName('2019-12-23'), null); // 2019年は天皇誕生日がない
  assert.equal(C.holidayName('2019-10-14'), '体育の日');
  assert.deepEqual(['2020-07-23', '2020-07-24', '2020-08-10'].map(C.holidayName), ['海の日', 'スポーツの日', '山の日']);
  assert.equal(C.holidayName('2020-07-20'), null);
  assert.deepEqual(['2021-07-22', '2021-07-23', '2021-08-08', '2021-08-09'].map(C.holidayName), ['海の日', 'スポーツの日', '山の日', '振替休日']);
  assert.equal(C.holidayName('2021-10-11'), null);
  assert.equal(C.holidayName('2020-02-24'), '振替休日');
  assert.equal(C.holidayName('2019-03-21'), '春分の日');
  assert.equal(C.holidayName('2025-09-23'), '秋分の日');
  assert.equal(C.holidayName('2024-02-12'), '振替休日');
  assert.equal(C.holidaysOf(2025).size, 19); // 2025年は振替休日を含めて19日（2/24・5/6・11/24）
});

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:test
BEGIN:VEVENT
UID:allday-1
SUMMARY:合宿
DTSTART;VALUE=DATE:20250810
DTEND;VALUE=DATE:20250813
CATEGORIES:山
COLOR:#2a78d6
LOCATION:八ヶ岳
DESCRIPTION:テント泊\\n持ち物：ヘッドライト
END:VEVENT
BEGIN:VEVENT
UID:timed-1
SUMMARY:飲み
DTSTART:20250101T120000Z
DTEND:20250101T150000Z
END:VEVENT
BEGIN:VEVENT
UID:timed-2
SUMMARY:面接
DTSTART;TZID=Asia/Tokyo:20250102T100000
DTEND;TZID=Asia/Tokyo:20250102T110000
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Reminder
TRIGGER:-PT10M
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:rep-1
SUMMARY:バイト
DTSTART;TZID=Asia/Tokyo:20260105T170000
DTEND;TZID=Asia/Tokyo:20260105T220000
RRULE:FREQ=WEEKLY;BYDAY=MO,TH
EXDATE;TZID=Asia/Tokyo:20260108T170000
END:VEVENT
BEGIN:VEVENT
UID:rep-2
SUMMARY:家賃の日
DTSTART;VALUE=DATE:20260131
DTEND;VALUE=DATE:20260201
RRULE:FREQ=MONTHLY;COUNT=4
END:VEVENT
BEGIN:VEVENT
UID:rep-3
SUMMARY:定例
DTSTART;VALUE=DATE:20260109
RRULE:FREQ=MONTHLY;BYDAY=2FR;UNTIL=20260401
END:VEVENT
END:VCALENDAR`;

test('.ics：終日・時刻つき・場所とメモ・ラベル', () => {
  const items = C.parseICS(ICS, { until: '2026-01-20' });
  const by = (uid) => items.find((x) => x.uid === uid);
  const a = by('allday-1');
  assert.equal(a.date, '2025-08-10');
  assert.equal(a.end, '2025-08-12'); // 終日の DTEND は翌日を指すので1日引く
  assert.equal(a.memo, 'テント泊\n持ち物：ヘッドライト\n場所：八ヶ岳');
  assert.deepEqual(a.labels, ['山']);
  assert.equal(a.color, '#2a78d6');
  const t = by('timed-1');
  assert.equal(t.date, '2025-01-01'); // 12:00Z → 21:00（日本時間）
  assert.equal(t.startMin, T(21));
  assert.equal(t.end, null); // 0:00 に終わるので同じ日
  assert.equal(t.title, '飲み'); // 予定名に時刻は付けない
  assert.equal(by('timed-2').date, '2025-01-02');
  assert.equal(by('timed-2').memo, ''); // VALARM の DESCRIPTION は使わない
});

test('.ics：繰り返しを1回ずつに分ける（EXDATE・COUNT・UNTIL・第2金曜）', () => {
  const items = C.parseICS(ICS, { until: '2026-01-20' });
  const dates = (u) => items.filter((x) => x.uid.startsWith(u + '#')).map((x) => x.date);
  assert.deepEqual(dates('rep-1'), ['2026-01-05', '2026-01-12', '2026-01-15', '2026-01-19']); // 1/8 は除外
  const more = C.parseICS(ICS, { until: '2026-12-31' });
  const d2 = (u) => more.filter((x) => x.uid.startsWith(u + '#')).map((x) => x.date);
  assert.deepEqual(d2('rep-2'), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']); // 31日のない月は作らず、回数にも数えない
  assert.deepEqual(d2('rep-3'), ['2026-01-09', '2026-02-13', '2026-03-13']);
  assert.equal(C.expandRRule('FREQ=YEARLY', '2024-02-29', '2028-12-31').join(), '2024-02-29,2028-02-29');
  assert.equal(C.expandRRule('FREQ=DAILY;INTERVAL=2;COUNT=3', '2026-01-01', '2026-12-31').join(), '2026-01-01,2026-01-03,2026-01-05');
});

test('.ics の取り込み：重複させない・種類の決め方・ファイルごとの削除', () => {
  const s = L.defaultState();
  C.ensureCalendar(s);
  const cal = s.calendar;
  const items = C.parseICS(ICS, { until: '2026-01-20' });
  const labelMap = C.defaultLabelMap(cal, items);
  assert.equal(labelMap['山'], 'c_mount');
  const rules = [{ text: 'バイト', cat: 'c_job' }];
  const p = C.planImport(cal, items);
  assert.equal(p.dup, 0);
  assert.equal(p.from, '2025-01-01');
  const rec = C.applyImport(cal, p.fresh, { name: 'a.ics', labelMap, rules });
  assert.equal(rec.count, items.length);
  const ev = (t) => cal.events.find((e) => e.title === t);
  assert.equal(ev('合宿').cat, 'c_mount');
  assert.equal(ev('バイト').cat, 'c_job');
  assert.equal(ev('面接').cat, C.UNCAT);
  assert.equal(ev('合宿').src, 'timetree');
  // 同じファイルをもう一度読んでも重複しない
  const p2 = C.planImport(cal, C.parseICS(ICS, { until: '2026-01-20' }));
  assert.equal(p2.fresh.length, 0);
  assert.equal(p2.dup, items.length);
  // 同じ日の時刻つきの予定は、時刻の早い順に並ぶ
  const two = C.parseICS(`BEGIN:VEVENT\nUID:x2\nSUMMARY:夜\nDTSTART:20250301T110000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:x1\nSUMMARY:朝\nDTSTART:20250301T000000Z\nEND:VEVENT`, { until: '2026-01-01' });
  C.applyImport(cal, two, { name: 'b.ics' });
  assert.deepEqual(C.eventsOn(cal, '2025-03-01').map((e) => e.title), ['朝', '夜']);
  // ファイルごとの削除
  s.entries.push({ id: 'e1', date: '2025-08-10', kind: 'expense', memo: '', lines: [], eventId: ev('合宿').id });
  C.removeImport(s, rec.id);
  assert.equal(cal.events.length, 2);
  assert.equal(cal.imports.length, 1);
  assert.equal('eventId' in s.entries[0], false);
});

test('毎月の第n営業日（土日・祝日を除く）', () => {
  assert.equal(C.nthBusinessDay('2027-01', 1), '2027-01-04'); // 1/1 祝日・1/2 土・1/3 日
  assert.equal(C.nthBusinessDay('2026-05', 2), '2026-05-07'); // 5/4〜5/6 は祝日・振替休日
  assert.equal(C.nthBusinessDay('2026-11', 3), '2026-11-05'); // 11/3 文化の日
  assert.equal(C.nthBusinessDay('2026-11', 25), null);
  assert.equal(C.businessDayIndex('2026-11-05'), 3);
  assert.equal(C.businessDayIndex('2026-11-03'), null);
  // 日付より前の回は作らない：11/20 から「第3営業日」→ 12月から
  assert.deepEqual(C.repeatDates('2026-11-20', 'bizday', 3, 3), ['2026-12-03', '2027-01-06', '2027-02-03']);
  assert.deepEqual(C.repeatDates('2026-11-05', 'bizday', 2, 3), ['2026-11-05', '2026-12-03']);
  // 第21営業日は、営業日が20日しかない月を飛ばす
  assert.ok(C.repeatDates('2027-01-01', 'bizday', 3, 21).every((d) => C.businessDayIndex(d) === 21));
});
