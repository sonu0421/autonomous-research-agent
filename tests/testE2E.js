import app from '../src/server.js';
import fs from 'fs/promises';
import path from 'path';

async function runE2ETests() {
  console.log('\n==========================================');
  console.log('🚀 RUNNING END-TO-END FRONTEND & BACKEND INTEGRATION TESTS');
  console.log('==========================================\n');

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let passed = 0;
  let failed = 0;

  const assert = (condition, title, errorDetail = '') => {
    if (condition) {
      console.log(`  ✅ PASSED: ${title}`);
      passed++;
    } else {
      console.error(`  ❌ FAILED: ${title} - ${errorDetail}`);
      failed++;
    }
  };

  try {
    // 1. Static Assets Serving Test
    console.log('\n--- 1. Testing Static Assets Serving ---');
    const indexRes = await fetch(`${baseUrl}/index.html`);
    const indexHtml = await indexRes.text();
    assert(indexRes.status === 200, 'index.html served with HTTP 200');
    assert(indexHtml.includes('Autonomous Research Agent'), 'index.html contains expected header title');

    const cssRes = await fetch(`${baseUrl}/css/style.css`);
    assert(cssRes.status === 200, 'style.css served with HTTP 200');

    const jsRes = await fetch(`${baseUrl}/js/app.js`);
    assert(jsRes.status === 200, 'app.js served with HTTP 200');

    // 2. Full API Lifecycle Integration Test
    console.log('\n--- 2. Testing API Lifecycle & Polling ---');
    const topic = 'Next Generation Solar Panel Efficiency 2026';
    const initRes = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    });

    const initData = await initRes.json();
    assert(initRes.status === 202, 'POST /api/research returns HTTP 202');
    assert(typeof initData.taskId === 'string', 'Returns valid taskId');

    const taskId = initData.taskId;

    // Check status immediately
    const statusRes = await fetch(`${baseUrl}/api/research/${taskId}/status`);
    const statusData = await statusRes.json();
    assert(statusRes.status === 200, 'GET status returns HTTP 200');
    assert(statusData.job.id === taskId, 'Task ID matches in job status');
    assert(['running', 'completed', 'failed'].includes(statusData.job.status), 'Status is a valid lifecycle state');

    console.log('\n==========================================');
    console.log(`E2E SUMMARY: ${passed} PASSED, ${failed} FAILED.`);
    console.log('==========================================\n');

    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('❌ E2E Test Exception:', err);
    process.exit(1);
  } finally {
    server.close();
  }
}

runE2ETests();
