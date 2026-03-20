// server.js
import express from 'express';
import fs from 'node:fs';
const app = express();
const PORT = process.env.PORT || 3000;

const INPUT_CSV_PATH = '/data/in/tables/01km5ky89sdjsrgz7t55kv60t3.csv';
const LIMIT_ROWS = 5; // for testing

function parseCsvSimple(csvText) {
  const csv = csvText.trim();
  const [headerLine, ...lines] = csv.split(/\r?\n/);
  const headers = headerLine.split(',');
  const rows = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(','));
  return { headers, rows };
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

app.all('/', (req, res) => {
  try {
    const csvText = fs.readFileSync(INPUT_CSV_PATH, 'utf8');
    const { headers, rows } = parseCsvSimple(csvText);
    const limitedRows = rows.slice(0, LIMIT_ROWS);

    // Pick a column to plot.
    const numericColIndex = pickBestNumericColumn(headers, limitedRows);
    const numericColName = numericColIndex >= 0 ? headers[numericColIndex] : null;
    const numericValues = numericColIndex >= 0 ? limitedRows.map((r) => parseNumeric(r[numericColIndex])) : [];
    const numericValuesNonNull = numericValues.filter((n) => n !== null);
    const maxAbs = numericValuesNonNull.length ? Math.max(...numericValuesNonNull.map((n) => Math.abs(n))) : 0;

    const tableHeaderHtml = headers
      .map((h) => `<th style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;white-space:nowrap">${escapeHtml(h)}</th>`)
      .join('');

    const tableRowsHtml = limitedRows
      .map(
        (cols) =>
          `<tr>${headers
            .map((_, i) => `<td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;white-space:nowrap">${escapeHtml(cols[i])}</td>`)
            .join('')}</tr>`,
      )
      .join('');

    let chartHtml = '';
    if (numericColIndex >= 0 && maxAbs > 0) {
      const chartW = 680;
      const chartH = 260;
      const padTop = 18;
      const padBottom = 50;
      const padLeft = 40;
      const padRight = 20;
      const innerW = chartW - padLeft - padRight;
      const innerH = chartH - padTop - padBottom;

      const values = numericValues.map((v) => (v === null ? 0 : v));
      const zeroY = padTop + innerH / 2;

      const barCount = limitedRows.length;
      const gap = 10;
      const barW = Math.max(8, Math.floor((innerW - gap * (barCount - 1)) / barCount));

      const totalBarsW = barW * barCount + gap * (barCount - 1);
      const startX = padLeft + (innerW - totalBarsW) / 2;

      const bars = values
        .map((v, i) => {
          const scaled = v / maxAbs; // in [-1,1]
          const barHalf = (innerH / 2) * Math.abs(scaled);
          const x = startX + i * (barW + gap);

          if (v >= 0) {
            const y = zeroY - barHalf;
            const h = barHalf;
            return `
              <g>
                <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#2563eb" />
                <text x="${x + barW / 2}" y="${chartH - 22}" font-size="12" text-anchor="middle" fill="#111827">${i + 1}</text>
              </g>`;
          }

          // negative
          const y = zeroY;
          const h = barHalf;
          return `
              <g>
                <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#60a5fa" />
                <text x="${x + barW / 2}" y="${chartH - 22}" font-size="12" text-anchor="middle" fill="#111827">${i + 1}</text>
              </g>`;
        })
        .join('');

      // Show baseline + simple labels
      chartHtml = `
        <div style="margin-top:16px;">
          <h3 style="margin:0 0 8px 0;font-size:16px;">Top ${LIMIT_ROWS} bar chart: ${escapeHtml(numericColName)}</h3>
          <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img" aria-label="Bar chart">
            <line x1="${padLeft}" x2="${chartW - padRight}" y1="${zeroY}" y2="${zeroY}" stroke="#9ca3af" />
            ${bars}
          </svg>
        </div>`;
    } else {
      chartHtml = `
        <div style="margin-top:16px;color:#6b7280;">
          Could not detect a numeric column to chart. Showing the table only.
        </div>`;
    }

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Keboola Input Preview</title>
          <style>
            body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; margin: 24px; color:#111827; }
            .card { background:#ffffff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; }
            table { border-collapse: collapse; width:100%; }
            th { background:#f9fafb; font-weight:600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2 style="margin:0 0 10px 0;">Input mapping preview</h2>
            <div style="color:#6b7280;margin-bottom:12px;">Reading from <code>${escapeHtml(INPUT_CSV_PATH)}</code></div>

            <div style="color:#374151;margin-bottom:10px;">
              Showing top <b>${LIMIT_ROWS}</b> rows.
            </div>

            <div style="overflow:auto; border:1px solid #e5e7eb; border-radius:12px;">
              <table>
                <thead><tr>${tableHeaderHtml}</tr></thead>
                <tbody>${tableRowsHtml}</tbody>
              </table>
            </div>

            ${chartHtml}
          </div>
        </body>
      </html>
    `;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).type('text/plain').send(`Error reading CSV: ${err?.message || String(err)} (file: ${INPUT_CSV_PATH})`);
  }
}); // app.all handles both GET and POST

app.listen(PORT, '0.0.0.0', () => {
    console.log(`App running on port ${PORT}`);
});
