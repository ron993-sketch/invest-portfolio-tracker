// Auto-refresh Stooq prices into index.html.
// Runs in GitHub Actions on a cron schedule (see ../workflows/refresh-prices.yml).
// Server-side fetch — no CORS proxies, no browser flakiness.

const fs = require('fs');
const https = require('https');

const FILE_PATH = 'index.html';

// Active live-portfolio tickers (positions with shares > 0). Closed positions (QFIN, CEG)
// keep their historical exit price baked in — no refresh needed.
const TICKERS = ['MU', 'OPFI', 'META', 'POWL', 'GOOGL', 'EVER', 'HLI', 'PANW', 'SMMT', 'BRK-B', 'UNH'];

function fetchStooq(tickers) {
    const symbols = tickers.map(t => t.toLowerCase() + '.us').join('+');
    const url = `https://stooq.com/q/l/?s=${symbols}&f=sd2t2ohlcv&h&e=csv`;
    return new Promise((resolve, reject) => {
        const opts = {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioRefresh/1.0)' }
        };
        https.get(url, opts, res => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Stooq HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function parsePrices(csv) {
    const prices = {};
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('Stooq returned empty CSV');
    // Header: Symbol,Date,Time,Open,High,Low,Close,Volume
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length < 7) continue;
        const sym = cols[0].replace(/\.US$/i, '').toUpperCase();
        const close = parseFloat(cols[6]);
        if (sym && Number.isFinite(close) && close > 0) prices[sym] = close;
    }
    return prices;
}

function updateHtml(html, prices) {
    let changes = 0;
    const lines = html.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [ticker, price] of Object.entries(prices)) {
            const tickerEscaped = ticker.replace('-', '\\-');
            // Match the portfolio entry line: {t:'TICKER',  ...currentPrice:X.XX, ...
            const isThisLine = new RegExp(`\\{t:\\s*'${tickerEscaped}'`).test(line);
            if (isThisLine && /currentPrice:\d+(\.\d+)?/.test(line)) {
                const before = line.match(/currentPrice:(\d+(\.\d+)?)/)[1];
                const after = price.toFixed(2);
                if (before !== after) {
                    lines[i] = line.replace(
                        /currentPrice:\d+(\.\d+)?/,
                        `currentPrice:${after}`
                    );
                    changes++;
                    console.log(`  ${ticker.padEnd(6)} ${before.padStart(8)} → ${after}`);
                } else {
                    console.log(`  ${ticker.padEnd(6)} ${before.padStart(8)} (unchanged)`);
                }
                break;
            }
        }
    }
    return { html: lines.join('\n'), changes };
}

(async () => {
    try {
        console.log('Fetching prices from Stooq…');
        const csv = await fetchStooq(TICKERS);
        const prices = parsePrices(csv);
        const got = Object.keys(prices);
        console.log(`Got ${got.length}/${TICKERS.length} prices: ${got.join(', ')}`);

        if (got.length < Math.ceil(TICKERS.length * 0.8)) {
            throw new Error(`Too few prices returned (${got.length}/${TICKERS.length}). Aborting to avoid partial update.`);
        }

        const html = fs.readFileSync(FILE_PATH, 'utf8');
        const { html: newHtml, changes } = updateHtml(html, prices);

        if (changes === 0) {
            console.log('No price changes — file already current.');
            process.exit(0);
        }

        fs.writeFileSync(FILE_PATH, newHtml);
        console.log(`✅ Updated ${changes} prices in ${FILE_PATH}`);
    } catch (err) {
        console.error('❌ Refresh failed:', err.message);
        process.exit(1);
    }
})();
