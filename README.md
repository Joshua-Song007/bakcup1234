# Explainable

> Understand your code — contextual explanations and runnable sandboxes for CS students, inside VS Code.

CS students increasingly receive working code from AI tools without understanding what it does. Explainable intercepts the "I don't understand this" moment inside the editor itself: highlight code, get a plain-English explanation, and run a bare scaffold of the concept immediately — without leaving VS Code.

## Features

### Explain a selection
Highlight any code → right-click → **Explain this**

A split panel opens beside your editor:
- **Left pane** — plain-English explanation pitched at a beginner level, mentioning actual variable names from your code
- **Right pane** — an editable scaffold of the same concept with `TODO` comments; click **Run** to execute it

### Explain a file
Right-click any file in the Explorer → **Explain this file**

Same split panel, scoped to the whole file.

### Run the scaffold
The right pane executes code locally using your installed runtime:

Output and exit code appear below the Run button.

### Session history
Every explanation is saved to the **Explainable** activity bar panel for the current window. Click any entry to reopen that panel.

## Requirements

- VS Code 1.116.0+
- A **Gemini API key** (free at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey))
- The runtime for whatever language you want to run (`python3`, `node`, etc.)

## Getting Started

1. Install the extension
2. Open a file with code you want to understand
3. Highlight a snippet and right-click → **Explain this**
4. On first use, you'll be prompted to enter your Gemini API key — it's stored securely in VS Code's secret storage

To clear your API key: open the Command Palette → **Explainable: Reset API Key**

<!-- AUTO-GENERATED: scripts -->
## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile TypeScript to `out/` |
| `npm run watch` | Compile in watch mode |
| `npm run lint` | Run ESLint on `src/` |
| `npm run pretest` | Compile + lint (runs before tests) |
| `npm test` | Run the VS Code extension test suite |
| `npm run vscode:prepublish` | Pre-publish build (compile) |
<!-- END AUTO-GENERATED -->

## Extension Settings

No configuration settings are required. The Gemini API key is stored in VS Code's built-in secret storage and prompted on first use.

## Release Notes

### 0.0.1

Initial hackathon release — explain selection, explain file, runnable scaffold, session history, loading spinner, Gemini 2.5 Flash.
