import { createAssistantMessageEventStream, openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createStreamCodeArts } from './stream.mjs';
import { registerCodeArts } from './extension.mjs';
export { resolveAuth, signedTransport } from './transport.mjs';

const api = openAICompletionsApi();
export const streamCodeArts = createStreamCodeArts({
  createEventStream: createAssistantMessageEventStream,
  streamSimple: (model, context, options) => api.streamSimple(model, context, options),
});
export default async function (pi: ExtensionAPI, options: { agentDir?: string; configFile?: string } = {}) {
  return registerCodeArts(pi, { ...options, agentDir: options.agentDir || getAgentDir(), streamCodeArts });
}
