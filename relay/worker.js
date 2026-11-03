// Cloudflare Worker entry. Deploy from this folder: see DEMO.md, "Relay для модели".
// The prompt and schema are bundled from prompts/ at deploy time (wrangler.toml rules).
import system from '../prompts/inspect-system.md';
import schema from '../prompts/inspect-schema.json';
import { createRelay } from './core.mjs';

let handle = null, handleEnv = null;

export default {
  async fetch(request, env) {
    // One relay per isolate keeps the per-minute limits; they are not shared between isolates.
    if (!handle || handleEnv !== env) { handle = createRelay({ env, system, schema }); handleEnv = env; }
    return handle(request, { ip: request.headers.get('cf-connecting-ip') || 'unknown' });
  }
};
