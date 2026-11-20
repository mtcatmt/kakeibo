// カレンダーの計算（画面に依存しない部分）。ledger.js と同じく Node.js からも読み込んでテストできる。
// 予定は state.calendar に保存する。ledger.js の SCHEMA・migrate() は変えず、ensureCalendar() で用意する。
import { uid, pad2, signedAmount } from './ledger.js';

export const UNCAT = 'uncat'; // 「未分類」の種類のid（削除できない）
export const MAX_REPEAT = 60; // 予定を繰り返して作るときの最大の回数

// ---------------------------------------------------------------- 日付（'YYYY-MM-DD' の文字列で扱う）
const toUTC = (d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fromUTC = (t) => {
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
};
export const addDays = (d, n) => fromUTC(toUTC(d) + n * 86400000);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000); // b − a（日数）
export const weekday = (d) => new Date(toUTC(d)).getUTCDay(); // 0＝日曜
export const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUTC(toUTC(s)) === s;
export const startOfWeek = (d) => addDays(d, -weekday(d)); // 日曜はじまり

// 月の表示に使う6週分の最初の日（その月の1日を含む週の日曜）
export const monthGridStart = (ym) => startOfWeek(`${ym}-01`);

// ---------------------------------------------------------------- 予定名の時間の読み取り
// 予定名の先頭が時刻で、すぐ後ろに「-」「－」「〜」「~」が続くときだけ時間として読む。
// 返す値：{ start, end, len }。start・end は0時からの分（end はなければ null）、len は時間として読んだ部分の文字数。
// 時間として読まないときは null。
const SEP = '-－〜~～';
const toHalf = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/：/g, ':');

// s の先頭から時刻を1つ読む。{ min, len } または null
function readClock(s) {
  let m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m) return clock(Number(m[1]), Number(m[2]), m[0].length);
  m = /^(\d{1,2})時(?:(\d{1,2})分)?/.exec(s);
  if (m) return clock(Number(m[1]), Number(m[2] || 0), m[0].length);
  m = /^\d+/.exec(s);
  if (!m || m[0].length > 4) return null;
  const n = m[0];
  return n.length <= 2 ? clock(Number(n), 0, n.length) : clock(Number(n.slice(0, -2)), Number(n.slice(-2)), n.length);
}
const clock = (h, mi, len) => (h <= 29 && mi < 60 ? { min: h * 60 + mi, len } : null);

export function parseTime(title) {
  const s = toHalf(String(title || ''));
  const a = readClock(s);
  if (!a || !SEP.includes(s[a.len] || '\0')) return null;
  let len = a.len + 1;
  const rest = s.slice(len);
  let end = null;
  if (/^\d/.test(rest)) {
    const b = readClock(rest);
    if (!b) return null; // 終わりの時刻として読めない数字（例：10-99）は、全体を時間として読まない
    if (rest[b.len] === '限') return null; // 大学の時限（例：1-2限）
    end = b.min;
    len += b.len;
  }
  return { start: a.min, end, len };
}

// 予定名を、時間の部分とそれ以外に分ける（表示で時間を太字にするため）
export function splitTitle(title) {
  const t = parseTime(title);
  return t ? [title.slice(0, t.len), title.slice(t.len)] : ['', title];
}

// ---------------------------------------------------------------- 予定
export const isMultiDay = (ev) => !!ev.end && ev.end > ev.date;
export const lastDay = (ev) => (isMultiDay(ev) ? ev.end : ev.date);
export const occursOn = (ev, d) => ev.date <= d && d <= lastDay(ev);
export const overlaps = (ev, from, to) => ev.date <= to && lastDay(ev) >= from;

const byStart = (a, b) => (a.date === b.date ? (lastDay(b) > lastDay(a) ? 1 : lastDay(b) < lastDay(a) ? -1 : 0) : a.date < b.date ? -1 : 1);

// その日の予定を表示の順に並べる：何日も続く予定（開始日の早い順）を上に、続けて1日の予定を並び順で
export function eventsOn(cal, d) {
  const all = cal.events.filter((e) => occursOn(e, d));
  const multi = all.filter(isMultiDay).sort(byStart);
  const single = all.filter((e) => !isMultiDay(e)).sort((a, b) => a.order - b.order);
  return [...multi, ...single];
}

// 1日の予定を、その日の並び順に入れる。startMin（0時からの分）があれば、
// その日の予定のうち開始時刻が自分より遅い最初の予定の前に、なければいちばん下に入れる。
// 入れたあと、その日の並び順を 0, 1, 2… に振り直す。
export function placeEvent(cal, ev, startMin = parseTime(ev.title)?.start ?? null) {
  const list = cal.events.filter((e) => e !== ev && !isMultiDay(e) && e.date === ev.date).sort((a, b) => a.order - b.order);
  let i = list.length;
  if (startMin != null && !isMultiDay(ev)) {
    const j = list.findIndex((e) => {
      const t = parseTime(e.title);
      return t && t.start > startMin;
    });
    if (j >= 0) i = j;
  }
  list.splice(i, 0, ev);
  list.forEach((e, k) => (e.order = k));
  if (isMultiDay(ev)) ev.order = 0;
}

// 予定を作る（cal には入れない）
export function newEvent({ title, date, end = null, cat = UNCAT, memo = '', src = 'manual', importUid = null, importId = null }) {
  const ev = { id: uid(), title, date, end: end && end > date ? end : null, cat, order: 0, memo, src, createdAt: Date.now() };
  if (importUid) ev.importUid = importUid;
  if (importId) ev.importId = importId;
  return ev;
}

// 予定を cal に加え、その日の並び順に入れる
export function addEvent(cal, ev, startMin) {
  cal.events.push(ev);
  placeEvent(cal, ev, startMin);
  return ev;
}

// 予定を削除する。つながっている仕訳は消さず、つながり（eventId）だけ外す
export function removeEvents(state, ids) {
  const set = new Set(ids);
  state.calendar.events = state.calendar.events.filter((e) => !set.has(e.id));
  for (const e of state.entries) if (set.has(e.eventId)) delete e.eventId;
}

// 繰り返しの日付。freq：'weekly'（毎週）| 'monthly'（毎月その日。月の日数より大きい日は末日）
// | 'bizday'（毎月の第n営業日。土日・祝日を除いて数える。date より前と、第n営業日がない月は作らない）
export function repeatDates(date, freq, count, n = 1) {
  count = Math.max(1, Math.min(MAX_REPEAT, Math.floor(count) || 1));
  const out = [];
  const [y, m, d] = date.split('-').map(Number);
  if (freq === 'bizday') {
    for (let i = 0; out.length < count && i < count + 24; i++) {
      const t = y * 12 + (m - 1) + i;
      const x = nthBusinessDay(`${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`, n);
      if (x && x >= date) out.push(x);
    }
    return out;
  }
  for (let i = 0; i < count; i++) {
    if (freq === 'weekly') out.push(addDays(date, 7 * i));
    else if (freq === 'monthly') {
      const t = y * 12 + (m - 1) + i;
      const yy = Math.floor(t / 12);
      const mm = (t % 12) + 1;
      const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      out.push(ymd(yy, mm, Math.min(d, dim)));
    } else out.push(date);
  }
  return out;
}

// 営業日：土日・祝日（振替休日・国民の休日を含む）でない日
export const isBusinessDay = (d) => weekday(d) !== 0 && weekday(d) !== 6 && !holidayName(d);

// その月（'YYYY-MM'）の第n営業日。なければ null
export function nthBusinessDay(ym, n) {
  n = Math.floor(n);
  if (!(n >= 1)) return null;
  let k = 0;
  for (let d = `${ym}-01`; d.slice(0, 7) === ym; d = addDays(d, 1)) if (isBusinessDay(d) && ++k === n) return d;
  return null;
}

// その日がその月の第何営業日か。営業日でなければ null
export function businessDayIndex(d) {
  if (!isBusinessDay(d)) return null;
  let k = 0;
  for (let x = `${d.slice(0, 7)}-01`; x <= d; x = addDays(x, 1)) if (isBusinessDay(x)) k++;
  return k;
}

// 予定名とメモで探す。結果は新しい順
export function searchEvents(cal, q) {
  const words = q.trim().toLowerCase().split(/[\s　]+/).filter(Boolean);
  if (!words.length) return [];
  return cal.events
    .filter((e) => {
      const text = `${e.title}\n${e.memo || ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => (a.date === b.date ? b.order - a.order : a.date < b.date ? 1 : -1));
}

// 家計簿の記録から予定を探す：その日にある同じ名前の予定
export const findSameEvent = (cal, date, title) => cal.events.find((e) => occursOn(e, date) && e.title === title.trim()) || null;

// 仕訳の金額：支出は費用の行の合計（立替を除いた自分の分）、収入は収益の行の合計
export function entryAmounts(entry, accounts) {
  const type = new Map(accounts.map((a) => [a.id, a.type]));
  let expense = 0, income = 0;
  for (const l of entry.lines) {
    const t = type.get(l.acc);
    if (t === 'expense') expense += signedAmount(l, t);
    if (t === 'income') income += signedAmount(l, t);
  }
  return { expense, income };
}
export function sumAmounts(entries, accounts) {
  return entries.reduce(
    (s, e) => {
      const a = entryAmounts(e, accounts);
      return { expense: s.expense + a.expense, income: s.income + a.income };
    },
    { expense: 0, income: 0 },
  );
}
export const linkedEntries = (state, eventId) =>
  state.entries.filter((e) => e.eventId === eventId).sort((a, b) => (a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date < b.date ? -1 : 1));

// 家計簿から作る予定の種類：仕訳の最初の費用の行の科目に対応する種類。なければ未分類
export function catForLines(cal, lines, accounts) {
  const type = new Map(accounts.map((a) => [a.id, a.type]));
  const l = lines.find((x) => type.get(x.acc) === 'expense' && x.side === 'dr');
  const c = l && cal.accCat[l.acc];
  return c && cal.cats.some((x) => x.id === c) ? c : UNCAT;
}

// ---------------------------------------------------------------- state.calendar の用意
export function defaultCalendar(accounts = []) {
  const cats = [
    { id: 'c_job', name: 'バイト', color: 's2' },
    { id: 'c_univ', name: '大学', color: 's1' },
    { id: 'c_play', name: '遊び', color: 's5' },
    { id: 'c_mount', name: '山', color: 's6' },
    { id: UNCAT, name: '未分類', color: 's-other' },
  ].map((c, i) => ({ ...c, order: i }));
  const accCat = {};
  const ids = new Set(accounts.map((a) => a.id));
  if (ids.has('play')) accCat.play = 'c_play';
  if (ids.has('mountain')) accCat.mountain = 'c_mount';
  return { events: [], cats, accCat, rules: [], imports: [] };
}

// state.calendar がなければ作り、足りない項目を補う。L.migrate() のあとで呼ぶ。
// 仕訳の eventId がない予定を指していたら、つながりを外す（エラーにはしない）
export function ensureCalendar(state) {
  const d = defaultCalendar(state.accounts);
  const c = state.calendar && typeof state.calendar === 'object' ? state.calendar : (state.calendar = d);
  for (const k of ['events', 'cats', 'rules', 'imports']) if (!Array.isArray(c[k])) c[k] = d[k];
  if (!c.accCat || typeof c.accCat !== 'object') c.accCat = {};
  if (!c.cats.some((x) => x.id === UNCAT)) c.cats.push({ id: UNCAT, name: '未分類', color: 's-other', order: c.cats.length });
  const catIds = new Set(c.cats.map((x) => x.id));
  for (const e of c.events) {
    if (!catIds.has(e.cat)) e.cat = UNCAT;
    if (typeof e.order !== 'number') e.order = 0;
  }
  const ids = new Set(c.events.map((e) => e.id));
  for (const e of state.entries) if (e.eventId && !ids.has(e.eventId)) delete e.eventId;
  return state;
}

export const sortedCats = (cal) => [...cal.cats].sort((a, b) => a.order - b.order);

// 種類を削除する：その種類の予定と科目の対応は「未分類」に
export function removeCat(cal, id) {
  if (id === UNCAT) return;
  cal.cats = cal.cats.filter((c) => c.id !== id);
  for (const e of cal.events) if (e.cat === id) e.cat = UNCAT;
  for (const k of Object.keys(cal.accCat)) if (cal.accCat[k] === id) delete cal.accCat[k];
  cal.rules = cal.rules.filter((r) => r.cat !== id);
  sortedCats(cal).forEach((c, i) => (c.order = i));
}

// ---------------------------------------------------------------- 祝日（オフラインで計算する。2019年以降を内閣府の一覧と合わせてある）
const nthMonday = (y, m, n) => {
  const first = ymd(y, m, 1);
  const off = (8 - weekday(first)) % 7; // 最初の月曜まで
  return addDays(first, off + 7 * (n - 1));
};
const shunbun = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const shubun = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

// 「国民の祝日」（振替休日・国民の休日を除く）
function baseHolidays(y) {
  const h = new Map();
  const add = (d, name) => h.set(d, name);
  add(ymd(y, 1, 1), '元日');
  add(nthMonday(y, 1, 2), '成人の日');
  add(ymd(y, 2, 11), '建国記念の日');
  if (y >= 2020) add(ymd(y, 2, 23), '天皇誕生日');
  add(ymd(y, 3, shunbun(y)), '春分の日');
  add(ymd(y, 4, 29), '昭和の日');
  add(ymd(y, 5, 3), '憲法記念日');
  add(ymd(y, 5, 4), 'みどりの日');
  add(ymd(y, 5, 5), 'こどもの日');
  // 2020年・2021年は東京オリンピック・パラリンピックのため、海の日・スポーツの日・山の日が移った
  const special = { 2020: ['07-23', '07-24', '08-10'], 2021: ['07-22', '07-23', '08-08'] }[y];
  add(special ? `${y}-${special[0]}` : nthMonday(y, 7, 3), '海の日');
  if (y >= 2016) add(special ? `${y}-${special[2]}` : ymd(y, 8, 11), '山の日');
  add(nthMonday(y, 9, 3), '敬老の日');
  add(ymd(y, 9, shubun(y)), '秋分の日');
  add(special ? `${y}-${special[1]}` : nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  add(ymd(y, 11, 3), '文化の日');
  add(ymd(y, 11, 23), '勤労感謝の日');
  if (y <= 2018) add(ymd(y, 12, 23), '天皇誕生日');
  if (y === 2019) {
    add('2019-05-01', '天皇の即位の日');
    add('2019-10-22', '即位礼正殿の儀の行われる日');
  }
  return h;
}

const holidayCache = new Map();
// その年の祝日・振替休日・国民の休日（日付 → 名前）
export function holidaysOf(y) {
  y = Number(y);
  if (holidayCache.has(y)) return holidayCache.get(y);
  const base = baseHolidays(y);
  const all = new Map(base);
  // 国民の休日：前日と翌日が国民の祝日である日（その日が祝日でなく、日曜でもないとき）
  for (const d of base.keys()) {
    const mid = addDays(d, 1);
    if (!base.has(mid) && base.has(addDays(d, 2)) && weekday(mid) !== 0) all.set(mid, '国民の休日');
  }
  // 振替休日：国民の祝日が日曜のとき、その後の最も近い祝日でない日
  for (const d of [...base.keys()].sort()) {
    if (weekday(d) !== 0) continue;
    let x = addDays(d, 1);
    while (base.has(x)) x = addDays(x, 1);
    all.set(x, '振替休日');
  }
  holidayCache.set(y, all);
  return all;
}
export const holidayName = (d) => holidaysOf(d.slice(0, 4)).get(d) || null;

// ---------------------------------------------------------------- .ics の読み取り
// 返す値：[{ uid, title, date, end, startMin, memo, labels, color }]。
// 終日の予定の DTEND は翌日を指すので1日引く。時刻つきの予定は日本時間の日付だけ使う。
// 繰り返し（RRULE・RDATE）は1回ずつの予定に分け、until（'YYYY-MM-DD'）より後は作らない。EXDATE の日は作らない。
export function parseICS(text, { until }) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const vevents = [];
  let cur = null;
  let depth = 0; // VEVENT の中の VALARM などは読み飛ばす
  for (const raw of lines) {
    if (!raw) continue;
    if (raw === 'BEGIN:VEVENT') {
      cur = [];
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('BEGIN:')) depth++;
    else if (raw.startsWith('END:') && depth > 0) depth--;
    else if (raw === 'END:VEVENT') {
      vevents.push(cur);
      cur = null;
    } else if (depth === 0) cur.push(parseLine(raw));
  }
  const out = [];
  for (const props of vevents) out.push(...expandEvent(props, until));
  return out;
}

function parseLine(raw) {
  // 名前;パラメータ=値:内容（パラメータの値に「:」が入るときは "" で囲まれている）
  let i = 0, q = false;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  const head = raw.slice(0, i).split(';');
  const params = {};
  for (const p of head.slice(1)) {
    const k = p.indexOf('=');
    if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '');
  }
  return { name: head[0].toUpperCase(), params, value: raw.slice(i + 1) };
}

const unescape = (s) => s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
const splitList = (s) => s.split(/(?<!\\),/).map((x) => unescape(x).trim()).filter(Boolean);

// 日付・日時の値 → { date, min, allDay }（日本時間）
function readDT(p) {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  if (!m[4] || p.params.VALUE === 'DATE') return { date: ymd(m[1], m[2], m[3]), min: null, allDay: true };
  let date = ymd(m[1], m[2], m[3]);
  let min = Number(m[4]) * 60 + Number(m[5]);
  if (m[7]) {
    // UTC → 日本時間（+9時間）
    min += 9 * 60;
    if (min >= 1440) {
      min -= 1440;
      date = addDays(date, 1);
    }
  }
  return { date, min, allDay: false };
}

function expandEvent(props, until) {
  const get = (n) => props.find((p) => p.name === n);
  const all = (n) => props.filter((p) => p.name === n);
  const s = get('DTSTART') && readDT(get('DTSTART'));
  if (!s) return [];
  const e = get('DTEND') && readDT(get('DTEND'));
  let last = s.date;
  if (e) {
    if (e.allDay) last = addDays(e.date, -1);
    else last = e.min === 0 && e.date > s.date ? addDays(e.date, -1) : e.date; // 翌日の0:00に終わる予定は前日まで
  } else if (get('DURATION')) {
    const m = /P(?:(\d+)W)?(?:(\d+)D)?/.exec(get('DURATION').value);
    const days = m ? Number(m[1] || 0) * 7 + Number(m[2] || 0) : 0;
    if (days) last = addDays(s.date, s.allDay ? days - 1 : days);
  }
  if (last < s.date) last = s.date;
  const span = diffDays(s.date, last);

  const memoParts = [];
  if (get('DESCRIPTION')) memoParts.push(unescape(get('DESCRIPTION').value).trim());
  if (get('LOCATION') && unescape(get('LOCATION').value).trim()) memoParts.push('場所：' + unescape(get('LOCATION').value).trim());
  const labels = all('CATEGORIES').flatMap((p) => splitList(p.value));
  const color = get('COLOR')?.value.trim() || get('X-APPLE-CALENDAR-COLOR')?.value.trim() || null;
  const base = {
    uid: get('UID')?.value.trim() || '',
    title: unescape(get('SUMMARY')?.value || '').trim() || '（名前なし）',
    startMin: s.min,
    memo: memoParts.filter(Boolean).join('\n'),
    labels,
    color,
  };
  const rrule = get('RRULE');
  const rdates = all('RDATE').flatMap((p) => p.value.split(',').map((v) => readDT({ value: v, params: p.params })?.date)).filter(Boolean);
  if (!rrule && !rdates.length) return [{ ...base, date: s.date, end: span ? last : null }];

  const ex = new Set(all('EXDATE').flatMap((p) => p.value.split(',').map((v) => readDT({ value: v, params: p.params })?.date)).filter(Boolean));
  const dates = new Set(rrule ? expandRRule(rrule.value, s.date, until) : [s.date]);
  for (const d of rdates) if (d <= until) dates.add(d);
  return [...dates]
    .filter((d) => !ex.has(d))
    .sort()
    .map((d) => ({ ...base, uid: `${base.uid}#${d}`, date: d, end: span ? addDays(d, span) : null }));
}

const DAY_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCUR = 3000;

// RRULE を1回ずつの日付に分ける（FREQ・INTERVAL・COUNT・UNTIL・BYDAY・BYMONTHDAY・BYMONTH）
export function expandRRule(rule, start, until) {
  const r = {};
  for (const part of rule.split(';')) {
    const [k, v] = part.split('=');
    if (k && v != null) r[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  let end = until;
  if (r.UNTIL) {
    const u = readDT({ value: r.UNTIL, params: {} });
    if (u && u.date < end) end = u.date;
  }
  const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x); return m ? { n: m[1] ? Number(m[1]) : 0, wd: DAY_CODE.indexOf(m[2]) } : null; }).filter(Boolean) : null;
  const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
  const bymonth = r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null;
  const [sy, sm, sd] = start.split('-').map(Number);
  const out = [];
  let n = 0; // COUNT は開始日を含めて数える
  const take = (d) => {
    if (d < start || n >= count) return;
    n++;
    if (d <= end) out.push(d);
  };
  const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  // ある月の中で BYDAY（例：2MO、-1FR、MO）に当たる日
  const monthByDay = (y, m) => {
    const days = [];
    const len = dim(y, m);
    for (const b of byday) {
      const hits = [];
      for (let d = 1; d <= len; d++) if (weekday(ymd(y, m, d)) === b.wd) hits.push(d);
      if (!b.n) days.push(...hits);
      else {
        const d = b.n > 0 ? hits[b.n - 1] : hits[hits.length + b.n];
        if (d) days.push(d);
      }
    }
    return days;
  };
  const resolveMonthDays = (y, m) => {
    const len = dim(y, m);
    let days;
    if (bymd) days = bymd.map((d) => (d < 0 ? len + d + 1 : d)).filter((d) => d >= 1 && d <= len);
    else if (byday) days = monthByDay(y, m);
    else days = sd <= len ? [sd] : []; // 31日などがない月は作らない（RFC 5545 のとおり）
    if (bymd && byday) days = days.filter((d) => byday.some((b) => b.wd === weekday(ymd(y, m, d))));
    return [...new Set(days)].sort((a, b) => a - b).map((d) => ymd(y, m, d));
  };

  for (let i = 0; out.length < MAX_OCCUR && n < count; i++) {
    let batch = [];
    if (freq === 'DAILY') {
      const d = addDays(start, i * interval);
      if (d > end) break;
      const [y, m] = d.split('-').map(Number);
      if ((!bymonth || bymonth.includes(m)) && (!byday || byday.some((b) => b.wd === weekday(d)))) batch = [d];
    } else if (freq === 'WEEKLY') {
      const ws = addDays(startOfWeek(start), i * 7 * interval);
      if (ws > end) break;
      const wds = byday ? byday.map((b) => b.wd) : [weekday(start)];
      batch = [...new Set(wds)].sort((a, b) => a - b).map((w) => addDays(ws, w));
    } else if (freq === 'MONTHLY') {
      const t = sy * 12 + (sm - 1) + i * interval;
      const y = Math.floor(t / 12), m = (t % 12) + 1;
      if (ymd(y, m, 1) > end) break;
      if (!bymonth || bymonth.includes(m)) batch = resolveMonthDays(y, m);
    } else if (freq === 'YEARLY') {
      const y = sy + i * interval;
      if (ymd(y, 1, 1) > end) break;
      const months = bymonth || [sm];
      for (const m of months) {
        if (bymd || byday) batch.push(...resolveMonthDays(y, m));
        else if (sd <= dim(y, m)) batch.push(ymd(y, m, sd));
      }
      batch.sort();
    } else {
      take(start);
      break;
    }
    for (const d of batch) take(d);
    if (i > 100000) break;
  }
  return out;
}

// ---------------------------------------------------------------- 取り込み
// 取り込む予定の種類を決める。labelMap：ラベル（または色）→ 種類のid。rules：[{ text, cat }]（名前に text を含めば cat）
export const labelKey = (item) => item.labels[0] || item.color || '';
export function catForImport(cal, item, labelMap = {}, rules = cal.rules) {
  const ids = new Set(cal.cats.map((c) => c.id));
  const byLabel = labelMap[labelKey(item)];
  if (byLabel && ids.has(byLabel)) return byLabel;
  const r = rules.find((x) => x.text && ids.has(x.cat) && item.title.includes(x.text));
  return r ? r.cat : UNCAT;
}

// ラベルの名前と同じ名前の種類があれば、それを最初の対応にする
export function defaultLabelMap(cal, items) {
  const map = {};
  for (const it of items) {
    const k = labelKey(it);
    if (!k || k in map) continue;
    const c = cal.cats.find((x) => x.name === it.labels[0]);
    map[k] = c ? c.id : '';
  }
  return map;
}

// 取り込みの準備：すでに取り込んだ UID は除く
export function planImport(cal, items) {
  const have = new Set(cal.events.map((e) => e.importUid).filter(Boolean));
  const seen = new Set();
  const fresh = [];
  let dup = 0;
  for (const it of items) {
    if (it.uid && (have.has(it.uid) || seen.has(it.uid))) {
      dup++;
      continue;
    }
    if (it.uid) seen.add(it.uid);
    fresh.push(it);
  }
  const dates = fresh.map((x) => x.date).sort();
  return { fresh, dup, from: dates[0] || null, to: dates[dates.length - 1] || null };
}

// 取り込む：時刻の早い順にその日の並び順へ入れる。返す値は取り込みの記録
export function applyImport(cal, fresh, { name, labelMap = {}, rules = cal.rules, at = Date.now() }) {
  const importId = uid();
  const sorted = [...fresh].sort((a, b) => (a.date === b.date ? (a.startMin ?? 1e9) - (b.startMin ?? 1e9) : a.date < b.date ? -1 : 1));
  for (const it of sorted) {
    const ev = newEvent({ title: it.title, date: it.date, end: it.end, cat: catForImport(cal, it, labelMap, rules), memo: it.memo, src: 'timetree', importUid: it.uid || null, importId });
    cal.events.push(ev);
    placeEvent(cal, ev, null); // 時刻は予定名に付けないので、その日のいちばん下に（時刻の早い順に入る）
  }
  const rec = { id: importId, name, at, count: sorted.length };
  cal.imports.push(rec);
  return rec;
}

// 取り込んだ予定を、ファイルごとにまとめて削除する
export function removeImport(state, importId) {
  removeEvents(state, state.calendar.events.filter((e) => e.importId === importId).map((e) => e.id));
  state.calendar.imports = state.calendar.imports.filter((x) => x.id !== importId);
}

// ---------------------------------------------------------------- 月表示の帯の配置
// 1週間（start から7日）の予定を、段（lane）に並べる。返す値：[{ ev, col, span, lane }]。
// 何日も続く予定を先に（開始日の早い順・長い順）、続けて各日の1日の予定を並び順で、空いている最も上の段に置く。
export function layoutWeek(cal, start) {
  const end = addDays(start, 6);
  const used = []; // used[lane][col]
  const free = (lane, c0, c1) => {
    for (let c = c0; c <= c1; c++) if (used[lane]?.[c]) return false;
    return true;
  };
  const put = (ev, c0, c1) => {
    let lane = 0;
    while (!free(lane, c0, c1)) lane++;
    used[lane] = used[lane] || [];
    for (let c = c0; c <= c1; c++) used[lane][c] = true;
    return { ev, col: c0, span: c1 - c0 + 1, lane };
  };
  const out = [];
  const multi = cal.events.filter((e) => isMultiDay(e) && overlaps(e, start, end)).sort(byStart);
  for (const ev of multi) out.push(put(ev, Math.max(0, diffDays(start, ev.date)), Math.min(6, diffDays(start, ev.end))));
  for (let c = 0; c < 7; c++) {
    const d = addDays(start, c);
    for (const ev of cal.events.filter((e) => !isMultiDay(e) && e.date === d).sort((a, b) => a.order - b.order)) out.push(put(ev, c, c));
  }
  return out;
}
