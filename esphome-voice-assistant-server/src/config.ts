import fs from 'fs';

export interface Config {
  openai_api_key: string;
  websocket_port: number;
  model: string;
  voice: string;
  vad_threshold: number;
  vad_prefix_padding_ms: number;
  vad_silence_duration_ms: number;
  instructions: string;
  session_reuse_timeout_seconds: number;
  enable_ha_tools: boolean;
  ha_mcp_url: string;
  longlived_token: string;
  enable_recording: boolean;
  idle_timeout_seconds: number;
  output_gain: number;
}

const DEFAULTS: Config = {
  openai_api_key: '',
  websocket_port: 8080,
  model: 'gpt-realtime-mini',
  voice: 'sage',
  vad_threshold: 0.5,
  vad_prefix_padding_ms: 300,
  vad_silence_duration_ms: 500,
  instructions: 'You are a helpful home assistant voice assistant. Be concise in your responses.',
  session_reuse_timeout_seconds: 5,
  enable_ha_tools: false,
  ha_mcp_url: '',
  longlived_token: '',
  enable_recording: false,
  idle_timeout_seconds: 3,
  output_gain: 1.0,
};

export function loadConfig(): Config {
  const optionsPath = '/data/options.json';
  if (fs.existsSync(optionsPath)) {
    const raw = fs.readFileSync(optionsPath, 'utf-8');
    const options = JSON.parse(raw) as Partial<Config>;
    return { ...DEFAULTS, ...options };
  }

  // Fall back to environment variables for local development
  return {
    ...DEFAULTS,
    openai_api_key: process.env.OPENAI_API_KEY ?? DEFAULTS.openai_api_key,
    websocket_port: parseInt(process.env.WEBSOCKET_PORT ?? String(DEFAULTS.websocket_port), 10),
    model: process.env.MODEL ?? DEFAULTS.model,
    voice: process.env.VOICE ?? DEFAULTS.voice,
    vad_threshold: parseFloat(process.env.VAD_THRESHOLD ?? String(DEFAULTS.vad_threshold)),
    vad_prefix_padding_ms: parseInt(process.env.VAD_PREFIX_PADDING_MS ?? String(DEFAULTS.vad_prefix_padding_ms), 10),
    vad_silence_duration_ms: parseInt(process.env.VAD_SILENCE_DURATION_MS ?? String(DEFAULTS.vad_silence_duration_ms), 10),
    instructions: process.env.INSTRUCTIONS ?? DEFAULTS.instructions,
    session_reuse_timeout_seconds: parseInt(process.env.SESSION_REUSE_TIMEOUT_SECONDS ?? String(DEFAULTS.session_reuse_timeout_seconds), 10),
    enable_ha_tools: (process.env.ENABLE_HA_TOOLS ?? 'false') === 'true',
    ha_mcp_url: process.env.HA_MCP_URL ?? DEFAULTS.ha_mcp_url,
    longlived_token: process.env.HA_TOKEN ?? DEFAULTS.longlived_token,
    enable_recording: (process.env.ENABLE_RECORDING ?? 'false') === 'true',
    idle_timeout_seconds: parseInt(process.env.IDLE_TIMEOUT_SECONDS ?? String(DEFAULTS.idle_timeout_seconds), 10),
    output_gain: parseFloat(process.env.OUTPUT_GAIN ?? String(DEFAULTS.output_gain)),
  };
}
