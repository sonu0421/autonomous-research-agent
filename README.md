# 🤖 Autonomous AI Research Agent

An autonomous research system built with **Node.js, Express.js, Google Gemini API (`@google/genai`)**, and a multi-tiered live web search engine. The application accepts a high-level research topic, autonomously decomposes it into targeted search sub-questions, scrapes live web data, synthesizes findings using Gemini AI reasoning, and outputs a structured Markdown report with source citations and export capabilities.

---

## 🌟 Key Features

- **Autonomous Topic Decomposition**: Uses Gemini 2.5 API to deconstruct complex topics into 3–5 targeted, search-optimized sub-questions.
- **Multi-Tiered Live Web Search Engine**: 
  - **Tier 1**: DuckDuckGo library search.
  - **Tier 2**: Bing HTML search fallback.
  - **Tier 3**: Wikipedia API search fallback.
- **Deep Content Extraction**: Scrapes web pages using Axios and Cheerio, stripping clutter (scripts, navs, ads) to extract readable text while capping context budget to preserve efficiency.
- **Structured Markdown Report Generation**: Synthesizes empirical evidence into structured reports featuring:
  - Executive Summary
  - Key Findings & Technical Analysis
  - Detailed Evidence & Breakthrough Insights
  - Actionable Recommendations & Future Outlook
  - Verified Sources & Citations
- **Real-Time Web Dashboard**: Responsive dark-mode UI with live step-by-step progress tracking, animated step logs, and Markdown previews.
- **One-Click Markdown Export**: Download research reports as `.md` files or copy raw Markdown directly to the clipboard.
- **Enterprise Security**: Path-traversal defense on file exports, XSS sanitization, and secure environment variable handling for API keys.

---

## 🛠️ Technology Stack

- **Backend**: Node.js (ES Modules), Express.js
- **AI Model & SDK**: Official Google Gen AI SDK (`@google/genai`) powered by `gemini-2.5-flash`
- **Web Scraping & Search**: `duck-duck-scrape`, `axios`, `cheerio`
- **Frontend**: HTML5, Vanilla CSS3 (Custom Glassmorphism Design System), JavaScript (ES6+), `marked.js`
- **Environment & Security**: `dotenv`

---

## 📂 Project Directory Structure

```text
autonomous-research-agent/
├── package.json               # Dependencies and scripts (type: module)
├── .env.example               # Environment variables template
├── .env                       # Local environment configuration (GEMINI_API_KEY)
├── .gitignore                 # Excludes node_modules, .env, and exports
├── README.md                  # Complete documentation and setup guide
├── src/
│   ├── server.js              # Express server & error middleware
│   ├── config/
│   │   └── env.js             # Environment variable loader & validator
│   ├── services/
│   │   ├── geminiService.js   # Gemini API topic breakdown & synthesis
│   │   ├── searchService.js   # Multi-tier web search & text extraction
│   │   └── agentService.js    # Autonomous workflow state machine
│   └── routes/
│       └── researchRoutes.js  # REST API routes (/api/research, /api/export)
├── public/
│   ├── index.html             # Responsive Web Dashboard UI
│   ├── css/
│   │   └── style.css          # Custom dark mode aesthetics & design tokens
│   └── js/
│       └── app.js             # Client controller, progress polling, & report rendering
├── exports/                   # Directory where generated Markdown reports are saved
└── tests/
    ├── testServices.js        # Core services test suite
    ├── testApiRoutes.js       # REST API endpoints & security test suite
    └── testE2E.js             # End-to-end integration test suite
```

---

## 🚀 Quick Start & Setup

### Prerequisites

- **Node.js**: `v18.0.0` or higher
- **npm**: `v9.0.0` or higher
- **Google Gemini API Key**: Obtain a free API key from [Google AI Studio](https://aistudio.google.com/).

### Installation Steps

1. **Clone or navigate to the project directory**:
   ```bash
   cd autonomous-research-agent
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to create `.env`:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and set your `GEMINI_API_KEY`:
   ```env
   PORT=3000
   NODE_ENV=development
   GEMINI_API_KEY=your_actual_gemini_api_key_here
   GEMINI_MODEL=gemini-2.5-flash
   ```

4. **Start the Application**:
   - **Production Mode**:
     ```bash
     npm start
     ```
   - **Development Mode** (with hot reload):
     ```bash
     npm run dev
     ```

5. **Access the Web Dashboard**:
   Open your browser and navigate to:
   ```text
   http://localhost:3000
   ```

---

## 📡 REST API Documentation

### 1. Initiate Research Task
- **Endpoint**: `POST /api/research`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "topic": "Impact of Quantum Computing on Post-Quantum Cryptography"
  }
  ```
- **Response (HTTP 202 Accepted)**:
  ```json
  {
    "success": true,
    "taskId": "job_1758967839201_a9f3b",
    "topic": "Impact of Quantum Computing on Post-Quantum Cryptography",
    "status": "running",
    "statusUrl": "/api/research/job_1758967839201_a9f3b/status"
  }
  ```

### 2. Poll Task Progress & Retrieve Results
- **Endpoint**: `GET /api/research/:id/status`
- **Response (HTTP 200 OK)**:
  ```json
  {
    "success": true,
    "job": {
      "id": "job_1758967839201_a9f3b",
      "topic": "Impact of Quantum Computing on Post-Quantum Cryptography",
      "status": "completed",
      "progressLogs": [
        { "step": "INITIATED", "detail": "Starting research...", "timestamp": "2026-09-26T16:30:00.000Z" },
        { "step": "DECOMPOSING", "detail": "Generating sub-questions via Gemini API...", "timestamp": "2026-09-26T16:30:02.000Z" },
        { "step": "SEARCHING", "detail": "Executing web search...", "timestamp": "2026-09-26T16:30:05.000Z" }
      ],
      "result": {
        "id": "research_1758967839",
        "subQuestions": [
          "What are the primary quantum algorithms threatening modern RSA encryption?",
          "NIST post-quantum cryptographic standardization progress in 2026"
        ],
        "sources": [
          { "title": "NIST Post-Quantum Cryptography", "url": "https://csrc.nist.gov" }
        ],
        "reportMarkdown": "# Executive Summary\n...",
        "exportFileName": "impact_of_quantum_computing_1758967839.md",
        "exportUrl": "/api/export/impact_of_quantum_computing_1758967839.md"
      }
    }
  }
  ```

### 3. Download Markdown Report
- **Endpoint**: `GET /api/export/:filename`
- **Response**: Downloads `.md` file with `Content-Type: text/markdown; charset=utf-8`.

### 4. Health Check
- **Endpoint**: `GET /api/health`
- **Response**: Returns server status and Gemini configuration state.

---

## 🧪 Automated Testing

The project includes unit, API, and integration test suites:

Run all tests automatically:
```bash
npm test
```

Or execute individual test modules:
```bash
# Core Services Test (Web Search & Gemini integration)
node tests/testServices.js

# REST API & Security Test (Input validation, status polling, path traversal defense)
node tests/testApiRoutes.js

# End-to-End Integration Test (Full frontend-backend lifecycle)
node tests/testE2E.js
```

---

## 🛡️ Security & Quality Standards

1. **No Hardcoded Keys**: API keys are strictly read from `.env` via `config/env.js`.
2. **Directory Traversal Protection**: Export filename parameter is sanitized using `path.basename()` and restricted strictly to `.md` files in the `exports/` folder.
3. **XSS Protection**: HTML content rendered in the dashboard is sanitized using `escapeHtml()` and safe DOM nodes.
4. **Git Protection**: `.gitignore` excludes `.env`, `node_modules/`, and generated `exports/*`.

---

## ⚠️ Known Limitations & Troubleshooting

- **Gemini API Key Required**: If `GEMINI_API_KEY` is not set or set to a placeholder, the API key validator will block research task initiation and report an environment setup error.
- **Web Search Anti-Bot Defenses**: If primary DuckDuckGo search encounters rate limiting, the agent automatically fails over to Bing and Wikipedia search providers without crashing.

---

## 📦 GitHub Push Checklist

To push this repository to GitHub:

```bash
# 1. Initialize git repository (if not already initialized)
git init

# 2. Add files
git add .

# 3. Create initial commit
git commit -m "feat: Autonomous AI Research Agent v1.0.0"

# 4. Connect to remote repository and push
git remote add origin https://github.com/your-username/autonomous-research-agent.git
git branch -M main
git push -u origin main
```

---

## 📄 License

MIT License.
