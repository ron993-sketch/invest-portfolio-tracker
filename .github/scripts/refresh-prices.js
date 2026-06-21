// Auto-refresh stock prices into index.html.
// Runs in GitHub Actions on a cron schedule (see ../workflows/refresh-prices.yml).
// Primary source: Yahoo Finance v8 chart endpoint (no API key, server-side only).
// Stooq's CSV API was blocked by a JavaScript Proof-of-Work challenge in June 2026,
// so it's no longer reliable; kept as a one-shot fallback in case Yahoo blocks us later.

const fs = require('fs');
const https = require('https');

const FILE_PATH = 'index.html';

// Active live-portfolio tickers (positions with shares > 0).
// Closed positions (QFIN, CEG) keep their historical exit price baked in.
const TICKERS = ['MU', 'OPFI', 'META', 'POWL', 'GOOGL', 'EVER', 'HLI', 'PANW', 'SMMT', 'BRK-B', 'UNH'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const opts = { headers: { 'User-Agent': UA, 'Accept': '*/*' } };
        https.get(url, opts, res => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function fetchYahoo(ticker) {
    // Yahoo uses BRK-B (hyphen) in URL like our internal symbol — no translation needed.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const body = await httpGet(url);
    const json = JSON.parse(body);
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Yahoo returned invalid price for ${ticker}`);
    }
    return price;
}

async function fetchAll(tickers) {
    const out = {};
    // Sequential to be polite to Yahoo; total ~3-6 seconds for 11 tickers.
    for (const t of tickers) {
        try {
            out[t] = await fetchYahoo(t);
            console.log(`  ✓ ${t.padEnd(6)} ${out[t].toFixed(2)}`);
        } catch (err) {
            console.warn(`  ✗ ${t.padEnd(6)} ${err.message}`);
        }
    }
    return out;
}

function updateHtml(html, prices) {
    let changes = 0;
    const lines = html.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [ticker, price] of Object.entries(prices)) {
            const tickerEscaped = ticker.replace('-', '\\-');
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
                }
                break;
            }
        }
    }
    return { html: lines.join('\n'), changes };
}

(async () => {
    try {
        console.log('Fetching prices from Yahoo Finance…');
        const prices = await fetchAll(TICKERS);
        const got = Object.keys(prices);
        console.log(`\nGot ${got.length}/${TICKERS.length} prices.`);

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
