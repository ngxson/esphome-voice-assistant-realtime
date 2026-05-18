#!/usr/bin/env node
/**
 * Quick sanity-check for the OpenAI Realtime API.
 * Usage: OPENAI_API_KEY=sk-... npm run test:openai
 *
 * Connects, sends a minimal session.update, sends a text prompt,
 * prints every event received, then exits.
 */

import WebSocket from 'ws';

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL   = process.env.MODEL ?? 'gpt-4o-realtime-preview-2024-12-17';

if (!API_KEY) {
  console.error('OPENAI_API_KEY is not set');
  process.exit(1);
}

console.log(`Connecting to OpenAI Realtime API (model: ${MODEL}) ...\n`);

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});

ws.on('open', () => {
  console.log('[open] Connected\n');

  // ── Minimal session.update — add fields one by one to find what's accepted ──
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      // modalities: ['text', 'audio'],      // ← toggle these lines to probe
      instructions: 'Say "hello" and nothing else.',
      // voice: 'sage',
      // input_audio_format: 'pcm16',
      // output_audio_format: 'pcm16',
      // turn_detection: { type: 'server_vad' },
    },
  }));

  // Send a text item to trigger a response
  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hello!' }],
    },
  }));

  ws.send(JSON.stringify({ type: 'response.create' }));
});

ws.on('message', (raw) => {
  const event = JSON.parse(raw.toString());
  const { type, ...rest } = event;

  if (type === 'response.output_audio.delta') {
    process.stdout.write('.');   // don't flood with base64
    return;
  }
  if (type === 'response.output_audio_transcript.delta' || type === 'response.text.delta') {
    process.stdout.write(rest.delta ?? '');
    return;
  }

  console.log(`\n[${type}]`, JSON.stringify(rest, null, 2));

  if (type === 'response.done') {
    console.log('\n\nDone — closing.');
    ws.close();
  }
});

ws.on('close', (code, reason) => {
  console.log(`\n[close] code=${code} reason=${reason}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[error]', err.message);
  process.exit(1);
});

// Safety exit after 30s
setTimeout(() => { console.log('\n[timeout]'); ws.close(); }, 30_000);
