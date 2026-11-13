#!/usr/bin/env node
// Sums token usage from Claude Code session transcripts, for BUILD_LOG.md.
//
//   npm run usage                      -> every session recorded for this folder
//   npm run usage -- <file-or-folder>  -> a specific .jsonl transcript, or a folder of them
//
// Claude Code writes one .jsonl per session under ~/.claude/projects/<folder-slug>/.
// Each assistant line carries message.usage; lines repeat per message id, so we keep the last one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// $ per million tokens: [input, output]. Add other models before the final cost table (PLAN.md task 5.3).
// Sonnet 5.5: $2 / $10 per Anthropic's list price as reported by third-party trackers on 2026-11-13 (not read from Anthropic's own page; re-check in Phase 5).
const PRICES = { 'claude-fable-5-2': [8, 40], 'claude-sonnet-5-5': [2, 10] };
// Assumed cache multipliers on the input price. Check current pricing before publishing a number.
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const target = process.argv[2] ?? path.join(os.homedir(), '.claude', 'projects', slug);
if (!fs.existsSync(target)) {
  console.error(`No transcripts at ${target}\nPass a .jsonl file or folder: npm run usage -- <path>`);
  process.exit(1);
}
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(target, f))
  : [target];

const fmt = (n) => Math.round(n).toLocaleString('en-US');
let grand = 0;

for (const file of files) {
  const byMessage = new Map();
  let prompts = 0;
  let first = null;
  let last = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.timestamp) {
      first ??= row.timestamp;
      last = row.timestamp;
    }
    const content = row.message?.content;
    if (row.type === 'user' && !row.isMeta && !row.isSidechain) {
      const isToolResult = Array.isArray(content) && content.some((c) => c.type === 'tool_result');
      if (!isToolResult) prompts++;
    }
    const usage = row.message?.usage;
    if (row.type === 'assistant' && usage) {
      byMessage.set(row.message.id ?? row.uuid, { model: row.message.model ?? 'unknown', usage });
    }
  }

  const perModel = new Map();
  for (const { model, usage } of byMessage.values()) {
    const t = perModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    t.input += usage.input_tokens ?? 0;
    t.output += usage.output_tokens ?? 0;
    t.cacheRead += usage.cache_read_input_tokens ?? 0;
    // Cache writes are priced by lifetime (5 min or 1 h) when the transcript gives the split.
    const split = usage.cache_creation;
    const write1h = split?.ephemeral_1h_input_tokens ?? 0;
    const write5m = split ? (split.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0);
    t.cacheWrite += write5m + write1h;
    t.cacheWriteCost = (t.cacheWriteCost ?? 0) + write5m * CACHE_WRITE_5M + write1h * CACHE_WRITE_1H;
    perModel.set(model, t);
  }
  if (perModel.size === 0) continue;

  const minutes = first && last ? (new Date(last) - new Date(first)) / 60000 : 0;
  console.log(`\n${path.basename(file)}`);
  console.log(`  ${first ?? '?'} -> ${last ?? '?'}  (~${Math.round(minutes)} min, ${prompts} user prompts)`);
  for (const [model, t] of perModel) {
    const price = PRICES[model];
    let cost = 'price not set';
    if (price) {
      const usd = (t.input * price[0] + t.output * price[1] + t.cacheRead * price[0] * CACHE_READ + t.cacheWriteCost * price[0]) / 1e6;
      grand += usd;
      cost = `$${usd.toFixed(2)}`;
    }
    console.log(`  ${model}: input ${fmt(t.input)} | output ${fmt(t.output)} | cache read ${fmt(t.cacheRead)} | cache write ${fmt(t.cacheWrite)} | ${cost}`);
  }
}
console.log(`\nAPI-equivalent total for priced models: $${grand.toFixed(2)}`);
