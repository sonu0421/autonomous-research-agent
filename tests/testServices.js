import { searchWeb, classifySourceQuality } from '../src/services/searchService.js';
import {
  decomposeTopic,
  generateResearchReport,
  verifyAndCleanReportGrounding,
  filterRelevantSources,
  extractRelevantSnippets,
  detectTopicDrift,
  checkSubtopicOverrepresentation,
  calculateRetryDelay,
} from '../src/services/groqService.js';
import { applyDomainDiversity } from '../src/services/agentService.js';
import { validateEnv } from '../src/config/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Search Service
// ─────────────────────────────────────────────────────────────────────────────
async function testSearchService() {
  console.log('\n--- 1. Testing Search Service ---');
  const results = await searchWeb('Node.js Express AI Agent framework', 2);
  console.log(`[Test] Received ${results.length} search results:`);
  results.forEach((r, idx) => {
    console.log(`  Source #${idx + 1}: ${r.title} (${r.url})`);
    console.log(`  Snippet: ${r.snippet.substring(0, 100)}...`);
    console.log(`  Content length: ${r.content.length} chars`);
    console.log(`  Quality Tier: ${r.qualityTier}`);
    console.log(`  Full Content: ${r.hasFullContent}`);
  });

  if (results.length === 0) {
    throw new Error('Search service returned 0 results.');
  }

  // Every result must include a qualityTier label
  const missingQuality = results.filter((r) => !r.qualityTier);
  if (missingQuality.length > 0) {
    throw new Error('Search results missing qualityTier label.');
  }

  console.log('✅ Search Service Test PASSED.');
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Source Quality Classification
// ─────────────────────────────────────────────────────────────────────────────
function testSourceQualityClassification() {
  console.log('\n--- 2. Testing Source Quality Classification ---');

  const cases = [
    { url: 'https://arxiv.org/abs/2606.07591', expected: 'Official Documentation / Academic Paper' },
    { url: 'https://github.com/some/repo', expected: 'Official Documentation / Academic Paper' },
    { url: 'https://stanford.edu/research', expected: 'Official Documentation / Academic Paper' },
    { url: 'https://techcrunch.com/ai-article', expected: 'Reputable Tech Publication' },
    { url: 'https://venturebeat.com/story', expected: 'Reputable Tech Publication' },
    { url: 'https://medium.com/@user/ai-blog', expected: 'Company Blog / Industry Article' },
    { url: 'https://kiaantechnology.com/resources/state-of-ai', expected: 'General Web Source / Aggregator' },
    { url: 'https://remvix.com/blog/roi-2026', expected: 'Company Blog / Industry Article' },
  ];

  let passed = 0;
  for (const tc of cases) {
    const result = classifySourceQuality(tc.url, '', '');
    if (result === tc.expected) {
      console.log(`  ✅ ${tc.url.substring(8, 40)}: "${result}"`);
      passed++;
    } else {
      console.error(`  ❌ ${tc.url.substring(8, 40)}: expected "${tc.expected}", got "${result}"`);
    }
  }

  if (passed < cases.length) {
    throw new Error(`Source quality classification: ${cases.length - passed} assertions failed.`);
  }
  console.log('✅ Source Quality Classification Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: extractRelevantSnippets – deep evidence extraction
// ─────────────────────────────────────────────────────────────────────────────
function testExtractRelevantSnippets() {
  console.log('\n--- 3. Testing Evidence Extraction (extractRelevantSnippets) ---');

  // Content must be longer than maxChars (800) to trigger scoring logic
  const longPage = [
    'Homepage. About us. Contact. Services. Privacy Policy. Cookie settings. Navigation menu.',
    'Irrelevant paragraph one about general company history and mission statement that has nothing to do with AI technology or automation.',
    'Irrelevant marketing section about our award winning customer support team and their dedication to excellence in service delivery.',
    'Another irrelevant section about office locations and employee benefits packages including health insurance and retirement plans.',
    'Additional irrelevant paragraph about our corporate sustainability and responsibility commitments and ESG reporting frameworks.',
    'Key finding: In Q2 2026, LLM autonomous agents achieved 42% task completion improvements in production environments according to our internal benchmark study across 200 enterprise deployments.',
    'Research note: The deployment of agentic AI systems in enterprise automation workflows reduced human escalations by 31% in 2026 according to industry survey data collected in the second half of the year.',
    'Analysis shows that AI model integration with workflow tools accelerated significantly in 2026, with autonomous decision-making reaching production-grade maturity across multiple vertical industries.',
  ].join('\n\n');

  console.log(`  Fixture length: ${longPage.length} chars (maxChars=800)`);

  const extracted = extractRelevantSnippets(longPage, 'AI automation 2026', 800);

  console.log(`  Extracted snippet (${extracted.length} chars):\n  "${extracted.substring(0, 200)}..."`);

  if (!extracted.includes('42%') && !extracted.includes('31%')) {
    throw new Error('extractRelevantSnippets failed to surface deep-page numeric evidence!');
  }
  // Fluff blocks should be excluded since they score 0
  if (extracted.includes('Homepage') || extracted.includes('Cookie settings') || extracted.includes('office locations')) {
    throw new Error('extractRelevantSnippets returned top-of-page navigation fluff instead of evidence!');
  }

  // Short content (< maxChars) should be returned unchanged
  const shortSnippet = 'LLM agents deployed in 78% of enterprises in 2026.';
  const shortExtracted = extractRelevantSnippets(shortSnippet, 'AI automation', 800);
  if (shortExtracted !== shortSnippet) {
    throw new Error('extractRelevantSnippets should return short content unchanged.');
  }

  console.log('✅ Evidence Extraction Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Grounding Verifier – cited-source stat matching
// ─────────────────────────────────────────────────────────────────────────────
async function testGroundingVerification() {
  console.log('\n--- 4. Testing Statistics & Evidence Grounding Verification ---');

  // ── 4a: Core fixtures ──────────────────────────────────────────────────────
  const sourceA = {
    title: 'AI Agent Benchmark Report 2026',
    url: 'https://example.com/ai-agent-report-2026',
    snippet: 'Survey of 150 enterprise IT leaders found 35% adoption of LLM autonomous agents in 2026.',
    content: 'In mid-2026, a survey of 150 enterprise IT leaders found that 35% of companies have deployed LLM autonomous agents in production workflows.',
    hasFullContent: true,
    qualityTier: 'General Web Source / Aggregator',
  };

  const sourceB = {
    title: 'Enterprise Mobility - Home',
    url: 'https://www.enterprisemobility.com/',
    snippet: 'Enterprise Mobility car rental services and vehicle fleet technology.',
    content: 'Enterprise Mobility provides car rental services and transportation technology solutions globally.',
    hasFullContent: true,
    qualityTier: 'General Web Source / Aggregator',
  };

  const sourceC = {
    title: 'Deep Tech Report 2026',
    url: 'https://example.com/deep-tech-2026',
    snippet: 'Market grew significantly in 2026.',
    content: 'The AI automation market saw broad adoption in 2026. No specific figure for overall market size was published in this report.',
    hasFullContent: true,
    qualityTier: 'General Web Source / Aggregator',
  };

  // ── 4b: Irrelevant source rejection ───────────────────────────────────────
  console.log('[Test 4a] Relevance filter: mixed sources...');
  const relevant = await filterRelevantSources('AI automation developments 2026', [sourceA, sourceB]);
  if (relevant.some((s) => s.url.includes('enterprisemobility.com'))) {
    throw new Error('Relevance filter failed to reject car rental source!');
  }
  console.log('  ✅ Irrelevant source rejection PASSED.');

  // ── 4c: Verified stats should NOT be flagged ──────────────────────────────
  console.log('[Test 4b] Grounding: verified stats should pass...');
  const reportWithVerifiedStats = `# Executive Summary
Survey of 150 enterprise IT leaders showed 35% adoption of LLM agents [AI Agent Benchmark Report 2026](https://example.com/ai-agent-report-2026).`;
  const cleanedVerified = verifyAndCleanReportGrounding(reportWithVerifiedStats, [sourceA]);
  if (cleanedVerified.includes('35% (unverified') || cleanedVerified.includes('150 (unverified')) {
    throw new Error('Grounding verifier falsely flagged a valid statistic present in the cited source!');
  }
  console.log('  ✅ Verified stat not flagged PASSED.');

  // ── 4d: Fabricated stats cited from wrong source should be flagged ─────────
  console.log('[Test 4c] Grounding: fabricated stats on wrong source citation...');
  const reportWithWrongCitation = `# Executive Summary
Market is projected to reach $999.99 billion at CAGR of 99.9% [Deep Tech Report 2026](https://example.com/deep-tech-2026).`;
  const cleanedWrong = verifyAndCleanReportGrounding(reportWithWrongCitation, [sourceC]);
  if (!cleanedWrong.includes('unverified stat')) {
    throw new Error('Grounding verifier failed to flag fabricated stat cited from wrong source!');
  }
  console.log('  ✅ Fabricated stat on wrong source flagged PASSED.');

  // ── 4e: Stat absent from ALL sources should be flagged ────────────────────
  console.log('[Test 4d] Grounding: stat absent from all sources...');
  const reportWithFakeStats = `# Executive Summary
Market is projected to reach $999.99 billion at CAGR of 99.9% [AI Agent Benchmark Report 2026](https://example.com/ai-agent-report-2026).`;
  const cleanedFake = verifyAndCleanReportGrounding(reportWithFakeStats, [sourceA]);
  if (!cleanedFake.includes('$999.99 billion (unverified stat') && !cleanedFake.includes('99.9% (unverified stat')) {
    throw new Error('Grounding verifier failed to detect fabricated statistic absent in ALL sources!');
  }
  console.log('  ✅ Absent stat flagged PASSED.');

  // ── 4f: Snippet-only source should produce conservative evidence label ─────
  console.log('[Test 4e] Snippet-only source labeling...');
  const snippetOnlySource = {
    title: 'AI Weekly Digest',
    url: 'https://example.com/ai-digest',
    snippet: 'AI automation adoption up 60% in 2026.',
    content: 'AI automation adoption up 60% in 2026.',
    hasFullContent: false,
    qualityTier: 'General Web Source / Aggregator',
  };
  const snippetReport = `## Summary\nAI automation adoption is up 60% [AI Weekly Digest](https://example.com/ai-digest).`;
  const snippetCleaned = verifyAndCleanReportGrounding(snippetReport, [snippetOnlySource]);
  if (snippetCleaned.includes('60% (unverified')) {
    throw new Error('Grounding verifier incorrectly flagged a stat that IS present in snippet content!');
  }
  console.log('  ✅ Snippet-only source stat correctly accepted PASSED.');

  // ── 4g: Blog claim cannot be classified as "Primary Evidence" ──────────────
  console.log('[Test 4f] Blog claim cannot be classified as Primary Evidence...');
  const blogClaimReport = `# Executive Summary
| Finding | Category |
| MIT saves billions | Primary Evidence | [AI Blog](https://example.com/blog/ai)`;
  const blogSource = [{
    title: 'AI Blog',
    url: 'https://example.com/blog/ai',
    snippet: 'MIT saves billions',
    content: 'MIT saves billions in drug costs',
    qualityTier: 'Company Blog / Industry Article',
  }];
  const reclassifiedReport = verifyAndCleanReportGrounding(blogClaimReport, blogSource);
  if (reclassifiedReport.includes('| Primary Evidence |')) {
    throw new Error('Grounding verifier failed to demote blog claim from Primary Evidence to Secondary Reporting!');
  }
  if (!reclassifiedReport.includes('| Secondary Reporting |')) {
    throw new Error('Grounding verifier should reclassify blog claim to Secondary Reporting!');
  }
  console.log('  ✅ Blog claim demotion from Primary Evidence PASSED.');

  // ── 4h: Evidence Transparency Notice injection when primary sources missing ─
  console.log('[Test 4g] Evidence Transparency Notice injection...');
  const reportWithoutPrimary = `# Executive Summary\nAI automation is advancing [AI Blog](https://example.com/blog/ai).`;
  const disclosedReport = verifyAndCleanReportGrounding(reportWithoutPrimary, blogSource);
  if (!disclosedReport.includes('Evidence Transparency Notice')) {
    throw new Error('Grounding verifier failed to inject Evidence Transparency Notice when primary sources were missing!');
  }
  console.log('  ✅ Evidence Transparency Notice injection PASSED.');

  console.log('✅ ALL Grounding Verification Tests PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Domain Diversity Balancing & Backfilling
// ─────────────────────────────────────────────────────────────────────────────
function testDomainDiversity() {
  console.log('\n--- 5. Testing Domain Diversity Balancing ---');

  const sourcesWithRepetition = [
    { url: 'https://neuralcoretech.com/article-1', title: 'Article 1', hasFullContent: true },
    { url: 'https://neuralcoretech.com/article-2', title: 'Article 2', hasFullContent: true },
    { url: 'https://neuralcoretech.com/article-3', title: 'Article 3', hasFullContent: true },
    { url: 'https://ampcome.com/guide-1', title: 'Guide 1', hasFullContent: true },
    { url: 'https://ampcome.com/guide-2', title: 'Guide 2', hasFullContent: false },
    { url: 'https://ampcome.com/guide-3', title: 'Guide 3', hasFullContent: false },
    { url: 'https://arxiv.org/abs/2601.1234', title: 'Paper 1', hasFullContent: true },
    { url: 'https://nature.com/articles/12345', title: 'Paper 2', hasFullContent: true },
  ];

  // With max 2 per domain:
  // neuralcoretech: 2, ampcome: 2, arxiv: 1, nature: 1 -> Total 6
  const diversified = applyDomainDiversity(sourcesWithRepetition, 2, 3);
  console.log(`  Input: ${sourcesWithRepetition.length} sources -> Diversified: ${diversified.length} sources`);

  const neuralCount = diversified.filter((s) => s.url.includes('neuralcoretech.com')).length;
  const ampcomeCount = diversified.filter((s) => s.url.includes('ampcome.com')).length;

  if (neuralCount > 2 || ampcomeCount > 2) {
    throw new Error(`Domain diversity failed to cap domain frequency: neuralcoretech=${neuralCount}, ampcome=${ampcomeCount}`);
  }

  // Test backfilling when distinct domains are scarce (< minRetained)
  const singleDomainSources = [
    { url: 'https://neuralcoretech.com/article-1', title: 'Article 1', hasFullContent: true },
    { url: 'https://neuralcoretech.com/article-2', title: 'Article 2', hasFullContent: true },
    { url: 'https://neuralcoretech.com/article-3', title: 'Article 3', hasFullContent: true },
  ];
  const backfilled = applyDomainDiversity(singleDomainSources, 2, 3);
  if (backfilled.length < 3) {
    throw new Error(`Domain diversity should backfill to satisfy minRetained (3) when evidence would otherwise be discarded! Got: ${backfilled.length}`);
  }

  console.log('✅ Domain Diversity Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Report Completeness & Trailing Truncation Cleaning
// ─────────────────────────────────────────────────────────────────────────────
function testReportCompletenessAndCleaning() {
  console.log('\n--- 6. Testing Report Completeness & Trailing Truncation Cleaning ---');

  const truncatedReport = `# Executive Summary
This is a research report on AI automation.

## Key Research Findings & Analysis
- Finding 1: Autonomous orchestration is advancing.

## Detailed Evidence & Breakthrough Insights
- Point A: Model Context Protocol is emerging.
- Four critical pillars underpin modern`;

  const dummySource = [{ title: 'AI Report', url: 'https://example.com/ai', snippet: 'text', content: 'text' }];
  const cleaned = verifyAndCleanReportGrounding(truncatedReport, dummySource);

  console.log('  Cleaned report end:\n  "' + cleaned.split('\n').slice(-3).join('\n') + '"');

  if (cleaned.includes('underpin modern')) {
    throw new Error('Grounding verifier failed to clean broken truncated trailing fragment!');
  }

  console.log('✅ Report Completeness & Cleaning Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Topic Drift Detection
// ─────────────────────────────────────────────────────────────────────────────
function testTopicDriftDetection() {
  console.log('\n--- 8. Testing Topic Drift Detection ---');

  const dimensions = [
    { dimension: 'AI Agents & Autonomous Workflows', keywords: ['agent', 'autonomous', 'orchestration'] },
    { dimension: 'Business Process & RPA Automation', keywords: ['rpa', 'business process', 'workflow automation'] },
    { dimension: 'AI-Assisted Software Development', keywords: ['code generation', 'developer', 'copilot'] },
    { dimension: 'Customer Support & Conversational AI', keywords: ['chatbot', 'customer support', 'conversational'] },
    { dimension: 'Industrial & Robotic Automation', keywords: ['predictive maintenance', 'manufacturing', 'industrial'] },
    { dimension: 'Enterprise Adoption & Governance', keywords: ['governance', 'compliance', 'enterprise adoption'] },
  ];

  // All 5 sources are about predictive maintenance (industrial) → drift
  const driftedSources = [
    { title: 'AI Predictive Maintenance 2026', snippet: 'predictive maintenance AI sensor data', content: 'industrial predictive maintenance AI' },
    { title: 'SAP AI Asset Agents', snippet: 'manufacturing predictive maintenance industrial', content: 'industrial factory maintenance AI agents' },
    { title: 'Edge AI for Predictive Maintenance', snippet: 'predictive maintenance edge AI industrial', content: 'manufacturing predictive maintenance systems' },
    { title: 'AI in Factory Automation', snippet: 'manufacturing industrial automation AI 2026', content: 'predictive maintenance industrial AI' },
    { title: 'Self-Healing Factories 2026', snippet: 'industrial factory automation predictive maintenance', content: 'manufacturing AI sensors predictive maintenance' },
  ];

  const driftResult = detectTopicDrift('Latest developments in AI automation in 2026', driftedSources, dimensions);

  console.log(`  Drift detected: ${driftResult.driftDetected}`);
  console.log(`  Dominant dimension: ${driftResult.dominantDimension}`);
  console.log(`  Coverage gaps: ${driftResult.gaps.join(', ')}`);

  if (!driftResult.driftDetected) {
    throw new Error('Drift detection failed: should have flagged drift when 5/5 sources are about industrial/predictive maintenance!');
  }

  if (!driftResult.dominantDimension.includes('Industrial')) {
    throw new Error(`Drift detection: expected dominant dimension to include "Industrial", got "${driftResult.dominantDimension}"`);
  }

  if (driftResult.gaps.length === 0) {
    throw new Error('Drift detection: should report coverage gaps when non-industrial dimensions have 0 sources!');
  }

  // Verify balanced sources do NOT trigger drift
  const balancedSources = [
    { title: 'AI Agents 2026', snippet: 'autonomous agent orchestration AI workflow', content: 'agent-based workflow orchestration' },
    { title: 'RPA Automation Trends', snippet: 'rpa business process automation enterprise', content: 'robotic process automation workflow' },
    { title: 'GitHub Copilot 2026', snippet: 'code generation developer copilot AI', content: 'AI-assisted software development copilot' },
    { title: 'Chatbot Enterprise 2026', snippet: 'chatbot customer support conversational AI', content: 'conversational AI customer support automation' },
    { title: 'Predictive Maintenance AI', snippet: 'predictive maintenance manufacturing industrial', content: 'industrial AI factory automation' },
  ];

  const balancedResult = detectTopicDrift('AI automation in 2026', balancedSources, dimensions);
  if (balancedResult.driftDetected) {
    throw new Error('Drift detection false positive: balanced sources should NOT trigger drift!');
  }

  console.log('✅ Topic Drift Detection Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Narrow Subtopic Overrepresentation
// ─────────────────────────────────────────────────────────────────────────────
function testSubtopicOverrepresentation() {
  console.log('\n--- 9. Testing Subtopic Overrepresentation Detection ---');

  const sources = [
    { title: 'AI PdM 1', snippet: 'predictive maintenance AI 2026', content: 'predictive maintenance industrial AI' },
    { title: 'AI PdM 2', snippet: 'predictive maintenance sensors', content: 'AI predictive maintenance factory' },
    { title: 'AI PdM 3', snippet: 'industrial predictive maintenance ROI', content: 'predictive maintenance cost reduction' },
    { title: 'AI PdM 4', snippet: 'predictive maintenance downtime', content: 'AI-driven predictive maintenance system' },
    { title: 'AI Agents 2026', snippet: 'autonomous agent orchestration', content: 'AI agentic workflow' },
  ];

  // 4/5 sources mention "predictive maintenance" → overrepresented
  const result = checkSubtopicOverrepresentation(sources, ['predictive maintenance', 'pdm']);
  console.log(`  Fraction: ${(result.fraction * 100).toFixed(0)}% | Overrepresented: ${result.overrepresented}`);

  if (!result.overrepresented) {
    throw new Error(`Subtopic overrepresentation not detected: ${(result.fraction * 100).toFixed(0)}% of sources are about predictive maintenance (threshold 60%)!`);
  }

  // Diverse sources should not trigger overrepresentation
  const diverseSources = [
    { title: 'AI Agents', snippet: 'autonomous agents workflow', content: 'agent orchestration' },
    { title: 'RPA Trends', snippet: 'robotic process automation enterprise', content: 'rpa workflow' },
    { title: 'Copilot Dev', snippet: 'code generation developer AI', content: 'software development AI tools' },
    { title: 'AI Chatbot', snippet: 'conversational AI customer support', content: 'chatbot nlp' },
    { title: 'AI PdM', snippet: 'predictive maintenance industrial', content: 'manufacturing AI' },
  ];

  const diverseResult = checkSubtopicOverrepresentation(diverseSources, ['predictive maintenance', 'pdm']);
  if (diverseResult.overrepresented) {
    throw new Error('Subtopic overrepresentation false positive: diverse sources should NOT flag overrepresentation!');
  }

  console.log('✅ Subtopic Overrepresentation Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Irrelevant Source Rejection (filterRelevantSources – narrow/off-topic)
// ─────────────────────────────────────────────────────────────────────────────
async function testIrrelevantSourceRejection() {
  console.log('\n--- 10. Testing Irrelevant Source Rejection ---');

  const offTopicSources = [
    {
      title: 'Enterprise Mobility Car Rental',
      url: 'https://www.enterprisemobility.com/',
      snippet: 'Car rental and vehicle fleet technology services.',
      content: 'Enterprise Mobility provides car rental services and transportation technology solutions globally.',
      hasFullContent: true,
      qualityTier: 'General Web Source / Aggregator',
    },
    {
      title: 'Home Automation Hub Guide',
      url: 'https://homeautomationhub.com/guide',
      snippet: 'Smart home automation guide for HVAC and lighting control.',
      content: 'Control your home HVAC, lighting, and security systems with smart home automation.',
      hasFullContent: true,
      qualityTier: 'General Web Source / Aggregator',
    },
    {
      title: 'AI Agentic Workflow Automation 2026',
      url: 'https://example.com/ai-agents-2026',
      snippet: 'AI autonomous agents are transforming enterprise workflow automation in 2026.',
      content: 'Enterprises are deploying AI autonomous agents in 2026 to automate complex multi-step workflows.',
      hasFullContent: true,
      qualityTier: 'General Web Source / Aggregator',
    },
  ];

  const relevant = await filterRelevantSources('Latest developments in AI automation in 2026', offTopicSources);

  if (relevant.some((s) => s.url.includes('enterprisemobility.com'))) {
    throw new Error('Source rejection failed: car rental source should have been rejected!');
  }
  if (relevant.some((s) => s.url.includes('homeautomationhub.com'))) {
    throw new Error('Source rejection failed: HVAC home automation source should have been rejected!');
  }
  if (!relevant.some((s) => s.url.includes('example.com/ai-agents-2026'))) {
    throw new Error('Source rejection false negative: AI agentic workflow source should have been ACCEPTED!');
  }

  console.log(`  Accepted ${relevant.length}/3 sources. Correctly rejected off-topic sources.`);
  console.log('✅ Irrelevant Source Rejection Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: Coverage Gap Reporting Without Fabrication
// ─────────────────────────────────────────────────────────────────────────────
function testCoverageGapReportingWithoutFabrication() {
  console.log('\n--- 11. Testing Coverage Gap Reporting Without Fabrication ---');

  const dimensions = [
    { dimension: 'AI Agents & Autonomous Workflows', keywords: ['agent', 'autonomous'] },
    { dimension: 'Business Process & RPA', keywords: ['rpa', 'business process'] },
    { dimension: 'AI-Assisted Software Development', keywords: ['code generation', 'copilot'] },
  ];

  // Only one dimension is covered
  const narrowSources = [
    { title: 'AI Agents 2026', snippet: 'autonomous agent AI orchestration', content: 'autonomous AI agent workflow system' },
    { title: 'Agentic AI 2026', snippet: 'agent-based automation AI 2026', content: 'autonomous agent multi-agent framework' },
  ];

  const { gaps, driftDetected, coverageMap } = detectTopicDrift('AI automation', narrowSources, dimensions);

  console.log(`  Gaps detected: [${gaps.join(', ')}]`);
  console.log(`  Drift detected: ${driftDetected}`);
  console.log(`  Coverage map:`, coverageMap);

  // Gaps must be reported
  if (!gaps.includes('Business Process & RPA') && !gaps.includes('AI-Assisted Software Development')) {
    throw new Error('Coverage gap reporting failed: gaps in RPA and Software Dev dimensions should be reported!');
  }

  // Verify the coverage map does NOT count keywords that are absent
  if (coverageMap['Business Process & RPA'] > 0) {
    throw new Error('Coverage map incorrectly credited "Business Process & RPA" when no source contains those keywords!');
  }
  if (coverageMap['AI-Assisted Software Development'] > 0) {
    throw new Error('Coverage map incorrectly credited "AI-Assisted Software Development" when no source contains those keywords!');
  }

  console.log('✅ Coverage Gap Reporting Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Groq API Integration (live)
// ─────────────────────────────────────────────────────────────────────────────
async function testGroqService(searchResults) {
  console.log('\n--- 7. Testing Groq Service (Live API) ---');
  const envCheck = validateEnv();
  if (!envCheck.valid) {
    console.log('⚠️  GROQ_API_KEY not configured. Skipping live Groq API tests.');
    return;
  }

  const topic = 'Impact of AI Agents on Software Engineering';
  console.log(`[Test] decomposeTopic for: "${topic}"...`);
  const subQuestions = await decomposeTopic(topic);
  console.log('[Test] Sub-questions:', subQuestions.map((q) => q.searchQuery));

  if (!Array.isArray(subQuestions) || subQuestions.length === 0) {
    throw new Error('decomposeTopic did not return a valid non-empty array.');
  }

  console.log('[Test] generateResearchReport with quality-labeled sources...');
  const labeledResults = searchResults.map((r) => ({
    ...r,
    qualityTier: classifySourceQuality(r.url, r.title, r.snippet),
  }));
  const report = await generateResearchReport(topic, labeledResults);
  console.log('[Test] Report preview (200 chars):\n', report.substring(0, 200) + '...');

  if (!report || !report.includes('# Executive Summary')) {
    throw new Error('generateResearchReport output missing mandatory "# Executive Summary" header.');
  }
  console.log('✅ Groq Service Test PASSED.');
}

function testNonAiTopicRelevanceFiltering() {
  console.log('\n--- 8. Testing Non-AI Topic Relevance Filtering ---');
  const topic = 'Post-Quantum Cryptography standards and enterprise adoption';
  const stopWords = new Set(['latest', 'developments', 'with', 'about', 'from', 'in', 'and', 'for', 'standards', 'enterprise', 'adoption', 'overview', 'trends', 'report']);
  const topicTerms = topic
    .toLowerCase()
    .split(/[^\w]+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));
  const isAiTopic = /\b(ai|artificial intelligence|machine learning|llm|llms|agentic|autonomous agent|autonomous agents|generative ai)\b/i.test(topic);

  if (isAiTopic) {
    throw new Error('PQC topic incorrectly classified as AI topic.');
  }

  const sampleSources = [
    { title: 'NIST Announces Selected Post-Quantum Cryptography Algorithms', snippet: 'NIST has released post-quantum cryptography standards including Kyber and Dilithium for enterprise data security.', content: 'NIST PQC standards...' },
    { title: 'Enterprise Car Rental Fleet Management', snippet: 'Rent cars online with Enterprise Mobility.', content: 'Car rental services.' }
  ];

  const filtered = sampleSources.filter((s) => {
    const text = `${s.title} ${s.snippet} ${s.content}`.toLowerCase();
    const mentionsTopicTerm = topicTerms.length === 0 || topicTerms.some((t) => text.includes(t));
    if (isAiTopic) {
      const mentionsAI = /\b(ai|artificial intelligence|machine learning|llm|llms|agentic|autonomous agent|autonomous agents|generative ai)\b/i.test(text);
      return mentionsAI && mentionsTopicTerm;
    }
    return mentionsTopicTerm;
  });

  if (filtered.length !== 1 || !filtered[0].title.includes('NIST')) {
    throw new Error('Non-AI topic relevance filter failed to retain NIST PQC source.');
  }
  console.log('✅ Non-AI Topic Relevance Filtering Test PASSED.');
}

function testRetryAfterAndRateLimitHandling() {
  console.log('\n--- 9. Testing Retry-After Duration Parsing & Limits ---');

  // Case A: Header retry-after: 4.92s
  const errHeader = {
    response: {
      status: 429,
      headers: { 'retry-after': '4.92' },
      data: { error: { message: 'Rate limit reached' } },
    },
  };
  const delayA = calculateRetryDelay(errHeader, 0);
  console.log(`  Parsed delay for retry-after 4.92s header: ${delayA}ms`);
  if (delayA < 5000 || delayA > 6000) {
    throw new Error(`Expected delay ~5420ms for header 4.92s, got ${delayA}ms`);
  }

  // Case B: Error message "Please try again in 4.92s."
  const errMsg = {
    response: {
      status: 429,
      data: { error: { message: 'Rate limit reached for model openai/gpt-oss-20b. Please try again in 4.92s.' } },
    },
  };
  const delayB = calculateRetryDelay(errMsg, 0);
  console.log(`  Parsed delay for error message "Please try again in 4.92s.": ${delayB}ms`);
  if (delayB < 5000 || delayB > 6000) {
    throw new Error(`Expected delay ~5420ms for body "4.92s", got ${delayB}ms`);
  }

  // Case C: Error message "Please try again in 12.5s."
  const errMsgC = {
    response: {
      status: 429,
      data: { error: { message: 'Rate limit reached. Please try again in 12.5s.' } },
    },
  };
  const delayC = calculateRetryDelay(errMsgC, 0);
  console.log(`  Parsed delay for 12.5s: ${delayC}ms`);
  if (delayC < 12500 || delayC > 13500) {
    throw new Error(`Expected delay ~13000ms for 12.5s, got ${delayC}ms`);
  }

  // Case D: Exceeds max 60s cap (e.g., 17m45s daily TPD reset)
  const errMsgD = {
    response: {
      status: 429,
      data: { error: { message: 'Rate limit reached. Please try again in 17m45s.' } },
    },
  };
  const delayD = calculateRetryDelay(errMsgD, 0);
  console.log(`  Parsed delay for 17m45s (capped at 60s max): ${delayD}ms`);
  if (delayD !== 60000) {
    throw new Error(`Expected delay capped at 60000ms for 17m45s, got ${delayD}ms`);
  }

  console.log('✅ Retry-After Duration Parsing & Limits Test PASSED.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────────────────────────────────────
async function runAllTests() {
  try {
    const searchResults = await testSearchService();
    testSourceQualityClassification();
    testExtractRelevantSnippets();
    await testGroundingVerification();
    testDomainDiversity();
    testReportCompletenessAndCleaning();
    // New topic drift & coverage tests (pure unit tests – no API calls)
    testTopicDriftDetection();
    testSubtopicOverrepresentation();
    testCoverageGapReportingWithoutFabrication();
    testNonAiTopicRelevanceFiltering();
    testRetryAfterAndRateLimitHandling();
    // API-dependent tests
    await testIrrelevantSourceRejection();
    await testGroqService(searchResults);
    console.log('\n🎉 ALL CORE SERVICES TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message || err);
    process.exit(1);
  }
}

runAllTests();

