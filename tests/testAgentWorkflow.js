import { runResearchTask } from '../src/services/agentService.js';
import { validateEnv } from '../src/config/env.js';

async function testAgentWorkflow() {
  console.log('\n--- Testing Agent Service Autonomous Workflow ---');
  const envCheck = validateEnv();

  if (!envCheck.valid) {
    console.log('⚠️ GEMINI_API_KEY is not configured in .env. Testing input validation and error throwing...');
    try {
      await runResearchTask('Autonomous AI Agents');
      console.error('❌ Expected runResearchTask to throw an error due to missing API key, but it did not.');
      process.exit(1);
    } catch (err) {
      console.log('✅ Validation Test PASSED: Gracefully caught error ->', err.message);
    }
    return;
  }

  console.log('🚀 Running live Autonomous Agent Workflow for topic: "AI Automation in Software Development"');
  const progressLogs = [];
  const result = await runResearchTask('AI Automation in Software Development', (status) => {
    progressLogs.push(status);
    console.log(`[Progress Log] [${status.step}] ${status.detail}`);
  });

  console.log('\n--- Workflow Result Summary ---');
  console.log('Task ID:', result.id);
  console.log('Topic:', result.topic);
  console.log('Sub-questions count:', result.subQuestions.length);
  console.log('Sources count:', result.sources.length);
  console.log('Exported File Path:', result.exportPath);
  console.log('Report Preview (first 250 chars):\n', result.reportMarkdown.substring(0, 250));

  if (!result.exportPath || !result.reportMarkdown.includes('# Executive Summary')) {
    throw new Error('Agent service output is missing required fields or report structure.');
  }

  console.log('\n✅ Agent Workflow Test PASSED SUCCESSFULLY!');
}

testAgentWorkflow().catch((err) => {
  console.error('❌ Agent Workflow Test FAILED:', err);
  process.exit(1);
});
