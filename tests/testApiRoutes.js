import fs from 'fs/promises';
import path from 'path';
import config from '../src/config/env.js';
import app from '../src/server.js';

// Simple lightweight HTTP test runner using Node's internal server listener
async function runApiTests() {
  console.log('\n==========================================');
  console.log('🚀 RUNNING AUTOMATED API ROUTE TESTS');
  console.log('==========================================\n');

  // Start test server on random free port
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[TestServer] Test instance running at ${baseUrl}`);

  let passedCount = 0;
  let failedCount = 0;

  const assert = (condition, testName, failureDetail = '') => {
    if (condition) {
      console.log(`  ✅ PASSED: ${testName}`);
      passedCount++;
    } else {
      console.error(`  ❌ FAILED: ${testName} - ${failureDetail}`);
      failedCount++;
    }
  };

  try {
    // Test 1: GET /api/health
    console.log('\n--- 1. Testing GET /api/health ---');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthData = await healthRes.json();
    assert(healthRes.status === 200, 'Health endpoint returns HTTP 200');
    assert(healthData.status === 'ok', 'Health response contains status ok');

    // Test 2: POST /api/research Input Validation
    console.log('\n--- 2. Testing POST /api/research Validation ---');
    
    // Empty body
    const emptyRes = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const emptyData = await emptyRes.json();
    assert(emptyRes.status === 400, 'Rejects empty topic with HTTP 400');
    assert(emptyData.error.includes('required'), 'Returns clear validation error for empty topic');

    // Too short topic
    const shortRes = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'hi' }),
    });
    const shortData = await shortRes.json();
    assert(shortRes.status === 400, 'Rejects topic under 3 chars with HTTP 400');
    assert(shortData.error.includes('at least 3 characters'), 'Returns clear validation error for short topic');

    // Test 3: POST /api/research Valid Request & Job Creation
    console.log('\n--- 3. Testing POST /api/research Job Creation ---');
    const validTopic = 'Autonomous AI Research Systems';
    const initRes = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: validTopic }),
    });
    const initData = await initRes.json();
    assert(initRes.status === 202, 'Initiates valid research with HTTP 202 Accepted');
    assert(initData.success === true, 'Response contains success=true');
    assert(typeof initData.taskId === 'string', 'Returns generated taskId string');

    const createdTaskId = initData.taskId;

    // Test duplicate task submission prevention
    const duplicateRes = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: validTopic }),
    });
    const duplicateData = await duplicateRes.json();
    assert(duplicateRes.status === 202, 'Duplicate topic submission returns HTTP 202');
    assert(duplicateData.taskId === createdTaskId, 'Returns existing running taskId for duplicate topic submission');

    // Test 4: GET /api/research/:id/status
    console.log('\n--- 4. Testing GET /api/research/:id/status ---');
    // Non-existent ID
    const notFoundStatusRes = await fetch(`${baseUrl}/api/research/invalid_id_12345/status`);
    assert(notFoundStatusRes.status === 404, 'Returns HTTP 404 for unknown task ID');

    // Valid Task ID
    const validStatusRes = await fetch(`${baseUrl}/api/research/${createdTaskId}/status`);
    const validStatusData = await validStatusRes.json();
    assert(validStatusRes.status === 200, 'Returns HTTP 200 for valid task ID');
    assert(validStatusData.job.id === createdTaskId, 'Returned job ID matches request');
    assert(['running', 'completed', 'failed'].includes(validStatusData.job.status), 'Job status is valid status string');

    // Test 5: GET /api/export/:filename & Security Traversal Checks
    console.log('\n--- 5. Testing GET /api/export/:filename & Security Checks ---');
    
    // Traversal attack attempt 1
    const attackRes1 = await fetch(`${baseUrl}/api/export/..%2F..%2Fpackage.json`);
    assert(attackRes1.status === 400, 'Blocks directory traversal attempt (../) with HTTP 400');

    // Traversal attack attempt 2
    const attackRes2 = await fetch(`${baseUrl}/api/export/test.txt`);
    assert(attackRes2.status === 400, 'Blocks non-.md extension requests with HTTP 400');

    // Non-existent report file
    const missingFileRes = await fetch(`${baseUrl}/api/export/non_existent_report_999.md`);
    assert(missingFileRes.status === 404, 'Returns HTTP 404 for missing markdown report');

    // Valid Export Download Test
    await fs.mkdir(config.exportsDir, { recursive: true });
    const dummyFileName = `test_export_${Date.now()}.md`;
    const dummyFilePath = path.join(config.exportsDir, dummyFileName);
    await fs.writeFile(dummyFilePath, '# Test Research Report\nThis is test content.', 'utf-8');

    const validExportRes = await fetch(`${baseUrl}/api/export/${dummyFileName}`);
    const exportContent = await validExportRes.text();
    assert(validExportRes.status === 200, 'Successfully downloads valid markdown report');
    assert(validExportRes.headers.get('content-type').includes('text/markdown'), 'Sets Content-Type to text/markdown');
    assert(exportContent.includes('# Test Research Report'), 'Export file content matches saved markdown');

    // Cleanup dummy file
    await fs.unlink(dummyFilePath).catch(() => {});

    console.log('\n==========================================');
    console.log(`SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED.`);
    console.log('==========================================\n');

    if (failedCount > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Unexpected Error during API tests:', err);
    process.exit(1);
  } finally {
    server.close();
  }
}

runApiTests();
