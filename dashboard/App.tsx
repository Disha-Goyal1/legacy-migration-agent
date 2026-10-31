import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";

interface MigrationReport {
  sourceFile: string;
  outputFile: string;
  transformations: string[];
  warnings: string[];
  errors: string[];
  status: "completed" | "review_required" | "failed";
}

interface MigrationResult {
  output: string | null;
  report: MigrationReport;
}

interface Summary {
  totalFiles: number;
  successful: number;
  failures: number;
  review: number;
  files: string[];
}

interface SourceFixture {
  filename: string;
  source: string;
}

const EMPTY_SUMMARY: Summary = {
  totalFiles: 0,
  successful: 0,
  failures: 0,
  review: 0,
  files: [],
};

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data
        ? data.error
        : undefined;
    throw new Error(message || `Request failed (${response.status}).`);
  }
  return data as T;
}

function formatStatus(status: MigrationReport["status"]): string {
  if (status === "review_required") return "Review required";
  if (status === "failed") return "Failed";
  return "Completed";
}

function App() {
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState("");
  const [filename, setFilename] = useState("");
  const [source, setSource] = useState("");
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [activeTab, setActiveTab] = useState<"output" | "report">("output");
  const [isMigrating, setIsMigrating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSummary();
  }, []);

  async function loadSummary(): Promise<void> {
    setSummaryLoading(true);
    setSummaryError("");
    try {
      setSummary(await readJson<Summary>(await fetch("/api/summary")));
    } catch (reason) {
      setSummaryError(
        reason instanceof Error ? reason.message : "Could not load project summary.",
      );
    } finally {
      setSummaryLoading(false);
    }
  }

  async function chooseFixture(event: ChangeEvent<HTMLSelectElement>): Promise<void> {
    const selected = event.target.value;
    setError("");
    setResult(null);
    if (!selected) {
      setFilename("");
      setSource("");
      return;
    }

    try {
      const fixture = await readJson<SourceFixture>(
        await fetch(`/api/source?name=${encodeURIComponent(selected)}`),
      );
      setFilename(fixture.filename);
      setSource(fixture.source);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load fixture.");
    }
  }

  async function loadUpload(file?: File): Promise<void> {
    if (!file) return;
    setError("");
    setResult(null);
    if (!file.name.toLowerCase().endsWith(".js")) {
      setError("Choose a JavaScript file with a .js extension.");
      return;
    }
    if (file.size > 1_000_000) {
      setError("This file is larger than the local API limit of 1 MB.");
      return;
    }

    try {
      setFilename(file.name);
      setSource(await file.text());
    } catch (reason) {
      setFilename("");
      setSource("");
      setError(reason instanceof Error ? reason.message : "Could not read this file.");
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    void loadUpload(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragging(false);
    void loadUpload(event.dataTransfer.files[0]);
  }

  async function migrate(): Promise<void> {
    if (!filename || !source.trim()) return;
    setIsMigrating(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/migrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename, source }),
      });
      const migration = await readJson<MigrationResult>(response);
      setResult(migration);
      setActiveTab(migration.output ? "output" : "report");
      void loadSummary();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The local migration service could not process this file.",
      );
    } finally {
      setIsMigrating(false);
    }
  }

  function downloadOutput(): void {
    if (!result?.output) return;
    const url = URL.createObjectURL(
      new Blob([result.output], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = result.report.outputFile;
    link.click();
    URL.revokeObjectURL(url);
  }

  const metrics = [
    { label: "Total files", value: summary.totalFiles, icon: "01", tone: "blue" },
    { label: "Successful", value: summary.successful, icon: "02", tone: "green" },
    { label: "Failures", value: summary.failures, icon: "03", tone: "red" },
    { label: "Needs review", value: summary.review, icon: "04", tone: "amber" },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Legacy Migration Agent home">
          <span className="brand-mark" aria-hidden="true">LM</span>
          <span className="brand-name">Legacy<span>Migration</span></span>
        </a>
        <div className="topbar-right">
          <span className="local-pill"><i /> Local workspace</span>
          <span className="topbar-divider" />
          <span className="avatar">LM</span>
        </div>
      </header>

      <main className="page-content">
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><span /> MIGRATION WORKSPACE</div>
            <h1>Modernize your JavaScript,<br /><em>one file at a time.</em></h1>
            <p>Convert legacy JavaScript into readable TypeScript with AST-powered analysis and transparent human-review guidance.</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="hero-orbit orbit-one" />
            <div className="hero-orbit orbit-two" />
            <div className="code-chip chip-js">JS</div>
            <div className="code-chip chip-ts">TS</div>
            <div className="hero-arrow">→</div>
            <div className="hero-grid" />
          </div>
        </section>

        <section className="metrics-grid" aria-label="Migration summary">
          {metrics.map((metric, index) => (
            <article className={`metric-card metric-${metric.tone}`} key={metric.label}>
              <div className="metric-top">
                <span className="metric-icon">{metric.icon}</span>
                <span className="metric-index">0{index + 1}</span>
              </div>
              <div className="metric-value">
                {summaryLoading ? <span className="skeleton-value" /> : metric.value}
              </div>
              <div className="metric-label">{metric.label}</div>
              <div className="metric-foot">
                <span className="metric-dot" />
                <span>{metric.label === "Total files" ? "In legacy fixtures" : "Latest fixture report"}</span>
              </div>
            </article>
          ))}
        </section>
        {summaryError && <div className="inline-notice error-notice">{summaryError}</div>}

        <div className="workspace-heading">
          <div>
            <div className="section-kicker">GET STARTED</div>
            <h2>Migration workspace</h2>
          </div>
          <div className="engine-pill"><span /> Real migration engine connected</div>
        </div>

        <section className="workspace-grid">
          <article className="panel source-panel">
            <div className="panel-heading">
              <div className="panel-title-group">
                <span className="panel-step">01</span>
                <div><h3>Select a source file</h3><p>Choose a project fixture or upload a local .js file</p></div>
              </div>
              <span className="file-type-badge">.JS</span>
            </div>

            <label className="field-label" htmlFor="fixture-select">PROJECT FIXTURES</label>
            <select id="fixture-select" className="fixture-select" value={filename && summary.files.includes(filename) ? filename : ""} onChange={chooseFixture}>
              <option value="">Select a file from fixtures/legacy</option>
              {summary.files.map(file => <option value={file} key={file}>{file}</option>)}
            </select>

            <div className="upload-divider"><span />or upload a file<span /></div>
            <div
              className={`drop-zone ${isDragging ? "is-dragging" : ""} ${filename && !summary.files.includes(filename) ? "has-file" : ""}`}
              onDragOver={event => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") fileInput.current?.click();
              }}
            >
              <input ref={fileInput} className="visually-hidden" type="file" accept=".js,application/javascript,text/javascript" onChange={onFileChange} />
              <span className="upload-icon" aria-hidden="true">↑</span>
              {filename && !summary.files.includes(filename) ? (
                <><strong>{filename}</strong><span>File loaded locally · click to replace</span></>
              ) : (
                <><strong>Drop your JavaScript file here</strong><span>or <b>browse files</b> from your computer</span></>
              )}
              <small>JavaScript only · Up to 1 MB · Source is never executed</small>
            </div>

            {filename && (
              <div className="selected-file">
                <span className="selected-file-icon">JS</span>
                <div className="selected-file-info"><strong>{filename}</strong><span>{source.split(/\r?\n/).length} lines · source preserved</span></div>
                <button className="clear-file" type="button" onClick={() => { setFilename(""); setSource(""); setResult(null); }}>Remove</button>
              </div>
            )}

            {error && <div className="inline-notice error-notice" role="alert">{error}</div>}

            <div className="source-preview">
              <div className="preview-heading">
                <span>SOURCE PREVIEW</span>
                <span>{filename || "No file selected"}</span>
              </div>
              {source ? (
                <pre><code>{source}</code></pre>
              ) : (
                <div className="empty-source"><span className="empty-source-icon">⌘</span><strong>Your source will appear here</strong><span>Select a fixture or upload a JavaScript file to begin.</span></div>
              )}
            </div>

            <button className="migrate-button" type="button" onClick={() => void migrate()} disabled={!filename || !source.trim() || isMigrating}>
              {isMigrating ? <><span className="spinner" /> Analyzing source…</> : <>Migrate file <span aria-hidden="true">→</span></>}
            </button>
            <p className="privacy-note"><span>◇</span> Runs locally. Your original JavaScript file is never modified.</p>
          </article>

          <article className="panel result-panel">
            <div className="panel-heading result-heading">
              <div className="panel-title-group">
                <span className="panel-step">02</span>
                <div><h3>Migration results</h3><p>Output and review details from the migration engine</p></div>
              </div>
              {result && <span className={`status-badge status-${result.report.status}`}>{formatStatus(result.report.status)}</span>}
            </div>

            {result ? (
              <>
                <div className="result-file-bar">
                  <div className="result-file"><span className="ts-file-icon">TS</span><strong>{result.report.outputFile}</strong></div>
                  {result.output && <button className="download-button" type="button" onClick={downloadOutput}><span>↓</span> Download .ts</button>}
                </div>
                <div className="result-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={activeTab === "output"} className={activeTab === "output" ? "active" : ""} onClick={() => setActiveTab("output")}>TypeScript output</button>
                  <button type="button" role="tab" aria-selected={activeTab === "report"} className={activeTab === "report" ? "active" : ""} onClick={() => setActiveTab("report")}>Migration report <span>{result.report.warnings.length + result.report.errors.length}</span></button>
                </div>
                {activeTab === "output" && result.output ? (
                  <pre className="output-code"><code>{result.output}</code></pre>
                ) : activeTab === "output" ? (
                  <div className="empty-result"><span className="failed-symbol">!</span><h4>No TypeScript output was written</h4><p>The engine rejected this source. Review the parser or migration errors in the report.</p><button type="button" onClick={() => setActiveTab("report")}>Inspect errors →</button></div>
                ) : (
                  <div className="report-content">
                    <div className="report-status-row"><span className={`status-indicator status-${result.report.status}`} /><div><strong>{formatStatus(result.report.status)}</strong><span>{result.report.sourceFile} → {result.report.outputFile}</span></div></div>
                    <ReportList title="Transformations" items={result.report.transformations} tone="transform" empty="No transformations were performed." />
                    <ReportList title="Warnings · human review" items={result.report.warnings} tone="warning" empty="No review warnings." />
                    <ReportList title="Errors" items={result.report.errors} tone="error" empty="No migration errors." />
                  </div>
                )}
              </>
            ) : (
              <div className="empty-result empty-result-initial">
                <div className="empty-illustration"><div className="empty-file">.TS</div><span>→</span><div className="empty-report">✓</div></div>
                <h4>Ready when you are</h4>
                <p>Select a JavaScript file and run the migration to see generated TypeScript, transformations, and review warnings.</p>
                <div className="result-capabilities"><span><i /> Type-safe output</span><span><i /> Honest review flags</span><span><i /> Source stays untouched</span></div>
              </div>
            )}
          </article>
        </section>

        <footer className="page-footer">
          <span><span className="footer-mark">LM</span> Legacy Migration Agent</span>
          <span>Local analysis · No source execution · No external services</span>
        </footer>
      </main>
    </div>
  );
}

function ReportList({
  title,
  items,
  tone,
  empty,
}: {
  title: string;
  items: string[];
  tone: "transform" | "warning" | "error";
  empty: string;
}) {
  return (
    <section className={`report-list report-${tone}`}>
      <h4>{title}<span>{items.length}</span></h4>
      {items.length > 0 ? (
        <ul>{items.map((item, index) => <li key={`${item}-${index}`}><i />{item}</li>)}</ul>
      ) : <p className="report-empty">{empty}</p>}
    </section>
  );
}

export default App;
