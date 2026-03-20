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
  const rows = lines.map((line) => line.split(','));
  return { headers, rows };
}

app.all('/', (req, res) => {
  try {
    const csvText = fs.readFileSync(INPUT_CSV_PATH, 'utf8');
    const { headers, rows } = parseCsvSimple(csvText);
    const limitedRows = rows.slice(0, LIMIT_ROWS);

    const objects = limitedRows.map((cols) => Object.fromEntries(headers.map((h, i) => [h, cols[i]])));
    res.json({ ok: true, file: INPUT_CSV_PATH, rows: objects });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      file: INPUT_CSV_PATH,
    });
  }
}); // app.all handles both GET and POST

app.listen(PORT, '0.0.0.0', () => {
    console.log(`App running on port ${PORT}`);
});
