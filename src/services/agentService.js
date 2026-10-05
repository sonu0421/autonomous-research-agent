import fs from 'fs/promises';
import path from 'path';
import config from '../config/env.js';
import { decomposeTopic, refineSearchQueries, filterRelevantSources, generateResearchReport, analyzeTopicDimensions, detectTopicDrift } from './groqService.js';
import { searchWeb, getDomain } from './searchService.js';

/**
 * Balances source list by applying a domain frequency cap (max 2 per domain),
 * while ensuring relevant evidence is not discarded if doing so would leave the topic under-supported.
 * @param {Array<object>} sources
 * @param {number} maxPerDomain
 * @param {number} minRetained
 * @returns {Array<object>}
 */
export function applyDomainDiversity(sources, maxPerDomain = 2, minRetained = 3) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  // Group sources by normalized domain
  const domainGroups = new Map();
  for (const src of sources) {
    const domain = getDomain(src.url) || 'unknown_domain';
    if (!domainGroups.has(domain)) {
      domainGroups.set(domain, []);
    }
    domainGroups.get(domain).push(src);
  }

  const selected = [];
  const excess = [];

  for (const [domain, group] of domainGroups.entries()) {
    // Sort within domain group: prioritize full content
    group.sort((a, b) => {
      if (a.hasFullContent !== b.hasFullContent) {
        return a.hasFullContent ? -1 : 1;
      }
      return 0;
    });

    const kept = group.slice(0, maxPerDomain);
    const overflow = group.slice(maxPerDomain);

    selected.push(...kept);
    excess.push(...overflow);
  }

  // If domain cap reduced total sources below minRetained, backfill from excess to preserve evidence
  if (selected.length < minRetained && excess.length > 0) {
    const needed = minRetained - selected.length;
    const backfilled = excess.slice(0, needed);
    selected.push(...backfilled);
    console.log(`[AgentService] Domain diversity backfilled ${backfilled.length} sources to maintain minimum evidence threshold (${minRetained}).`);
  }

  return selected;
}

/**
 * Executes an autonomous research workflow for a given topic.
 * @param {string} topic - User-provided research topic.
 * @param {Function} [statusCallback] - Optional status progress logger function.
 * @returns {Promise<{
 *   id: string,
 *   topic: string,
 *   timestamp: string,
 *   subQuestions: string[],
 *   sources: Array<{ title: string, url: string }>,
 *   reportMarkdown: string,
 *   exportPath: string
 * }>}
 */
export async function runResearchTask(topic, statusCallback = () => {}) {
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    throw new Error('Research topic must be a valid, non-empty string.');
  }

  const sanitizedTopic = topic.trim();
  const taskId = `research_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const logProgress = (step, detail) => {
    console.log(`[AgentService] [${step}] ${detail}`);
    statusCallback({ step, detail, timestamp: new Date().toISOString() });
  };

  logProgress('INITIATED', `Starting autonomous research on topic: "${sanitizedTopic}"`);

  // Step 1: Query Engineering via Groq API
  logProgress('DECOMPOSING', 'Analyzing topic and engineering targeted search queries via Groq API...');
  const queryPlan = await decomposeTopic(sanitizedTopic);

  const subQuestions = queryPlan.map((p) => p.subQuestion || p.searchQuery);
  logProgress('DECOMPOSED', `Generated ${queryPlan.length} research sub-queries.`);

  // Step 2: Multi-query Live Web Search
  logProgress('SEARCHING', 'Executing live web search using unwrapped target URLs...');
  const rawResults = [];

  for (let i = 0; i < queryPlan.length; i++) {
    const item = queryPlan[i];
    const searchQuery = item.searchQuery || item.subQuestion;
    logProgress('SEARCHING_SUBQUERY', `Searching web query ${i + 1}/${queryPlan.length}: "${searchQuery}"`);

    const results = await searchWeb(searchQuery, 6);
    rawResults.push(...results);
  }

  // Step 3: Deduplication
  logProgress('DEDUPLICATING', 'Filtering duplicate URLs across search queries...');
  const uniqueSourcesMap = new Map();

  for (const item of rawResults) {
    if (item.url && !uniqueSourcesMap.has(item.url)) {
      uniqueSourcesMap.set(item.url, item);
    }
  }

  const deduplicatedResults = Array.from(uniqueSourcesMap.values());
  logProgress('DEDUPLICATED', `Collected ${deduplicatedResults.length} unique raw web sources.`);

  // Step 4: Groq Source Relevance Audit & Filtering
  logProgress('RELEVANCE_FILTERING', 'Auditing source relevance via Groq AI filter...');
  let relevantResults = await filterRelevantSources(sanitizedTopic, deduplicatedResults);
  logProgress('RELEVANCE_FILTERED', `Verified ${relevantResults.length}/${deduplicatedResults.length} sources as directly relevant to "${sanitizedTopic}".`);

  // Step 4a: Analyze topic dimensions for coverage tracking
  let topicDimensions = [];
  let coverageGaps = [];
  try {
    logProgress('ANALYZING_DIMENSIONS', 'Identifying research dimensions for topic coverage tracking...');
    topicDimensions = await analyzeTopicDimensions(sanitizedTopic);
    logProgress('DIMENSIONS_IDENTIFIED', `Identified ${topicDimensions.length} research dimensions: ${topicDimensions.map((d) => d.dimension).join(', ')}`);
  } catch (dimErr) {
    console.warn('[AgentService] Dimension analysis notice:', dimErr.message);
  }

  // Step 4b: Iterative Search Query Improvement if evidence is sparse (< 5 relevant sources)
  const MIN_RELEVANT_SOURCES = 5;
  if (relevantResults.length < MIN_RELEVANT_SOURCES) {
    // Run drift detection before refinement to focus gap-filling on missing dimensions
    let driftResult = null;
    if (topicDimensions.length > 0) {
      driftResult = detectTopicDrift(sanitizedTopic, relevantResults, topicDimensions);
      coverageGaps = driftResult.gaps;
      if (driftResult.driftDetected) {
        logProgress('DRIFT_DETECTED', `Topic drift detected: "${driftResult.dominantDimension}" is over-represented. Coverage gaps: ${coverageGaps.join(', ') || 'none'}.`);
      }
    }

    logProgress('INSUFFICIENT_EVIDENCE', `Collected evidence is sparse (${relevantResults.length}/${MIN_RELEVANT_SOURCES} target sources). Generating refined search queries via Groq...`);

    try {
      const executedQueries = queryPlan.map((p) => p.searchQuery || p.subQuestion);
      const refinedPlan = await refineSearchQueries(sanitizedTopic, executedQueries, relevantResults, coverageGaps);
      logProgress('REFINING_QUERIES', `Engineered ${refinedPlan.length} refined search queries targeting coverage gaps.`);

      const extraRawResults = [];
      for (let i = 0; i < refinedPlan.length; i++) {
        const item = refinedPlan[i];
        const searchQuery = item.searchQuery || item.subQuestion;
        subQuestions.push(item.subQuestion || searchQuery);
        logProgress('SEARCHING_REFINED_QUERY', `Searching refined web query ${i + 1}/${refinedPlan.length}: "${searchQuery}"`);
        const results = await searchWeb(searchQuery, 6);
        extraRawResults.push(...results);
      }

      // Filter and deduplicate new results against existing relevant sources
      const existingUrls = new Set(relevantResults.map((s) => s.url));
      const newCandidateMap = new Map();
      for (const item of extraRawResults) {
        if (item.url && !existingUrls.has(item.url) && !newCandidateMap.has(item.url)) {
          newCandidateMap.set(item.url, item);
        }
      }

      const newCandidates = Array.from(newCandidateMap.values());
      if (newCandidates.length > 0) {
        logProgress('AUDITING_REFINED_SOURCES', `Auditing ${newCandidates.length} additional candidate sources...`);
        const newVerified = await filterRelevantSources(sanitizedTopic, newCandidates);
        relevantResults.push(...newVerified);
        logProgress('REFINED_SOURCES_VERIFIED', `Total verified relevant sources increased to ${relevantResults.length}.`);
      }
    } catch (refineErr) {
      console.warn(`[AgentService] Query refinement notice: ${refineErr.message}`);
    }
  }

  // GRACEFUL DEGRADATION: If strict filter rejected everything, fall back to
  // the best raw sources (ranked by quality tier) so a report can still be
  // generated instead of failing outright.
  if (relevantResults.length === 0) {
    // Collect every raw source seen (initial + refined), deduped by URL
    const allRawMap = new Map();
    for (const s of deduplicatedResults) {
      if (s.url && !allRawMap.has(s.url)) allRawMap.set(s.url, s);
    }
    const allRaw = Array.from(allRawMap.values());
    if (allRaw.length === 0) {
      const failMsg = `Research Failed: No web sources could be retrieved for "${sanitizedTopic}".`;
      logProgress('FAILED', failMsg);
      throw new Error(failMsg);
    }
    // Rank by quality tier (Tier 1 best) then by snippet length as tiebreak
    const tierRank = (s) => {
      const t = (s.qualityTier || '').toLowerCase();
      if (t.includes('tier 1')) return 0;
      if (t.includes('tier 2')) return 1;
      if (t.includes('tier 3')) return 2;
      return 3;
    };
    allRaw.sort((a, b) => tierRank(a) - tierRank(b) || ((b.snippet || '').length - (a.snippet || '').length));
    relevantResults = allRaw.slice(0, Math.max(MIN_RELEVANT_SOURCES, 5));
    logProgress(
      'FALLBACK_SOURCES',
      `Strict relevance filter rejected all sources. Falling back to top ${relevantResults.length} raw sources by quality tier. Report will note limited verification.`
    );
  }

  // Step 4c: Apply Domain Diversity Cap (max 2 per domain while preserving sufficient evidence)
  const diverseRelevantResults = applyDomainDiversity(relevantResults, 2, MIN_RELEVANT_SOURCES);
  logProgress('DOMAIN_DIVERSIFIED', `Domain diversity applied: retained ${diverseRelevantResults.length} high-quality sources across distinct domains.`);

  // Step 4d: Run final drift and coverage gap detection before report generation
  let finalCoverageGaps = coverageGaps;
  if (topicDimensions.length > 0) {
    const finalDrift = detectTopicDrift(sanitizedTopic, diverseRelevantResults, topicDimensions);
    finalCoverageGaps = finalDrift.gaps;
    const coveredDimCount = Object.values(finalDrift.coverageMap).filter((c) => c > 0).length;
    const totalDimCount = topicDimensions.length;
    const majorityUncovered = finalCoverageGaps.length >= Math.ceil(totalDimCount / 2);

    if (finalDrift.driftDetected || majorityUncovered) {
      const reason = finalDrift.driftDetected
        ? `drift toward "${finalDrift.dominantDimension}"`
        : `${finalCoverageGaps.length}/${totalDimCount} dimensions have no matching sources`;
      logProgress('COVERAGE_WARNING', `Final coverage check: ${reason}. Covered ${coveredDimCount}/${totalDimCount} dimensions. Gaps: [${finalCoverageGaps.join(', ')}]. Report will disclose gaps.`);
    } else {
      logProgress('COVERAGE_OK', `Final coverage check: sources span ${coveredDimCount}/${totalDimCount} dimensions. Gaps: [${finalCoverageGaps.join(', ') || 'none'}].`);
    }
  }

  // Step 5: Report Synthesis via Groq API
  logProgress('ANALYZING', 'Synthesizing verified web evidence into structured report via Groq API...');
  const reportMarkdown = await generateResearchReport(sanitizedTopic, diverseRelevantResults);
  logProgress('REPORT_GENERATED', 'Structured research report generated successfully.');

  // Step 6: Markdown Export
  logProgress('EXPORTING', 'Saving research report to exports directory...');
  await fs.mkdir(config.exportsDir, { recursive: true });

  const safeFileName = sanitizedTopic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 40);

  const exportFileName = `${safeFileName}_${Date.now()}.md`;
  const exportPath = path.join(config.exportsDir, exportFileName);

  const fullReportFileContent = `<!-- 
  Autonomous Research Agent Generated Report
  Topic: ${sanitizedTopic}
  Date: ${new Date().toISOString()}
  Task ID: ${taskId}
-->

${reportMarkdown}
`;

  await fs.writeFile(exportPath, fullReportFileContent, 'utf-8');
  logProgress('COMPLETED', `Research task completed. Report saved to: ${exportPath}`);

  const sourcesList = relevantResults.map((s) => ({
    title: s.title,
    url: s.url,
  }));

  return {
    id: taskId,
    topic: sanitizedTopic,
    timestamp: new Date().toISOString(),
    subQuestions,
    sources: sourcesList,
    reportMarkdown,
    exportPath,
  };
}

export default {
  runResearchTask,
};
