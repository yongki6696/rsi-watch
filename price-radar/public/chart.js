// 주식형 가격 차트 (TradingView lightweight-charts v4)
import { DAY, HOUR, MIN, nf, won, absWon, arrow, pctStr, dir, pad, cssVar, rgba, priceAt } from './lib.js';

const LWC = window.LightweightCharts;
export const RANGES = [['1D', '1일', DAY], ['1W', '1주', 7 * DAY], ['1M', '1개월', 30 * DAY], ['3M', '3개월', 90 * DAY], ['ALL', '전체', null]];
const STEPS = [10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
const tzShift = (t) => Math.floor(t / 1000) - new Date(t).getTimezoneOffset() * 60; // 차트는 UTC로 그리므로 현지 시각으로 민다

/**
 * lightweight-charts 는 점 사이 간격을 시간과 무관하게 똑같이 그린다.
 * 그래서 "가격이 바뀐 순간"만 있는 기록을 일정 간격으로 다시 나눠 시간 축이 왜곡되지 않게 한다.
 */
export function buildSeries(item, range) {
  const hist = item.history || [];
  const end = Math.max(item.lastFoundAt || 0, hist.length ? hist[hist.length - 1].t : 0, Date.now());
  if (!hist.length) return { line: [], candles: [], start: end, end, min: null, max: null, avg: null };
  const span0 = (RANGES.find(([k]) => k === range) || RANGES[2])[2];
  const start = span0 ? Math.max(hist[0].t, end - span0) : hist[0].t;
  if (end <= start) return { line: [], candles: [], start, end, min: null, max: null, avg: null };
  const off = (t) => t - new Date(t).getTimezoneOffset() * MIN;
  const inRange = [{ t: start, p: priceAt(hist, start) ?? hist[0].p }];
  for (const pt of hist) if (pt.t > start && pt.t <= end) inRange.push(pt);
  let min = inRange[0]; let max = inRange[0];
  for (const pt of inRange) { if (pt.p < min.p) min = pt; if (pt.p > max.p) max = pt; }

  const span = end - start;
  const step = STEPS.find((s) => span / s <= 300) || STEPS[STEPS.length - 1];
  const line = [];
  const push = (t, v) => { const time = tzShift(t); if (line.length && line[line.length - 1].time >= time) line[line.length - 1].value = v; else line.push({ time, value: v }); };
  push(start, inRange[0].p);
  let i = 1; let cur = inRange[0].p;
  const firstGrid = Math.ceil(off(start) / step) * step - (off(start) - start);
  for (let g = firstGrid; g < end + step; g += step) {
    const t = Math.min(g, end);
    let v = null;
    while (i < inRange.length && inRange[i].t <= t) {
      cur = inRange[i].p;
      if (cur === min.p || cur === max.p) v = cur; // 칸 안에 잠깐 있었던 최저/최고가도 놓치지 않게
      i++;
    }
    push(t, v ?? cur);
    if (t === end) break;
  }

  const cstep = range === '1D' ? HOUR : range === '1W' ? 6 * HOUR : span > 400 * DAY ? 7 * DAY : DAY;
  const candles = [];
  let j = 0; let last = null;
  const b0 = Math.floor(off(start) / cstep) * cstep - (off(start) - start);
  for (let b = b0; b <= end; b += cstep) {
    const bEnd = b + cstep;
    let o = last; let hi = last; let lo = last; let c = last;
    while (j < inRange.length && inRange[j].t < bEnd) {
      const v = inRange[j].p;
      if (o === null) { o = v; hi = v; lo = v; }
      hi = Math.max(hi, v); lo = Math.min(lo, v); c = v; last = v; j++;
    }
    if (o === null) continue;
    const time = tzShift(Math.max(b, start));
    const prev = candles[candles.length - 1];
    if (prev && prev.time >= time) { prev.high = Math.max(prev.high, hi); prev.low = Math.min(prev.low, lo); prev.close = c; } else candles.push({ time, open: o, high: hi, low: lo, close: c });
  }

  let area = 0;
  for (let k = 0; k < inRange.length; k++) {
    const t0 = inRange[k].t; const t1 = k + 1 < inRange.length ? inRange[k + 1].t : end;
    area += inRange[k].p * Math.max(0, t1 - t0);
  }
  return { line, candles, start, end, min, max, avg: span > 0 ? area / span : inRange[0].p, first: inRange[0].p, lastP: inRange[inRange.length - 1].p };
}

export class PriceChart {
  /**
   * @param {HTMLElement} el
   * @param {(info: null | {price:number, time:number, candle?:object}) => void} onHover
   */
  constructor(el, onHover) {
    this.el = el;
    this.onHover = onHover;
    this.empty = el.querySelector('.chart-empty');
    this.series = null;
    this.type = null;
    this.targetLine = null;
    this.chart = LWC.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: cssVar('--surface') }, textColor: cssVar('--text-2'), fontSize: 11, fontFamily: cssVar('--font') },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar('--grid') } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.12 } },
      timeScale: {
        borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (time, type) => {
          const d = new Date(time * 1000);
          if (type === 0) return `${d.getUTCFullYear()}년`;
          if (type === 1) return `${d.getUTCMonth() + 1}월`;
          if (type === 2) return `${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
          return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      crosshair: {
        mode: LWC.CrosshairMode.Magnet,
        vertLine: { color: cssVar('--text-3'), width: 1, style: LWC.LineStyle.Solid, labelBackgroundColor: cssVar('--btn') },
        horzLine: { color: cssVar('--text-3'), width: 1, style: LWC.LineStyle.Solid, labelBackgroundColor: cssVar('--btn') },
      },
      localization: {
        locale: 'ko-KR',
        priceFormatter: (v) => nf.format(Math.round(v)),
        timeFormatter: (time) => { const d = new Date(time * 1000); return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; },
      },
      handleScroll: { vertTouchDrag: false },
    });
    this.chart.subscribeCrosshairMove((param) => {
      const d = param && param.time !== undefined && this.series ? param.seriesData.get(this.series) : null;
      if (!d || !param.point || param.point.x < 0) { this.onHover(null); return; }
      this.onHover({ price: d.value !== undefined ? d.value : d.close, time: param.time, candle: d.close !== undefined ? d : null });
    });
  }

  _ensure(type) {
    if (this.series && this.type === type) return;
    if (this.series) { this.chart.removeSeries(this.series); this.series = null; this.targetLine = null; }
    const autoscaleInfoProvider = (original) => {
      const r = original();
      if (!r || !r.priceRange) return r;
      let { minValue, maxValue } = r.priceRange;
      if (maxValue - minValue < 1) { const v = minValue; minValue = v * 0.95; maxValue = v * 1.05; }
      // 목표가가 가까우면(현재 범위의 ±40% 안) 점선이 보이도록 범위를 넓힌다
      const t = this.target;
      if (t && t < minValue && t >= minValue * 0.6) minValue = t * 0.98;
      if (t && t > maxValue && t <= maxValue * 1.4) maxValue = t * 1.02;
      return { ...r, priceRange: { minValue, maxValue } };
    };
    this.series = type === 'candle'
      ? this.chart.addCandlestickSeries({
        upColor: cssVar('--up'), downColor: cssVar('--down'), wickUpColor: cssVar('--up'), wickDownColor: cssVar('--down'),
        borderVisible: false, priceLineVisible: true, priceLineStyle: LWC.LineStyle.Solid, priceLineWidth: 1, autoscaleInfoProvider,
      })
      : this.chart.addAreaSeries({
        lineWidth: 2, lineType: LWC.LineType.WithSteps, priceLineVisible: true, priceLineStyle: LWC.LineStyle.Solid, priceLineWidth: 1,
        crosshairMarkerRadius: 4, crosshairMarkerBorderColor: cssVar('--surface'), crosshairMarkerBorderWidth: 2, autoscaleInfoProvider,
      });
    this.type = type;
  }

  /** @returns 계산된 구간 정보 (평균가 등) */
  setData(item, { range, type, fit }) {
    this.target = item.targetPrice || null;
    this._ensure(type);
    const data = buildSeries(item, range);
    const hist = item.history || [];
    const tooShort = !hist.length || data.end - hist[0].t < 30 * MIN;
    if (this.empty) {
      this.empty.hidden = !tooShort;
      this.empty.textContent = hist.length
        ? `첫 가격 ${won(hist[0].p)}을 기록했어요. 다음 확인부터 변동이 차트에 쌓여요.`
        : '아직 가격을 확인하지 못했어요. 첫 확인을 기다리는 중…';
    }
    const line = tooShort ? [] : data.line;
    const candles = tooShort ? [] : data.candles;
    const trend = data.lastP !== undefined ? data.lastP - data.first : 0;
    const color = trend > 0 ? cssVar('--up') : trend < 0 ? cssVar('--down') : cssVar('--text-2');
    if (type === 'candle') {
      const flat = cssVar('--flat');
      this.series.setData(candles.map((c) => (c.open === c.close ? { ...c, color: flat, wickColor: flat } : c)));
      this.series.setMarkers([]);
    } else {
      this.series.applyOptions({ lineColor: color, topColor: rgba(color, 0.22), bottomColor: rgba(color, 0), priceLineColor: color });
      this.series.setData(line);
      const marks = [];
      if (line.length > 1 && data.min && data.max && data.min.p !== data.max.p) {
        const t0 = line[0].time; const t1 = line[line.length - 1].time;
        const inside = (t) => { const f = (t - t0) / Math.max(1, t1 - t0); return f > 0.05 && f < 0.93; }; // 가장자리 글자는 잘리므로 생략
        const findT = (target, from) => { const tt = tzShift(from); for (const pt of line) if (pt.time >= tt && pt.value === target) return pt.time; return null; };
        const tMin = findT(data.min.p, data.min.t); const tMax = findT(data.max.p, data.max.t);
        if (tMin && inside(tMin)) marks.push({ time: tMin, position: 'belowBar', color: cssVar('--text-2'), shape: 'arrowUp', text: `최저 ${nf.format(data.min.p)}` });
        if (tMax && inside(tMax)) marks.push({ time: tMax, position: 'aboveBar', color: cssVar('--text-2'), shape: 'arrowDown', text: `최고 ${nf.format(data.max.p)}` });
        marks.sort((a, b) => a.time - b.time);
      }
      this.series.setMarkers(marks);
    }
    if (this.targetLine) { this.series.removePriceLine(this.targetLine); this.targetLine = null; }
    if (item.targetPrice) {
      this.targetLine = this.series.createPriceLine({ price: item.targetPrice, color: cssVar('--text-2'), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '목표가' });
    }
    if (fit) this.chart.timeScale().fitContent();
    return data;
  }

  destroy() { this.chart.remove(); }
}

/** 차트에 손가락을 올렸을 때 위쪽 큰 가격 영역 문구 */
export function hoverText(info, currentPrice) {
  const diff = info.price - currentPrice;
  const t = new Date(info.time * 1000);
  const when = `${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일 ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  return {
    price: won(info.price),
    chg: diff === 0 ? '지금과 같은 가격' : `지금보다 ${absWon(diff)}원 ${diff > 0 ? '비쌌어요' : '쌌어요'} (${arrow(diff)} ${pctStr((diff / currentPrice) * 100)})`,
    cls: dir(diff),
    when: info.candle ? `${when} · 시작 ${nf.format(info.candle.open)} · 고 ${nf.format(info.candle.high)} · 저 ${nf.format(info.candle.low)}` : `${when} 기준`,
  };
}
