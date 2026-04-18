import * as path from 'path';
import * as vscode from 'vscode';
import hljs from 'highlight.js';
import { GeminiResult } from '../ai/gemini';
import { SessionTreeProvider } from '../views/SessionTreeProvider';
import { escapeHtml, getNonce } from '../utils/htmlUtils';
import { startRun, RunHandle } from '../execution/runner';

// ── Link resolution ──────────────────────────────────────────────────────────

function escapeRegexStr(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFINITION_PATTERNS = [
  (s: string) => new RegExp(`^\\s*class\\s+${escapeRegexStr(s)}\\b`),
  (s: string) => new RegExp(`^\\s*def\\s+${escapeRegexStr(s)}\\s*\\(`),
  (s: string) => new RegExp(`^\\s*(export\\s+)?(default\\s+)?(abstract\\s+)?(class|interface|enum)\\s+${escapeRegexStr(s)}\\b`),
  (s: string) => new RegExp(`^\\s*(export\\s+)?(async\\s+)?function\\s+${escapeRegexStr(s)}\\b`),
  (s: string) => new RegExp(`^\\s*(export\\s+)?(const|let|var)\\s+${escapeRegexStr(s)}\\s*=`),
  (s: string) => new RegExp(`^\\s*(public|private|protected|static|final).*\\s+${escapeRegexStr(s)}\\s*\\(`),
];

async function findSymbolInFiles(symbol: string, files: vscode.Uri[]): Promise<{ uri: string; line: number } | null> {
  const patterns = DEFINITION_PATTERNS.map(fn => fn(symbol));
  for (const uri of files.slice(0, 100)) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf8');
      if (content.length > 1000000) { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < Math.min(lines.length, 10000); i++) {
        if (patterns.some(p => p.test(lines[i]))) {
          return { uri: uri.toString(), line: i };
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

async function resolveSymbolLinks(explanation: string): Promise<Record<string, { uri: string; line: number }>> {
  try {
    const refs = new Set<string>();
    const re = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(explanation)) !== null) {
      const tok = m[1].trim();
      if (tok && !tok.includes(' ') && !tok.includes('\n')) { refs.add(tok); }
    }
    if (refs.size === 0) { return {}; }

    const sourceFiles = await vscode.workspace.findFiles(
      '**/*.{py,ts,js,tsx,jsx,java,go,rs,cpp,c,cs,rb,swift,kt,php}',
      '**/node_modules/**', 300,
    );

    const byFullName = new Map<string, vscode.Uri>();
    const byNameNoExt = new Map<string, vscode.Uri>();
    for (const uri of sourceFiles) {
      const base = path.basename(uri.fsPath);
      byFullName.set(base, uri);
      byNameNoExt.set(base.replace(/\.[^.]+$/, ''), uri);
    }

    const links: Record<string, { uri: string; line: number }> = {};
    for (const ref of refs) {
      const exact = byFullName.get(ref);
      if (exact) { links[ref] = { uri: exact.toString(), line: 0 }; continue; }
      const mod = byNameNoExt.get(ref);
      if (mod) { links[ref] = { uri: mod.toString(), line: 0 }; continue; }
      const found = await findSymbolInFiles(ref, sourceFiles);
      if (found) { links[ref] = found; }
    }
    return links;
  } catch (error) {
    console.error('Error in resolveSymbolLinks:', error);
    return {};
  }
}

function buildExplanationHtml(text: string, links: Record<string, { uri: string; line: number }>): string {
  const parts = text.split(/(`[^`]+`)/);
  return parts.map((part, i) => {
    if (i % 2 === 0) {
      return part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const ref = part.slice(1, -1);
    const safe = ref.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const link = links[ref];
    if (link) {
      return `<a href="#" data-uri="${escapeHtml(link.uri)}" data-line="${link.line}">${safe}</a>`;
    }
    return `<code>${safe}</code>`;
  }).join('');
}

function highlightScaffold(code: string, language: string): string {
  try {
    const lang = hljs.getLanguage(language) ? language : 'plaintext';
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

// ── Message guards ───────────────────────────────────────────────────────────

interface RunMessage   { type: 'run';      code: string; language: string; }
interface OpenFileMsg  { type: 'openFile'; uri: string;  line: number; }

function isRunMessage(msg: unknown): msg is RunMessage {
  return typeof msg === 'object' && msg !== null &&
    (msg as Record<string, unknown>)['type'] === 'run' &&
    typeof (msg as Record<string, unknown>)['code'] === 'string' &&
    typeof (msg as Record<string, unknown>)['language'] === 'string';
}

function isOpenFileMsg(msg: unknown): msg is OpenFileMsg {
  return typeof msg === 'object' && msg !== null &&
    (msg as Record<string, unknown>)['type'] === 'openFile' &&
    typeof (msg as Record<string, unknown>)['uri'] === 'string';
}

// ── Panel ────────────────────────────────────────────────────────────────────

export class ExplainPanel {
  private static currentPanel: ExplainPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _disposed = false;
  private _activeRun: RunHandle | null = null;
  private _pendingMsg: unknown = null;
  private _lastMsg: unknown = null;
  private _webviewReady = false;

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible && this._lastMsg) {
        this._panel.webview.postMessage(this._lastMsg);
      }
    }, null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      const type = (msg as Record<string, unknown>)['type'];

      if (type === 'ready') {
        this._webviewReady = true;
        if (this._pendingMsg) {
          this._panel.webview.postMessage(this._pendingMsg);
          this._lastMsg = this._pendingMsg;
          this._pendingMsg = null;
        }
        return;
      }

      if (type === 'requestRefresh') {
        if (this._lastMsg) { this._panel.webview.postMessage(this._lastMsg); }
        return;
      }

      if (isOpenFileMsg(msg)) {
        try {
          const uri = vscode.Uri.parse(msg.uri);
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc, { preview: false });
          if (typeof msg.line === 'number' && msg.line > 0) {
            const pos = new vscode.Position(msg.line, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
        } catch {
          vscode.window.showErrorMessage('Explainable: Could not open file.');
        }
        return;
      }

      if (!isRunMessage(msg)) { return; }
      if (this._activeRun) { return; }
      const handle = startRun(msg.code, msg.language);
      this._activeRun = handle;
      try {
        const result = await handle.result;
        if (!this._disposed) {
          this._panel.webview.postMessage({ type: 'runResult', result });
        }
      } catch (err) {
        if (!this._disposed) {
          this._panel.webview.postMessage({
            type: 'runResult',
            result: { stdout: '', stderr: '', exitCode: 1, error: err instanceof Error ? err.message : 'Unknown error' },
          });
        }
      } finally {
        this._activeRun = null;
      }
    }, undefined, this._disposables);
  }

  private _post(msg: unknown): void {
    this._lastMsg = msg;
    this._pendingMsg = null;
    if (this._webviewReady) {
      this._panel.webview.postMessage(msg);
    } else {
      this._pendingMsg = msg;
    }
  }

  /** Shows the spinner. Creates the panel if it doesn't exist yet. */
  static openLoading(context: vscode.ExtensionContext, language: string): void {
    void context;
    const column = vscode.ViewColumn.Beside;
    const loadingMsg = { type: 'loading', language };

    if (ExplainPanel.currentPanel) {
      ExplainPanel.currentPanel._panel.reveal(column);
      ExplainPanel.currentPanel._post(loadingMsg);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'explainablePanel', `Explainable: ${language}`, column,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const ep = new ExplainPanel(panel);
      ep._pendingMsg = loadingMsg;
      ep._panel.webview.html = ExplainPanel._shellHtml();
      ExplainPanel.currentPanel = ep;
    }

    ExplainPanel.currentPanel._panel.title = `Explainable: ${language}`;
  }

  /** Displays an error state — clears the spinner so it never gets stuck. */
  static showError(message: string): void {
    if (!ExplainPanel.currentPanel) { return; }
    ExplainPanel.currentPanel._post({ type: 'error', message });
  }

  /** Called once the API result is ready. Updates content via postMessage — no HTML replacement. */
  static createOrShow(
    _context: vscode.ExtensionContext,
    result: GeminiResult,
    language: string,
    sessionProvider: SessionTreeProvider,
    fileName = '',
    addToHistory = true,
  ): void {
    const column = vscode.ViewColumn.Beside;
    const label = fileName ? `${path.basename(fileName)} — ${result.title}` : result.title;

    if (ExplainPanel.currentPanel) {
      ExplainPanel.currentPanel._panel.reveal(column);
      void ExplainPanel.currentPanel._update(result, label, language);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'explainablePanel', `Explainable: ${label}`, column,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const ep = new ExplainPanel(panel);
      ep._panel.webview.html = ExplainPanel._shellHtml();
      ExplainPanel.currentPanel = ep;
      void ep._update(result, label, language);
    }

    if (addToHistory) {
      sessionProvider.addSession({
        label, timestamp: Date.now(),
        explanation: result.explanation,
        scaffold: result.scaffold,
        runnable: result.runnable,
        language,
      });
    }
  }

  private async _update(result: GeminiResult, label: string, language: string): Promise<void> {
    this._panel.title = `Explainable: ${label}`;
    let links: Record<string, { uri: string; line: number }> = {};
    try {
      links = await resolveSymbolLinks(result.explanation);
    } catch (error) {
      console.error('ExplainPanel: Failed to resolve symbol links:', error);
    }
    if (this._disposed) { return; }
    this._post({
      type: 'update',
      label,
      explanationHtml: buildExplanationHtml(result.explanation, links),
      scaffold: result.scaffold,
      scaffoldHtml: highlightScaffold(result.scaffold, language),
      runnable: result.runnable ?? '',
      language,
    });
  }

  /** Shell HTML — set exactly once per panel lifetime. All content arrives via postMessage. */
  private static _shellHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Explainable</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      display: flex; flex-direction: column;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
    }

    /* ── highlight.js — VS Code Dark+ palette ── */
    .hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-type { color: #569cd6; }
    .hljs-built_in,.hljs-title,.hljs-title.function_ { color: #dcdcaa; }
    .hljs-title.class_,.hljs-name { color: #4ec9b0; }
    .hljs-string,.hljs-regexp,.hljs-template-string { color: #ce9178; }
    .hljs-number { color: #b5cea8; }
    .hljs-comment,.hljs-doctag { color: #6a9955; font-style: italic; }
    .hljs-variable,.hljs-params,.hljs-attr { color: #9cdcfe; }
    .hljs-operator,.hljs-punctuation { color: #d4d4d4; }
    .hljs-meta { color: #9b9b9b; }
    .hljs-selector-class,.hljs-selector-id { color: #d7ba7d; }
    .hljs-emphasis { font-style: italic; }
    .hljs-strong { font-weight: bold; }

    /* ── Loading ─────────────────── */
    #loading {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      flex: 1; gap: 14px; opacity: 0.7;
    }
    .spinner {
      width: 28px; height: 28px;
      border: 3px solid var(--vscode-panel-border, #555);
      border-top-color: var(--vscode-focusBorder, #007fd4);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #loading p { font-size: 13px; }

    /* ── Error state ─────────────── */
    #error-state {
      display: none; flex-direction: column;
      align-items: center; justify-content: center;
      flex: 1; gap: 12px; padding: 24px; text-align: center;
    }
    #error-state p { color: var(--vscode-terminal-ansiRed, #f48771); font-size: 13px; max-width: 360px; line-height: 1.5; }
    #error-state small { opacity: 0.5; font-size: 11px; }

    /* ── Content ─────────────────── */
    #content { display: none; flex-direction: column; flex: 1; overflow: hidden; }

    header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      font-weight: 600; font-size: 14px;
      letter-spacing: 0.03em; opacity: 0.85;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between;
    }
    #refreshBtn {
      font-size: 11px; font-weight: 600;
      background: none; border: 1px solid var(--vscode-panel-border, #555);
      color: inherit; cursor: pointer; border-radius: 3px;
      padding: 2px 8px; opacity: 0.6; letter-spacing: 0.04em;
    }
    #refreshBtn:hover { opacity: 1; }

    .split { display: flex; flex: 1; overflow: hidden; }

    .pane {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
      overflow: hidden; padding: 16px; gap: 10px;
    }
    .pane + .pane { border-left: 1px solid var(--vscode-panel-border, #444); }

    .pane-title {
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em;
      opacity: 0.6; flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between;
    }

    /* ── Explanation ─────────────── */
    #explanation {
      flex: 1; overflow-y: auto;
      line-height: 1.65; white-space: pre-wrap;
    }
    #explanation code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: rgba(255,255,255,0.08);
      padding: 1px 4px; border-radius: 3px; font-size: 0.92em;
    }
    #explanation a {
      color: var(--vscode-textLink-foreground, #4daafc);
      font-family: var(--vscode-editor-font-family, monospace);
      background: rgba(255,255,255,0.08);
      padding: 1px 4px; border-radius: 3px; font-size: 0.92em;
      text-decoration: underline; cursor: pointer;
    }
    #explanation a:hover { color: var(--vscode-textLink-activeForeground, #6fc3ff); }

    /* ── Code editor overlay ─────── */
    .code-wrap {
      flex: 1; min-height: 80px;
      position: relative;
      border: 1px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 4px; overflow: hidden;
    }
    .code-wrap:focus-within {
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }
    #scaffold-hl, #scaffold {
      position: absolute; inset: 0;
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5; padding: 10px 12px;
      tab-size: 4; margin: 0;
      white-space: pre; overflow: auto; word-wrap: normal;
    }
    #scaffold-hl {
      background: #1e1e1e; color: #d4d4d4;
      pointer-events: none; border: none; outline: none; z-index: 0;
    }
    #scaffold {
      background: transparent; color: transparent;
      caret-color: #aeafad;
      border: none; outline: none; resize: none; z-index: 1;
    }

    #resetBtn {
      font-size: 10px; font-weight: 600; opacity: 0.5;
      background: none; border: none; color: inherit;
      cursor: pointer; padding: 0;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    #resetBtn:hover { opacity: 1; }

    /* ── Run button ──────────────── */
    #runBtn {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 3px; cursor: pointer;
      font-size: 13px; font-weight: 500;
      align-self: flex-start; flex-shrink: 0;
    }
    #runBtn:hover    { background: var(--vscode-button-hoverBackground, #1177bb); }
    #runBtn:disabled { opacity: 0.5; cursor: not-allowed; }

    .output-label {
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em;
      opacity: 0.6; flex-shrink: 0;
    }
    #exit-code { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    #exit-code.fail { color: var(--vscode-terminal-ansiRed, #f48771); }
    #output {
      flex: 0 0 120px; overflow-y: auto;
      background: var(--vscode-terminal-background, #111);
      color: var(--vscode-terminal-foreground, #ccc);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 4px; padding: 8px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; white-space: pre-wrap;
    }
    #output.has-error { color: var(--vscode-terminal-ansiRed, #f48771); }
  </style>
</head>
<body>
  <div id="loading">
    <div class="spinner"></div>
    <p id="loading-msg">Analyzing code&hellip;</p>
  </div>

  <div id="error-state">
    <p id="error-msg"></p>
    <small>Check the VS Code notification for details.</small>
  </div>

  <div id="content">
    <header>
      <span id="header"></span>
      <button id="refreshBtn" title="Reload content">&#x21BB; Refresh</button>
    </header>
    <div class="split">
      <div class="pane">
        <div class="pane-title">&#x1F4A1; What this does</div>
        <div id="explanation"></div>
      </div>
      <div class="pane">
        <div class="pane-title">
          <span>&#x270F; Edit &amp; Run</span>
          <button id="resetBtn" title="Restore original">Reset</button>
        </div>
        <div class="code-wrap">
          <pre id="scaffold-hl" aria-hidden="true"></pre>
          <textarea id="scaffold" spellcheck="false" autocorrect="off" autocapitalize="off"></textarea>
        </div>
        <button id="runBtn">&#x25B6; Run</button>
        <div class="output-label">Output</div>
        <pre id="output">Press Run to see output&hellip;</pre>
        <div id="exit-code"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const loadingEl     = document.getElementById('loading');
    const loadingMsg    = document.getElementById('loading-msg');
    const errorEl       = document.getElementById('error-state');
    const errorMsgEl    = document.getElementById('error-msg');
    const contentEl     = document.getElementById('content');
    const headerEl      = document.getElementById('header');
    const explanationEl = document.getElementById('explanation');
    const scaffoldHlEl  = document.getElementById('scaffold-hl');
    const scaffoldEl    = document.getElementById('scaffold');
    const resetBtn      = document.getElementById('resetBtn');
    const refreshBtn    = document.getElementById('refreshBtn');
    const runBtn        = document.getElementById('runBtn');
    const outputEl      = document.getElementById('output');
    const exitCodeEl    = document.getElementById('exit-code');

    vscode.postMessage({ type: 'ready' });

    let runnableCode         = '';
    let currentLang          = '';
    let originalScaffold     = '';
    let originalScaffoldHtml = '';

    function showOnly(el) {
      loadingEl.style.display  = 'none';
      errorEl.style.display    = 'none';
      contentEl.style.display  = 'none';
      el.style.display = 'flex';
      if (el === contentEl) {
        el.style.flex           = '1';
        el.style.overflow       = 'hidden';
        el.style.flexDirection  = 'column';
      }
    }

    // ── Indentation-aware scaffold injection ──────────────────────────────────
    function applyScaffold(runnable, scaffold) {
      var ph = '{{SCAFFOLD}}';
      var idx = runnable.indexOf(ph);
      if (idx === -1) { return scaffold; }
      var lineStart = runnable.lastIndexOf('\\n', idx - 1) + 1;
      var indent = runnable.slice(lineStart, idx).match(/^(\\s*)/)[1];
      var lines = scaffold.split('\\n');
      var indented = lines.map(function(l, i) { return i === 0 ? l : (l ? indent + l : ''); }).join('\\n');
      return runnable.slice(0, idx) + indented + runnable.slice(idx + ph.length);
    }

    // ── Inline tokenizer ──────────────────────────────────────────────────────
    var TOKEN_RE = new RegExp(
      '(\\/\\/[^\\n]*'                               +
      '|#[^\\n]*'                                    +
      '|\\/\\*[\\s\\S]*?\\*\\/'                      +
      '|"(?:[^"\\\\]|\\\\.)*"'                       +
      '|\'(?:[^\'\\\\]|\\\\.)*\''                    +
      '|\x60(?:[^\x60\\\\]|\\\\.)*\x60'              +
      '|\\b(?:for|while|if|else|elif|def|class|import|from|return|in|and|or|not' +
        '|True|False|None|function|const|let|var|async|await|try|catch|except' +
        '|finally|new|this|super|extends|export|default|typeof|instanceof' +
        '|null|undefined|true|false|void|pass|print|self|static|public|private|protected' +
        '|int|str|float|bool|list|dict|set|tuple|range|len|type|interface|enum)\\b' +
      '|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'  +
      ')',
      'g'
    );

    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function tokenize(code) {
      var result = '';
      var last = 0;
      var m;
      TOKEN_RE.lastIndex = 0;
      while ((m = TOKEN_RE.exec(code)) !== null) {
        result += esc(code.slice(last, m.index));
        last = m.index + m[0].length;
        var tok = m[0];
        var cls;
        if (tok.startsWith('//') || tok.startsWith('#') || tok.startsWith('/*')) {
          cls = 'hljs-comment';
        } else if (tok[0] === '"' || tok[0] === "'" || tok[0] === '\x60') {
          cls = 'hljs-string';
        } else if (/^\\d/.test(tok)) {
          cls = 'hljs-number';
        } else {
          cls = 'hljs-keyword';
        }
        result += '<span class="' + cls + '">' + esc(tok) + '</span>';
      }
      result += esc(code.slice(last));
      return result;
    }

    function syncHighlight() {
      scaffoldHlEl.innerHTML = tokenize(scaffoldEl.value) + '\\n';
    }
    function syncScroll() {
      scaffoldHlEl.scrollTop  = scaffoldEl.scrollTop;
      scaffoldHlEl.scrollLeft = scaffoldEl.scrollLeft;
    }

    scaffoldEl.addEventListener('input', syncHighlight);
    scaffoldEl.addEventListener('scroll', syncScroll);

    scaffoldEl.addEventListener('keydown', function(e) {
      if (e.key !== 'Tab') { return; }
      e.preventDefault();
      var s = scaffoldEl.selectionStart, end = scaffoldEl.selectionEnd;
      scaffoldEl.value = scaffoldEl.value.slice(0, s) + '    ' + scaffoldEl.value.slice(end);
      scaffoldEl.selectionStart = scaffoldEl.selectionEnd = s + 4;
      syncHighlight();
    });

    resetBtn.addEventListener('click', function() {
      scaffoldEl.value = originalScaffold;
      scaffoldHlEl.innerHTML = originalScaffoldHtml + '\\n';
    });
    refreshBtn.addEventListener('click', function() { vscode.postMessage({ type: 'requestRefresh' }); });

    explanationEl.addEventListener('click', function(e) {
      var a = e.target.closest('a[data-uri]');
      if (!a) { return; }
      e.preventDefault();
      vscode.postMessage({ type: 'openFile', uri: a.dataset.uri, line: parseInt(a.dataset.line || '0', 10) });
    });

    runBtn.addEventListener('click', function() {
      runBtn.disabled = true;
      runBtn.textContent = 'Running...';
      outputEl.textContent = '';
      outputEl.className = '';
      exitCodeEl.textContent = '';
      exitCodeEl.className = '';
      var combined = applyScaffold(runnableCode, scaffoldEl.value);
      vscode.postMessage({ type: 'run', code: combined, language: currentLang });
    });

    window.addEventListener('message', function(event) {
      try {
        var msg = event.data;

        if (msg.type === 'loading') {
          loadingMsg.textContent = 'Analyzing ' + (msg.language || '') + ' code\u2026';
          showOnly(loadingEl);
          return;
        }

        if (msg.type === 'error') {
          errorMsgEl.textContent = msg.message || 'An error occurred. Please try again.';
          showOnly(errorEl);
          return;
        }

        if (msg.type === 'update') {
          headerEl.textContent      = 'Explainable \u2014 ' + msg.label;
          explanationEl.innerHTML   = msg.explanationHtml || '';
          scaffoldEl.value          = msg.scaffold || '';
          originalScaffold          = msg.scaffold || '';
          originalScaffoldHtml      = msg.scaffoldHtml || tokenize(msg.scaffold || '');
          scaffoldHlEl.innerHTML    = originalScaffoldHtml + '\\n';
          runnableCode              = msg.runnable || '';
          currentLang               = msg.language || '';
          runBtn.disabled           = false;
          runBtn.innerHTML          = '&#x25B6; Run';
          outputEl.textContent      = 'Press Run to see output\u2026';
          outputEl.className        = '';
          exitCodeEl.textContent    = '';
          exitCodeEl.className      = '';
          showOnly(contentEl);
          scaffoldEl.focus();
          return;
        }

        if (msg.type === 'runResult') {
          var r = msg.result;
          runBtn.disabled  = false;
          runBtn.innerHTML = '&#x25B6; Run';
          if (r.error) {
            outputEl.textContent   = r.error;
            outputEl.className     = 'has-error';
            exitCodeEl.textContent = '';
          } else {
            var parts = [];
            if (r.stdout) { parts.push(r.stdout); }
            if (r.stderr) { parts.push('--- stderr ---\\n' + r.stderr); }
            outputEl.textContent   = parts.join('\\n') || '(no output)';
            outputEl.className     = r.exitCode !== 0 ? 'has-error' : '';
            exitCodeEl.textContent = 'exit ' + r.exitCode;
            exitCodeEl.className   = r.exitCode === 0 ? '' : 'fail';
          }
        }
      } catch (error) {
        errorMsgEl.textContent = 'Error rendering content. Please try again.';
        showOnly(errorEl);
      }
    });
  </script>
</body>
</html>`;
  }

  private _dispose(): void {
    this._disposed = true;
    this._activeRun?.kill();
    this._activeRun = null;
    ExplainPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }
}
