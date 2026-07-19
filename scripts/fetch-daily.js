/**
 * fetch-daily.js — Bills History Daily
 * Fetches articles, saves to public/pending/YYYY-MM-DD.json for editorial review.
 * The admin page at /admin handles selection, headline generation, and publishing.
 */

const fs   = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set.'); process.exit(1); }

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

async function callAnthropic(messages, useSearch = false) {
  const body = { model: 'claude-sonnet-4-6', max_tokens: 4000, messages };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
  } catch(e) { throw new Error(`Network error: ${e.message}`); }
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tb = data.content?.find(b => b.type === 'text');
  if (!tb) throw new Error('No text in response');
  return tb.text;
}

// ── RSS feed fetching ─────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'Buffalo Rumblings', url: 'https://www.buffalorumblings.com/rss/index.xml', loose: true },
  { name: 'Buffalo Bills',     url: 'https://www.buffalobills.com/rss/news', loose: true },
  { name: 'Banged Up Bills',   url: 'https://bangedupbills.com/feed', loose: true },
  { name: 'WGR 550',           url: 'https://www.wgr550.com/feed/', loose: true, filter: ['bills', 'buffalo'] },
  { name: 'WKBW Bills',        url: 'https://www.wkbw.com/sports/buffalo-bills/rss', loose: true },
  { name: 'ESPN',              url: 'https://www.espn.com/espn/rss/nfl/news', loose: true, filter: ['bills', 'buffalo'] },
  { name: 'Pro Football Talk', url: 'https://profootballtalk.nbcsports.com/feed/', loose: true, filter: ['bills', 'buffalo'] },
  { name: 'Bills News Aggregator', url: 'https://rss.app/feeds/v1.1/_kUr4Rzeb0eCbl80W.json', loose: true, jsonfeed: true, useAuthor: true },
  { name: 'Bills YouTube',     url: 'https://rss.app/feeds/v1.1/_V749Ggacq7cF1gct.json', loose: true, jsonfeed: true, filter: ['bills', 'buffalo', 'josh allen', 'mcdermott', 'joe brady'] },
];

const SOURCE_NAMES = {
  'buffalorumblings.com': 'Buffalo Rumblings', 'buffalobills.com': 'Buffalo Bills',
  'bangedupbills.com': 'Banged Up Bills', 'twobillsdrive.com': 'Two Bills Drive',
  'buffalonews.com': 'Buffalo News', 'wgr550.com': 'WGR 550', 'wkbw.com': 'WKBW',
  'espn.com': 'ESPN', 'nbcsports.com': 'Pro Football Talk', 'si.com': 'Sports Illustrated',
  'heavy.com': 'Heavy.com', 'nfl.com': 'NFL.com', 'usatoday.com': 'USA Today',
  'nypost.com': 'NY Post', 'cbssports.com': 'CBS Sports', 'foxsports.com': 'Fox Sports',
  'theathletic.com': 'The Athletic', 'bleacherreport.com': 'Bleacher Report',
  'sportingnews.com': 'Sporting News', 'yardbarker.com': 'Yardbarker',
  'youtube.com': 'YouTube', 'youtu.be': 'YouTube',
};

function sourceFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    for (const [domain, name] of Object.entries(SOURCE_NAMES)) {
      if (hostname.includes(domain)) return name;
    }
    return hostname.split('.')[0].replace(/^\w/, c => c.toUpperCase());
  } catch(e) { return 'Unknown'; }
}

function extractText(xml, tag) {
  let idx = xml.indexOf('<' + tag);
  if (idx === -1) return null;
  let start = xml.indexOf('>', idx) + 1;
  let end = xml.indexOf('</' + tag, start);
  if (end === -1) return null;
  let val = xml.slice(start, end).trim();
  if (val.startsWith('<![CDATA[')) val = val.slice(9);
  if (val.endsWith(']]>')) val = val.slice(0, -3);
  return val.replace(/<[^>]+>/g, '').trim() || null;
}

function extractLink(item) {
  let m = item.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (m) return m[1].trim();
  m = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)/i);
  if (m) return m[1].trim();
  m = item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i);
  if (m) return m[1].trim();
  return null;
}

async function fetchRssArticles(dateKey) {
  const targetDate = new Date(dateKey + 'T00:00:00Z');
  const nextDate   = new Date(dateKey + 'T23:59:59Z');
  const articles   = [];

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`  Fetching RSS: ${feed.name}`);
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BillsHistoryBot/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, application/json, */*' },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { console.log(`  ${feed.name}: HTTP ${res.status}`); continue; }

      if (feed.jsonfeed) {
        const data = await res.json();
        const posts = data.items || [];
        console.log(`  ${feed.name}: ${posts.length} items`);
        for (const post of posts) {
          const pubDate = new Date(post.date_published);
          if (isNaN(pubDate.getTime())) continue;
          const slack = feed.loose ? 2 * 24 * 60 * 60 * 1000 : 0;
          if (pubDate < new Date(targetDate.getTime() - slack) || pubDate > new Date(nextDate.getTime() + slack)) continue;
          const title = (post.title || '').trim();
          const url   = post.url;
          if (!title || !url) continue;
          if (feed.filter) {
            const keywords = Array.isArray(feed.filter) ? feed.filter : [feed.filter];
            const text = (title + ' ' + (post.content_text || '')).toLowerCase();
            if (!keywords.some(k => text.includes(k))) continue;
          }
          const source = (feed.useAuthor && (post.author?.name || post.author)) ? (post.author?.name || post.author) : sourceFromUrl(url);
          articles.push({ title, source, url, image: post.image || null });
          console.log(`  ✓ [${source}] ${title.substring(0, 60)}`);
        }
        continue;
      }

      if (feed.json) {
        const posts = await res.json();
        console.log(`  ${feed.name}: ${posts.length} posts`);
        for (const post of posts) {
          const pubDate = new Date(post.date);
          if (isNaN(pubDate.getTime())) continue;
          if (pubDate < targetDate || pubDate > nextDate) continue;
          const title = post.title?.rendered?.replace(/<[^>]+>/g,'').trim() || post.title;
          const url   = post.link;
          if (title && url) { articles.push({ title, source: feed.name, url }); console.log(`  ✓ ${title.substring(0, 70)}`); }
        }
        continue;
      }

      const xml = await res.text();
      console.log(`  ${feed.name}: got ${xml.length} chars`);
      const itemRe  = /<item[\s\S]*?<\/item>/gi;
      const entryRe = /<entry[\s\S]*?<\/entry>/gi;
      const items   = [...(xml.match(itemRe) || []), ...(xml.match(entryRe) || [])];
      console.log(`  ${feed.name}: ${items.length} items in feed`);

      for (const item of items) {
        const title = extractText(item, 'title');
        const url   = extractLink(item);
        if (!title || !url) continue;
        const rawDate = extractText(item, 'pubDate') || extractText(item, 'published') || extractText(item, 'updated') || extractText(item, 'dc:date');
        if (rawDate) {
          const pubDate = new Date(rawDate);
          if (!isNaN(pubDate.getTime())) {
            const slack = feed.loose ? 2 * 24 * 60 * 60 * 1000 : 0;
            if (pubDate < new Date(targetDate.getTime() - slack) || pubDate > new Date(nextDate.getTime() + slack)) continue;
          }
        }
        if (feed.filter) {
          const keywords = Array.isArray(feed.filter) ? feed.filter : [feed.filter];
          const text = (title + ' ' + url).toLowerCase();
          if (!keywords.some(k => text.includes(k))) continue;
        }
        articles.push({ title, source: feed.name, url });
        console.log(`  ✓ ${title.substring(0, 70)}`);
      }
    } catch(e) { console.log(`  ${feed.name} failed: ${e.message}`); }
  }

  console.log(`RSS total: ${articles.length} articles found`);
  return articles;
}

// ── og:image extraction ───────────────────────────────────────────────────────
async function extractOgImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BillsHistoryBot/1.0)' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const html = await res.text();
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const imgUrl = match[1].trim();
        if (imgUrl.match(/\.(svg|ico)$/i) || imgUrl.length < 10) continue;
        return imgUrl;
      }
    }
    return null;
  } catch(e) { return null; }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
function deduplicateArticles(articles) {
  function normalizeTitle(t) {
    return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }
  function titleSimilarity(a, b) {
    const wa = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 3));
    const wb = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 3));
    const intersection = [...wa].filter(w => wb.has(w)).length;
    const union = new Set([...wa, ...wb]).size;
    return union === 0 ? 0 : intersection / union;
  }
  const deduped = [];
  for (const article of articles) {
    const isDuplicate = deduped.some(kept => titleSimilarity(article.title, kept.title) > 0.6);
    if (!isDuplicate) deduped.push(article);
    else console.log(`  Deduped (same-day): "${article.title.substring(0, 60)}"`);
  }
  return deduped;
}

// ── Cross-day deduplication against yesterday's published articles ─────────────
function removePreviousDayDuplicates(articles, dateKey) {
  function normalizeTitle(t) {
    return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }
  function titleSimilarity(a, b) {
    const wa = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 3));
    const wb = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 3));
    const intersection = [...wa].filter(w => wb.has(w)).length;
    const union = new Set([...wa, ...wb]).size;
    return union === 0 ? 0 : intersection / union;
  }

  // Load yesterday's published articles
  let yesterdayArticles = [];
  try {
    const d = new Date(dateKey + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    const yKey = d.toISOString().split('T')[0];
    const yPath = path.join(__dirname, '..', 'public', 'data', `${yKey}.json`);
    if (fs.existsSync(yPath)) {
      const yData = JSON.parse(fs.readFileSync(yPath, 'utf8'));
      yesterdayArticles = yData.articles || [];
      console.log(`Cross-day dedup: checking against ${yesterdayArticles.length} articles from ${yKey}`);
    }
  } catch(e) {
    console.log('Could not load yesterday\'s articles for cross-day dedup:', e.message);
  }

  if (yesterdayArticles.length === 0) return articles;

  const filtered = articles.filter(article => {
    const isCrossDedup = yesterdayArticles.some(prev =>
      titleSimilarity(article.title, prev.title) > 0.6
    );
    if (isCrossDedup) console.log(`  Deduped (cross-day): "${article.title.substring(0, 60)}"`);
    return !isCrossDedup;
  });

  const removed = articles.length - filtered.length;
  if (removed > 0) console.log(`Cross-day dedup removed ${removed} article(s) also covered yesterday.`);
  return filtered;
}

// ── Save pending file ─────────────────────────────────────────────────────────
function savePending(dateKey, articles, images = []) {
  const pendingDir = path.join(__dirname, '..', 'public', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const filePath = path.join(pendingDir, `${dateKey}.json`);
  const data = { dateKey, date: readableDate(dateKey), fetchedAt: new Date().toISOString(), articles, images };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✓ Saved pending: ${filePath}`);
  console.log(`  ${articles.length} articles ready for review`);
  console.log(`  ${images.length} photos available to pick from`);
  console.log(`  Admin URL: https://billshistorydaily.com/admin`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const dateKey = getTargetDate();
  console.log(`\nFetching Bills news for: ${dateKey} (${readableDate(dateKey)})\n`);
  try {
    console.log('Step 1: Fetching RSS feeds...');
    const rssArticles = await fetchRssArticles(dateKey);

    console.log('\nStep 2: Searching web for additional coverage...');
    const readable = readableDate(dateKey);
    const webSearch = await callAnthropic([{
      role: 'user',
      content: `Search for Buffalo Bills NFL news from ${readable} on these sites: buffalobills.com, buffalorumblings.com, buffalonews.com, si.com, espn.com, nfl.com, profootballtalk.nbcsports.com. List every article you find with title, source, and URL.`
    }], true);

    const generalSearch = await callAnthropic([{
      role: 'user',
      content: `Search broadly for any additional Buffalo Bills NFL news from ${readable} not already covered. List every article with title, source, and URL.`
    }], true);

    // Extract articles from web search results
    const webText = webSearch + '\n' + generalSearch;
    const urlMatches = webText.match(/https?:\/\/[^\s\)\"\']+/g) || [];
    const webArticles = [];
    const seenUrls = new Set(rssArticles.map(a => a.url));

    // Ask Claude to parse these into structured articles
    const structuredResult = await callAnthropic([{
      role: 'user',
      content: `Here are Buffalo Bills news findings from ${readable}:\n\n${webText}\n\nExtract every article mentioned into this JSON:\n{"articles":[{"title":"headline","source":"publication","url":"https://..."}]}\nOnly include articles with real URLs. Respond ONLY with the JSON.`
    }], false);

    try {
      const match = structuredResult.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        for (const a of (parsed.articles || [])) {
          if (a.url && !seenUrls.has(a.url) && !a.url.includes('heavy.com')) {
            webArticles.push(a);
            seenUrls.add(a.url);
          }
        }
      }
    } catch(e) { console.warn('Could not parse web search articles:', e.message); }

    // Merge and deduplicate (same-day)
    const sameDayDeduped = deduplicateArticles([...rssArticles, ...webArticles]);

    // Remove articles too similar to yesterday's published coverage
    const allArticles = removePreviousDayDuplicates(sameDayDeduped, dateKey);

    // Try to extract images from articles
    console.log('\nStep 3: Extracting article images...');
    const articlesWithImages = [];
    for (const article of allArticles.slice(0, 20)) { // check first 20 articles
      let imageUrl = article.image || '';
      if (!imageUrl && article.url) {
        imageUrl = await extractOgImage(article.url) || '';
      }
      articlesWithImages.push({ ...article, imageUrl });
    }
    // Add remaining articles without images
    for (const article of allArticles.slice(20)) {
      articlesWithImages.push({ ...article, imageUrl: article.image || '' });
    }

    // Collect unique images for the photo picker
    const images = [...new Set(
      articlesWithImages
        .map(a => a.imageUrl)
        .filter(url => url && url.startsWith('http'))
    )].slice(0, 12); // max 12 photos to pick from

    console.log(`Found ${images.length} unique images for photo picker`);

    // Clean up article objects
    const cleanArticles = articlesWithImages.map(({ title, source, url, imageUrl }) => ({ title, source, url, imageUrl }));

    savePending(dateKey, cleanArticles, images);

    console.log('\n✓ Done. Visit /admin to review and publish.');
  } catch (err) {
    console.error('\n✗ Failed:', err.message);
    process.exit(1);
  }
})();