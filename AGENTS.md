# AGENTS.md — Project Knowledge for AI Agents

This document captures architectural decisions, protocol specs, known constraints, and coding patterns for this project. Read before making changes.

---

## Project Overview

A Home Assistant addon (`esphome-voice-assistant-server/`) that bridges ESP32 devices running ESPHome to the OpenAI Realtime API. The ESP32 sends raw PCM audio over WebSocket; the server streams it to OpenAI and returns synthesized speech audio. Optionally integrates with Home Assistant via MCP for tool calling.

---

## Repository Layout

```
esphome-voice-assistant-server/   Node.js/TypeScript server (HA addon)
  src/
    index.ts          Entry point
    config.ts         Config loading (options.json or env vars)
    server.ts         WebSocket server, per-client session orchestration
    openai-client.ts  OpenAI Realtime API WebSocket client
    session-manager.ts  Conversation context cache between sessions
    mcp-client.ts     Home Assistant MCP HTTP client
    audio-recorder.ts  Optional WAV debug recording
  config.yaml         HA addon manifest + options schema
  dev.sh              Build Docker image and run locally (reads ../.env)

components/voice_assistant_websocket/   ESPHome C++ component
  voice_assistant_websocket.h
  voice_assistant_websocket.cpp
  __init__.py         ESPHome codegen / automation registration
```

---

## Server ↔ ESP32 WebSocket Protocol

### Server → ESP32
| Frame | Content |
|-------|---------|
| Binary | Raw PCM audio, 24 kHz, 16-bit, mono |
| Text JSON | `{"type":"tool_start","name":"<tool_name>"}` — tool call began |
| Text JSON | `{"type":"tool_done","name":"<tool_name>"}` — tool call finished |
| Text JSON | `{"type":"interrupt"}` — cancel current response |
| Text JSON | `{"type":"disconnect"}` — session ending |

### ESP32 → Server
| Frame | Content |
|-------|---------|
| Binary | Raw PCM audio, 24 kHz, 16-bit, mono (resampled from 16 kHz mic) |
| Text JSON | `{"type":"interrupt"}` — user interrupted assistant |

---

## OpenAI Realtime API

- Endpoint: `wss://api.openai.com/v1/realtime?model=<model>`
- Auth: `Authorization: Bearer <key>` header
- VAD: `semantic_vad` with `eagerness: low` (do NOT use `server_vad` — it has different params)
- `prefix_padding_ms` is NOT a valid param for `semantic_vad` — omit it
- Audio format: 24 kHz, 16-bit, mono PCM, base64-encoded in `input_audio_buffer.append`
- Output audio rate: 48000 bytes/sec (24 kHz × 2 bytes)

### Key events handled
| Event | Action |
|-------|--------|
| `session.created` / `session.updated` | Session ready — restore context, start idle timer |
| `input_audio_buffer.speech_started` | User is speaking — cancel idle + playback timers |
| `response.output_audio.delta` | Stream audio to ESP32, clear idle timer |
| `response.output_audio.done` | Schedule idle timer restart after estimated playback |
| `response.output_audio_transcript.done` | Log assistant transcript |
| `conversation.item.input_audio_transcription.completed` | Log user transcript |
| `response.output_item.added` | Capture function call name (before args stream) |
| `response.function_call_arguments.done` | Execute tool |

---

## Idle Timer Logic

The idle timer disconnects a session after `idle_timeout_seconds` of silence. **This is the most fragile part of the code** — several iterations were needed to get it right.

### Rules
1. **Start** the timer when the session is ready (`session.created`/`session.updated`)
2. **Clear both `idleTimer` and `playbackTimer`** on `input_audio_buffer.speech_started` — the user is actively speaking; nothing should disconnect mid-utterance
3. **Clear `idleTimer`** (do not reset) on each `response.output_audio.delta` — pauses idle while assistant is streaming
4. **Schedule restart** via `playbackTimer` on `response.output_audio.done`: delay = `(responseAudioBytes / 48000 * 1000) + 200ms`, then call `resetIdleTimer()`. Skip entirely if `playbackMs === 0` (init-time no-audio responses)

### Why two timers
- `idleTimer`: the actual disconnect countdown
- `playbackTimer`: deferred restart of `idleTimer` after audio finishes playing on the device

If only one timer is used, `audio.delta` events (arriving faster than real-time) restart the idle countdown from when bytes were *sent*, not when they finish *playing* on the ESP32 ring buffer.

### Critical bugs to avoid
- Do NOT call `resetIdleTimer()` inside `response.output_audio.delta` — for responses longer than `idle_timeout_seconds`, the last-chunk timer fires before `audio.done`'s setTimeout can reset it → premature disconnect
- Do NOT start idle timer when `playbackMs === 0` — OpenAI fires `response.output_audio.done` at init (zero-byte response to context injection), which would start the countdown before the user speaks
- Do NOT only clear `idleTimer` on `speech_started` — also cancel `playbackTimer`, which may still be pending and will restart `idleTimer` while user is mid-sentence

---

## Context Restore

On session ready, `restoreContext()` injects in order:
1. MCP system prompt (`role: system`, `type: input_text`)
2. Live home state snapshot (`role: system`, `type: input_text`)
3. Previous conversation turns

**Content type mapping** (wrong type = OpenAI error):
- User messages: `type: "input_text"`
- Assistant messages: `type: "output_text"` ← NOT `"text"`, that causes an error

---

## Half-Duplex Echo Prevention

`ENABLE_DUPLEX = false` at the top of `openai-client.ts`. When false, `sendAudio()` drops all mic input while `isSpeaking === true`. `isSpeaking` is set on first `audio.delta` and cleared after estimated playback drain time.

---

## Drain Timer (Disconnect After Speech)

When `disconnect_client` tool is called by the AI, the server must not close the WebSocket immediately — the ESP32 ring buffer still has audio to play.

`scheduleDrain()` calculates `delayMs = (drainAudioBytes / 48000 * 1000) + 500ms` and calls `onDisconnect()` after that delay. `drainAudioBytes` accumulates during `audio.delta` events after `pendingDisconnect = true`.

---

## HA MCP Client

- HTTP JSON-RPC POST to `ha_mcp_url`
- Response may be `application/json` or `text/event-stream` (SSE) — both are handled
- Tool names: HA tools may have multiple comma-separated aliases; **always use the first name** (before the first comma) when calling tools. This is injected as a system instruction via the MCP prompt.
- `GetLiveContext` accepts a `domain` filter, not a `name` filter
- MCP data (tools + prompt) is refreshed every 5 minutes silently after startup

---

## ESPHome Component

- Uses `esp_websocket_client` from `esp-protocols` (ref: `websocket-v1.6.0`)
- Audio ring buffer: 512 KB in PSRAM (falls back to internal heap)
- Input: 16 kHz mic → linear interpolation resample → 24 kHz → binary WebSocket frame
- Output: binary WebSocket frame → ring buffer → speaker (drained in `loop()`)
- `is_bot_speaking()`: true if ring buffer non-empty OR within 500ms of last audio write
- `interrupt()`: sends `{"type":"interrupt"}` text frame, clears ring buffer, ignores incoming audio for 500ms

### Automation triggers
| Trigger | Args | Fired when |
|---------|------|-----------|
| `on_connected` | — | WebSocket connected |
| `on_disconnected` | — | WebSocket disconnected |
| `on_error` | — | WebSocket error |
| `on_stopped` | — | Session fully stopped |
| `on_tool_start` | `tool_name: std::string` | Server started a tool call |
| `on_tool_done` | — | Server finished a tool call |

### Conditions / Actions
- `voice_assistant_websocket.start` / `.stop` / `.interrupt`
- `voice_assistant_websocket.is_running` / `.is_connected` / `.is_bot_speaking`

---

## Config

All options live in `config.yaml` (HA addon schema) and `src/config.ts` (defaults + env fallbacks). When adding a new option, update both files and `dev.sh`.

| Key | Default | Notes |
|-----|---------|-------|
| `idle_timeout_seconds` | 3 | Seconds of silence before session closes |
| `session_reuse_timeout_seconds` | 5 | Context cache TTL after disconnect |
| `output_gain` | 1.0 | PCM gain multiplier applied to assistant audio |
| `enable_ha_tools` | false | Load HA MCP tools and prompt |

---

## Paired-Device Architecture (mic-only + speaker-only)

A single `voice_assistant_websocket` component can operate in three roles determined by which hardware is wired up and which UID fields are set:

| Role | `microphone` | `speaker` | `device_uid` | `peer_uid` |
|------|-------------|-----------|-------------|-----------|
| full (default) | set | set | optional | — |
| mic-only | set | — | set | set → paired speaker's UID |
| speaker-only | — | set | set | — (omit) |

### Config keys (ESPHome YAML)
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `device_uid` | uint32 (hex ok) | 0 | Unique ID for this device |
| `peer_uid` | uint32 (hex ok) | 0 | Mic-only: UID of the paired speaker |
| `udp_wake_port` | uint16 | 55300 | UDP port for wake packets |

`device_uid` and `peer_uid` are **plain 32-bit integers**. YAML hex literals (`0xA0000001`) are valid and preferred for readability.

### UDP wake protocol
- Packet: 12 bytes — magic `VAWK` (4 B) + source UID (4 B, big-endian) + target UID (4 B, big-endian)
- Mic device broadcasts to `255.255.255.255:udp_wake_port` at the start of every `start()` call
- Speaker device runs a permanent FreeRTOS task (`udp_wake`, 2 KB stack) that listens on `udp_wake_port` and sets `pending_start_ = true` when a packet arrives with `target_uid == device_uid_`
- Ring buffer is **not allocated** on mic-only devices (saves 512 KB — critical on WROOM-32 with no PSRAM)

### Server pairing (server.ts)
Devices identify themselves via URL query params on connect:
- Mic: `ws://server/?uid=<device_uid>&peer_uid=<peer_uid>&role=mic`
- Speaker: `ws://server/?uid=<device_uid>&role=speaker`

The server maintains two maps:
- `pairedSpeakers: Map<uid, WebSocket>` — speaker clients parked waiting for their mic
- `pendingSpeakerCallbacks: Map<uid, callback>` — mic sessions waiting for their speaker

When both sides are matched, OpenAI audio is routed to the speaker WS only (not back to mic). When the mic session ends, the server sends `{"type":"disconnect"}` to the speaker WS and closes it after 1 s. Unmatched speaker connections are closed after 30 s.

### Example configs
- `example/micro-only.yaml` — ESP32-WROOM-32 + INMP441 I2S mic, mic-only role
- `example/voice_pe_config.yaml` — ESP32-S3 Voice PE, full role (add `device_uid` to make it speaker-only)

### Hardware notes
- **ESP32-WROOM-32**: plain ESP32, no PSRAM. Fine for mic-only (no ring buffer needed). `micro_wake_word` supported. Use `i2s_mode: primary`.
- **ESP32-CAM (AI-Thinker "ESP32-S")**: same chip as WROOM-32, has PSRAM but limited free GPIOs (camera pins). Needs FTDI to flash.
- **ESP32-C3**: `micro_wake_word` not officially supported in ESPHome (WakeNet9s exists in ESP-SR but ESPHome component targets S3/ESP32). Use button trigger as fallback.

---

## Local Development

```bash
cd esphome-voice-assistant-server
./dev.sh   # builds Docker image, runs with env vars from ../.env
```

`DEBUG=true` is set by `dev.sh` — enables `[DEBUG]` log lines for timer events in `openai-client.ts`.

Env vars needed in `../.env`: `OPENAI_API_KEY`, and optionally `HA_TOKEN`, `HA_MCP_URL`, `ENABLE_HA_TOOLS`.
