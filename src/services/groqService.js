import axios from 'axios';
import config, { validateEnv } from '../config/env.js';
import { classifySourceQuality } from './searchService.js';

let cachedAvailableModels = null;
let lastModelFetchTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // Cache model list for 5 minutes

/**
 * Queries Groq's model discovery endpoint to fetch currently available models for the API key.
 * @returns {Promise<string[]>} List of available model IDs.
 */
export async function getAvailableGroqModels() {
  const now = Date.now();
  if (cachedAvailableModels && now - lastModelFetchTimestamp < CACHE_TTL_MS) {
    return cachedAvailableModels;
  }

  const key = config.groqApiKey;
  if (!key) return [];

  try {
    const res = await axios.get(`${config.groqBaseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${key}`,
      },
      timeout: 10000,
    });

    if (res.data?.data && Array.isArray(res.data.data)) {
      const activeModels = res.data.data.map((m) => m.id);
      cachedAvailableModels = activeModels;
      lastModelFetchTimestamp = now;
      console.log('[GroqService] Verified active Groq models for account:', activeModels.filter(m => !m.includes('whisper') && !m.includes('guard')));
      return activeModels;
    }
  } catch (err) {
    console.warn('[GroqService] Could not fetch models list from Groq API:', err.message);
  }

  return cachedAvailableModels || [];
}

/**
 * Parses HTTP 429 Retry-After duration or error message retry seconds.
 * Reads retry-after headers or error body duration (e.g. "Please try again in 4.92s.").
 * Honors retry duration up to a maximum wait of 60 seconds per retry.
 * @param {object} err - Axios error object.
 * @param {number} attempt - Current retry attempt index.
 * @returns {number} Delay in milliseconds.
 */
export function calculateRetryDelay(err, attempt = 0) {
  const MAX_WAIT_MS = 60000; // 60s max per retry
  const headers = err.response?.headers || {};
  const retryAfterHeader = headers['retry-after'] || headers['x-ratelimit-reset-tokens'] || headers['x-ratelimit-reset-requests'];

  if (retryAfterHeader) {
    const parsedSec = parseFloat(retryAfterHeader);
    if (!isNaN(parsedSec) && parsedSec > 0) {
      const waitMs = Math.ceil(parsedSec * 1000) + 500;
      return Math.min(waitMs, MAX_WAIT_MS);
    }
  }

  // Parse "retry in Xs", "try again in Xs", or "try again in XmYs" from Groq error message body
  const errMsg = err.response?.data?.error?.message || err.message || '';
  const minSecMatch = errMsg.match(/(?:try again in|retry in|reset in)\s*(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s/i);
  if (minSecMatch) {
    const mins = minSecMatch[1] ? parseFloat(minSecMatch[1]) : 0;
    const secs = minSecMatch[2] ? parseFloat(minSecMatch[2]) : 0;
    const totalSec = mins * 60 + secs;
    if (totalSec > 0) {
      const waitMs = Math.ceil(totalSec * 1000) + 500; // +500ms buffer
      return Math.min(waitMs, MAX_WAIT_MS);
    }
  }

  // Fallback exponential backoff: 3s, 6s, 12s, capped at MAX_WAIT_MS
  return Math.min(3000 * Math.pow(2, attempt), MAX_WAIT_MS);
}

/**
 * Executes a chat completion request against Groq's OpenAI-compatible API endpoint (https://api.groq.com/openai/v1).
 * Includes model discovery, 30s request timeout, max 2 retries for HTTP 429 errors, and retry-after wait handling.
 * @param {string} prompt
 * @param {string} [systemMessage]
 * @param {number} [maxTokens]
 * @returns {Promise<string>}
 */
async function generateWithGroq(prompt, systemMessage = '', maxTokens = 4096) {
  const envCheck = validateEnv();
  if (!envCheck.valid) {
    throw new Error(`Groq API Configuration Error: ${envCheck.errors.join(' ')}`);
  }

  const availableModels = await getAvailableGroqModels();
  const primaryRequestedModel = config.groqModel || 'openai/gpt-oss-20b';

  // Build ordered list of candidate models, prioritizing currently active models
  let candidateModels = [primaryRequestedModel, 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];

  if (availableModels.length > 0) {
    candidateModels = candidateModels.filter((m) => availableModels.includes(m));

    if (availableModels.includes(primaryRequestedModel)) {
      candidateModels = [primaryRequestedModel, ...candidateModels.filter((m) => m !== primaryRequestedModel)];
    } else if (availableModels.includes('openai/gpt-oss-20b')) {
      candidateModels = ['openai/gpt-oss-20b', ...candidateModels.filter((m) => m !== 'openai/gpt-oss-20b')];
    } else {
      const extraTextModels = availableModels.filter((m) => !m.includes('whisper') && !m.includes('guard'));
      candidateModels = [...new Set([...candidateModels, ...extraTextModels])];
    }
  }

  const uniqueModels = [...new Set(candidateModels)];
  if (uniqueModels.length === 0) {
    uniqueModels.push('openai/gpt-oss-20b');
  }

  let lastError = null;

  for (const modelName of uniqueModels) {
    // Allow a maximum of 2 retries for HTTP 429 errors (3 attempts total)
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[GroqService] Invoking Groq model: "${modelName}" (Attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
        const messages = [];
        if (systemMessage) {
          messages.push({ role: 'system', content: systemMessage });
        }
        messages.push({ role: 'user', content: prompt });

        const response = await axios.post(
          `${config.groqBaseUrl}/chat/completions`,
          {
            model: modelName,
            messages,
            temperature: 0.2,
            max_tokens: maxTokens,
          },
          {
            headers: {
              'Authorization': `Bearer ${config.groqApiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000, // 30s timeout per API call
          }
        );

        const choice = response.data?.choices?.[0];
        let content = choice?.message?.content;
        const finishReason = choice?.finish_reason;

        if (content && typeof content === 'string') {
          // Detect if generation stopped prematurely due to token limit
          if (finishReason === 'length') {
            console.warn(`[GroqService] Model "${modelName}" hit token limit (finish_reason: length). Safely requesting continuation...`);
            let accumulatedContent = content;
            const MAX_CONTINUATIONS = 1;

            for (let c = 0; c < MAX_CONTINUATIONS; c++) {
              try {
                const continuationMessages = [
                  ...(systemMessage ? [{ role: 'system', content: systemMessage }] : []),
                  { role: 'user', content: prompt },
                  { role: 'assistant', content: accumulatedContent },
                  { role: 'user', content: 'Continue generating the remaining uncompleted sections of the research report starting exactly where you left off. Do not repeat already generated sections or introductory text.' },
                ];

                const contResponse = await axios.post(
                  `${config.groqBaseUrl}/chat/completions`,
                  {
                    model: modelName,
                    messages: continuationMessages,
                    temperature: 0.2,
                    max_tokens: maxTokens,
                  },
                  {
                    headers: {
                      'Authorization': `Bearer ${config.groqApiKey}`,
                      'Content-Type': 'application/json',
                    },
                    timeout: 30000,
                  }
                );

                const contChoice = contResponse.data?.choices?.[0];
                const contText = contChoice?.message?.content;
                const contFinish = contChoice?.finish_reason;

                if (contText && typeof contText === 'string' && contText.trim()) {
                  accumulatedContent = accumulatedContent.trimEnd() + '\n\n' + contText.trimStart();
                  if (contFinish !== 'length') {
                    console.log(`[GroqService] Continuation completed successfully on step ${c + 1}.`);
                    break;
                  }
                } else {
                  break;
                }
              } catch (contErr) {
                console.warn(`[GroqService] Continuation attempt notice: ${contErr.message}`);
                break;
              }
            }
            return accumulatedContent;
          }

          return content;
        }
      } catch (err) {
        const status = err.response?.status;
        const errMsg = err.response?.data?.error?.message || err.message || '';

        lastError = err;

        if (status === 401) {
          throw new Error('Groq API Error: 401 Invalid API Key. Please verify GROQ_API_KEY in .env file.');
        }

        // Handle HTTP 429 Rate Limits / TPM Quotas
        if (status === 429 || /rate limit|limit reached|tpd|tpm/i.test(errMsg)) {
          if (attempt < MAX_RETRIES) {
            const delayMs = calculateRetryDelay(err, attempt);

            const minSecMatch = errMsg.match(/(?:try again in|retry in|reset in)\s*(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s/i);
            const mins = minSecMatch && minSecMatch[1] ? parseFloat(minSecMatch[1]) : 0;
            if (mins >= 2) {
              // Daily token quota exhausted requiring multi-minute reset; fail fast
              throw new Error(`Groq API Rate Limit Exceeded (HTTP 429): Quota reset requires ${mins} minutes. ${errMsg}`);
            }

            console.warn(`[GroqService] Rate limit hit (HTTP 429) on "${modelName}". Waiting ${(delayMs / 1000).toFixed(2)}s before retry ${attempt + 1}/${MAX_RETRIES}...`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          } else {
            // Exceeded max 2 retries for 429
            throw new Error(`Groq API Rate Limit Exceeded (HTTP 429): Retried ${MAX_RETRIES} times without success. ${errMsg}`);
          }
        }

        // Non-429 errors fail fast without retrying for this model
        console.warn(`[GroqService] Model "${modelName}" returned non-429 error (HTTP ${status || 'Network/Timeout'}): ${errMsg}.`);
        break;
      }
    }
  }

  throw new Error(`Groq API generation failed: ${lastError ? (lastError.response?.data?.error?.message || lastError.message) : 'Unknown error'}`);
}

/**
 * Extracts high-density relevant evidence paragraphs across the entire body content based on topic keyword scoring.
 * Prevents top-of-page navigation fluff from obscuring deep page findings.
 * @param {string} content - Raw page text.
 * @param {string} topic - Research topic.
 * @param {number} maxChars - Maximum characters to return.
 * @returns {string} High-density evidence text.
 */
export function extractRelevantSnippets(content, topic = '', maxChars = 1000) {
  if (!content || typeof content !== 'string') return '';
  if (content.length <= maxChars) return content;

  // Split into paragraphs or logical sentence blocks
  const blocks = content
    .split(/(?:\r?\n){2,}|\.\s+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 25);

  if (blocks.length === 0) return content.substring(0, maxChars);

  const topicWords = (topic || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['latest', 'developments', 'with', 'about', 'from', 'in'].includes(w));

  const scoredBlocks = blocks.map((block) => {
    const lower = block.toLowerCase();
    let score = 0;

    for (const word of topicWords) {
      if (lower.includes(word)) score += 3;
    }

    if (/\b(ai|agent|agents|autonomous|llm|automation|benchmark|framework|model)\b/i.test(block)) score += 2;
    if (/\b\d+(?:\.\d+)?%|\$\d+|\b202\d\b|\b\d+(?:\.\d+)?x\b/i.test(block)) score += 3;

    return { block, score };
  });

  // Sort blocks by relevance score descending
  scoredBlocks.sort((a, b) => b.score - a.score);

  // Only include blocks with score > 0 to exclude nav/cookie/fluff blocks
  const relevantBlocks = scoredBlocks.filter((item) => item.score > 0);

  let selectedText = '';

  if (relevantBlocks.length > 0) {
    for (const item of relevantBlocks) {
      if ((selectedText + ' ' + item.block).length > maxChars) {
        if (selectedText.length === 0) {
          selectedText = item.block.substring(0, maxChars);
        }
        break;
      }
      selectedText += (selectedText ? '\n\n' : '') + item.block;
    }
  }

  // Fall back to beginning of content only if no relevant blocks found
  return selectedText || content.substring(0, maxChars);
}

/**
 * Identifies the main dimensions / research areas of a broad research topic.
 * Returns a structured list of expected coverage areas so that downstream steps
 * can detect drift and gaps before report generation.
 * @param {string} topic - Main research topic.
 * @returns {Promise<Array<{ dimension: string, keywords: string[] }>>}
 */
export async function analyzeTopicDimensions(topic) {
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    throw new Error('analyzeTopicDimensions: topic must be a non-empty string.');
  }

  const systemMessage = `You are an AI Research Scope Analyst. Return ONLY a valid JSON array.`;
  const prompt = `Identify the 4 to 6 most important distinct research dimensions (sub-areas) for the following research topic:
"${topic.trim()}"

For each dimension, list 3 to 5 short keywords that a web source would need to contain to be considered relevant to that dimension.

Return ONLY a valid JSON array:
[
  {
    "dimension": "Short name for this research dimension (e.g. AI Agents & Autonomous Workflows)",
    "keywords": ["keyword1", "keyword2", "keyword3"]
  }
]
Do not include any text outside the JSON array.`;

  try {
    console.log(`[GroqService] Analyzing topic dimensions for: "${topic}" via Groq API...`);
    const responseText = await generateWithGroq(prompt, systemMessage, 1024);
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Ensure a software-development dimension always exists for automation topics
        const hasSoftwareDim = parsed.some((d) =>
          /software|coding|developer|code generation/i.test(d.dimension + ' ' + (d.keywords || []).join(' '))
        );
        if (!hasSoftwareDim && /automation|ai/i.test(topic)) {
          parsed.push({
            dimension: 'AI-Assisted Software Development',
            keywords: ['coding', 'code generation', 'developer', 'copilot', 'swe-bench', 'github', 'cursor', 'claude code', 'software development'],
          });
        }
        // Expand dimension keywords to cover common real-world terms
        const expansionMap = {
          'rpa': ['robotic process', 'hyperautomation', 'hyper-automation', 'no-code', 'low-code', 'process automation'],
          'agent': ['agentic', 'orchestrator', 'multi-agent', 'autonomous workflow'],
          'governance': ['audit', 'compliance', 'human-in-the-loop', 'hitl', 'regulation', 'oversight'],
          'chatbot': ['customer service', 'conversational', 'virtual assistant', 'nlp', 'customer support'],
          'manufacturing': ['industrial', 'factory', 'iot', 'edge computing', 'predictive maintenance'],
        };
        for (const dim of parsed) {
          for (const [trigger, extras] of Object.entries(expansionMap)) {
            if ((dim.keywords || []).some((k) => k.toLowerCase().includes(trigger))) {
              dim.keywords = [...new Set([...(dim.keywords || []), ...extras])];
            }
          }
        }
        console.log('[GroqService] Identified topic dimensions:', parsed.map((d) => d.dimension));
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`[GroqService] Topic dimension analysis notice: ${err.message}. Using fallback dimensions.`);
  }

  // Generic fallback for AI automation topics — broader keyword lists to match real web sources
  return [
    { dimension: 'AI Agents & Autonomous Workflows', keywords: ['agent', 'autonomous', 'workflow', 'orchestration', 'multi-agent', 'agentic', 'orchestrator'] },
    { dimension: 'Business Process & RPA Automation', keywords: ['rpa', 'business process', 'process automation', 'hyperautomation', 'hyper-automation', 'robotic process', 'no-code', 'low-code'] },
    { dimension: 'AI-Assisted Software Development', keywords: ['code generation', 'coding', 'developer', 'copilot', 'devops', 'swe-bench', 'code generation', 'github', 'software development', 'ide', 'cursor', 'claude code'] },
    { dimension: 'Customer Support & Conversational AI', keywords: ['chatbot', 'customer support', 'conversational', 'nlp', 'virtual assistant', 'customer service'] },
    { dimension: 'Industrial & Robotic Automation', keywords: ['robotics', 'manufacturing', 'predictive maintenance', 'industrial', 'factory', 'iot', 'edge computing'] },
    { dimension: 'Enterprise Adoption & Governance', keywords: ['governance', 'reliability', 'compliance', 'adoption', 'enterprise', 'audit', 'human-in-the-loop', 'hitl', 'regulation'] },
  ];
}

/**
 * Detects whether collected sources are drifting into a narrow subtopic, ignoring the broader topic.
 * Returns a drift report: which dimension has too many sources, which are under-covered.
 * @param {string} topic - Original research topic.
 * @param {Array<{ title: string, url: string, snippet: string, content: string }>} sources
 * @param {Array<{ dimension: string, keywords: string[] }>} dimensions
 * @returns {{ driftDetected: boolean, dominantDimension: string|null, coverageMap: Object, gaps: string[] }}
 */
export function detectTopicDrift(topic, sources, dimensions) {
  if (!Array.isArray(sources) || sources.length === 0 || !Array.isArray(dimensions) || dimensions.length === 0) {
    return { driftDetected: false, dominantDimension: null, coverageMap: {}, gaps: [] };
  }

  const coverageMap = {};
  for (const dim of dimensions) {
    coverageMap[dim.dimension] = 0;
  }

  for (const src of sources) {
    const text = `${src.title} ${src.snippet} ${src.content}`.toLowerCase();
    for (const dim of dimensions) {
      const matchCount = dim.keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
      if (matchCount >= 1) {
        coverageMap[dim.dimension] = (coverageMap[dim.dimension] || 0) + 1;
      }
    }
  }

  const totalSources = sources.length;
  const DRIFT_THRESHOLD = 0.60; // If one dimension has ≥60% of sources → drift
  const GAP_THRESHOLD = 0;      // Dimensions with 0 matching sources → gap

  let dominantDimension = null;
  let maxCount = 0;
  for (const [dim, count] of Object.entries(coverageMap)) {
    if (count > maxCount) {
      maxCount = count;
      dominantDimension = dim;
    }
  }

  const driftDetected = totalSources > 0 && maxCount / totalSources >= DRIFT_THRESHOLD;
  const gaps = Object.entries(coverageMap)
    .filter(([, count]) => count <= GAP_THRESHOLD)
    .map(([dim]) => dim);

  if (driftDetected) {
    console.warn(`[TopicDriftDetector] DRIFT DETECTED: "${dominantDimension}" covers ${maxCount}/${totalSources} sources (${Math.round(maxCount / totalSources * 100)}%). Coverage map:`, coverageMap);
  } else {
    console.log('[TopicDriftDetector] Coverage spread is acceptable. Coverage map:', coverageMap);
  }

  if (gaps.length > 0) {
    console.warn('[TopicDriftDetector] Coverage gaps detected (0 sources) in dimensions:', gaps);
  }

  return { driftDetected, dominantDimension, coverageMap, gaps };
}

/**
 * Checks if any single subtopic keyword cluster is over-represented among sources.
 * Returns true if overrepresentation is detected and the dominant cluster label.
 * @param {Array<{ title: string, snippet: string, content: string }>} sources
 * @param {string[]} subtopicKeywords - Keywords identifying the narrow subtopic (e.g. ['predictive maintenance', 'pdm'])
 * @param {number} threshold - Fraction of sources that triggers overrepresentation (default 0.6).
 * @returns {{ overrepresented: boolean, fraction: number, subtopic: string }}
 */
export function checkSubtopicOverrepresentation(sources, subtopicKeywords, threshold = 0.60) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { overrepresented: false, fraction: 0, subtopic: '' };
  }

  const keywordsLower = subtopicKeywords.map((k) => k.toLowerCase());
  const subtopicLabel = subtopicKeywords[0] || 'unknown subtopic';

  const matchingCount = sources.filter((src) => {
    const text = `${src.title} ${src.snippet} ${src.content}`.toLowerCase();
    return keywordsLower.some((kw) => text.includes(kw));
  }).length;

  const fraction = matchingCount / sources.length;
  const overrepresented = fraction >= threshold;

  if (overrepresented) {
    console.warn(`[SubtopicChecker] OVERREPRESENTATION: "${subtopicLabel}" present in ${matchingCount}/${sources.length} sources (${Math.round(fraction * 100)}%).`);
  }

  return { overrepresented, fraction, subtopic: subtopicLabel };
}

/**
 * Uses Groq API to break down a research topic into sub-questions and keyword-dense search queries.
 * @param {string} topic - Main research topic.
 * @returns {Promise<Array<{ subQuestion: string, searchQuery: string }>>} Array of search query objects.
 */
export async function decomposeTopic(topic) {
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    throw new Error('Research topic must be a non-empty string.');
  }

  const systemMessage = `You are an Autonomous AI Search Query Engineer. Return ONLY a valid JSON array.`;
  const prompt = `The user wants to conduct technical research on the BROAD topic: "${topic.trim()}".

Your task:
1. Identify 5 to 6 DISTINCT, non-overlapping research dimensions that together span the full breadth of "${topic.trim()}".
   MANDATORY: Each sub-question MUST cover a DIFFERENT dimension. Do NOT generate multiple queries about the same narrow subtopic.
   Example dimensions for an "AI automation" topic:
   - AI agents and autonomous workflow orchestration
   - Business process automation and RPA
   - AI-assisted software development tools
   - Customer support and conversational AI automation
   - Industrial automation and robotics
   - Enterprise adoption, governance, and reliability
2. For EACH dimension, craft a short, keyword-dense WEB SEARCH QUERY (4 to 7 words) designed for Google/Bing.
3. MANDATORY CRITERIA: Every search query MUST explicitly contain "AI", "Artificial Intelligence", "Autonomous Agents", or "LLM" and the year or domain keywords.
4. DIVERSITY RULE: No two search queries may target the same narrow subtopic (e.g. do NOT generate two different queries both about "predictive maintenance").
5. Do NOT use conversational filler like "latest developments in" or generic corporate terms without explicit AI keywords.

Return ONLY a valid JSON array of objects with the following schema:
[
  {
    "subQuestion": "Analytical sub-question covering a distinct dimension",
    "searchQuery": "AI automation agentic workflow enterprise 2026"
  }
]
Do not include any text outside the JSON array.`;

  try {
    console.log(`[GroqService] Decomposing research topic: "${topic}" via Groq API...`);
    const responseText = await generateWithGroq(prompt, systemMessage);

    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('[GroqService] Could not parse raw JSON from query plan. Using default keyword queries.');
      return [
        { subQuestion: `Technical AI breakthroughs in ${topic}`, searchQuery: `AI ${topic} breakthroughs 2026` },
        { subQuestion: `Autonomous agent architectures in ${topic}`, searchQuery: `autonomous AI agents ${topic} enterprise 2026` },
        { subQuestion: `LLM process automation trends in ${topic}`, searchQuery: `LLM agentic automation ${topic} 2026` },
      ];
    }

    const queryPlan = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(queryPlan) || queryPlan.length === 0) {
      throw new Error('Parsed query plan is not a valid array.');
    }

    const processed = queryPlan.map((item) => {
      let q = String(item.searchQuery || item.subQuestion || '').trim();
      if (!/\b(ai|artificial intelligence|machine learning|llm|agentic|autonomous agent)\b/i.test(q)) {
        q = `AI ${q}`;
      }
      return {
        subQuestion: String(item.subQuestion || item.searchQuery || '').trim(),
        searchQuery: q,
      };
    });

    console.log('[GroqService] Engineered Search Queries:', processed.map((p) => p.searchQuery));
    return processed;
  } catch (error) {
    console.error('[GroqService] Topic decomposition failed:', error.message);
    throw new Error(`Failed to decompose research topic using Groq API: ${error.message}`);
  }
}

/**
 * Uses Groq API to refine and generate additional search queries when evidence is sparse.
 * @param {string} topic - Research topic.
 * @param {string[]} existingQueries - Queries already searched.
 * @param {Array<{ title: string, url: string }>} existingSources - Currently verified sources.
 * @returns {Promise<Array<{ subQuestion: string, searchQuery: string }>>}
 */
export async function refineSearchQueries(topic, existingQueries = [], existingSources = [], coverageGaps = []) {
  const systemMessage = `You are a Principal AI Search Query Optimizer. Return ONLY a valid JSON array.`;

  const gapContext = coverageGaps.length > 0
    ? `\nCOVERAGE GAPS to fill (dimensions with no sources yet):\n${coverageGaps.map((g) => `- ${g}`).join('\n')}\nPrioritize queries that cover these missing dimensions.`
    : '';

  const prompt = `The research topic is: "${topic.trim()}".

Initial search queries executed:
${existingQueries.map((q) => `- ${q}`).join('\n')}

Sources collected so far (${existingSources.length}):
${existingSources.map((s) => `- ${s.title} (${s.url})`).join('\n') || 'None'}
${gapContext}

Craft 2 to 3 REFINED, high-intent, alternative web search queries (5 to 8 words) to uncover technical evidence directly relevant to "${topic.trim()}".
Each query MUST cover a DIFFERENT sub-area of the topic — do NOT repeat already-covered subtopics.
Every refined query MUST include explicit AI terms (e.g. "AI", "LLM", "autonomous agents", "agentic automation") and year "2026" or core topic terms.

Return ONLY a valid JSON array of objects:
[
  {
    "subQuestion": "Refined analytical aspect covering a new dimension",
    "searchQuery": "AI agentic business process automation enterprise 2026"
  }
]`;

  try {
    console.log(`[GroqService] Refining search queries for topic: "${topic}" via Groq API...`);
    const responseText = await generateWithGroq(prompt, systemMessage);
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const refinedPlan = JSON.parse(jsonMatch[0]);
      if (Array.isArray(refinedPlan) && refinedPlan.length > 0) {
        return refinedPlan.map((item) => {
          let q = String(item.searchQuery || item.subQuestion || '').trim();
          if (!/\b(ai|artificial intelligence|machine learning|llm|agentic|autonomous agent)\b/i.test(q)) {
            q = `AI ${q}`;
          }
          return {
            subQuestion: String(item.subQuestion || item.searchQuery || '').trim(),
            searchQuery: q,
          };
        });
      }
    }
  } catch (err) {
    console.warn(`[GroqService] Query refinement notice: ${err.message}. Using default refined query.`);
  }

  return [
    { subQuestion: `Advanced technical frameworks for ${topic}`, searchQuery: `AI autonomous agents workflow automation 2026 trends` },
    { subQuestion: `Enterprise implementation benchmarks for ${topic}`, searchQuery: `agentic AI process automation enterprise report 2026` },
  ];
}

/**
 * Uses Groq API to evaluate web search content and audit source relevance against the research topic.
 * @param {string} topic - Original research topic.
 * @param {Array<{ title: string, url: string, snippet: string, content: string, hasFullContent?: boolean, qualityTier?: string }>} rawSources - Raw collected search items.
 * @returns {Promise<Array<{ title: string, url: string, snippet: string, content: string, hasFullContent?: boolean, qualityTier?: string }>>} Filtered relevant sources.
 */
export async function filterRelevantSources(topic, rawSources) {
  if (!rawSources || rawSources.length === 0) return [];

  const candidatesFormatted = rawSources
    .map((s, idx) => `[ID ${idx}] Title: "${s.title}"\nURL: ${s.url}\nQuality Tier: ${s.qualityTier || classifySourceQuality(s.url, s.title, s.snippet)}\nData Status: ${s.hasFullContent ? 'FULL PAGE TEXT' : 'SNIPPET ONLY'}\nExtracted Content: "${(s.content || s.snippet).substring(0, 1000)}"`)
    .join('\n---\n');

  const systemMessage = `You are a Principal Technical Fact Verification & Relevance Auditor. Return ONLY a valid JSON array.`;
  const prompt = `The user is researching the topic: "${topic.trim()}".

Below are candidate web search sources along with their actual extracted page content and quality classification:

${candidatesFormatted}

AUDIT MANDATE:
Evaluate each source based on its EXTRACTED CONTENT.
- ACCEPT a source if its content directly addresses, discusses, or provides technical/domain evidence relevant to "${topic.trim()}".
- REJECT any source that is completely off-topic, spam, car rental advertisements, home appliance automation (unless topic is home automation), generic non-technical landing pages, dictionary definitions, movie trailers, or unrelated marketing directories.
- Do NOT reject a source merely because it does not mention AI unless the research topic explicitly involves AI.

Return ONLY a valid JSON array of objects:
[
  {
    "id": 0,
    "accepted": true/false,
    "reason": "Clear explanation based strictly on the extracted page content"
  }
]`;

  try {
    console.log(`[GroqService] Auditing relevance of ${rawSources.length} sources for topic: "${topic}" via Groq API`);
    const responseText = await generateWithGroq(prompt, systemMessage);
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);

    if (jsonMatch) {
      const auditData = JSON.parse(jsonMatch[0]);
      if (Array.isArray(auditData)) {
        const acceptedSources = [];

        console.log('\n--- SOURCE RELEVANCE AUDIT EVALUATION (GROQ) ---');
        for (const evalItem of auditData) {
          const idx = typeof evalItem.id === 'number' ? evalItem.id : parseInt(evalItem.id, 10);
          const src = rawSources[idx];
          if (src) {
            const statusStr = evalItem.accepted ? '✅ ACCEPTED' : '❌ REJECTED';
            console.log(`Source [ID ${idx}] (${src.url}): ${statusStr}`);
            console.log(`  Title: ${src.title}`);
            console.log(`  Quality: ${src.qualityTier || classifySourceQuality(src.url, src.title, src.snippet)}`);
            console.log(`  Reason: ${evalItem.reason}`);

            if (evalItem.accepted) {
              acceptedSources.push(src);
            }
          }
        }
        console.log('--------------------------------------------------\n');

        console.log(`[GroqService] Audit kept ${acceptedSources.length}/${rawSources.length} sources.`);
        return acceptedSources;
      }
    }
  } catch (err) {
    console.warn(`[GroqService] Relevance audit notice: ${err.message}. Running fallback heuristic filter.`);
  }

  // Fallback Keyword Filter (does not force AI keywords for non-AI topics)
  const stopWords = new Set(['latest', 'developments', 'with', 'about', 'from', 'in', 'and', 'for', 'standards', 'enterprise', 'adoption', 'overview', 'trends', 'report']);
  const topicTerms = topic
    .toLowerCase()
    .split(/[^\w]+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));
  const isAiTopic = /\b(ai|artificial intelligence|machine learning|llm|llms|agentic|autonomous agent|autonomous agents|generative ai)\b/i.test(topic);

  const fallbackFiltered = rawSources.filter((s) => {
    const text = `${s.title} ${s.snippet} ${s.content}`.toLowerCase();
    const mentionsTopicTerm = topicTerms.length === 0 || topicTerms.some((t) => text.includes(t));

    if (isAiTopic) {
      const mentionsAI = /\b(ai|artificial intelligence|machine learning|llm|llms|agentic|autonomous agent|autonomous agents|generative ai)\b/i.test(text);
      return mentionsAI && mentionsTopicTerm;
    }

    return mentionsTopicTerm;
  });

  console.log(`[GroqService] Fallback keyword filter kept ${fallbackFiltered.length}/${rawSources.length} sources.`);
  return fallbackFiltered;
}

/**
 * Verifies that numerical claims in the generated report exist in the specifically cited source.
 * Replaces digit-only matching with strict cited-source evidence verification.
 * @param {string} reportMarkdown - Generated Markdown report.
 * @param {Array<{ title: string, url: string, snippet: string, content: string }>} researchData - Aggregated research sources.
 * @returns {string} Grounded report Markdown.
 */
export function verifyAndCleanReportGrounding(reportMarkdown, researchData) {
  if (!reportMarkdown || typeof reportMarkdown !== 'string') return reportMarkdown;
  if (!researchData || researchData.length === 0) return reportMarkdown;

  // Build Map of lowercased URLs to full source objects
  const sourceMap = new Map();
  researchData.forEach((s) => {
    if (s.url) {
      sourceMap.set(s.url.toLowerCase(), s);
    }
  });

  const validUrls = new Map(researchData.map((s) => [s.url.toLowerCase(), s.url]));
  const defaultUrl = researchData[0] ? researchData[0].url : '';

  // Check if primary sources (Academic/Official) are present
  const hasPrimarySources = researchData.some((s) => {
    const tier = s.qualityTier || classifySourceQuality(s.url, s.title, s.snippet);
    return tier === 'Official Documentation / Academic Paper';
  });

  // Combine full corpus for fallback check
  const fullCorpusText = researchData
    .map((s) => `${s.title} ${s.snippet} ${s.content}`)
    .join(' ')
    .toLowerCase();

  const rawLines = reportMarkdown.split('\n');

  // Check and clean trailing truncated/incomplete sentence if present
  let cleanedLinesList = [...rawLines];
  while (cleanedLinesList.length > 0) {
    const lastLine = cleanedLinesList[cleanedLinesList.length - 1].trim();
    if (!lastLine) {
      cleanedLinesList.pop();
      continue;
    }
    // If last line looks abruptly cut off (e.g. no trailing period, colon, bracket, or markdown header)
    if (!/[.!?:"')\]`~#*|-]$/.test(lastLine) && lastLine.length > 0 && !lastLine.startsWith('#')) {
      console.warn(`[GroundingVerifier] Cleaning trailing truncated fragment: "${lastLine}"`);
      cleanedLinesList.pop();
    } else {
      break;
    }
  }

  const cleanedLines = cleanedLinesList.map((line) => {
    if (line.startsWith('#') || !line.trim()) return line;

    // Detect markdown link URLs cited on this specific line
    const citedUrlsOnLine = [];
    const linkMatches = line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
    for (const match of linkMatches) {
      const citedUrl = match[2].trim().toLowerCase();
      citedUrlsOnLine.push(citedUrl);
    }

    let modifiedLine = line;

    // RULE 1: Never classify a blog or secondary claim as "Primary Evidence" or "Verified Empirical Fact"
    if (/\|\s*(?:\*\*)?(?:Primary Evidence|Verified Empirical Fact|Verified Fact)(?:\*\*)?\s*\|/i.test(modifiedLine)) {
      const isActuallyPrimary = citedUrlsOnLine.some((citedUrl) => {
        const src = sourceMap.get(citedUrl);
        const tier = src ? (src.qualityTier || classifySourceQuality(src.url, src.title, src.snippet)) : '';
        return tier === 'Official Documentation / Academic Paper';
      });

      if (!isActuallyPrimary) {
        modifiedLine = modifiedLine.replace(/\|\s*(?:\*\*)?(?:Primary Evidence|Verified Empirical Fact|Verified Fact)(?:\*\*)?\s*\|/gi, '| Secondary Reporting |');
      }
    }

    // RULE 2: Match statistics, percentages, currency, multipliers (e.g. 3.8x), and CAGRs
    const statRegex = /(?:\$\d+(?:\.\d+)?(?:\s*(?:billion|million|trillion))?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?x\s*(?:roi|productivity|return)?|\bCAGR of \d+(?:\.\d+)?%|\b\d+\s*(?:organizations|enterprises|agents|users))/gi;
    const matches = line.match(statRegex);

    if (matches && matches.length > 0) {
      for (const stat of matches) {
        const digitsMatch = stat.match(/\d+(?:\.\d+)?/);
        if (!digitsMatch) continue;

        const digitStr = digitsMatch[0];
        let isGroundedInCitedSource = false;

        if (citedUrlsOnLine.length > 0) {
          // Verify if digit exists in the SPECIFICALLY CITED source's content/snippet
          for (const citedUrl of citedUrlsOnLine) {
            const matchedSrc = sourceMap.get(citedUrl) || researchData.find((s) => s.url.toLowerCase().includes(citedUrl) || citedUrl.includes(s.url.toLowerCase()));
            if (matchedSrc) {
              const srcText = `${matchedSrc.title} ${matchedSrc.snippet} ${matchedSrc.content}`.toLowerCase();
              if (srcText.includes(digitStr)) {
                isGroundedInCitedSource = true;
                break;
              }
            }
          }
        } else {
          // If no link on line, check overall corpus
          if (fullCorpusText.includes(digitStr)) {
            isGroundedInCitedSource = true;
          }
        }

        if (!isGroundedInCitedSource) {
          console.warn(`[GroundingVerifier] Flagging ungrounded statistic "${stat}" (digit "${digitStr}" absent in cited source).`);
          modifiedLine = modifiedLine.replace(stat, `${stat} (unverified stat - absent in cited source text)`);
        }
      }
    }

    return modifiedLine;
  });

  let processedMarkdown = cleanedLines.join('\n');

  // Fix inline citations: Ensure Markdown links point to valid URLs in researchData
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  processedMarkdown = processedMarkdown.replace(linkRegex, (match, title, url) => {
    const cleanUrl = url.trim().toLowerCase();
    if (validUrls.has(cleanUrl)) {
      return `[${title}](${validUrls.get(cleanUrl)})`;
    }
    for (const [validLower, originalUrl] of validUrls.entries()) {
      if (cleanUrl.includes(validLower) || validLower.includes(cleanUrl)) {
        return `[${title}](${originalUrl})`;
      }
    }
    if (defaultUrl) {
      return `[${title}](${defaultUrl})`;
    }
    return match;
  });

  // Inject Evidence Transparency Notice if primary sources are absent and notice not yet present
  if (!hasPrimarySources && !processedMarkdown.includes('Evidence Transparency Notice')) {
    const noticeBlock = `> [!NOTE]\n> **Evidence Transparency Notice**: This research report is synthesized from secondary industry commentary, vendor publications, and technology articles. Primary peer-reviewed scientific literature or regulatory filings were not directly present in the collected web corpus.\n\n`;
    if (processedMarkdown.includes('# Executive Summary')) {
      processedMarkdown = processedMarkdown.replace('# Executive Summary', `# Executive Summary\n\n${noticeBlock}`);
    } else {
      processedMarkdown = `${noticeBlock}${processedMarkdown}`;
    }
  }

  return processedMarkdown;
}

/**
 * Analyzes collected web research data and generates a structured markdown research report using Groq API.
 * Uses high-density evidence extraction across full source text and includes quality tier labels.
 * @param {string} topic - Original research topic.
 * @param {Array<{ title: string, url: string, snippet: string, content: string, hasFullContent?: boolean, qualityTier?: string }>} researchData - Aggregated research entries.
 * @returns {Promise<string>} Generated Markdown research report.
 */
export async function generateResearchReport(topic, researchData) {
  if (!topic || typeof topic !== 'string') {
    throw new Error('Invalid topic provided to report generator.');
  }

  if (!researchData || researchData.length === 0) {
    throw new Error(`Research Failed: Zero verified web sources relevant to "${topic}" were found. Report generation aborted.`);
  }

  // Cap at 10 sources to stay within the 8K TPM limit on gpt-oss-20b;
  // gpt-oss-120b is used as fallback and handles larger payloads.
  const cappedResearchData = researchData.length > 10
    ? researchData.slice(0, 10)
    : researchData;
  if (researchData.length > 10) {
    console.warn(`[GroqService] Capping evidence context from ${researchData.length} to 10 sources to stay within TPM limits.`);
  }

  // Extract high-density evidence paragraphs (600 chars per source keeps prompt within 8K tokens)
  const evidenceContext = cappedResearchData
    .map((item, index) => {
      const statusText = item.hasFullContent ? 'FULL EXTRACTED PAGE TEXT (CONCISE)' : 'SNIPPET ONLY - LIMITED EVIDENCE';
      const tierText = item.qualityTier || classifySourceQuality(item.url, item.title, item.snippet);
      const highDensityEvidence = extractRelevantSnippets(item.content || item.snippet, topic, 600);

      return `---
Source #${index + 1}:
Title: ${item.title}
URL: ${item.url}
Quality Tier: ${tierText}
Data Status: ${statusText}
Snippet: ${item.snippet}
Key Extracted Evidence: ${highDensityEvidence}
---`;
    })
    .join('\n\n');

  const systemMessage = `You are a Principal AI Technical Research Analyst. Generate a strictly evidence-grounded Research Report in GitHub Flavored Markdown.`;
  const prompt = `Generate a strictly evidence-grounded Research Report on the topic: "${topic.trim()}".

Below is the verified, live web research data collected by our autonomous search engine:

${evidenceContext}

STRICT EVIDENCE & VERIFICATION MANDATE (CRITICAL):
1. STANDARDIZED EVIDENCE CLASSIFICATION:
   In all findings and summary tables, classify evidence ONLY under these standardized categories:
   - Primary Evidence: Direct peer-reviewed research papers, official technical documentation, primary benchmark registries (e.g. arXiv, Nature, IEEE, official docs).
   - Secondary Reporting: Tech publications or media summaries reporting on external studies/benchmarks without primary data access.
   - Vendor Claim: Statements or self-reported metrics by a vendor or company marketing blog about their own tools, adoption, or performance.
   - Editorial Opinion: Thought leadership, conceptual frameworks, or speculative perspectives.
   - Unverified Claim: Rumors, M&A claims, or statistics lacking published methodology/sample size.
   - Snippet-Only Evidence: Observations derived strictly from short search engine snippets.
   *CRITICAL: NEVER classify a blog post or secondary article claim as "Primary Evidence" or "Verified Empirical Fact".*

2. SOURCE ATTRIBUTION VS. INDEPENDENT VERIFICATION:
   - Clearly distinguish source attribution from independent verification. (e.g., write "Reported by [Source Title]" rather than declaring it an independently verified objective fact).
   - For every major claim, cite the exact source supporting it using format [Source Title](URL).

3. NO INVENTED STATISTICS OR FABRICATED METHODOLOGIES:
   - NEVER invent, estimate, or assume statistics, market sizes, CAGRs, percentages, survey counts, or monetary figures.
   - You may ONLY state a statistic if that EXACT number appears in the Key Extracted Evidence of one of the provided sources above.
   - NEVER fabricate or invent survey methodologies, respondent profiles, sample sizes, or study scopes (e.g. do NOT write "drawn from a comprehensive survey of mid-market enterprises" unless those exact words appear in the source text).
   - If a source mentions a figure without disclosing methodology or sample size, describe it accurately as an unverified vendor-reported figure.

4. STRICT RECOMMENDATION GROUNDING:
   - Every recommendation MUST be directly supported by relevant, robust evidence in the sources above.
   - DO NOT recommend speculative or unsupported actions (such as quantum computing integration, specialized pharmaceutical R&D audits, or unverified M&A partnerships) unless supported by clear primary evidence.
   - Recommendations derived from vendor blogs or early benchmarks must be prudently framed as internal proof-of-concept / evaluation.

5. REPORT TRANSPARENCY & NON-REPETITION:
   - If primary scientific or regulatory sources are absent, explicitly state that findings reflect secondary industry commentary.
   - DO NOT repeat the same sentence, statistic, or phrasing across multiple sections.

6. TOPIC COVERAGE & ANTI-DRIFT RULES:
   - This is a BROAD research topic. Do NOT allow any single narrow subtopic (e.g. only predictive maintenance, only chatbots, only one vendor's product) to dominate the report.
   - Before writing, mentally map each source to its research dimension (e.g. AI agents, business process automation, software dev tools, conversational AI, industrial automation, governance).
   - The report MUST reflect ALL dimensions for which evidence exists in the provided sources.
   - If a dimension has NO supporting sources, explicitly note the coverage gap — do NOT invent findings to fill it.
   - NEVER repeat findings across sections. Each section must add new information.

Mandatory headers:
# Executive Summary
## Key Research Findings & Analysis
## Detailed Evidence & Breakthrough Insights
## Actionable Recommendations & Future Outlook
## Coverage Gaps & Limitations
## Verified Sources & References`;

  try {
    console.log(`[GroqService] Generating research report for topic: "${topic}" with ${researchData.length} verified sources via Groq API.`);
    const rawReportMarkdown = await generateWithGroq(prompt, systemMessage, 4096);

    if (!rawReportMarkdown.trim()) {
      throw new Error('Groq API returned empty report content.');
    }

    const verifiedReportMarkdown = verifyAndCleanReportGrounding(rawReportMarkdown, researchData);
    return verifiedReportMarkdown;
  } catch (error) {
    console.error('[GroqService] Report generation failed:', error.message);
    throw new Error(`Failed to generate research report using Groq API: ${error.message}`);
  }
}

export default {
  getAvailableGroqModels,
  extractRelevantSnippets,
  analyzeTopicDimensions,
  detectTopicDrift,
  checkSubtopicOverrepresentation,
  decomposeTopic,
  refineSearchQueries,
  filterRelevantSources,
  verifyAndCleanReportGrounding,
  generateResearchReport,
};
