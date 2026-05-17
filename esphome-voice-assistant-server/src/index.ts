import { loadConfig } from './config.js';
import { VoiceAssistantServer } from './server.js';

async function main(): Promise<void> {
  console.log('[Main] Starting ESPHome Voice Assistant Realtime Server...');

  const config = loadConfig();

  if (!config.openai_api_key) {
    console.error('[Main] Fatal: openai_api_key is required');
    process.exit(1);
  }

  console.log(`[Main] Model: ${config.model}, Voice: ${config.voice}`);
  console.log(`[Main] VAD threshold: ${config.vad_threshold}, silence: ${config.vad_silence_duration_ms}ms`);
  console.log(`[Main] HA tools: ${config.enable_ha_tools}, recording: ${config.enable_recording}`);

  const server = new VoiceAssistantServer(config);
  await server.init();
  server.start();

  const shutdown = (): void => {
    console.log('[Main] Shutting down...');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
