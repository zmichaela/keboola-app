// server_ux.js
// A simpler, more interactive UI for visualizing Keboola Data App Input Mapping CSVs.
import express from 'express';
import fs from 'node:fs';

const app = express();
const PORT = process.env.PORT || 3000;

const DATASETS = [
  {
    key: 'monthly_listening_trends',
    label: 'Monthly Listening Trends',
    path: '/data/in/tables/monthly_listening_trends.csv',
  },
  {
    key: 'artist_leaderboard',
    label: 'Artist Leaderboard',
    path: '/data/in/tables/artist_leaderboard.csv',
  },
];

const MONTHLY_CHARTS = [
  { key: 'hours_line', label: 'Line: MONTH vs TOTAL_HOURS' },
  { key: 'hours_area', label: 'Area: MONTH vs TOTAL_HOURS' },
  { key: 'unique_bar', label: 'Bar: MONTH vs UNIQUE_ARTISTS' },
  { key: 'combo', label: 'Combo: HOURS + PLAYS' },
  { key: 'top_artist_timeline', label: 'Top Artist Timeline' },
];

const ARTIST_CHARTS = [
  { key: 'top_hours_bar', label: 'Horizontal Bar: artist_name vs TOTAL_HOURS' },
  { key: 'hours_vs_skip_scatter', label: 'Scatter: TOTAL_HOURS vs SKIP_RATE_PCT' },
  { key: 'hours_plays_bubble', label: 'Bubble: HOURS vs PLAYS (size=followers)' },
];

const PALETTE = [
  '#2563eb',
  '#16a34a',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#e11d48',
  '#0ea5e9',
  '#22c55e',
  '#3b82f6',
  '#f97316',
  '#a855f7',
  '#db2777',
  '#10b981',
];

function colorForKey(key) {
  const s = String(key ?? '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function parseCsv(csvText) {
  const input = csvText.trim();
  if (!input) return { headers: [], rows: [] };

  const rows = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;

  // RFC4180-ish: supports commas/newlines inside double quotes.
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = i + 1 < input.length ? input[i + 1] : '';

    if (ch === '"' && inQuotes && next === '"') {
      currentField += '"';
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && ch === ',') {
      currentRow.push(currentField);
      currentField = '';
      continue;
    }

    if (!inQuotes && ch === '\n') {
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      continue;
    }

    if (!inQuotes && ch === '\r') continue;
    currentField += ch;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  const [headerRow, ...dataRows] = rows;
  return { headers: headerRow || [], rows: dataRows };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseNumeric(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Handle "1,234.56" and "1,23" (decimal comma).
  const normalized =
    raw.includes(',') && raw.includes('.')
      ? raw.replace(/,/g, '')
      : raw.includes(',') && !raw.includes('.')
        ? raw.replace(/,/g, '.')
        : raw;

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function normalizeHeaderValue(value) {
  return String(value ?? '').trim().toUpperCase();
}

function findColumnIndex(headers, candidates) {
  const normalizedCandidates = (candidates || []).map(normalizeHeaderValue);
  for (const cand of normalizedCandidates) {
    const idx = headers.findIndex((h) => normalizeHeaderValue(h) === cand);
    if (idx >= 0) return idx;
  }

  // Substring fallback for small naming differences.
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeaderValue(headers[i]);
    for (const cand of normalizedCandidates) {
      if (cand && h.includes(cand)) return i;
    }
  }

  return -1;
}

function parseMonthToTime(monthValue) {
  const s = String(monthValue ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  return null;
}

function getCell(row, idx) {
  return idx >= 0 ? row[idx] : undefined;
}

function formatShortNumber(n) {
  if (n === null || n === undefined) return '';
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return String(n);
  const abs = Math.abs(num);
  const units = [
    { v: 1e12, s: 'T' },
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
  ];
  for (const u of units) {
    if (abs >= u.v) return `${(num / u.v).toFixed(2)}${u.s}`;
  }
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function buildSvgLine({ width, height, padLeft, padRight, padTop, padBottom, xCount, xAt, yAt, stroke, fill }) {
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const baselineY = padTop + innerH;

  const points = [];
  for (let i = 0; i < xCount; i++) {
    const x = xAt(i);
    const y = yAt(i);
    if (x === null || y === null) continue;
    points.push([x, y]);
  }

  const polylinePoints = points.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  let areaPoints = '';
  if (fill) {
    const first = points[0];
    const last = points[points.length - 1];
    const area = [...points, [last[0], baselineY], [first[0], baselineY]];
    areaPoints = area.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  }

  return `
    ${
      fill
        ? `<polygon points="${areaPoints}" fill="${fill}" stroke="none" />`
        : ''
    }
    <polyline fill="none" stroke="${stroke}" stroke-width="3" points="${polylinePoints}" />
    ${points
      .map(
        (p) => `
        <circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="${stroke}" />
      `,
      )
      .join('')}
  `;
}

function buildAxes({ width, height, padLeft, padRight, padTop, padBottom, yMin, yMax }) {
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const ticks = [0, 1 / 3, 2 / 3, 1].map((t) => yMin + (yMax - yMin) * t);

  const tickHtml = ticks
    .map((val, idx) => {
      const y = padTop + innerH * (1 - idx / (ticks.length - 1 || 1));
      return `
        <g>
          <line x1="${padLeft}" x2="${width - padRight}" y1="${y}" y2="${y}" stroke="#e5e7eb" />
          <text x="${padLeft - 8}" y="${y + 4}" font-size="11" fill="#6b7280" text-anchor="end">${formatShortNumber(val)}</text>
        </g>
      `;
    })
    .join('');

  return tickHtml;
}

function renderMonthlyChart({ headers, rows, chartKey, monthLow, monthHigh }) {
  const idxMonth = findColumnIndex(headers, ['MONTH']);
  const idxHours = findColumnIndex(headers, ['TOTAL_HOURS']);
  const idxPlays = findColumnIndex(headers, ['TOTAL_PLAYS']);
  const idxUniqueArtists = findColumnIndex(headers, ['UNIQUE_ARTISTS']);
  const idxTopArtist = findColumnIndex(headers, ['TOP_ARTIST']);
  const idxTopArtistHours = findColumnIndex(headers, ['TOP_ARTIST_HOURS']);

  const missing = [];
  if (idxMonth < 0) missing.push('MONTH');
  if (idxHours < 0 && (chartKey === 'hours_line' || chartKey === 'hours_area' || chartKey === 'combo' || chartKey === 'top_artist_timeline')) missing.push('TOTAL_HOURS');
  if (idxPlays < 0 && chartKey === 'combo') missing.push('TOTAL_PLAYS');
  if (idxUniqueArtists < 0 && chartKey === 'unique_bar') missing.push('UNIQUE_ARTISTS');
  if (idxTopArtist < 0 && chartKey === 'top_artist_timeline') missing.push('TOP_ARTIST');
  if (idxTopArtistHours < 0 && chartKey === 'top_artist_timeline') missing.push('TOP_ARTIST_HOURS');

  if (missing.length) {
    return `<div style="margin-top:16px;color:#6b7280;">Missing columns: ${escapeHtml(missing.join(', '))}</div>`;
  }

  const parsed = rows
    .map((r) => {
      const monthTime = parseMonthToTime(getCell(r, idxMonth));
      return { monthTime, monthRaw: getCell(r, idxMonth), r };
    })
    .sort((a, b) => {
      if (a.monthTime !== null && b.monthTime !== null) return a.monthTime - b.monthTime;
      if (a.monthTime !== null) return -1;
      if (b.monthTime !== null) return 1;
      return String(a.monthRaw).localeCompare(String(b.monthRaw));
    })
    .map((x) => x.r);

  const n = parsed.length;
  const low = Math.max(0, Math.min(n - 1, monthLow));
  const high = Math.max(low, Math.min(n - 1, monthHigh));
  const filtered = parsed.slice(low, high + 1);
  const labels = filtered.map((r) => String(getCell(r, idxMonth)));

  const hours = filtered.map((r) => parseNumeric(getCell(r, idxHours)));
  const plays = filtered.map((r) => parseNumeric(getCell(r, idxPlays)));
  const unique = filtered.map((r) => parseNumeric(getCell(r, idxUniqueArtists)));
  const topArtist = filtered.map((r) => String(getCell(r, idxTopArtist)));
  const topHours = filtered.map((r) => parseNumeric(getCell(r, idxTopArtistHours)));

  const chartW = 900;
  const chartH = 360;
  const padLeft = 70;
  const padRight = 24;
  const padTop = 26;
  const padBottom = 52;

  const xCount = filtered.length;
  const xAt = (i) => padLeft + (chartW - padLeft - padRight) * (xCount === 1 ? 0 : i / (xCount - 1));

  const valuesForScale =
    chartKey === 'hours_line' || chartKey === 'hours_area' ? hours : chartKey === 'unique_bar' ? unique : chartKey === 'combo' ? hours.concat(plays) : topHours;
  const numericVals = valuesForScale.filter((v) => v !== null && v !== undefined);
  const yMax = numericVals.length ? Math.max(...numericVals) : 1;
  const yMin = 0;

  const yAt = (i) => {
    let v = 0;
    if (chartKey === 'hours_line' || chartKey === 'hours_area') v = hours[i] ?? 0;
    else if (chartKey === 'unique_bar') v = unique[i] ?? 0;
    else if (chartKey === 'combo') v = hours[i] ?? 0; // for axes; hours scale
    else if (chartKey === 'top_artist_timeline') v = topHours[i] ?? 0;

    const t = yMax === yMin ? 0 : (v - yMin) / (yMax - yMin);
    const innerH = chartH - padTop - padBottom;
    return padTop + innerH * (1 - t);
  };

  const axes = buildAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMin, yMax });

  const xTickHtml = (() => {
    if (xCount <= 1) return '';
    const indices = [0, Math.floor((xCount - 1) / 3), Math.floor((2 * (xCount - 1)) / 3), xCount - 1].filter(
      (v, idx, arr) => arr.indexOf(v) === idx,
    );
    return indices
      .map((i) => {
        const x = xAt(i);
        const label = labels[i] ?? '';
        return `<text x="${x}" y="${chartH - 20}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(
          label.length > 12 ? label.slice(0, 12) : label,
        )}</text>`;
      })
      .join('');
  })();

  if (chartKey === 'hours_line') {
    const line = buildSvgLine({
      width: chartW,
      height: chartH,
      padLeft,
      padRight,
      padTop,
      padBottom,
      xCount,
      xAt: (i) => xAt(i),
      yAt: (i) => yAt(i),
      stroke: '#2563eb',
      fill: null,
    });

    return `
      <div style="margin-top:16px;">
        <h3 style="margin:0 0 10px 0;font-size:16px;">Line: MONTH vs TOTAL_HOURS</h3>
        <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
          ${axes}
          ${line}
          ${xTickHtml}
        </svg>
      </div>
    `;
  }

  if (chartKey === 'hours_area') {
    const area = buildSvgLine({
      width: chartW,
      height: chartH,
      padLeft,
      padRight,
      padTop,
      padBottom,
      xCount,
      xAt: (i) => xAt(i),
      yAt: (i) => yAt(i),
      stroke: '#2563eb',
      fill: 'rgba(37, 99, 235, 0.18)',
    });

    return `
      <div style="margin-top:16px;">
        <h3 style="margin:0 0 10px 0;font-size:16px;">Area: MONTH vs TOTAL_HOURS</h3>
        <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
          ${axes}
          ${area}
          ${xTickHtml}
        </svg>
      </div>
    `;
  }

  if (chartKey === 'unique_bar') {
    const innerW = chartW - padLeft - padRight;
    const innerH = chartH - padTop - padBottom;
    const barGap = 2;
    const barW = innerW / xCount - barGap;

    const bars = filtered
      .map((r, i) => {
        const v = unique[i] ?? 0;
        const t = yMax === 0 ? 0 : v / yMax;
        const h = innerH * t;
        const x = padLeft + i * (barW + barGap);
        const y = padTop + innerH - h;
        const label = escapeHtml(labels[i] ?? '');
        return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(
          2,
        )}" rx="4" fill="#f59e0b">
          <title>${label} • ${formatShortNumber(v)}</title>
        </rect>`;
      })
      .join('');

    return `
      <div style="margin-top:16px;">
        <h3 style="margin:0 0 10px 0;font-size:16px;">Bar: MONTH vs UNIQUE_ARTISTS</h3>
        <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
          ${axes}
          ${bars}
          ${xTickHtml}
        </svg>
      </div>
    `;
  }

  if (chartKey === 'combo') {
    const hoursVals = hours.map((v) => v ?? 0);
    const playsVals = plays.map((v) => v ?? 0);
    const all = hoursVals.concat(playsVals);
    const maxAll = all.length ? Math.max(...all) : 1;

    const yAtCombo = (i, series) => {
      const v = series === 'hours' ? hours[i] ?? 0 : plays[i] ?? 0;
      const t = maxAll === 0 ? 0 : v / maxAll;
      const innerH = chartH - padTop - padBottom;
      return padTop + innerH * (1 - t);
    };

    const hoursLine = buildSvgLine({
      width: chartW,
      height: chartH,
      padLeft,
      padRight,
      padTop,
      padBottom,
      xCount,
      xAt: (i) => xAt(i),
      yAt: (i) => yAtCombo(i, 'hours'),
      stroke: '#2563eb',
      fill: null,
    });
    const playsLine = buildSvgLine({
      width: chartW,
      height: chartH,
      padLeft,
      padRight,
      padTop,
      padBottom,
      xCount,
      xAt: (i) => xAt(i),
      yAt: (i) => yAtCombo(i, 'plays'),
      stroke: '#10b981',
      fill: null,
    });

    const legend = `
      <g>
        <rect x="${padLeft}" y="10" width="12" height="12" fill="#2563eb" />
        <text x="${padLeft + 18}" y="22" font-size="12" fill="#111827">Hours</text>
        <rect x="${padLeft + 110}" y="10" width="12" height="12" fill="#10b981" />
        <text x="${padLeft + 128}" y="22" font-size="12" fill="#111827">Plays</text>
      </g>
    `;

    return `
      <div style="margin-top:16px;">
        <h3 style="margin:0 0 10px 0;font-size:16px;">Combo: HOURS + PLAYS</h3>
        <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
          ${legend}
          ${buildAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMin: 0, yMax: maxAll })}
          ${hoursLine}
          ${playsLine}
          ${xTickHtml}
        </svg>
      </div>
    `;
  }

  if (chartKey === 'top_artist_timeline') {
    // Simple colored bars by TOP_ARTIST; tooltips show top artist + hours.
    const innerW = chartW - padLeft - padRight;
    const innerH = chartH - padTop - padBottom;
    const barGap = 2;
    const barW = innerW / xCount - barGap;
    const maxVal = topHours.filter((v) => v !== null).reduce((m, v) => Math.max(m, v ?? 0), 0) || 1;

    const bars = filtered
      .map((r, i) => {
        const v = topHours[i] ?? 0;
        const t = maxVal === 0 ? 0 : v / maxVal;
        const h = innerH * t;
        const x = padLeft + i * (barW + barGap);
        const y = padTop + innerH - h;
        const artist = topArtist[i] ?? '';
        const color = colorForKey(artist);
        return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(
          2,
        )}" rx="4" fill="${color}">
          <title>${escapeHtml(labels[i] ?? '')} • ${escapeHtml(artist)} • ${formatShortNumber(v)} hours</title>
        </rect>`;
      })
      .join('');

    return `
      <div style="margin-top:16px;">
        <h3 style="margin:0 0 10px 0;font-size:16px;">Top Artist Timeline</h3>
        <div style="color:#6b7280;margin-bottom:8px;">Bar color = top artist; height = top artist hours.</div>
        <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
          ${buildAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMin: 0, yMax: maxVal })}
          ${bars}
          ${xTickHtml}
        </svg>
      </div>
    `;
  }

  return `<div style="margin-top:16px;color:#6b7280;">Unknown monthly chart.</div>`;
}

function renderArtistChart({ headers, rows, chartKey, topN, skipMinPct }) {
  const idxName = findColumnIndex(headers, ['artist_name', 'ARTIST_NAME', 'artist']);
  const idxHours = findColumnIndex(headers, ['TOTAL_HOURS']);
  const idxSkip = findColumnIndex(headers, ['SKIP_RATE_PCT', 'SKIP_PCT', 'SKIP_RATE']);
  const idxPlays = findColumnIndex(headers, ['TOTAL_PLAYS', 'PLAYS']);
  const idxFollowers = findColumnIndex(headers, ['FOLLOWERS', 'follower']);

  const missing = [];
  if (idxName < 0) missing.push('artist_name');
  if (idxHours < 0) missing.push('TOTAL_HOURS');
  if (chartKey === 'hours_vs_skip_scatter' && idxSkip < 0) missing.push('SKIP_RATE_PCT');
  if (chartKey === 'hours_plays_bubble' && idxPlays < 0) missing.push('TOTAL_PLAYS');

  if (missing.length) {
    return `<div style="margin-top:16px;color:#6b7280;">Missing columns: ${escapeHtml(missing.join(', '))}</div>`;
  }

  const parsed = rows
    .map((r) => {
      const name = getCell(r, idxName);
      const hours = parseNumeric(getCell(r, idxHours));
      const skipPct = idxSkip >= 0 ? parseNumeric(getCell(r, idxSkip)) : null;
      const plays = idxPlays >= 0 ? parseNumeric(getCell(r, idxPlays)) : null;
      const followers = idxFollowers >= 0 ? parseNumeric(getCell(r, idxFollowers)) : null;
      return { name, hours, skipPct, plays, followers, raw: r };
    })
    .filter((x) => x.name !== undefined && x.hours !== null)
    .filter((x) => (skipMinPct !== null && x.skipPct !== null ? x.skipPct >= skipMinPct : true))
    .sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))
    .slice(0, Math.max(1, Math.min(topN, rows.length)));

  const chartW = 900;
  const chartH = 360;
  const padLeft = 200;
  const padRight = 24;
  const padTop = 26;
  const padBottom = 52;
  const innerW = chartW - padLeft - padRight;
  const innerH = chartH - padTop - padBottom;

  if (chartKey === 'top_hours_bar') {
    const maxVal = parsed.reduce((m, v) => Math.max(m, v.hours ?? 0), 0) || 1;
    const n = Math.max(1, parsed.length);
    const minBarH = 8;
    // Add some gap between bars, but keep the layout within the SVG height.
    // When n is large (e.g., 50), the gap collapses automatically.
    let barGap = 6;
    const remainingForGap = innerH - n * minBarH;
    if (remainingForGap < 0) barGap = 0;
    else barGap = Math.min(6, Math.floor(remainingForGap / Math.max(1, n - 1)));
    const barH = Math.max(4, Math.floor((innerH - barGap * (n - 1)) / n));

    const bars = parsed
      .map((t, i) => {
        const x = padLeft;
        const w = innerW * ((t.hours ?? 0) / maxVal);
        const y = padTop + i * (barH + barGap);
        const h = barH;
        const c = colorForKey(t.name);
        return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${c}">
          <title>${escapeHtml(t.name)} • ${formatShortNumber(t.hours)} hours</title>
        </rect>
        <text x="${padLeft - 10}" y="${y + h / 2 + 4}" font-size="12" fill="#111827" text-anchor="end">${escapeHtml(
          String(t.name).length > 22 ? `${String(t.name).slice(0, 22)}…` : String(t.name),
        )}</text>`;
      })
      .join('');

    const axisRight = padLeft + innerW;
    return `
      <div style="margin-top:16px;">
        <h3 style="margin:0 0 10px 0;font-size:16px;">Horizontal Bar: TOTAL_HOURS</h3>
        <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
          <line x1="${padLeft}" x2="${axisRight}" y1="${chartH - padBottom}" y2="${chartH - padBottom}" stroke="#e5e7eb" />
          ${bars}
        </svg>
      </div>
    `;
  }

  if (chartKey === 'hours_vs_skip_scatter') {
    const xMax = parsed.reduce((m, v) => Math.max(m, v.hours ?? 0), 0) || 1;
    const xMin = parsed.reduce((m, v) => Math.min(m, v.hours ?? 0), 0) || 0;
    const yVals = parsed.map((p) => p.skipPct).filter((v) => v !== null);
    const yMax = yVals.length ? Math.max(...yVals) : 1;
    const yMin = yVals.length ? Math.min(...yVals) : 0;

    const xAt = (v) => padLeft + innerW * ((v - xMin) / Math.max(1e-9, xMax - xMin));
    const yAt = (v) => padTop + innerH * (1 - (v - yMin) / Math.max(1e-9, yMax - yMin));

    const points = parsed
      .filter((p) => p.skipPct !== null)
      .map((p) => {
        const cx = xAt(p.hours ?? 0);
        const cy = yAt(p.skipPct ?? 0);
        const c = colorForKey(p.name);
        return `<circle cx="${cx}" cy="${cy}" r="5" fill="${c}" opacity="0.85">
          <title>${escapeHtml(p.name)} • Hours ${formatShortNumber(p.hours)} • Skip ${formatShortNumber(p.skipPct)}%</title>
        </circle>`;
      })
      .join('');

    return `
      <div style="margin-top:16px;">
        <h3 style="margin:0 0 10px 0;font-size:16px;">Scatter: Hours vs Skip Rate</h3>
        <div style="color:#6b7280;margin-bottom:8px;">X = TOTAL_HOURS, Y = SKIP_RATE_PCT</div>
        <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
          ${buildAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMin, yMax })}
          <line x1="${padLeft}" x2="${chartW - padRight}" y1="${chartH - padBottom}" y2="${chartH - padBottom}" stroke="#e5e7eb" />
          ${points}
        </svg>
      </div>
    `;
  }

  // hours_plays_bubble
  const xMax = parsed.reduce((m, v) => Math.max(m, v.hours ?? 0), 0) || 1;
  const yMax = parsed.reduce((m, v) => Math.max(m, v.plays ?? 0), 0) || 1;
  const xAt = (v) => padLeft + innerW * ((v ?? 0) / xMax);
  const yAt = (v) => padTop + innerH * (1 - (v ?? 0) / yMax);

  const followersVals = parsed.map((p) => p.followers).filter((v) => v !== null);
  const fMax = followersVals.length ? Math.max(...followersVals) : 1;

  const points = parsed
    .map((p) => {
      const cx = xAt(p.hours ?? 0);
      const cy = yAt(p.plays ?? 0);
      const size = p.followers === null ? 8 : 6 + 18 * ((p.followers ?? 0) / Math.max(1e-9, fMax));
      const c = colorForKey(p.name);
      return `<circle cx="${cx}" cy="${cy}" r="${size.toFixed(1)}" fill="${c}" opacity="0.25" stroke="${c}" stroke-width="1.3">
        <title>${escapeHtml(p.name)} • Hours ${formatShortNumber(p.hours)} • Plays ${formatShortNumber(p.plays)} • Followers ${formatShortNumber(p.followers)}</title>
      </circle>`;
    })
    .join('');

  return `
    <div style="margin-top:16px;">
      <h3 style="margin:0 0 10px 0;font-size:16px;">Bubble: Hours vs Plays</h3>
      <div style="color:#6b7280;margin-bottom:8px;">X = TOTAL_HOURS, Y = TOTAL_PLAYS, size = followers (if present)</div>
      <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
        ${buildAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMin: 0, yMax })}
        <line x1="${padLeft}" x2="${chartW - padRight}" y1="${chartH - padBottom}" y2="${chartH - padBottom}" stroke="#e5e7eb" />
        ${points}
      </svg>
    </div>
  `;
}

app.all('/', (req, res) => {
  try {
    const requestedDatasetKey = typeof req.query.dataset === 'string' ? req.query.dataset : DATASETS[0].key;
    const dataset = DATASETS.find((d) => d.key === requestedDatasetKey) || DATASETS[0];

    // Monthly filters (index-based).
    const monthLow = Number.isFinite(Number(req.query.monthLow)) ? Number(req.query.monthLow) : 0;
    const monthHigh = Number.isFinite(Number(req.query.monthHigh)) ? Number(req.query.monthHigh) : 9999;

    // Artist filters.
    const topN = Number.isFinite(Number(req.query.topN)) ? Number(req.query.topN) : 50;
    const skipMinPctRaw = typeof req.query.skipMinPct === 'string' ? req.query.skipMinPct : '';
    const skipMinPct = skipMinPctRaw ? parseNumeric(skipMinPctRaw) : null;

    const csvText = fs.readFileSync(dataset.path, 'utf8');
    const { headers, rows } = parseCsv(csvText);

    let chartKey = '';
    if (dataset.key === 'monthly_listening_trends') {
      const defaultKey = 'hours_line';
      chartKey = typeof req.query.viz === 'string' ? req.query.viz : defaultKey;
      if (!MONTHLY_CHARTS.some((c) => c.key === chartKey)) chartKey = defaultKey;
    } else {
      const defaultKey = 'top_hours_bar';
      chartKey = typeof req.query.viz === 'string' ? req.query.viz : defaultKey;
      if (!ARTIST_CHARTS.some((c) => c.key === chartKey)) chartKey = defaultKey;
    }

    const pageTitle = `${dataset.label} • Preview`;

    // Controls
    const datasetSelector = `
      <div class="control">
        <div class="label">Dataset</div>
        <select id="datasetSelect" onchange="applyUrl()">
          ${DATASETS.map((d) => {
            const selected = d.key === dataset.key ? 'selected' : '';
            return `<option value="${escapeHtml(d.key)}" ${selected}>${escapeHtml(d.label)}</option>`;
          }).join('')}
        </select>
      </div>
    `;

    const chartSelectorOptions = (dataset.key === 'monthly_listening_trends' ? MONTHLY_CHARTS : ARTIST_CHARTS)
      .map((c) => `<option value="${escapeHtml(c.key)}" ${c.key === chartKey ? 'selected' : ''}>${escapeHtml(c.label)}</option>`)
      .join('');

    const chartSelector = `
      <div class="control">
        <div class="label">Chart</div>
        <select id="vizSelect" onchange="applyUrl()">${chartSelectorOptions}</select>
      </div>
    `;

    const monthlyControls = (() => {
      if (dataset.key !== 'monthly_listening_trends') return '';
      const idxMonth = findColumnIndex(headers, ['MONTH']);
      const parsed = rows
        .map((r) => ({ monthTime: parseMonthToTime(getCell(r, idxMonth)), r }))
        .sort((a, b) => {
          if (a.monthTime !== null && b.monthTime !== null) return a.monthTime - b.monthTime;
          if (a.monthTime !== null) return -1;
          if (b.monthTime !== null) return 1;
          return 0;
        })
        .map((x) => x.r);
      const n = parsed.length;
      const safeLow = Math.max(0, Math.min(n - 1, monthLow));
      const safeHigh = Math.max(safeLow, Math.min(n - 1, monthHigh === 9999 ? n - 1 : monthHigh));

      return `
        <div class="control control-wide">
          <div class="label">Month range</div>
          <div class="rangeRow">
            <div class="rangeBox">
              <div class="smallLabel">From</div>
              <input id="monthLow" type="range" min="0" max="${n - 1}" value="${safeLow}" oninput="onMonthRangeInput()"/>
              <div class="value">${escapeHtml(String(safeLow))}</div>
            </div>
            <div class="rangeBox">
              <div class="smallLabel">To</div>
              <input id="monthHigh" type="range" min="0" max="${n - 1}" value="${safeHigh}" oninput="onMonthRangeInput()"/>
              <div class="value">${escapeHtml(String(safeHigh))}</div>
            </div>
          </div>
        </div>
      `;
    })();

    const artistControls = (() => {
      if (dataset.key !== 'artist_leaderboard') return '';
      return `
        <div class="control control-wide">
          <div class="label">Filters</div>
          <div class="rangeRow">
            <div class="rangeBox">
              <div class="smallLabel">Top N</div>
              <input id="topN" type="range" min="1" max="50" value="${Math.max(1, Math.min(50, topN))}" oninput="document.getElementById('topNVal').textContent=this.value"/>
              <div class="value"><span id="topNVal">${Math.max(1, Math.min(50, topN))}</span></div>
            </div>
            <div class="rangeBox">
              <div class="smallLabel">Skip min %</div>
              <input id="skipMinPct" type="number" step="0.1" value="${skipMinPct === null ? '' : escapeHtml(String(skipMinPct))}" placeholder="optional" oninput="applyUrlDebounced()"/>
            </div>
          </div>
        </div>
      `;
    })();

    const chartHtml = (() => {
      if (dataset.key === 'monthly_listening_trends') return renderMonthlyChart({ headers, rows, chartKey, monthLow, monthHigh });
      return renderArtistChart({ headers, rows, chartKey, topN, skipMinPct });
    })();

    // Table preview: first 8 rows of filtered set (for readability).
    const previewHtml = (() => {
      const tableHeaders = headers.slice(0, 10);
      const previewRows =
        dataset.key === 'monthly_listening_trends'
          ? rows.slice(0, 8)
          : rows.slice(0, 8);
      const th = tableHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
      const tr = previewRows
        .map((r) => `<tr>${tableHeaders.map((_, i) => `<td>${escapeHtml(r[i])}</td>`).join('')}</tr>`)
        .join('');
      return `
        <div class="tableWrap">
          <div class="tableTitle">Preview (first rows)</div>
          <div class="tableScroller">
            <table>
              <thead><tr>${th}</tr></thead>
              <tbody>${tr}</tbody>
            </table>
          </div>
        </div>
      `;
    })();

    const monthJs = dataset.key === 'monthly_listening_trends'
      ? `
      function onMonthRangeInput() {
        const lowEl = document.getElementById('monthLow');
        const highEl = document.getElementById('monthHigh');
        const lowVal = Number(lowEl.value);
        const highVal = Number(highEl.value);
        if (lowVal > highVal) {
          lowEl.value = highVal;
        }
        document.querySelectorAll('.rangeBox .value')[0].textContent = lowEl.value;
        document.querySelectorAll('.rangeBox .value')[1].textContent = highEl.value;
        applyUrlDebounced();
      }
    `
      : '';

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${escapeHtml(pageTitle)}</title>
          <style>
            :root { --bg:#f6f7fb; --card:#ffffff; --border:#e5e7eb; --text:#111827; --muted:#6b7280; --brand:#2563eb; }
            body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin:0; background:var(--bg); color:var(--text); }
            .wrap { max-width: 1120px; margin: 0 auto; padding: 22px; }
            .hero { background: linear-gradient(135deg, rgba(37,99,235,0.10), rgba(16,185,129,0.08)); border:1px solid rgba(229,231,235,0.9); border-radius: 16px; padding: 18px 18px; }
            h1 { margin:0; font-size: 18px; letter-spacing: -0.01em; }
            .sub { margin-top:6px; color:var(--muted); font-size: 13px; }
            .grid { display:grid; grid-template-columns: 1fr; gap: 14px; margin-top: 14px; }
            @media (min-width: 980px) { .grid { grid-template-columns: 1fr 420px; align-items:start; } }
            .card { background: var(--card); border:1px solid var(--border); border-radius:16px; padding: 14px; }
            .controls { display:flex; flex-wrap:wrap; gap: 12px; align-items:flex-end; margin-top: 12px; }
            .control { display:flex; flex-direction:column; gap: 6px; min-width: 220px; }
            .control-wide { width: 100%; }
            .label { font-size: 12px; color:var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
            select { padding: 10px 10px; border:1px solid var(--border); border-radius: 12px; background:#fff; color:#111827; font-weight: 600; }
            input[type="range"] { width: 100%; }
            input[type="number"] { padding: 10px 10px; border:1px solid var(--border); border-radius: 12px; background:#fff; color:#111827; font-weight: 600; width: 160px; }
            .rangeRow { display:flex; flex-wrap:wrap; gap: 14px; align-items:center; }
            .rangeBox { flex: 1; min-width: 240px; }
            .smallLabel { font-size: 13px; color:#374151; font-weight: 700; margin-bottom: 6px; }
            .value { font-size: 12px; color: var(--muted); margin-top: 6px; }
            .tableWrap { padding: 0; }
            .tableTitle { font-size: 13px; color:#374151; font-weight: 800; margin-bottom: 8px; }
            .tableScroller { max-height: 340px; overflow:auto; border:1px solid var(--border); border-radius: 14px; }
            table { border-collapse: collapse; width: 100%; font-size: 12px; }
            th { position: sticky; top: 0; background: #f9fafb; border-bottom: 1px solid var(--border); text-align:left; padding: 10px; white-space: nowrap; }
            td { border-bottom: 1px solid #f3f4f6; padding: 9px 10px; white-space: nowrap; max-width: 240px; overflow:hidden; text-overflow: ellipsis; }
            .chartTitle { font-size: 14px; font-weight: 800; color:#374151; margin-bottom: 10px; }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="hero">
              <h1>${escapeHtml(dataset.label)}</h1>
              <div class="sub">Input Mapping preview • CSV loaded from <code>${escapeHtml(dataset.path)}</code></div>
              <div class="controls">
                ${datasetSelector}
                ${chartSelector}
                ${monthlyControls}
                ${artistControls}
              </div>
            </div>

            <div class="grid">
              <div class="card">
                ${chartHtml}
              </div>
              <div class="card">${previewHtml}</div>
            </div>
          </div>

          <script>
            const baseUrl = '/';
            let debounceTimer = null;
            function applyUrl() { applyUrlDebounced(0); }
            function applyUrlDebounced(ms) {
              clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                const dataset = document.getElementById('datasetSelect').value;
                const viz = document.getElementById('vizSelect').value;

                const url = new URL(window.location.href);
                url.pathname = baseUrl;
                url.searchParams.set('dataset', dataset);
                url.searchParams.set('viz', viz);

                // Monthly filters
                const lowEl = document.getElementById('monthLow');
                const highEl = document.getElementById('monthHigh');
                if (lowEl && highEl) {
                  url.searchParams.set('monthLow', lowEl.value);
                  url.searchParams.set('monthHigh', highEl.value);
                }

                // Artist filters
                const topEl = document.getElementById('topN');
                const skipEl = document.getElementById('skipMinPct');
                if (topEl) url.searchParams.set('topN', topEl.value);
                if (skipEl && skipEl.value !== '') url.searchParams.set('skipMinPct', skipEl.value);
                if (skipEl && skipEl.value === '') url.searchParams.delete('skipMinPct');

                window.location.href = url.toString();
              }, ms === undefined ? 250 : ms);
            }

            ${monthJs}
          </script>
        </body>
      </html>
    `;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).type('text/plain').send(`Error: ${err?.message || String(err)}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`App running on port ${PORT}`);
});

