# ESPHome Voice Assistant Realtime Server

A Home Assistant addon that bridges ESPHome voice assistant devices to the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime). It accepts raw PCM audio from your ESP32 over WebSocket, streams it to OpenAI for real-time speech-to-speech processing, and returns the synthesized response audio — all with sub-second latency.

Optionally, it exposes your Home Assistant tools (lights, switches, scripts, etc.) to the AI via the HA Model Context Protocol (MCP), so the assistant can control your home.

---

## Requirements

- Home Assistant OS or Supervised installation
- An [OpenAI API key](https://platform.openai.com/api-keys) with access to `gpt-4o-realtime-preview`
- An ESP32 device flashed with the [ESPHome voice assistant component](../components/voice_assistant_websocket/) from this repository

---

## Installation

### 1. Add this repository to Home Assistant

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Click the **⋮** menu (top right) and select **Repositories**
3. Add the URL of this repository and click **Add**
4. Refresh the page — the **ESPHome Voice Assistant Realtime Server** addon will appear in the store
5. Click it and then click **Install**

### 2. Configure the addon

Go to the addon's **Configuration** tab and fill in the options:

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `openai_api_key` | **Yes** | — | Your OpenAI API key |
| `websocket_port` | No | `8080` | Port the server listens on for ESP32 connections |
| `model` | No | `gpt-4o-realtime-preview` | OpenAI Realtime model to use |
| `voice` | No | `sage` | Voice for the AI responses (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`, `sage`) |
| `vad_threshold` | No | `0.5` | Voice activity detection sensitivity (0.0–1.0, lower = more sensitive) |
| `vad_prefix_padding_ms` | No | `300` | Audio kept before detected speech start (ms) |
| `vad_silence_duration_ms` | No | `500` | Silence duration that ends a turn (ms) |
| `instructions` | No | *(see below)* | System prompt for the AI |
| `session_reuse_timeout_seconds` | No | `300` | How long (seconds) to cache conversation context after disconnect. Set to `0` to disable. |
| `enable_ha_tools` | No | `false` | Expose Home Assistant controls to the AI via MCP |
| `ha_mcp_url` | No | — | URL of the HA MCP endpoint (required if `enable_ha_tools` is true) |
| `longlived_token` | No | — | Long-lived access token for MCP authentication |
| `enable_recording` | No | `false` | Save debug WAV recordings of each session to `/data/recordings/` |

Example configuration (YAML mode):

```yaml
openai_api_key: sk-proj-...
websocket_port: 8080
model: gpt-4o-realtime-preview
voice: sage
instructions: >
  You are a helpful home assistant. Answer concisely.
  When controlling devices, confirm what you did in one sentence.
enable_ha_tools: true
ha_mcp_url: http://supervisor/core/api/mcp
longlived_token: eyJ...
session_reuse_timeout_seconds: 300
```

### 3. Enable the port mapping

On the **Info** tab, make sure the port `8080/tcp` is mapped to `8080` on your host (this is the default). Your ESP32 will connect to `ws://<your-ha-ip>:8080`.

### 4. Start the addon

Click **Start** on the **Info** tab. Check the **Log** tab to confirm the server is running:

```
[Main] Starting ESPHome Voice Assistant Realtime Server...
[Main] Model: gpt-4o-realtime-preview, Voice: sage
[Server] Listening on port 8080
```

---

## Configuring the ESP32

Flash your ESP32 with ESPHome using the `voice_assistant_websocket` component. Set the `server_url` to point to this addon:

```yaml
voice_assistant_websocket:
  id: voice_assistant_ws
  server_url: ws://192.168.1.100:8080
  microphone: i2s_mics
  speaker: voice_resampling_speaker
```

Replace `192.168.1.100` with the IP address of your Home Assistant instance. See the [example configuration](../example/voice_pe_config.yaml) for a complete setup targeting the Home Assistant Voice PE hardware.

---

## Home Assistant Tool Integration

When `enable_ha_tools` is enabled, the addon connects to the HA MCP endpoint at startup and loads all available tools (entity controls, scripts, automations). The AI can then act on your home in response to voice commands.

### Getting a long-lived access token

1. In Home Assistant, click your profile (bottom left)
2. Scroll to **Long-Lived Access Tokens** and click **Create Token**
3. Give it a name (e.g. "Voice Assistant") and copy the token
4. Paste it into the `longlived_token` option

### MCP URL

For a standard Home Assistant OS installation, the MCP endpoint is:

```
http://supervisor/core/api/mcp
```

If you are running Home Assistant in a non-supervised setup or behind a reverse proxy, use the full external URL with `/api/mcp` appended.

---

## Tool Call Events (LED / Busy Indication)

When the AI calls a Home Assistant tool (e.g. to control a light or run a script), the server sends JSON events to the ESP32 so you can show a visual indicator.

### Server → ESP32 protocol

All control messages are JSON text frames. Audio is raw binary PCM (24 kHz, 16-bit mono).

| Message | When sent |
|---------|-----------|
| `{"type":"tool_start","name":"<tool_name>"}` | A tool call has begun (before the HA request) |
| `{"type":"tool_done","name":"<tool_name>"}` | The tool call completed |
| `{"type":"interrupt"}` | Server is cancelling the current response |
| `{"type":"disconnect"}` | Server is closing the session |

### ESP32 → Server protocol

| Message | When sent |
|---------|-----------|
| Binary frame | Raw PCM audio (24 kHz, 16-bit mono, resampled from 16 kHz) |
| `{"type":"interrupt"}` | User interrupted the assistant |

### ESPHome automation triggers

Use `on_tool_start` and `on_tool_done` in your ESPHome YAML. `on_tool_start` exposes the tool name as the `tool_name` variable:

```yaml
voice_assistant_websocket:
  id: voice_assistant_ws
  server_url: ws://192.168.1.100:8080
  microphone: i2s_mics
  speaker: voice_resampling_speaker
  on_tool_start:
    - lambda: ESP_LOGI("va", "Tool started: %s", tool_name.c_str());
    - light.turn_on:
        id: status_led
        effect: pulse
  on_tool_done:
    - light.turn_off:
        id: status_led
```

---

## Session Context Caching

When an ESP32 disconnects and reconnects within `session_reuse_timeout_seconds`, the previous conversation transcript is restored. The AI remembers what was said and can continue the conversation naturally without starting over.

Set `session_reuse_timeout_seconds: 0` to always start fresh sessions.

---

## Debug Recording

When `enable_recording: true`, the addon saves stereo-separated WAV files for each session:

```
/data/recordings/<client-ip>_<timestamp>_input.wav   # Audio from the ESP32
/data/recordings/<client-ip>_<timestamp>_output.wav  # Audio from OpenAI
```

These files are accessible from the Home Assistant filesystem. All recordings are 24 kHz, 16-bit mono PCM.

---

## Troubleshooting

**ESP32 connects but no audio is processed**
- Check that the port mapping is correct and port 8080 is not blocked by a firewall
- Verify the `openai_api_key` is valid and has access to the Realtime API

**HA tools are not available**
- Ensure `enable_ha_tools: true` and both `ha_mcp_url` and `longlived_token` are set
- Check the addon log for `Failed to load MCP tools` errors

**High latency or choppy audio**
- Try increasing `vad_silence_duration_ms` to reduce premature turn endings
- Check your local network for packet loss between the ESP32 and HA host

**The AI ends the call unexpectedly**
- The AI can call a built-in `disconnect_client` tool when it determines the conversation is over. Adjust your `instructions` to tell it when disconnecting is appropriate.
