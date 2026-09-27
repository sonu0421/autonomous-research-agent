/**
 * Proxy module maintaining backward compatibility for geminiService imports by forwarding all operations to groqService.
 */
export {
  decomposeTopic,
  refineSearchQueries,
  filterRelevantSources,
  verifyAndCleanReportGrounding,
  generateResearchReport,
  default,
} from './groqService.js';
