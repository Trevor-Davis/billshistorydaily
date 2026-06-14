/**
 * fetch-daily.js
 *
 * Fetches the previous day's Buffalo Bills news via Anthropic API + web search,
 * saves it to public/data/YYYY-MM-DD.json, and updates public/data/index.json.
 *
 * Runs nightly at 2am ET via GitHub Actions.
 *
 * Manual usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/fetch-daily.js
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/fetch-daily.js 2024-01-28
 */

const fs   = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

// ── Target date ───────────────────────────────────────────────────────────────
function getTargetDate() {
  if (process.argv[2]) return process.argv[2];
  const d = new Date();
  d.setDate(d.getDate() - 1); // yesterday
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
      messages: [
        {
          role: 'user',
          content: prompt
        },
        {
          role: 'assistant',
          content: '{'
        }
      ]
    })
  });

  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tb = data.content?.find(b => b.type === 'text');
  if (!tb) throw new Error('No text in response');
  // The assistant started with '{' so we prepend it back
  return '{' + tb.text;
}

// ── Fetch and parse ───────────────────────────────────────────────────────────
async function fetchDailyData(dateKey) {
  const readable = readableDate(dateKey);

  const prompt = `Search for all Buffalo Bills NFL news articles published on ${readable}.

Return a JSON object with exactly this shape:
{
  "themes": ["short theme 1", "short theme 2", "short theme 3"],
  "writeup": "3-5 sentence editorial narrative of the day in engaging sports-journalism style",
  "articles": [
    { "title": "Article headline", "source": "Publication name", "url": "https://..." }
  ]
}

Rules:
- themes: 2-4 noun phrases (4-6 words max each)
- writeup: flowing 3-5 sentence summary covering the main stories and their significance
- articles: every distinct Bills news article from that date, 3-8 items, REAL URLs only
- If no Bills news: themes:["Quiet news day"], writeup:"No significant Bills news coverage found for this date.", articles:[{"title":"No coverage found","source":"—","url":""}]
- Your response must be a valid JSON object starting with { and ending with }
- No text before or after the JSON. No markdown. No backticks. No preamble. No explanation.`;

  const raw = await callAnthropic(prompt);

  // Extract JSON even if there's any stray text
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in response: ' + raw.substring(0, 200));

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

  // Write day file
  const dayPath = path.join(dataDir, `${dateKey}.json`);
  fs.writeFileSync(dayPath, JSON.stringify(data, null, 2));
  console.log(`✓ Saved ${dayPath}`);

  // Update index
  const indexPath = path.join(dataDir, 'index.json');
  let index = { dates: [] };
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
    catch(e) { console.warn('Could not parse index.json, rebuilding.'); }
  }
  if (!index.dates.includes(dateKey)) {
    index.dates.push(dateKey);
    index.dates.sort((a, b) => b.localeCompare(a)); // newest first
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
    saveData(dateKey, data);
    console.log('\n✓ Done.');
    console.log('Themes  :', data.themes.join(' | '));
    console.log('Articles:', data.articles.length);
  } catch (err) {
    console.error('\n✗ Failed:', err.message);
    process.exit(1);
  }
})();