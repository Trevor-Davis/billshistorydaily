/**
 * fetch-daily.js
 *
 * Fetches the previous day's Buffalo Bills news via Anthropic API + web search,
 * extracts an og:image from one of the article URLs,
 * saves everything to public/data/YYYY-MM-DD.json,
 * and updates public/data/index.json.
 */

const fs   = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

function getTargetDate() {
  if (process.argv[2] && process.argv[2].trim()) return process.argv[2].trim();
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function readableDate(key) {
  return new Date(key + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });
}

// ── Anthropic API call ────────────────────────────────────────────────────────
async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tb = data.content?.find(b => b.type === 'text');
  if (!tb) throw new Error('No text in response');
  return tb.text;
}

// ── Extract og:image from article URL ────────────────────────────────────────
async function extractOgImage(url) {
  if (!url || url === '') return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BillsHistoryBot/1.0)',
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Try og:image first
    let match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (!match) {
      // Try content before property
      match = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    }
    if (!match) {
      // Try twitter:image as fallback
      match = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    }
    if (!match) {
      match = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    }

    if (match && match[1]) {
      const imgUrl = match[1].trim();
      // Filter out tiny icons and SVGs
      if (imgUrl.match(/\.(svg|ico)$/i)) return null;
      if (imgUrl.includes('logo') && !imgUrl.includes('article')) return null;
      console.log('  Found image:', imgUrl.substring(0, 70) + '...');
      return imgUrl;
    }
    return null;
  } catch(e) {
    console.log('  Could not fetch:', url.substring(0, 50), '-', e.message);
    return null;
  }
}

// ── Fetch Bills news ──────────────────────────────────────────────────────────
async function fetchDailyData(dateKey) {
  const readable = readableDate(dateKey);

  const prompt = `Search the web for Buffalo Bills NFL news articles published on ${readable}.

IMPORTANT: You must ONLY output a JSON object. Do NOT explain your findings. Do NOT write any sentences. Do NOT include any text outside the JSON.

Even if you find little or no news, still return the JSON object with themes:["Quiet news day"].

Output this JSON structure and nothing else:
{"themes":["theme1","theme2"],"writeup":"3-5 sentence summary of the day","articles":[{"title":"headline","source":"publication","url":"https://..."}]}

JSON rules:
- themes: 2-4 short noun phrases describing the day
- writeup: engaging sports journalism summary
- articles: 3-8 real articles with real URLs found in search, or [{"title":"No coverage found","source":"—","url":""}] if none
- START your response with { and END with }
- ZERO other text`;

  const raw = await callAnthropic(prompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + raw.substring(0, 200));

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.themes || !parsed.writeup || !parsed.articles) {
    throw new Error('Response missing required fields: ' + JSON.stringify(parsed));
  }
  return parsed;
}

// ── Save data ─────────────────────────────────────────────────────────────────
function saveData(dateKey, data) {
  const dataDir = path.join(__dirname, '..', 'public', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const dayPath = path.join(dataDir, `${dateKey}.json`);
  fs.writeFileSync(dayPath, JSON.stringify(data, null, 2));
  console.log(`✓ Saved ${dayPath}`);

  const indexPath = path.join(dataDir, 'index.json');
  let index = { dates: [] };
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
    catch(e) { console.warn('Could not parse index.json, rebuilding.'); }
  }
  if (!index.dates.includes(dateKey)) {
    index.dates.push(dateKey);
    index.dates.sort((a, b) => b.localeCompare(a));
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`✓ Updated index.json (${index.dates.length} dates total)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const dateKey = getTargetDate();
  console.log(`\nFetching Bills news for: ${dateKey} (${readableDate(dateKey)})\n`);

  try {
    const data = await fetchDailyData(dateKey);
    console.log('Themes  :', data.themes.join(' | '));
    console.log('Articles:', data.articles.length);

    // Try to extract og:image from articles
    console.log('\nLooking for article image...');
    let imageUrl = null;
    for (const article of data.articles) {
      if (!article.url) continue;
      console.log('Trying:', article.source);
      imageUrl = await extractOgImage(article.url);
      if (imageUrl) break;
    }

    if (imageUrl) {
      data.imageUrl = imageUrl;
      console.log('✓ Image found');
    } else {
      console.log('No image found, continuing without.');
    }

    saveData(dateKey, data);
    console.log('\n✓ Done.\n');
  } catch (err) {
    console.error('\n✗ Failed:', err.message);
    process.exit(1);
  }
})();