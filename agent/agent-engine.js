'use strict';

const { listTools, getTool } = require('./tool-registry');
const { nextStep } = require('./llm-client');

const MAX_STEPS = 6;

function buildSystemPrompt({ memory, env }) {
  const toolDocs = listTools()
    .map((t) => `- ${t.name}: ${t.description}\n  params: ${JSON.stringify(t.parameters)}`)
    .join('\n');

  return [
    'You are Kolabrya Agent, an autonomous assistant that drives a case-management API.',
    'You operate a tool loop. On every turn you MUST reply with strict JSON: either',
    '  {"tool": "<name>", "input": {...}}   to call a tool, OR',
    '  {"final": "<message>"}              when the user goal is fully done OR you need to ask the user.',
    'Never include prose outside JSON. Never invent UUIDs.',
    '',
    'Available tools:',
    toolDocs,
    '',
    'Operational rules:',
    '- If the user wants to upload files, the typical sequence is: (optional create_case) -> read_local_files -> upload_files.',
    '- If a caseUuid is needed and you don\'t have one, prefer memory.lastCaseUuid; otherwise call get_cases or create_case.',
    '- If a folderPath is needed and you don\'t have one, prefer memory.lastFolderPath; otherwise return {"final": "Please pick a folder first."}.',
    '- To delete a file by name, first call get_cases with filterByName, find the matching fileUuid, then call delete_file.',
    '- Stop and return {"final": "..."} as soon as the goal is satisfied; do not loop redundantly.',
    '- Never call the same tool with identical inputs twice in a row.',
    '',
    `Current memory: ${JSON.stringify(memory)}`,
    `Default caseType (if creating): ${env.DEFAULT_CASE_TYPE || '(unset)'}`,
  ].join('\n');
}

/**
 * Run the agent loop until {final}, MAX_STEPS, or unrecoverable error.
 *
 * `deps` provides:
 *   api      axios instance (already auth'd)
 *   memory   { get(k), set(k,v), all() }
 *   env      process.env subset
 *   apiKey   OpenAI key
 *   model    OpenAI model
 *   log      (level, msg) => void
 *   onStep   (step) => void   step = { i, tool, input, result?, error?, final? }
 *   onProgress (payload) => void   forwarded into upload tool
 */
async function runAgent({ prompt, context, deps }) {
  const { memory, env, apiKey, model, api, log, onStep, onProgress } = deps;
  if (!prompt || typeof prompt !== 'string') throw new Error('Empty prompt.');

  const memoryView = memory.all();
  const systemPrompt = buildSystemPrompt({ memory: memoryView, env });

  // The conversation we keep with the LLM.
  const history = [
    {
      role: 'user',
      content: JSON.stringify({
        userPrompt: prompt,
        uiContext: context || {},
        memory: memoryView,
      }),
    },
  ];

  // Per-run scratch shared between tools (e.g. listed file descriptors).
  const scratch = {};

  // Light loop-guard: track last tool+input signatures.
  let lastSig = null;

  for (let i = 0; i < MAX_STEPS; i++) {
    let decision;
    try {
      decision = await nextStep({ apiKey, model, systemPrompt, history });
    } catch (err) {
      log('error', `LLM error on step ${i + 1}: ${err.message}`);
      onStep && onStep({ i: i + 1, error: err.message });
      return { ok: false, error: err.message, steps: i };
    }

    // Final answer?
    if (decision && typeof decision.final === 'string') {
      log('info', `Agent final: ${decision.final}`);
      onStep && onStep({ i: i + 1, final: decision.final });
      return { ok: true, final: decision.final, steps: i + 1 };
    }

    const toolName = decision?.tool;
    const input = decision?.input || {};
    if (!toolName) {
      const msg = `Step ${i + 1}: LLM returned no "tool" or "final".`;
      log('warn', msg);
      onStep && onStep({ i: i + 1, error: msg, raw: decision });
      return { ok: false, error: msg, steps: i + 1 };
    }

    const tool = getTool(toolName);
    if (!tool) {
      const msg = `Unknown tool "${toolName}".`;
      log('warn', msg);
      // Feed back to LLM so it can self-correct.
      history.push({ role: 'assistant', content: JSON.stringify(decision) });
      history.push({ role: 'user', content: JSON.stringify({ error: msg, availableTools: listTools().map((t) => t.name) }) });
      continue;
    }

    // Auto-inject memory defaults the LLM forgot.
    if (tool.name === 'upload_files' || tool.name === 'delete_file') {
      if (!input.caseUuid && memory.get('lastCaseUuid')) input.caseUuid = memory.get('lastCaseUuid');
    }
    if (tool.name === 'upload_files' || tool.name === 'read_local_files') {
      if (!input.folderPath && memory.get('lastFolderPath')) input.folderPath = memory.get('lastFolderPath');
    }

    const sig = `${tool.name}:${JSON.stringify(input)}`;
    if (sig === lastSig) {
      const msg = `Refusing to repeat "${tool.name}" with the same input.`;
      log('warn', msg);
      history.push({ role: 'assistant', content: JSON.stringify(decision) });
      history.push({ role: 'user', content: JSON.stringify({ error: msg }) });
      continue;
    }
    lastSig = sig;

    onStep && onStep({ i: i + 1, tool: tool.name, input });
    log('info', `Step ${i + 1}: ${tool.name}(${JSON.stringify(input)})`);

    let result;
    try {
      result = await tool.run(input, {
        api,
        env,
        memory,
        scratch,
        log,
        emitProgress: (p) => onProgress && onProgress(p),
      });
    } catch (err) {
      const msg = err.message || String(err);
      log('error', `Tool ${tool.name} failed: ${msg}`);
      onStep && onStep({ i: i + 1, tool: tool.name, input, error: msg });
      // Tell the LLM and let it decide whether to recover or surrender.
      history.push({ role: 'assistant', content: JSON.stringify(decision) });
      history.push({
        role: 'user',
        content: JSON.stringify({ toolError: { tool: tool.name, message: msg } }),
      });
      continue;
    }

    onStep && onStep({ i: i + 1, tool: tool.name, input, result });
    history.push({ role: 'assistant', content: JSON.stringify(decision) });
    history.push({
      role: 'user',
      content: JSON.stringify({ toolResult: { tool: tool.name, result } }),
    });
  }

  log('warn', `Agent hit MAX_STEPS (${MAX_STEPS}).`);
  return { ok: false, error: `Reached step limit (${MAX_STEPS}).`, steps: MAX_STEPS };
}

module.exports = { runAgent, MAX_STEPS };
