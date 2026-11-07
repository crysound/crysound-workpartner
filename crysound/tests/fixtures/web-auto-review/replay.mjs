// Only the model transport is replaced; permission, review, approval, and tools remain shipped plugins.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/package.json');
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
export const name = 'web-auto-review-replay';
export const inject = ['llm'];
function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
export function apply(ctx) {
  const input = fs.readFileSync(process.env.AUTO_REVIEW_REPLAY, 'utf8');
  const fixture = {
    responses: input.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'assistant/message').map(e => e.data.message.content),
    reviews: JSON.parse(fs.readFileSync(process.env.AUTO_REVIEW_VERDICTS)),
  };
  let main = 0, review = 0;
  class Replay extends LlmAdapter {
    async listModels() { return [{ id: 'recorded', name: 'Recorded' }]; }
    async *stream(options) {
      if (options.purpose === 'auto-review') {
        const verdict = fixture.reviews[review++];
        if (!verdict) throw new Error('Unexpected reviewer request');
        fs.appendFileSync(process.env.AUTO_REVIEW_OBSERVED, JSON.stringify({ review, verdict, messages: options.messages }) + '\n');
        yield* textChunks(JSON.stringify(verdict));
        return;
      }
      const blocks = fixture.responses[main++];
      if (!blocks) throw new Error('Unexpected main-model request');
      for (const block of blocks) {
        if (block.type === 'text') { yield* [...textChunks(block.text)].slice(0, -1); continue; }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
      }
      yield { type: 'finish', reason: { kind: blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['recorded'], new Replay());
}
