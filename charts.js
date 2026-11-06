// SVG のグラフ（縦棒・折れ線）。色は style.css の --s1〜--s8 などを参照する。

export function yen(n) {
  const s = Math.abs(Math.round(n)).toLocaleString('ja-JP');
  return (n < 0 ? '−' : '') + '¥' + s;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * p;
}

function scale(min, max, count = 4) {
  if (max - min <= 0) max = min + 10000;
  const step = niceStep((max - min) / count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  return { lo, hi, ticks };
}

function tickFormatter(lo, hi) {
  const man = Math.max(Math.abs(lo), Math.abs(hi)) >= 10000;
  return (v) => {
    if (v === 0) return '0';
    if (!man) return v.toLocaleString('ja-JP');
    const m = v / 10000;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + '万';
  };
}

// 上側の角だけ丸めた棒（下側は基線に接して直角）
function barPath(x, top, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
}

const PAD = { l: 40, r: 10, t: 14, b: 24 };
const HEIGHT = 190;

function frame(el, n) {
  const W = Math.max(260, el.clientWidth || 320);
  const pw = W - PAD.l - PAD.r;
  const ph = HEIGHT - PAD.t - PAD.b;
  return { W, pw, ph, band: pw / n };
}

function gridAndAxis(s, f, W, yOf) {
  let out = '';
  for (const t of s.ticks) {
    const yy = yOf(t).toFixed(1);
    out += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${yy}" y2="${yy}" class="${t === 0 ? 'c-base' : 'c-grid'}"/>`;
    out += `<text x="${PAD.l - 6}" y="${yy}" class="c-tick" text-anchor="end" dominant-baseline="middle">${f(t)}</text>`;
  }
  return out;
}

function xLabels(labels, band, selected) {
  return labels
    .map((lb, i) => {
      const x = (PAD.l + band * (i + 0.5)).toFixed(1);
      return `<text x="${x}" y="${HEIGHT - 6}" class="c-tick${i === selected ? ' c-tick-sel' : ''}" text-anchor="middle">${esc(lb)}</text>`;
    })
    .join('');
}

function hitRects(n, band, ph) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `<rect class="c-hit" data-i="${i}" x="${(PAD.l + band * i).toFixed(1)}" y="0" width="${band.toFixed(1)}" height="${PAD.t + ph + PAD.b}"/>`;
  }
  return out;
}

// タップで期間を選び、マウスでは数値の吹き出しを出す
function bindInteraction(el, { n, band, tipHtml, onSelect }) {
  const tip = el.querySelector('.c-tip');
  el.querySelectorAll('.c-hit').forEach((r) => {
    r.addEventListener('click', () => onSelect && onSelect(Number(r.dataset.i)));
    r.addEventListener('pointerenter', (ev) => {
      if (ev.pointerType !== 'mouse') return;
      const i = Number(r.dataset.i);
      tip.innerHTML = tipHtml(i);
      tip.hidden = false;
      const cx = PAD.l + band * (i + 0.5);
      const w = tip.offsetWidth;
      const left = Math.min(Math.max(cx - w / 2, 0), el.clientWidth - w);
      tip.style.left = left + 'px';
    });
    r.addEventListener('pointerleave', () => (tip.hidden = true));
  });
}

/**
 * 縦棒グラフ（系列が2つ以上なら横に並べる）
 * series: [{ name, color: 'var(--s1)', values: number[] }]
 */
export function columnChart(el, { labels, series, selected, onSelect, ariaLabel }) {
  const n = labels.length;
  const { W, ph, band } = frame(el, n);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const s = scale(0, max || 10000);
  const f = tickFormatter(s.lo, s.hi);
  const yOf = (v) => PAD.t + ph - ((v - s.lo) / (s.hi - s.lo)) * ph;
  const k = series.length;
  const gap = 2;
  const bw = Math.max(3, Math.min(24, (band * 0.7 - gap * (k - 1)) / k));
  const gw = bw * k + gap * (k - 1);

  let svg = `<svg width="${W}" height="${HEIGHT}" viewBox="0 0 ${W} ${HEIGHT}" role="img" aria-label="${esc(ariaLabel || '')}">`;
  if (selected != null) {
    svg += `<rect x="${(PAD.l + band * selected).toFixed(1)}" y="${PAD.t - 6}" width="${band.toFixed(1)}" height="${ph + 6}" rx="6" class="c-sel"/>`;
  }
  svg += gridAndAxis(s, f, W, yOf);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      const v = series[j].values[i];
      if (!(v > 0)) continue;
      const x = PAD.l + band * i + (band - gw) / 2 + j * (bw + gap);
      const top = yOf(v);
      svg += `<path d="${barPath(x, top, bw, yOf(0) - top)}" fill="${series[j].color}"/>`;
    }
  }
  svg += xLabels(labels, band, selected);
  svg += hitRects(n, band, ph);
  svg += '</svg><div class="c-tip" hidden></div>';
  el.innerHTML = svg;

  bindInteraction(el, {
    n, band, onSelect,
    tipHtml: (i) =>
      `<div class="c-tip-title">${esc(labels[i])}</div>` +
      series
        .map((sr) => `<div class="c-tip-row"><span class="sw" style="background:${sr.color}"></span>${esc(sr.name)}<b>${yen(sr.values[i])}</b></div>`)
        .join(''),
  });
}

/** 折れ線グラフ（1系列） */
export function lineChart(el, { labels, values, color, selected, onSelect, ariaLabel, name }) {
  const n = labels.length;
  const { W, ph, band } = frame(el, n);
  const s = scale(Math.min(0, ...values), Math.max(0, ...values));
  const f = tickFormatter(s.lo, s.hi);
  const yOf = (v) => PAD.t + ph - ((v - s.lo) / (s.hi - s.lo)) * ph;
  const xOf = (i) => PAD.l + band * (i + 0.5);
  const pts = values.map((v, i) => [xOf(i), yOf(v)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const base = yOf(0).toFixed(1);
  const area = `${d}L${pts[n - 1][0].toFixed(1)},${base}L${pts[0][0].toFixed(1)},${base}Z`;

  let svg = `<svg width="${W}" height="${HEIGHT}" viewBox="0 0 ${W} ${HEIGHT}" role="img" aria-label="${esc(ariaLabel || '')}">`;
  if (selected != null) {
    svg += `<rect x="${(PAD.l + band * selected).toFixed(1)}" y="${PAD.t - 6}" width="${band.toFixed(1)}" height="${ph + 6}" rx="6" class="c-sel"/>`;
  }
  svg += gridAndAxis(s, f, W, yOf);
  svg += `<path d="${area}" fill="${color}" opacity="0.1"/>`;
  svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const dotAt = (i) =>
    `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="4" fill="${color}" stroke="var(--card)" stroke-width="2"/>`;
  svg += dotAt(n - 1);
  if (selected != null && selected !== n - 1) svg += dotAt(selected);
  svg += xLabels(labels, band, selected);
  svg += hitRects(n, band, ph);
  svg += '</svg><div class="c-tip" hidden></div>';
  el.innerHTML = svg;

  bindInteraction(el, {
    n, band, onSelect,
    tipHtml: (i) =>
      `<div class="c-tip-title">${esc(labels[i])}</div><div class="c-tip-row">${esc(name || '')}<b>${yen(values[i])}</b></div>`,
  });
}
