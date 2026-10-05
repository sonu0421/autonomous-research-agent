/**
 * Autonomous Research Agent Frontend Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const researchForm = document.getElementById('researchForm');
  const topicInput = document.getElementById('topicInput');
  const charCount = document.getElementById('charCount');
  const startBtn = document.getElementById('startBtn');
  const topicChips = document.querySelectorAll('.topic-chip');

  const progressCard = document.getElementById('progressCard');
  const agentStatusPill = document.getElementById('agentStatusPill');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const progressStageText = document.getElementById('progressStageText');
  const logStream = document.getElementById('logStream');
  const agentSpinner = document.getElementById('agentSpinner');

  const errorBanner = document.getElementById('errorBanner');
  const errorMessage = document.getElementById('errorMessage');
  const dismissErrorBtn = document.getElementById('dismissErrorBtn');

  const reportCard = document.getElementById('reportCard');
  const reportTopicTitle = document.getElementById('reportTopicTitle');
  const reportTimestamp = document.getElementById('reportTimestamp');
  const subQuestionsList = document.getElementById('subQuestionsList');
  const sourcesList = document.getElementById('sourcesList');
  const reportContent = document.getElementById('reportContent');
  const copyMarkdownBtn = document.getElementById('copyMarkdownBtn');
  const downloadMdBtn = document.getElementById('downloadMdBtn');
  const downloadPdfBtn = document.getElementById('downloadPdfBtn');
  const systemStatus = document.getElementById('systemStatus');
  const providerBadge = document.getElementById('providerBadge');

  let activePollInterval = null;
  let currentRawMarkdown = '';
  let currentResult = null;

  // 1. Initial System Health Check
  checkSystemHealth();

  // 2. Character Counter & Input Validation
  topicInput.addEventListener('input', () => {
    const len = topicInput.value.length;
    charCount.textContent = len;
  });

  // 3. Quick Start Sample Topic Chips
  topicChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      topicInput.value = chip.getAttribute('data-topic');
      charCount.textContent = topicInput.value.length;
      topicInput.focus();
    });
  });

  // 4. Form Submission & Research Execution
  researchForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const topic = topicInput.value.trim();
    if (!topic || topic.length < 3) {
      showError('Please enter a valid research topic (at least 3 characters).');
      return;
    }

    // Reset UI states
    hideError();
    reportCard.classList.add('hidden');
    progressCard.classList.remove('hidden');
    logStream.innerHTML = '';
    updateProgressUI('INITIATED', 'Submitting research task...');
    agentSpinner.classList.add('fa-spin');

    // Disable input controls
    setFormDisabled(true);

    try {
      addLogEntry('INITIATED', `Submitting research request for: "${topic}"`);

      const response = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to initiate research task.');
      }

      addLogEntry('RUNNING', `Task created successfully (ID: ${data.taskId}). Monitoring workflow...`);

      // Start polling status
      startStatusPolling(data.taskId);
    } catch (err) {
      showError(err.message);
      progressCard.classList.add('hidden');
      setFormDisabled(false);
    }
  });

  // 5. Polling Mechanism
  function startStatusPolling(taskId) {
    if (activePollInterval) clearInterval(activePollInterval);

    let seenLogsCount = 0;

    activePollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/research/${taskId}/status`);
        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to fetch task status.');
        }

        const { job } = data;

        // Process new progress log entries
        if (job.progressLogs && job.progressLogs.length > seenLogsCount) {
          const newLogs = job.progressLogs.slice(seenLogsCount);
          newLogs.forEach((log) => {
            addLogEntry(log.step, log.detail, log.timestamp);
            updateProgressUI(log.step, log.detail);
          });
          seenLogsCount = job.progressLogs.length;
        }

        // Handle Completed Job State
        if (job.status === 'completed') {
          clearInterval(activePollInterval);
          updateProgressUI('COMPLETED', 'Research report successfully generated!');
          agentSpinner.classList.remove('fa-spin');

          renderReport(job.result);
          setFormDisabled(false);
        }

        // Handle Failed Job State
        if (job.status === 'failed') {
          clearInterval(activePollInterval);
          updateProgressUI('FAILED', 'Research execution encountered an error.');
          agentSpinner.classList.remove('fa-spin');

          showError(job.error || 'Research execution failed.');
          setFormDisabled(false);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1500);
  }

  // 6. Progress UI Update Helper
  function updateProgressUI(step, detail = '') {
    const stepConfigMap = {
      INITIATED: { percent: 10, label: 'Initiating Task' },
      DECOMPOSING: { percent: 25, label: 'Engineering Search Queries' },
      DECOMPOSED: { percent: 35, label: 'Sub-queries Generated' },
      SEARCHING: { percent: 45, label: 'Live Web Search Active' },
      SEARCHING_SUBQUERY: { percent: 55, label: 'Searching Sub-queries' },
      DEDUPLICATING: { percent: 65, label: 'Deduplicating Sources' },
      DEDUPLICATED: { percent: 70, label: 'Deduplication Complete' },
      RELEVANCE_FILTERING: { percent: 75, label: 'Source Relevance Audit' },
      RELEVANCE_FILTERED: { percent: 80, label: 'Sources Verified' },
      ANALYZING_DIMENSIONS: { percent: 85, label: 'Analyzing Topic Dimensions' },
      DIMENSIONS_IDENTIFIED: { percent: 88, label: 'Dimensions Identified' },
      INSUFFICIENT_EVIDENCE: { percent: 82, label: 'Gathering More Evidence' },
      REFINING_QUERIES: { percent: 83, label: 'Refining Search Queries' },
      SEARCHING_REFINED_QUERY: { percent: 84, label: 'Searching Refined Queries' },
      AUDITING_REFINED_SOURCES: { percent: 85, label: 'Auditing New Sources' },
      REFINED_SOURCES_VERIFIED: { percent: 86, label: 'New Sources Verified' },
      FALLBACK_SOURCES: { percent: 87, label: 'Using Best Available Sources' },
      DRIFT_DETECTED: { percent: 88, label: 'Checking Topic Coverage' },
      DOMAIN_DIVERSIFIED: { percent: 89, label: 'Diversifying Sources' },
      COVERAGE_WARNING: { percent: 90, label: 'Coverage Check' },
      COVERAGE_OK: { percent: 90, label: 'Coverage Check' },
      ANALYZING: { percent: 92, label: 'Synthesizing Empirical Report' },
      REPORT_GENERATED: { percent: 98, label: 'Report Generated' },
      COMPLETED: { percent: 100, label: 'Research Completed' },
      FAILED: { percent: 100, label: 'Execution Failed' },
    };

    const config = stepConfigMap[step] || { percent: 50, label: step };

    // Never let the progress bar go backwards (monotonic progress)
    if (typeof window._maxProgressShown === 'undefined') window._maxProgressShown = 0;
    // Reset on new job start
    if (step === 'INITIATED') window._maxProgressShown = 0;
    const shownPercent = Math.max(config.percent, window._maxProgressShown);
    window._maxProgressShown = shownPercent;

    progressBar.style.width = `${shownPercent}%`;
    progressPercent.textContent = `${shownPercent}%`;
    agentStatusPill.textContent = step;
    progressStageText.textContent = detail || config.label;
  }

  // 7. Render Research Report UI
  function renderReport(result) {
    currentResult = result;
    currentRawMarkdown = result.reportMarkdown || '';
    window.currentResult = result;
    window.currentRawMarkdown = currentRawMarkdown;

    reportTopicTitle.textContent = result.topic;
    reportTimestamp.innerHTML = `<i class="fa-regular fa-clock"></i> Generated at ${new Date(result.timestamp).toLocaleTimeString()}`;

    // Render Sub-questions
    subQuestionsList.innerHTML = '';
    if (result.subQuestions && result.subQuestions.length > 0) {
      result.subQuestions.forEach((q) => {
        const li = document.createElement('li');
        li.textContent = q;
        subQuestionsList.appendChild(li);
      });
    }

    // Render Source Links
    sourcesList.innerHTML = '';
    if (result.sources && result.sources.length > 0) {
      result.sources.forEach((src) => {
        const div = document.createElement('div');
        div.className = 'source-card';
        div.innerHTML = `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${escapeHtml(src.title)}</a>`;
        sourcesList.appendChild(div);
      });
    }

    // Safely Parse & Render Markdown Body
    if (window.marked) {
      reportContent.innerHTML = window.marked.parse(currentRawMarkdown);
    } else {
      reportContent.textContent = currentRawMarkdown;
    }

    // Set Download Export Link for Markdown
    downloadMdBtn.href = result.exportUrl || '#';
    downloadMdBtn.setAttribute('download', result.exportFileName || 'report.md');

    // Show Report Card
    reportCard.classList.remove('hidden');
    reportCard.scrollIntoView({ behavior: 'smooth' });
  }

  window.renderReport = renderReport;

  // 8. Copy Markdown to Clipboard
  copyMarkdownBtn.addEventListener('click', async () => {
    if (!currentRawMarkdown) return;
    try {
      await navigator.clipboard.writeText(currentRawMarkdown);
      const originalHtml = copyMarkdownBtn.innerHTML;
      copyMarkdownBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
      setTimeout(() => {
        copyMarkdownBtn.innerHTML = originalHtml;
      }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });

  // 9. Download Report as PDF
  downloadPdfBtn.addEventListener('click', async () => {
    if (!currentResult || !currentRawMarkdown) return;

    const originalBtnText = downloadPdfBtn.innerHTML;
    downloadPdfBtn.disabled = true;
    downloadPdfBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Generating PDF...';

    // Save user's current scroll position
    const savedScrollX = window.scrollX || window.pageXOffset || 0;
    const savedScrollY = window.scrollY || window.pageYOffset || 0;

    let outerContainer = null;
    try {
      // Temporarily scroll to top (0,0) so html2canvas computes top offset Y as exactly 0px
      window.scrollTo(0, 0);
      // Wait for scroll to settle before capturing
      await new Promise(resolve => setTimeout(resolve, 120));

      // Create offscreen container wrapper behind body elements to prevent screen flashing
      outerContainer = document.createElement('div');
      outerContainer.id = 'pdfExportOuterWrapper';
      outerContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: -9999px;
        width: 718px;
        overflow: visible;
        z-index: -9999;
        background: #ffffff;
      `;

      // Inner in-flow pdfWrapper so html2canvas computes full height (4500px+) without collapsing to 0
      const pdfWrapper = document.createElement('div');
      pdfWrapper.id = 'pdfExportContainer';
      pdfWrapper.className = 'pdf-export-container';
      pdfWrapper.style.cssText = `
        position: relative;
        display: block;
        width: 718px;
        min-width: 718px;
        max-width: 718px;
        background: #ffffff;
        color: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 10pt;
        line-height: 1.5;
        padding: 16px 0;
        margin: 0;
        box-sizing: border-box;
      `;

      const title = escapeHtml(currentResult.topic);
      const dateStr = new Date(currentResult.timestamp).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });

      // Render Markdown body to HTML
      let bodyHtml = window.marked ? window.marked.parse(currentRawMarkdown) : `<pre>${escapeHtml(currentRawMarkdown)}</pre>`;

      // Document Title & Metadata Header
      const headerHtml = `
        <div style="border-bottom: 2px solid #4f46e5; padding-bottom: 8px; margin-bottom: 14px;">
          <h1 style="font-size: 16pt; font-weight: 800; color: #1e1b4b; margin: 0 0 4px 0; line-height: 1.25; page-break-after: avoid; break-after: avoid;">${title}</h1>
          <p style="font-size: 8.5pt; color: #64748b; margin: 0;">Autonomous AI Research Report &bull; Published: ${dateStr} &bull; Task ID: ${escapeHtml(currentResult.id || '')}</p>
        </div>
      `;

      pdfWrapper.innerHTML = `
        ${headerHtml}
        <div class="pdf-body-content">
          ${bodyHtml}
        </div>
      `;

      outerContainer.appendChild(pdfWrapper);
      document.body.appendChild(outerContainer);

      // Apply print & page-break inline styles to all elements inside pdfWrapper
      const headings = pdfWrapper.querySelectorAll('h1, h2, h3, h4');
      headings.forEach((h) => {
        h.style.pageBreakAfter = 'avoid';
        h.style.breakAfter = 'avoid';
        if (h.tagName === 'H1') {
          h.style.fontSize = '13.5pt';
          h.style.color = '#1e1b4b';
          h.style.marginTop = '14px';
          h.style.marginBottom = '6px';
          h.style.borderBottom = '1px solid #cbd5e1';
          h.style.paddingBottom = '3px';
        } else if (h.tagName === 'H2') {
          h.style.fontSize = '11.5pt';
          h.style.color = '#334155';
          h.style.marginTop = '12px';
          h.style.marginBottom = '4px';
        } else if (h.tagName === 'H3') {
          h.style.fontSize = '10.5pt';
          h.style.color = '#475569';
          h.style.marginTop = '10px';
          h.style.marginBottom = '3px';
        } else if (h.tagName === 'H4') {
          h.style.fontSize = '10pt';
          h.style.color = '#475569';
          h.style.marginTop = '8px';
          h.style.marginBottom = '2px';
        }
      });

      const paragraphs = pdfWrapper.querySelectorAll('p');
      paragraphs.forEach((p) => {
        p.style.marginTop = '0';
        p.style.marginBottom = '8px';
        p.style.lineHeight = '1.5';
      });

      const lists = pdfWrapper.querySelectorAll('ul, ol');
      lists.forEach((l) => {
        l.style.marginTop = '0';
        l.style.marginBottom = '8px';
        l.style.paddingLeft = '20px';
      });

      const listItems = pdfWrapper.querySelectorAll('li');
      listItems.forEach((li) => {
        li.style.marginBottom = '3px';
        li.style.lineHeight = '1.45';
      });

      const tables = pdfWrapper.querySelectorAll('table');
      tables.forEach((t) => {
        t.style.display = 'table';
        t.style.tableLayout = 'fixed';
        t.style.width = '100%';
        t.style.borderCollapse = 'collapse';
        t.style.marginTop = '8px';
        t.style.marginBottom = '12px';
        t.style.fontSize = '9pt';
        t.style.boxSizing = 'border-box';
        t.style.overflow = 'visible';

        const thead = t.querySelector('thead');
        if (thead) {
          thead.style.display = 'table-header-group';
          thead.querySelectorAll('th').forEach((th) => {
            th.style.backgroundColor = '#f1f5f9';
            th.style.color = '#0f172a';
            th.style.fontWeight = '700';
            th.style.border = '1px solid #cbd5e1';
            th.style.padding = '5px 7px';
            th.style.textAlign = 'left';
            th.style.wordBreak = 'break-word';
            th.style.overflowWrap = 'break-word';
            th.style.boxSizing = 'border-box';
          });
        }

        const tbody = t.querySelector('tbody');
        if (tbody) {
          tbody.style.display = 'table-row-group';
        }

        const rows = t.querySelectorAll('tr');
        rows.forEach((r) => {
          r.style.display = 'table-row';
          r.style.pageBreakInside = 'avoid';
          r.style.breakInside = 'avoid';
          r.querySelectorAll('td').forEach((td) => {
            td.style.border = '1px solid #cbd5e1';
            td.style.padding = '4px 7px';
            td.style.wordBreak = 'break-word';
            td.style.overflowWrap = 'break-word';
            td.style.boxSizing = 'border-box';
          });
        });
      });

      const blockquotes = pdfWrapper.querySelectorAll('blockquote');
      blockquotes.forEach((bq) => {
        bq.style.pageBreakInside = 'avoid';
        bq.style.breakInside = 'avoid';
        bq.style.borderLeft = '3.5px solid #6366f1';
        bq.style.backgroundColor = '#f8fafc';
        bq.style.padding = '6px 10px';
        bq.style.margin = '8px 0';
        bq.style.borderRadius = '0 4px 4px 0';
        bq.style.fontSize = '9.5pt';
      });

      const pres = pdfWrapper.querySelectorAll('pre');
      pres.forEach((pre) => {
        pre.style.pageBreakInside = 'avoid';
        pre.style.breakInside = 'avoid';
        pre.style.backgroundColor = '#f8fafc';
        pre.style.border = '1px solid #e2e8f0';
        pre.style.padding = '8px 10px';
        pre.style.margin = '8px 0';
        pre.style.borderRadius = '4px';
        pre.style.fontFamily = 'monospace';
        pre.style.fontSize = '8.5pt';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-word';
      });

      const links = pdfWrapper.querySelectorAll('a');
      links.forEach((a) => {
        a.style.color = '#2563eb';
        a.style.textDecoration = 'underline';
        a.style.wordBreak = 'break-all';
      });

      // Wait for layout to fully paint before capturing
      await new Promise(resolve => setTimeout(resolve, 200));

      // Options for html2pdf
      const opt = {
        margin: [10, 10, 10, 10], // 10mm margins on A4
        filename: currentResult.exportFileName ? currentResult.exportFileName.replace(/\.md$/, '.pdf') : 'research_report.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
          scrollX: 0,
          scrollY: 0,
          windowWidth: 718,
          x: 0,
          y: 0,
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
      };

      if (window.html2pdf) {
        const pdfWorker = window.html2pdf().set(opt).from(pdfWrapper);
        if (window.__onPdfGenerated) {
          await window.__onPdfGenerated(pdfWorker);
        }
        await pdfWorker.save();
      } else {
        throw new Error('PDF Export library (html2pdf) is not loaded.');
      }
    } catch (pdfErr) {
      console.error('PDF Export Error:', pdfErr);
      showError(`PDF Export failed: ${pdfErr.message}`);
    } finally {
      if (outerContainer && outerContainer.parentNode) {
        outerContainer.parentNode.removeChild(outerContainer);
      }
      // Restore user's original scroll position seamlessly
      window.scrollTo(savedScrollX, savedScrollY);
      downloadPdfBtn.disabled = false;
      downloadPdfBtn.innerHTML = originalBtnText;
    }
  });

  // Helper Functions
  function addLogEntry(step, detail, timeStr) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const time = timeStr ? new Date(timeStr).toLocaleTimeString() : new Date().toLocaleTimeString();

    entry.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-step">[${escapeHtml(step)}]</span>
      <span class="log-detail">${escapeHtml(detail)}</span>
    `;

    logStream.appendChild(entry);
    logStream.scrollTop = logStream.scrollHeight;
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function hideError() {
    errorBanner.classList.add('hidden');
  }

  dismissErrorBtn.addEventListener('click', hideError);

  function setFormDisabled(disabled) {
    topicInput.disabled = disabled;
    startBtn.disabled = disabled;
    if (disabled) {
      startBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Researching...';
    } else {
      startBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Start Autonomous Research';
    }
  }

  async function checkSystemHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        const providerName = data.provider || 'AI Research Agent';
        const modelName = data.model || 'openai/gpt-oss-20b';
        const isReady = !!data.groqConfigured;

        providerBadge.textContent = `${providerName} (${modelName}) Powered`;

        if (isReady) {
          systemStatus.innerHTML = `
            <span class="status-indicator online"></span>
            <span class="status-text">System Ready &bull; AI Engine Active</span>
          `;
        } else {
          systemStatus.innerHTML = `
            <span class="status-indicator warning"></span>
            <span class="status-text">Setup Needed &bull; GROQ_API_KEY missing in .env</span>
          `;
        }
      } else {
        throw new Error('Health check non-ok status');
      }
    } catch (e) {
      systemStatus.innerHTML = '<span class="status-indicator offline"></span><span class="status-text">Server Disconnected</span>';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
