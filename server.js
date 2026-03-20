// server.js
import express from 'express';
import fs from 'node:fs';
const app = express();
const PORT = process.env.PORT || 3000;

const DATASETS = [
  {
    key: 'artist_leaderboard',
    label: 'Artist leaderboard',
    path: '/data/in/tables/artist_leaderboard.csv',
  },
  {
    key: 'monthly_listening_trends',
    label: 'Monthly listening trends',
    path: '/data/in/tables/monthly_listening_trends.csv',
  },
];
const MONTHLY_TABLE_ROWS = 8; // in the HTML table (chart uses all available months)
const ARTIST_TABLE_TOP_N = 50; // leaderboard spec

const DEFAULT_VIZ_BY_DATASET = {
  artist_leaderboard: 'artist_hbar_total_hours',
  monthly_listening_trends: 'monthly_line_total_hours',
};

function parseCsvSimple(csvText) {
  const input = csvText.trim();
  const rows = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;

  // RFC4180-ish parser: handles commas/newlines inside double quotes.
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = i + 1 < input.length ? input[i + 1] : '';

    if (ch === '"' && inQuotes && next === '"') {
      currentField += '"';
      i += 1; // skip escaped quote
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

    // handle CRLF by ignoring \r when not inQuotes
    if (!inQuotes && ch === '\r') continue;

    currentField += ch;
  }

  // flush last row if there is trailing content
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow || [];
  return { headers, rows: dataRows };
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

  // Heuristic for number formatting: handle "1,234.56" and "1,23"
  const normalized =
    raw.includes(',') && raw.includes('.')
      ? raw.replace(/,/g, '') // thousands separators
      : raw.includes(',') && !raw.includes('.') // decimal comma
        ? raw.replace(/,/g, '.')
        : raw;

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function pickBestNumericColumn(headers, rows) {
  let best = { index: -1, count: 0, maxAbs: 0 };

  for (let col = 0; col < headers.length; col++) {
    let count = 0;
    let maxAbs = 0;
    for (const r of rows) {
      const n = parseNumeric(r[col]);
      if (n === null) continue;
      count += 1;
      maxAbs = Math.max(maxAbs, Math.abs(n));
    }

    // Prefer columns with more numeric values; tie-break by magnitude.
    if (count > best.count || (count === best.count && maxAbs > best.maxAbs)) {
      best = { index: col, count, maxAbs };
    }
  }

  return best.index >= 0 && best.count > 0 ? best.index : -1;
}

function normalizeHeaderValue(value) {
  return String(value ?? '').trim().toUpperCase();
}

function findColumnIndex(headers, candidates) {
  const normalizedCandidates = (candidates || []).map(normalizeHeaderValue);
  for (const headerName of normalizedCandidates) {
    const idx = headers.findIndex((h) => normalizeHeaderValue(h) === headerName);
    if (idx >= 0) return idx;
  }

  // Fallback: substring match (useful if header names slightly differ).
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

function formatNumber(n) {
  if (n === null || n === undefined) return '';
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return String(n);
  const abs = Math.abs(num);
  if (abs >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
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
  return formatNumber(num);
}

function buildSvgAxes({ width, height, padLeft, padRight, padTop, padBottom, yMax }) {
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const baselineY = padTop + innerH;

  // 4 ticks: 0, 1/3, 2/3, 1
  const ticks = [0, 1 / 3, 2 / 3, 1].map((t) => {
    const val = yMax * t;
    const y = baselineY - innerH * t;
    return { val, y };
  });

  return {
    innerW,
    innerH,
    baselineY,
    ticksHtml: ticks
      .map(
        (t) => `
      <g>
        <line x1="${padLeft}" x2="${width - padRight}" y1="${t.y}" y2="${t.y}" stroke="#e5e7eb" />
        <text x="${padLeft - 8}" y="${t.y + 4}" font-size="11" fill="#6b7280" text-anchor="end">${formatShortNumber(t.val)}</text>
      </g>`,
      )
      .join(''),
  };
}

app.all('/', (req, res) => {
  try {
    const requestedDatasetKey = typeof req.query.dataset === 'string' ? req.query.dataset : DATASETS[0].key;
    const dataset = DATASETS.find((d) => d.key === requestedDatasetKey) || DATASETS[0];

    const requestedViz = typeof req.query.viz === 'string' ? req.query.viz : DEFAULT_VIZ_BY_DATASET[dataset.key];
    const viz = requestedViz || DEFAULT_VIZ_BY_DATASET[dataset.key];

    const filePath = dataset.path;
    const csvText = fs.readFileSync(filePath, 'utf8');
    const { headers, rows } = parseCsvSimple(csvText);

    const getCell = (r, idx) => (idx >= 0 ? r[idx] : undefined);

    // HTML: header + controls
    const datasetSelector = `
      <select name="dataset" onchange="location.href='/?dataset='+encodeURIComponent(this.value)+'&viz='+encodeURIComponent(document.querySelector('select[name=viz]').value)">
        ${DATASETS.map((d) => {
          const selected = d.key === dataset.key ? 'selected' : '';
          return `<option value="${escapeHtml(d.key)}" ${selected}>${escapeHtml(d.label)}</option>`;
        }).join('')}
      </select>
    `;

    let vizOptionsHtml = '';
    let chartTitle = '';
    let chartHtml = '';
    let tableHtml = '';

    if (dataset.key === 'monthly_listening_trends') {
      const idxMonth = findColumnIndex(headers, ['MONTH']);
      const idxHours = findColumnIndex(headers, ['TOTAL_HOURS']);
      const idxPlays = findColumnIndex(headers, ['TOTAL_PLAYS']);
      const idxUniqueArtists = findColumnIndex(headers, ['UNIQUE_ARTISTS']);
      const idxTopArtist = findColumnIndex(headers, ['TOP_ARTIST']);
      const idxTopArtistHours = findColumnIndex(headers, ['TOP_ARTIST_HOURS']);

      vizOptionsHtml = `
        <select name="viz" onchange="location.href='/?dataset='+encodeURIComponent('${dataset.key}')+'&viz='+encodeURIComponent(this.value)">
          <option value="monthly_line_total_hours" ${viz === 'monthly_line_total_hours' ? 'selected' : ''}>Line: MONTH vs TOTAL_HOURS</option>
          <option value="monthly_area_total_hours" ${viz === 'monthly_area_total_hours' ? 'selected' : ''}>Area: MONTH vs TOTAL_HOURS</option>
          <option value="monthly_bar_unique_artists" ${viz === 'monthly_bar_unique_artists' ? 'selected' : ''}>Bar: MONTH vs UNIQUE_ARTISTS</option>
          <option value="monthly_combo_hours_plays" ${viz === 'monthly_combo_hours_plays' ? 'selected' : ''}>Combo: Hours + Plays</option>
          <option value="monthly_top_artist_timeline" ${viz === 'monthly_top_artist_timeline' ? 'selected' : ''}>Top artist timeline</option>
        </select>
      `;

      const missing = [];
      if (idxMonth < 0) missing.push('MONTH');
      if (idxHours < 0) missing.push('TOTAL_HOURS');
      if (idxPlays < 0) missing.push('TOTAL_PLAYS');
      if (idxUniqueArtists < 0) missing.push('UNIQUE_ARTISTS');
      if (idxTopArtist < 0) missing.push('TOP_ARTIST');
      if (idxTopArtistHours < 0) missing.push('TOP_ARTIST_HOURS');

      const parsedRows = rows
        .map((r) => {
          const monthTime = idxMonth >= 0 ? parseMonthToTime(getCell(r, idxMonth)) : null;
          return { monthTime, monthRaw: getCell(r, idxMonth), r };
        })
        .sort((a, b) => {
          if (a.monthTime !== null && b.monthTime !== null) return a.monthTime - b.monthTime;
          if (a.monthTime !== null) return -1;
          if (b.monthTime !== null) return 1;
          return String(a.monthRaw).localeCompare(String(b.monthRaw));
        })
        .map((x) => x.r);

      // Chart uses all months (118 in your case)
      const chartW = 860;
      const chartH = 320;
      const padTop = 24;
      const padBottom = 54;
      const padLeft = 56;
      const padRight = 20;

      const months = parsedRows.map((r) => getCell(r, idxMonth));
      const labelsX = months.map((m) => String(m));

      const seriesHours = parsedRows.map((r) => parseNumeric(getCell(r, idxHours)));
      const seriesPlays = parsedRows.map((r) => parseNumeric(getCell(r, idxPlays)));
      const seriesUnique = parsedRows.map((r) => parseNumeric(getCell(r, idxUniqueArtists)));
      const seriesTopArtistHours = parsedRows.map((r) => parseNumeric(getCell(r, idxTopArtistHours)));
      const seriesTopArtist = parsedRows.map((r) => getCell(r, idxTopArtist));

      const nonNull = (arr) => arr.filter((v) => v !== null);
      const safeMax = (arr) => {
        const vals = nonNull(arr);
        if (!vals.length) return 0;
        return Math.max(...vals.map((v) => Math.max(0, v)));
      };

      if (idxMonth < 0) {
        chartHtml = `<div style="margin-top:16px;color:#6b7280;">Missing column: MONTH</div>`;
      } else if (viz === 'monthly_line_total_hours') {
        chartTitle = 'Line Chart: MONTH vs TOTAL_HOURS';
        const yMax = safeMax(seriesHours) || 1;
        const axes = buildSvgAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMax });
        const n = parsedRows.length;
        const xAt = (i) => padLeft + (axes.innerW * i) / Math.max(1, n - 1);
        const yAt = (val) => axes.baselineY - axes.innerH * (Math.max(0, val || 0) / yMax);

        const path = seriesHours
          .map((v, i) => {
            if (v === null) return null;
            const x = xAt(i);
            const y = yAt(v);
            return `${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .filter(Boolean)
          .join(' ');

        const pointsHtml = seriesHours
          .map((v, i) => {
            if (v === null) return '';
            const x = xAt(i);
            const y = yAt(v);
            return `<circle cx="${x}" cy="${y}" r="3.2" fill="#2563eb">
              <title>${escapeHtml(labelsX[i])} • ${escapeHtml(formatNumber(v))}</title>
            </circle>`;
          })
          .join('');

        const xTicks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]
          .filter((v, idx, arr) => v >= 0 && v < n && arr.indexOf(v) === idx);
        const xTicksHtml = xTicks
          .map((i) => {
            const x = xAt(i);
            const label = labelsX[i];
            return `<text x="${x}" y="${chartH - 22}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(
              label.length > 12 ? label.slice(0, 12) : label,
            )}</text>`;
          })
          .join('');

        chartHtml = `
          <div style="margin-top:16px;">
            <h3 style="margin:0 0 10px 0;font-size:16px;">${escapeHtml(chartTitle)}</h3>
            <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
              ${axes.ticksHtml}
              <polyline fill="none" stroke="#2563eb" stroke-width="3" points="${path}" />
              ${pointsHtml}
              ${xTicksHtml}
            </svg>
          </div>`;
      } else if (viz === 'monthly_area_total_hours') {
        chartTitle = 'Area Chart: MONTH vs TOTAL_HOURS';
        const yMax = safeMax(seriesHours) || 1;
        const axes = buildSvgAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMax });
        const n = parsedRows.length;
        const xAt = (i) => padLeft + (axes.innerW * i) / Math.max(1, n - 1);
        const yAt = (val) => axes.baselineY - axes.innerH * (Math.max(0, val || 0) / yMax);

        const pts = [];
        for (let i = 0; i < n; i++) {
          const v = seriesHours[i];
          if (v === null) continue;
          pts.push({ x: xAt(i), y: yAt(v) });
        }

        const line = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
        const areaBase = axes.baselineY;
        const area = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
        const areaPoly = `${area} ${xAt(n - 1).toFixed(2)},${areaBase.toFixed(2)} ${xAt(0).toFixed(2)},${areaBase.toFixed(2)}`;

        const pointsHtml = seriesHours
          .map((v, i) => {
            if (v === null) return '';
            const x = xAt(i);
            const y = yAt(v);
            return `<circle cx="${x}" cy="${y}" r="3.2" fill="#2563eb" opacity="0.9">
              <title>${escapeHtml(labelsX[i])} • ${escapeHtml(formatNumber(v))}</title>
            </circle>`;
          })
          .join('');

        const xTicks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]
          .filter((v, idx, arr) => v >= 0 && v < n && arr.indexOf(v) === idx);
        const xTicksHtml = xTicks
          .map((i) => {
            const x = xAt(i);
            const label = labelsX[i];
            return `<text x="${x}" y="${chartH - 22}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(
              label.length > 12 ? label.slice(0, 12) : label,
            )}</text>`;
          })
          .join('');

        chartHtml = `
          <div style="margin-top:16px;">
            <h3 style="margin:0 0 10px 0;font-size:16px;">${escapeHtml(chartTitle)}</h3>
            <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
              ${axes.ticksHtml}
              <polygon points="${areaPoly}" fill="rgba(37,99,235,0.18)" stroke="none" />
              <polyline fill="none" stroke="#2563eb" stroke-width="3" points="${line}" />
              ${pointsHtml}
              ${xTicksHtml}
            </svg>
          </div>`;
      } else if (viz === 'monthly_bar_unique_artists') {
        chartTitle = 'Bar Chart: MONTH vs UNIQUE_ARTISTS';
        const yMax = safeMax(seriesUnique) || 1;
        const axes = buildSvgAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMax });
        const n = parsedRows.length;
        const barGap = 2;
        const barW = (axes.innerW - barGap * (n - 1)) / n;
        const xAt = (i) => padLeft + i * (barW + barGap);
        const yAt = (val) => axes.baselineY - axes.innerH * (Math.max(0, val || 0) / yMax);
        const bars = seriesUnique
          .map((v, i) => {
            if (v === null) return '';
            const x = xAt(i);
            const y = yAt(v);
            const h = axes.baselineY - y;
            return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#f59e0b">
              <title>${escapeHtml(labelsX[i])} • ${escapeHtml(formatNumber(v))}</title>
            </rect>`;
          })
          .join('');

        const xTicks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]
          .filter((v, idx, arr) => v >= 0 && v < n && arr.indexOf(v) === idx);
        const xTicksHtml = xTicks
          .map((i) => {
            const x = xAt(i) + barW / 2;
            const label = labelsX[i];
            return `<text x="${x}" y="${chartH - 22}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(
              label.length > 12 ? label.slice(0, 12) : label,
            )}</text>`;
          })
          .join('');

        chartHtml = `
          <div style="margin-top:16px;">
            <h3 style="margin:0 0 10px 0;font-size:16px;">${escapeHtml(chartTitle)}</h3>
            <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
              ${axes.ticksHtml}
              ${bars}
              ${xTicksHtml}
            </svg>
          </div>`;
      } else if (viz === 'monthly_combo_hours_plays') {
        chartTitle = 'Combo Chart: Hours + Plays (normalized)';
        const hoursMax = safeMax(seriesHours) || 1;
        const playsMax = safeMax(seriesPlays) || 1;

        // Use same y range [0..1] after normalization.
        const axes = buildSvgAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMax: 1 });
        const n = parsedRows.length;
        const xAt = (i) => padLeft + (axes.innerW * i) / Math.max(1, n - 1);
        const yAt = (norm) => axes.baselineY - axes.innerH * (Math.max(0, norm || 0) / 1);

        const hoursPts = seriesHours
          .map((v, i) => (v === null ? null : `${xAt(i).toFixed(2)},${yAt(v / hoursMax).toFixed(2)}`))
          .filter(Boolean)
          .join(' ');
        const playsPts = seriesPlays
          .map((v, i) => (v === null ? null : `${xAt(i).toFixed(2)},${yAt(v / playsMax).toFixed(2)}`))
          .filter(Boolean)
          .join(' ');

        const hoursPointsHtml = seriesHours
          .map((v, i) => {
            if (v === null) return '';
            const x = xAt(i);
            const y = yAt(v / hoursMax);
            return `<circle cx="${x}" cy="${y}" r="3.0" fill="#2563eb">
              <title>Hours • ${escapeHtml(labelsX[i])} • ${escapeHtml(formatNumber(v))}</title>
            </circle>`;
          })
          .join('');
        const playsPointsHtml = seriesPlays
          .map((v, i) => {
            if (v === null) return '';
            const x = xAt(i);
            const y = yAt(v / playsMax);
            return `<circle cx="${x}" cy="${y}" r="3.0" fill="#10b981" opacity="0.9">
              <title>Plays • ${escapeHtml(labelsX[i])} • ${escapeHtml(formatNumber(v))}</title>
            </circle>`;
          })
          .join('');

        const xTicks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]
          .filter((v, idx, arr) => v >= 0 && v < n && arr.indexOf(v) === idx);
        const xTicksHtml = xTicks
          .map((i) => {
            const x = xAt(i);
            const label = labelsX[i];
            return `<text x="${x}" y="${chartH - 22}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(
              label.length > 12 ? label.slice(0, 12) : label,
            )}</text>`;
          })
          .join('');

        const legend = `
          <g>
            <rect x="${padLeft}" y="10" width="14" height="14" fill="#2563eb" />
            <text x="${padLeft + 20}" y="22" font-size="12" fill="#111827">Hours</text>
            <rect x="${padLeft + 90}" y="10" width="14" height="14" fill="#10b981" />
            <text x="${padLeft + 110}" y="22" font-size="12" fill="#111827">Plays</text>
          </g>
        `;

        chartHtml = `
          <div style="margin-top:16px;">
            <h3 style="margin:0 0 10px 0;font-size:16px;">${escapeHtml(chartTitle)}</h3>
            <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
              ${legend}
              ${axes.ticksHtml}
              <polyline fill="none" stroke="#2563eb" stroke-width="2.6" points="${hoursPts}" />
              <polyline fill="none" stroke="#10b981" stroke-width="2.6" points="${playsPts}" />
              ${hoursPointsHtml}
              ${playsPointsHtml}
              ${xTicksHtml}
            </svg>
          </div>`;
      } else if (viz === 'monthly_top_artist_timeline') {
        chartTitle = 'Top Artist Timeline (by monthly top-artist hours)';
        const yMax = safeMax(seriesTopArtistHours) || 1;
        const axes = buildSvgAxes({ width: chartW, height: chartH, padLeft, padRight, padTop, padBottom, yMax });
        const n = parsedRows.length;
        const barGap = 2;
        const barW = (axes.innerW - barGap * (n - 1)) / n;
        const xAt = (i) => padLeft + i * (barW + barGap);
        const yAt = (val) => axes.baselineY - axes.innerH * (Math.max(0, val || 0) / yMax);

        const bars = seriesTopArtistHours
          .map((v, i) => {
            if (v === null) return '';
            const x = xAt(i);
            const y = yAt(v);
            const h = axes.baselineY - y;
            const artist = seriesTopArtist[i];
            return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#8b5cf6" opacity="0.95">
              <title>${escapeHtml(labelsX[i])} • ${escapeHtml(artist)} • ${escapeHtml(formatNumber(v))} hours</title>
            </rect>`;
          })
          .join('');

        const xTicks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]
          .filter((v, idx, arr) => v >= 0 && v < n && arr.indexOf(v) === idx);
        const xTicksHtml = xTicks
          .map((i) => {
            const x = xAt(i) + barW / 2;
            const label = labelsX[i];
            return `<text x="${x}" y="${chartH - 22}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(
              label.length > 12 ? label.slice(0, 12) : label,
            )}</text>`;
          })
          .join('');

        chartHtml = `
          <div style="margin-top:16px;">
            <h3 style="margin:0 0 10px 0;font-size:16px;">${escapeHtml(chartTitle)}</h3>
            <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
              ${axes.ticksHtml}
              ${bars}
              ${xTicksHtml}
            </svg>
          </div>`;
      } else {
        chartHtml = `<div style="margin-top:16px;color:#6b7280;">Unknown monthly view: ${escapeHtml(viz)}</div>`;
      }

      const tableHeaders = headers;
      const tableRows = parsedRows.slice(0, MONTHLY_TABLE_ROWS);
      const tableHeaderHtml = tableHeaders
        .map(
          (h) =>
            `<th style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;white-space:nowrap;position:sticky;top:0;background:#f9fafb">${escapeHtml(
              h,
            )}</th>`,
        )
        .join('');
      const tableRowsHtml = tableRows
        .map(
          (cols) =>
            `<tr>${tableHeaders
              .map((_, i) => `<td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;white-space:nowrap">${escapeHtml(
                cols[i],
              )}</td>`)
              .join('')}</tr>`,
        )
        .join('');

      tableHtml = `
        <div style="margin-top:12px;overflow:auto; border:1px solid #e5e7eb; border-radius:12px; max-height:330px;">
          <table>
            <thead><tr>${tableHeaderHtml}</tr></thead>
            <tbody>${tableRowsHtml}</tbody>
          </table>
        </div>`;
    } else {
      // artist_leaderboard
      const idxName = findColumnIndex(headers, ['artist_name']);
      const idxHours = findColumnIndex(headers, ['TOTAL_HOURS']);
      const idxSkipPct = findColumnIndex(headers, ['SKIP_RATE_PCT', 'SKIP_PCT', 'SKIP_PCT_RATE']);

      vizOptionsHtml = `
        <select name="viz" onchange="location.href='/?dataset='+encodeURIComponent('${escapeHtml(dataset.key)}')+'&viz='+encodeURIComponent(this.value)">
          <option value="artist_hbar_total_hours" ${viz === 'artist_hbar_total_hours' ? 'selected' : ''}>Horizontal bar: artist_name vs TOTAL_HOURS</option>
          <option value="artist_scatter_hours_skip" ${viz === 'artist_scatter_hours_skip' ? 'selected' : ''} ${idxSkipPct < 0 || idxHours < 0 ? 'disabled' : ''}>Scatter: TOTAL_HOURS vs SKIP_RATE_PCT</option>
        </select>
      `;

      let chartMissing = '';
      if (idxName < 0) chartMissing = 'Missing column: artist_name';
      if (idxHours < 0) chartMissing = chartMissing ? `${chartMissing}, TOTAL_HOURS` : 'Missing column: TOTAL_HOURS';

      if (chartMissing) {
        chartHtml = `<div style="margin-top:16px;color:#6b7280;">${escapeHtml(chartMissing)}</div>`;
      } else {
        const maxRows = ARTIST_TABLE_TOP_N;
        const parsed = rows
          .map((r) => ({
            name: getCell(r, idxName),
            hours: parseNumeric(getCell(r, idxHours)),
            skipPct: idxSkipPct >= 0 ? parseNumeric(getCell(r, idxSkipPct)) : null,
            r,
          }))
          .filter((x) => x.hours !== null)
          .sort((a, b) => (b.hours || 0) - (a.hours || 0));

        const top = parsed.slice(0, maxRows);
        chartTitle = viz === 'artist_scatter_hours_skip' ? 'Scatter: TOTAL_HOURS vs SKIP_RATE_PCT' : 'Horizontal bar: TOTAL_HOURS by artist';

        const chartW = 860;
        const chartH = 340;
        const padTop = 24;
        const padBottom = 58;
        const padLeft = 160;
        const padRight = 20;

        const yCount = top.length || 1;
        const barH = (chartH - padTop - padBottom) / yCount;

        if (viz === 'artist_scatter_hours_skip' && idxSkipPct >= 0) {
          // Scatter: x=hours normalized, y=skipPct normalized
          const xVals = top.map((t) => t.hours).filter((v) => v !== null);
          const yVals = top.map((t) => t.skipPct).filter((v) => v !== null);
          const xMax = xVals.length ? Math.max(...xVals) : 1;
          const xMin = xVals.length ? Math.min(...xVals) : 0;
          const yMax = yVals.length ? Math.max(...yVals) : 1;
          const yMin = yVals.length ? Math.min(...yVals) : 0;

          const innerW = chartW - padLeft - padRight;
          const innerH = chartH - padTop - padBottom;
          const xAt = (x) => padLeft + innerW * ((x - xMin) / Math.max(1e-9, xMax - xMin));
          const yAt = (y) => padTop + innerH * (1 - (y - yMin) / Math.max(1e-9, yMax - yMin));

          const pointsHtml = top
            .filter((t) => t.skipPct !== null)
            .map((t) => {
              const cx = xAt(t.hours);
              const cy = yAt(t.skipPct);
              return `<circle cx="${cx}" cy="${cy}" r="4.0" fill="#2563eb" opacity="0.85">
                <title>${escapeHtml(t.name)} • Hours ${escapeHtml(formatNumber(t.hours))} • Skip ${escapeHtml(
                formatNumber(t.skipPct),
              )}%</title>
              </circle>`;
            })
            .join('');

          const xLabelTicks = [0, 0.5, 1]
            .map((t) => {
              const val = xMin + (xMax - xMin) * t;
              const x = xAt(val);
              return `<text x="${x}" y="${chartH - 22}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(
                formatShortNumber(val),
              )}</text>`;
            })
            .join('');

          const yLabelTicks = [0, 0.5, 1]
            .map((t) => {
              const val = yMax - (yMax - yMin) * t;
              const y = yAt(val);
              return `<text x="${padLeft - 10}" y="${y + 4}" font-size="11" fill="#6b7280" text-anchor="end">${escapeHtml(
                formatShortNumber(val),
              )}</text>`;
            })
            .join('');

          chartHtml = `
            <div style="margin-top:16px;">
              <h3 style="margin:0 0 10px 0;font-size:16px;">${escapeHtml(chartTitle)}</h3>
              <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img">
                <line x1="${padLeft}" x2="${chartW - padRight}" y1="${chartH - padBottom}" y2="${chartH - padBottom}" stroke="#e5e7eb" />
                ${xLabelTicks}
                ${yLabelTicks}
                ${pointsHtml}
              </svg>
            </div>`;
        } else {
          const xMax = Math.max(...top.map((t) => t.hours));
          const innerW = chartW - padLeft - padRight;
          const innerH = chartH - padTop - padBottom;

          const xAt = (v) => padLeft + innerW * ((v || 0) / Math.max(1e-9, xMax));

          const bars = top
            .map((t, i) => {
              const y = padTop + i * barH;
              const w = innerW * ((t.hours || 0) / Math.max(1e-9, xMax));
              return `<rect x="${padLeft}" y="${y + 6}" width="${w}" height="${Math.max(10, barH - 12)}" fill="#2563eb" opacity="0.92">
                <title>${escapeHtml(t.name)} • ${escapeHtml(formatNumber(t.hours))} hours</title>
              </rect>
              <text x="${padLeft - 8}" y="${y + barH / 2 + 4}" font-size="12" fill="#111827" text-anchor="end">${escapeHtml(
                String(t.name).length > 24 ? String(t.name).slice(0, 24) + '…' : String(t.name),
              )}</text>`;
            })
            .join('');

          const chartW2 = chartW;
          chartHtml = `
            <div style="margin-top:16px;">
              <h3 style="margin:0 0 10px 0;font-size:16px;">${escapeHtml(chartTitle)}</h3>
              <svg viewBox="0 0 ${chartW2} ${chartH}" width="100%" height="auto" role="img">
                <line x1="${padLeft}" x2="${chartW2 - padRight}" y1="${chartH - padBottom}" y2="${chartH - padBottom}" stroke="#e5e7eb" />
                ${bars}
                <text x="${chartW2 - padRight}" y="${chartH - 22}" font-size="11" fill="#6b7280" text-anchor="end">${escapeHtml(
                  `${formatShortNumber(xMax)} max`,
                )}</text>
              </svg>
            </div>`;
        }

        const tableHeaders = headers;
        const tableRowsHtml = top
          .slice(0, MONTHLY_TABLE_ROWS)
          .map((t) => {
            return `<tr>${tableHeaders.map((_, i) => `<td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;white-space:nowrap">${escapeHtml(t.r[i])}</td>`).join(
              '',
            )}</tr>`;
          })
          .join('');
        const tableHeaderHtml = tableHeaders
          .map(
            (h) =>
              `<th style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;white-space:nowrap;position:sticky;top:0;background:#f9fafb">${escapeHtml(
                h,
              )}</th>`,
          )
          .join('');
        tableHtml = `
          <div style="margin-top:12px;overflow:auto; border:1px solid #e5e7eb; border-radius:12px; max-height:330px;">
            <table>
              <thead><tr>${tableHeaderHtml}</tr></thead>
              <tbody>${tableRowsHtml}</tbody>
            </table>
          </div>`;
      }
    }

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Keboola Data App Preview</title>
          <style>
            body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; margin: 24px; color:#111827; }
            .card { background:#ffffff; border:1px solid #e5e7eb; border-radius:14px; padding:18px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
            table { border-collapse: collapse; width:100%; }
            th { background:#f9fafb; font-weight:600; }
            .controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin: 10px 0 14px 0; }
            .pill { display:inline-flex; align-items:center; gap:6px; }
            select { padding:8px 10px; border:1px solid #e5e7eb; border-radius:10px; background:#fff; color:#111827; font-weight:500; }
            code { background:#f3f4f6; padding:2px 6px; border-radius:8px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2 style="margin:0 0 6px 0;">Keboola Data App Preview</h2>
            <div style="color:#6b7280;margin-bottom:6px;">Reading from <code>${escapeHtml(filePath)}</code></div>

            <div class="controls">
              <div class="pill">
                <label style="color:#374151;font-weight:600;margin-right:6px;">Dataset:</label>
                ${datasetSelector}
              </div>
              <div class="pill">
                <label style="color:#374151;font-weight:600;margin-right:6px;">Visualization:</label>
                ${vizOptionsHtml}
              </div>
            </div>

            ${chartHtml}
            ${tableHtml}
          </div>
        </body>
      </html>
    `;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res
      .status(500)
      .type('text/plain')
      .send(`Error reading CSV: ${err?.message || String(err)} (file: ${DATASETS[0]?.path || 'unknown'})`);
  }
}); // app.all handles both GET and POST

app.listen(PORT, '0.0.0.0', () => {
    console.log(`App running on port ${PORT}`);
});
