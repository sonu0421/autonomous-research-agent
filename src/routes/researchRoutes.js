import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import config from '../config/env.js';
import { runResearchTask } from '../services/agentService.js';

const router = express.Router();

// In-memory store for research task status and logs
const jobsStore = new Map();

/**
 * POST /api/research
 * Initiates an autonomous research job.
 */
router.post('/research', async (req, res) => {
  try {
    const { topic } = req.body;

    // Input Validation
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error: Research topic is required and must be a non-empty string.',
      });
    }

    const trimmedTopic = topic.trim();
    if (trimmedTopic.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error: Research topic must be at least 3 characters long.',
      });
    }

    if (trimmedTopic.length > 300) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error: Research topic cannot exceed 300 characters.',
      });
    }

    // Prevent duplicate background research tasks for the exact same running topic
    for (const [existingId, existingJob] of jobsStore.entries()) {
      if (existingJob.status === 'running' && existingJob.topic.toLowerCase() === trimmedTopic.toLowerCase()) {
        return res.status(202).json({
          success: true,
          taskId: existingId,
          topic: existingJob.topic,
          status: 'running',
          message: 'Research task for this topic is already running.',
          statusUrl: `/api/research/${existingId}/status`,
        });
      }
    }

    const taskId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const jobRecord = {
      id: taskId,
      topic: trimmedTopic,
      status: 'running', // 'running' | 'completed' | 'failed'
      progressLogs: [],
      startTime: new Date().toISOString(),
      endTime: null,
      result: null,
      error: null,
    };

    jobsStore.set(taskId, jobRecord);

    // Asynchronously execute research workflow
    runResearchTask(trimmedTopic, (statusUpdate) => {
      const job = jobsStore.get(taskId);
      if (job) {
        job.progressLogs.push(statusUpdate);
      }
    })
      .then((researchResult) => {
        const job = jobsStore.get(taskId);
        if (job) {
          job.status = 'completed';
          job.endTime = new Date().toISOString();
          job.result = {
            id: researchResult.id,
            topic: researchResult.topic,
            timestamp: researchResult.timestamp,
            subQuestions: researchResult.subQuestions,
            sources: researchResult.sources,
            reportMarkdown: researchResult.reportMarkdown,
            exportFileName: path.basename(researchResult.exportPath),
            exportUrl: `/api/export/${path.basename(researchResult.exportPath)}`,
          };
        }
      })
      .catch((err) => {
        const job = jobsStore.get(taskId);
        if (job) {
          job.status = 'failed';
          job.endTime = new Date().toISOString();
          job.error = err.message || 'An unknown error occurred during research execution.';
        }
      });

    // Respond immediately with Task ID for polling / real-time tracking
    return res.status(202).json({
      success: true,
      taskId,
      topic: trimmedTopic,
      status: 'running',
      statusUrl: `/api/research/${taskId}/status`,
    });
  } catch (err) {
    console.error('[ResearchRoutes] POST /api/research error:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error while initiating research task.',
    });
  }
});

/**
 * GET /api/research/:id/status
 * Fetches status, step logs, and completed result for a research task.
 */
router.get('/research/:id/status', (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ success: false, error: 'Task ID is required.' });
  }

  const job = jobsStore.get(id);
  if (!job) {
    return res.status(404).json({ success: false, error: `Research job with ID "${id}" was not found.` });
  }

  return res.json({
    success: true,
    job: {
      id: job.id,
      topic: job.topic,
      status: job.status,
      progressLogs: job.progressLogs,
      startTime: job.startTime,
      endTime: job.endTime,
      result: job.result,
      error: job.error,
    },
  });
});

/**
 * GET /api/export/:filename
 * Serves generated Markdown reports for download with directory traversal protection.
 */
router.get('/export/:filename', async (req, res) => {
  try {
    const rawFilename = req.params.filename;

    // Security check: Prevent Directory Traversal Attacks
    const safeFilename = path.basename(rawFilename);

    // Strict filename validation pattern
    if (rawFilename !== safeFilename || rawFilename.includes('..') || !/^[a-zA-Z0-9_\-\.]+\.md$/.test(safeFilename)) {
      return res.status(400).json({
        success: false,
        error: 'Security Error: Invalid or prohibited filename parameter.',
      });
    }

    const filePath = path.resolve(config.exportsDir, safeFilename);

    // Ensure resolved path stays strictly within exports directory
    if (!filePath.startsWith(config.exportsDir)) {
      return res.status(403).json({
        success: false,
        error: 'Access Denied: Path outside authorized export directory.',
      });
    }

    try {
      await fs.stat(filePath);
    } catch {
      return res.status(404).json({
        success: false,
        error: `Export file "${safeFilename}" was not found.`,
      });
    }

    // Set headers and send file for download
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    return res.sendFile(filePath);
  } catch (err) {
    console.error('[ResearchRoutes] GET /api/export/:filename error:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error while serving export file.',
    });
  }
});

export default router;
