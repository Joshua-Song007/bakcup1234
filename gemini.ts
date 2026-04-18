import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

export interface GeminiResult {
  title: string;
  explanation: string;
  scaffold: string;
  runnable: string;
}

/** Describes the outer structure of a code snippet, returned by step 1. */
interface StructureAnalysis {
  constructType: string;
  purpose: string;
  subPatterns: string[];
}

const MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are a patient CS tutor helping students understand code they did not write. Be concise and clear, and
focus on the big picture topics.
You must respond ONLY with valid JSON — no markdown, no prose outside the JSON object.
The JSON must have exactly four keys: "title", "explanation", "scaffold", and "runnable".`;

function buildPrompt(code: string, language: string, fileContext: string): string {
  const contextSnippet = fileContext.slice(0, 3000);
  return `Language: ${language}

SELECTED CODE:
\`\`\`${language}
${code}
\`\`\`

SURROUNDING FILE CONTEXT (for reference only):
\`\`\`${language}
${contextSnippet}
\`\`\`

Instructions:
Generate JSON with these 4 fields for the selected ${language} code:
"title": 3-5 word phrase describing what the code does. Be concrete; use actual names from the code when helpful.
"explanation": What the selected code does, in 3-5 sentences max:

Name the outer construct (loop, function, class, etc.) and its purpose.
Summarize the key steps inside it.
Note how it fits the larger file, if relevant.
Skip internal logic details, individual conditions, and implementation specifics.

"scaffold": A minimal, runnable ${language} snippet that teaches the same construct through a simplified example.

Match the outer structure of the original (if-elif-else → if-elif-else, for-loop → for-loop, etc.).
Replace ALL original logic with new, simple, concrete values — real variable names, real literals, real outputs. Never reproduce the original's specific conditions or data.
WRONG: commented pseudocode stubs like # return result for condition1. RIGHT: actual executable statements like return "low".
Keep it as short as possible while remaining a valid, complete demonstration of the construct.
Must produce visible output when run.
Add brief comments explaining structure and syntax.

"runnable": A complete ${language} program that wraps the scaffold for execution.

Include all setup needed to run (imports, boilerplate).
Place the exact string {{SCAFFOLD}} at the single insertion point where the scaffold code belongs. Include nothing else in that position.
The user never sees this — it runs behind the scenes with {{SCAFFOLD}} replaced by the student's edited scaffold.

Respond with ONLY this JSON (no markdown fences, no extra keys):
{"title": "...", "explanation": "...", "scaffold": "...", "runnable": "..."}`;
}

function parseResult(raw: string): GeminiResult {
  console.log('Gemini: Parsing result, raw length:', raw.length);
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  console.log('Gemini: Cleaned response:', cleaned.substring(0, 200) + '...');
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof parsed.explanation !== 'string' || typeof parsed.scaffold !== 'string') {
      console.error('Gemini: Missing required fields in parsed result');
      throw new Error('Missing explanation or scaffold field');
    }
    const result = {
      title: typeof parsed.title === 'string' ? parsed.title : 'code snippet',
      explanation: parsed.explanation,
      scaffold: parsed.scaffold,
      runnable: typeof parsed.runnable === 'string' ? parsed.runnable : parsed.scaffold,
    };
    console.log('Gemini: Successfully parsed result:', { title: result.title, explanationLength: result.explanation.length, scaffoldLength: result.scaffold.length });
    return result;
  } catch (parseError) {
    console.error('Gemini: JSON parse error:', parseError);
    return {
      title: 'code snippet',
      explanation: raw,
      scaffold: `// Could not generate example`,
      runnable: '',
    };
  }
}

function stripFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * Step 1 — Calls the model on the selected code and returns a structured
 * description of its outer construct, one-sentence purpose, and key sub-patterns.
 */
async function analyzeStructure(
  model: GenerativeModel,
  code: string,
  language: string,
): Promise<StructureAnalysis> {
  const prompt = `Language: ${language}

CODE:
\`\`\`${language}
${code}
\`\`\`

Respond with ONLY valid JSON (no markdown fences) with exactly three keys:
"constructType": the name of the outermost construct (e.g. "for-loop", "class", "if-elif-else", "function").
"purpose": one sentence describing what this construct achieves.
"subPatterns": a JSON array of short strings naming any notable inner patterns (e.g. ["list comprehension", "try-except"]).

Example: {"constructType":"for-loop","purpose":"Iterates over a list to accumulate a running total.","subPatterns":["conditional assignment"]}`;

  const res = await model.generateContent(prompt);
  const raw = stripFences(res.response.text());
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    constructType: typeof parsed.constructType === 'string' ? parsed.constructType : 'construct',
    purpose: typeof parsed.purpose === 'string' ? parsed.purpose : '',
    subPatterns: Array.isArray(parsed.subPatterns)
      ? (parsed.subPatterns as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
  };
}

/**
 * Step 2 — Takes the structure analysis from step 1 and produces a plain-text
 * generation brief describing what the scaffold and runnable should look like,
 * specific enough to use without seeing the original code.
 */
async function buildGenerationPrompt(
  model: GenerativeModel,
  analysis: StructureAnalysis,
  language: string,
): Promise<string> {
  const prompt = `You are preparing a teaching example for a CS student learning ${language}.

The code they are studying contains:
- Outer construct: ${analysis.constructType}
- Purpose: ${analysis.purpose}
- Sub-patterns: ${analysis.subPatterns.length ? analysis.subPatterns.join(', ') : 'none'}

Write a concise plain-text brief (no JSON, no code) describing:
1. What the scaffold snippet should demonstrate — the outer structure, simplified internal values, expected visible output.
2. What the runnable wrapper should include — imports, boilerplate, hardcoded inputs, and where {{SCAFFOLD}} slots in.

Be specific enough that another model can generate both pieces without seeing the original code.`;

  const res = await model.generateContent(prompt);
  return res.response.text().trim();
}

/**
 * Step 3 — Uses the generation brief from step 2 to produce only the scaffold
 * and runnable fields, following the existing format rules ({{SCAFFOLD}} placeholder).
 */
async function generateScaffoldAndRunnable(
  model: GenerativeModel,
  brief: string,
  language: string,
): Promise<{ scaffold: string; runnable: string }> {
  const prompt = `Language: ${language}

GENERATION BRIEF:
${brief}

Using the brief above, generate ONLY valid JSON with exactly two keys:

"scaffold": A minimal, runnable ${language} snippet demonstrating the construct described.
  - Use the outer structure from the brief exactly.
  - Replace all domain logic with new simple concrete values — real literals, real outputs. No pseudocode stubs.
  - Must produce visible output when run. Add brief comments explaining structure and syntax.

"runnable": A complete ${language} program that wraps the scaffold.
  - Include all imports and boilerplate needed to run.
  - Place the exact string {{SCAFFOLD}} at the single point where the scaffold belongs.
  - Use small hardcoded inputs matching what the scaffold expects.

Respond with ONLY this JSON (no markdown fences, no extra keys):
{"scaffold": "...", "runnable": "..."}`;

  const res = await model.generateContent(prompt);
  const raw = stripFences(res.response.text());
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.scaffold !== 'string' || typeof parsed.runnable !== 'string') {
    throw new Error('generateScaffoldAndRunnable: missing scaffold or runnable field');
  }
  return { scaffold: parsed.scaffold, runnable: parsed.runnable };
}

/** Single API call — returns title, explanation, and a first-pass scaffold+runnable quickly. */
export async function explainBase(
  code: string,
  language: string,
  fileContext: string,
  apiKey: string,
): Promise<GeminiResult> {
  if (!apiKey) {
    throw new Error(
      'Gemini API key not set. Go to Settings → search "Explainable" → enter your API key.'
    );
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: SYSTEM_PROMPT });
  const result = await model.generateContent(buildPrompt(code, language, fileContext));
  return parseResult(result.response.text());
}

/**
 * 3-step pipeline that refines scaffold+runnable quality.
 * Returns a new GeminiResult with only scaffold and runnable replaced.
 * Throws on failure — callers should catch and keep the base result.
 */
export async function improveScaffold(
  base: GeminiResult,
  language: string,
  apiKey: string,
  verbose?: boolean,
): Promise<GeminiResult> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const plainModel = genAI.getGenerativeModel({ model: MODEL });

  const analysis = await analyzeStructure(plainModel, base.explanation, language);
  if (verbose) { console.log('[improveScaffold] step 1:', JSON.stringify(analysis)); }

  const brief = await buildGenerationPrompt(plainModel, analysis, language);
  if (verbose) { console.log('[improveScaffold] step 2:', brief); }

  const { scaffold, runnable } = await generateScaffoldAndRunnable(plainModel, brief, language);
  if (verbose) { console.log('[improveScaffold] step 3:', JSON.stringify({ scaffold, runnable })); }

  return { ...base, scaffold, runnable };
}

/** Convenience wrapper: base call then pipeline. Kept for backward compatibility. */
export async function explainCode(
  code: string,
  language: string,
  fileContext: string,
  apiKey: string,
  verbose?: boolean,
): Promise<GeminiResult> {
  const base = await explainBase(code, language, fileContext, apiKey);
  if (verbose) { console.log('[explainCode] base result:', JSON.stringify(base)); }
  try {
    return await improveScaffold(base, language, apiKey, verbose);
  } catch (err) {
    console.warn('[explainCode] scaffold pipeline failed, using fallback:', err instanceof Error ? err.message : err);
    return base;
  }
}
