import { search } from 'duck-duck-scrape';
import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Extracts normalized hostname/domain from a URL.
 * @param {string} url
 * @returns {string} Normalized domain (e.g. "neuralcoretech.com")
 */
export function getDomain(url) {
  try {
    if (!url || typeof url !== 'string') return '';
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Unwraps Bing redirect URLs (`bing.com/ck/a?!...&u=a1aHR0...`) to extract the real target URL.
 * @param {string} rawUrl
 * @returns {string}
 */
export function unwrapBingUrl(rawUrl) {
  try {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    if (!rawUrl.includes('bing.com/ck/a')) return rawUrl;

    const uParamMatch = rawUrl.match(/[?&]u=([^&]+)/);
    if (!uParamMatch) return rawUrl;

    let encoded = uParamMatch[1];
    if (encoded.startsWith('a1')) {
      encoded = encoded.substring(2);
    }

    const base64Str = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const decodedUrl = Buffer.from(base64Str, 'base64').toString('utf-8');

    if (decodedUrl.startsWith('http://') || decodedUrl.startsWith('https://')) {
      return decodedUrl;
    }
  } catch (err) {
    // Return rawUrl if decoding fails
  }
  return rawUrl;
}

/**
 * Searches the web using a multi-tiered provider system with en-US market targeting.
 * @param {string} query - Search query.
 * @param {number} maxResults - Maximum number of search results to return (default: 4).
 * @returns {Promise<Array<{ title: string, url: string, snippet: string, content: string }>>}
 */
export async function searchWeb(query, maxResults = 4) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const sanitizedQuery = query.trim();
  console.log(`[SearchService] Executing targeted web search for: "${sanitizedQuery}"`);

  let searchResults = [];

  // Tier 1: DuckDuckGo library
  try {
    const ddgResponse = await search(sanitizedQuery, { safeSearch: 0 });
    if (ddgResponse && ddgResponse.results && ddgResponse.results.length > 0) {
      searchResults = ddgResponse.results.slice(0, maxResults * 2).map((r) => ({
        title: r.title || 'Untitled Source',
        url: r.url,
        snippet: r.description || r.snippet || '',
      }));
    }
  } catch (err) {
    console.warn(`[SearchService] Tier 1 (DuckDuckGo library) notice: ${err.message}. Trying Tier 2 (DuckDuckGo HTML)...`);
  }

  // Tier 2: DuckDuckGo HTML Provider
  if (searchResults.length === 0) {
    searchResults = await fetchDuckDuckGoHtml(sanitizedQuery, maxResults * 2);
  }

  // Tier 3: Bing Search Provider with en-US market targeting
  if (searchResults.length === 0) {
    searchResults = await fetchBingSearch(sanitizedQuery, maxResults * 2);
  }

  // Tier 4: Wikipedia Search Provider
  if (searchResults.length === 0) {
    searchResults = await fetchWikipediaSearch(sanitizedQuery, maxResults);
  }

  if (searchResults.length === 0) {
    console.warn(`[SearchService] All search providers returned 0 results for query: "${sanitizedQuery}"`);
    return [];
  }

  // Clean URLs and apply structural & domain blacklisting
  const cleanedResults = searchResults
    .map((r) => ({
      ...r,
      url: unwrapBingUrl(r.url),
    }))
    .filter((r) => isQualitySourceCandidate(r.url, r.title, r.snippet));

  const topResults = cleanedResults.slice(0, maxResults);

  // Deep text content extraction and quality classification
  const processedResults = await Promise.all(
    topResults.map(async (result) => {
      const pageContent = await fetchAndExtractText(result.url);
      const hasFullContent = !!pageContent && pageContent.length >= 100;
      const qualityTier = classifySourceQuality(result.url, result.title, result.snippet);
      return {
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        content: pageContent || result.snippet || 'Content unavailable.',
        hasFullContent,
        qualityTier,
      };
    })
  );

  // Sort results to prioritize full content and higher quality tiers
  processedResults.sort((a, b) => {
    if (a.hasFullContent !== b.hasFullContent) {
      return a.hasFullContent ? -1 : 1;
    }
    return 0;
  });

  return processedResults;
}

/**
 * Classifies a web source into a quality tier based on domain, title, and structure.
 * @param {string} url
 * @param {string} [title]
 * @param {string} [snippet]
 * @returns {string} Quality tier label.
 */
export function classifySourceQuality(url, title = '', snippet = '') {
  if (!url || typeof url !== 'string') return 'General Web Source / Aggregator';

  const lowerUrl = url.toLowerCase();
  const lowerTitle = (title || '').toLowerCase();

  if (
    lowerUrl.includes('arxiv.org') ||
    lowerUrl.includes('github.com') ||
    lowerUrl.includes('nature.com') ||
    lowerUrl.includes('science.org') ||
    lowerUrl.includes('frontiersin.org') ||
    lowerUrl.includes('stanford.edu') ||
    lowerUrl.includes('mit.edu') ||
    lowerUrl.includes('ieee.org') ||
    lowerUrl.includes('docs.') ||
    lowerUrl.includes('.edu') ||
    lowerUrl.includes('.gov')
  ) {
    return 'Official Documentation / Academic Paper';
  }

  if (
    lowerUrl.includes('techcrunch.com') ||
    lowerUrl.includes('wired.com') ||
    lowerUrl.includes('arstechnica.com') ||
    lowerUrl.includes('venturebeat.com') ||
    lowerUrl.includes('zdnet.com') ||
    lowerUrl.includes('theverge.com') ||
    lowerUrl.includes('infoworld.com') ||
    lowerUrl.includes('reuters.com') ||
    lowerUrl.includes('bloomberg.com')
  ) {
    return 'Reputable Tech Publication';
  }

  if (
    lowerUrl.includes('blog') ||
    lowerTitle.includes('blog') ||
    lowerUrl.includes('medium.com') ||
    lowerUrl.includes('dev.to') ||
    lowerUrl.includes('substack.com')
  ) {
    return 'Company Blog / Industry Article';
  }

  return 'General Web Source / Aggregator';
}

/**
 * Validates candidate URL and snippet quality to filter out non-AI spam, car rentals, and regional news portals.
 * @param {string} url
 * @param {string} title
 * @param {string} snippet
 * @returns {boolean}
 */
function isQualitySourceCandidate(url, title, snippet) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;

  // Reject unresolved Bing internal tracking URLs
  if (url.includes('bing.com/ck/a')) return false;

  const lowerUrl = url.toLowerCase();
  const combinedText = `${title} ${snippet} ${url}`.toLowerCase();

  // Explicit domain blacklist for car rentals, dictionaries, general news aggregators, and social video platforms
  const blacklistedDomains = [
    'enterprisemobility.com',
    'enterprise.com',
    'enterpriserentacar.com',
    'hertz.com',
    'avis.com',
    'budget.com',
    'nationalcar.com',
    'alamo.com',
    'ndtv.com',
    'hindustantimes.com',
    'timesofindia.indiatimes.com',
    'orissapost.com',
    'odishasambad.in',
    'news24online.com',
    'latestly.com',
    'aajtak.in',
    'bhaskar.com',
    'naidunia.com',
    'inanews.org',
    'news.google.com',
    'dictionary.cambridge.org',
    'dictionary.apa.org',
    'dictionary.com',
    'merriam-webster.com',
    'thefreedictionary.com',
    'vocabulary.com',
    'wiktionary.org',
    'collinsdictionary.com',
    'linguee.com',
    'thesaurus.com',
    'englishwordchamps.com',
    'facebook.com',
    'instagram.com',
    'tiktok.com',
    'pinterest.com',
    'play.google.com',
    'youtube.com/watch',
    'vimeo.com',
    'imdb.com',
  ];

  for (const domain of blacklistedDomains) {
    if (lowerUrl.includes(domain)) {
      return false;
    }
  }

  // Candidate MUST mention explicit AI/agent/automation/tech terms using word boundaries
  const aiKeywordRegex = /\b(ai|agent|agents|autonomous|automation|machine learning|llm|llms|agentic|neural network|deep learning|framework|express|node|software)\b/i;

  return aiKeywordRegex.test(combinedText);
}

/**
 * DuckDuckGo HTML Search Provider via GET request.
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
async function fetchDuckDuckGoHtml(query, maxResults = 8) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 5000,
    });

    const $ = cheerio.load(response.data);
    const results = [];

    $('.result__body').each((_, el) => {
      if (results.length >= maxResults) return false;
      const title = $(el).find('.result__title').text().trim();
      const href = $(el).find('.result__title a').attr('href') || '';
      const snippet = $(el).find('.result__snippet').text().trim();

      let targetUrl = href;
      if (href.includes('uddg=')) {
        const match = href.match(/uddg=([^&]+)/);
        if (match) targetUrl = decodeURIComponent(match[1]);
      }

      if (title && targetUrl && targetUrl.startsWith('http')) {
        results.push({ title, url: targetUrl, snippet });
      }
    });

    return results;
  } catch (err) {
    console.warn(`[SearchService] DDG HTML notice: ${err.message}`);
    return [];
  }
}

/**
 * Bing HTML Search Provider with explicit en-US market headers.
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
async function fetchBingSearch(query, maxResults = 8) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US&setlang=en-us`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 6000,
    });

    const $ = cheerio.load(response.data);
    const results = [];

    $('#b_results .b_algo').each((_, el) => {
      if (results.length >= maxResults) return false;
      const titleLink = $(el).find('h2 a');
      const title = titleLink.text().trim();
      let rawUrl = titleLink.attr('href') || '';
      const snippet = $(el).find('.b_caption p, .b_algoSubExtra').text().trim();

      const targetUrl = unwrapBingUrl(rawUrl);

      if (title && targetUrl && targetUrl.startsWith('http')) {
        results.push({ title, url: targetUrl, snippet });
      }
    });

    return results;
  } catch (err) {
    console.error('[SearchService] Bing search fallback error:', err.message);
    return [];
  }
}

/**
 * Wikipedia API Search Provider.
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
async function fetchWikipediaSearch(query, maxResults = 3) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'AutonomousResearchAgent/1.0 (Bot; nodejs)',
      },
      timeout: 5000,
    });

    if (!response.data?.query?.search) return [];

    return response.data.query.search.slice(0, maxResults).map((item) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: item.snippet ? item.snippet.replace(/<[^>]+>/g, '') : '',
    }));
  } catch (err) {
    console.error('[SearchService] Wikipedia API fallback error:', err.message);
    return [];
  }
}

/**
 * Fetches page content and extracts main readable text using Cheerio.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchAndExtractText(url) {
  try {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 6000,
      maxRedirects: 3,
      responseType: 'text',
    });

    if (!response.data || typeof response.data !== 'string') return null;

    const $ = cheerio.load(response.data);

    // Remove clutter elements
    $('script, style, noscript, nav, header, footer, iframe, svg, form, button, [role="navigation"], .sidebar, .ad, .cookie').remove();

    let bodyText = '';
    $('article, main, p, h1, h2, h3, h4, li, td, section, blockquote, div.content, div.post-body').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) {
        bodyText += text + '\n';
      }
    });

    const cleanedText = bodyText.replace(/\s+/g, ' ').trim();
    return cleanedText.length > 0 ? cleanedText.substring(0, 4000) : null;
  } catch (err) {
    return null;
  }
}

export default {
  searchWeb,
  unwrapBingUrl,
  classifySourceQuality,
};
