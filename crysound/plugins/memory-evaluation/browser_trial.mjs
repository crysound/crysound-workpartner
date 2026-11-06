/** Small driver for the explicitly configured persistent CDP browser, scoped to an owned tab. */
const [action, argument] = process.argv.slice(2);
const base = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222';
if (!process.env.CDP_TAB) throw new Error('Set CDP_TAB to the tab created for this trial.');
const page = (await (await fetch(base + '/json/list')).json()).find(p => p.id === process.env.CDP_TAB);
if (!page) throw new Error('Trial tab is unavailable; restore the configured browser connection.');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const number = ++id;
  pending.set(number, { resolve, reject });
  socket.send(JSON.stringify({ id: number, method, params }));
});
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  }
  if (message.method === 'Page.javascriptDialogOpening' && action === 'accept-delete') {
    // Only the candidate's explicit deletion confirmation is accepted in this action.
    void send('Page.handleJavaScriptDialog', { accept: message.params.type === 'confirm' && message.params.message.startsWith('Delete "') });
  }
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
};
const timeout = setTimeout(() => { socket.close(); process.exitCode = 1; }, 20000);
try {
  await send('Page.enable');
  if (action === 'send') {
    if (!argument) throw new Error('Supply the synthetic trial message.');
    await evaluate(`(() => {
      const editor = document.querySelector('[role="textbox"]');
      editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, ${JSON.stringify(argument)})) throw new Error('Cannot type trial message');
    })()`);
    const sent = await evaluate(`(async () => {
      for (let i=0; i<50; i++) {
        const button = document.querySelector('button[aria-label="Send message"]');
        if (document.querySelector('[role="textbox"]').innerText === ${JSON.stringify(argument)} && button && !button.disabled) { button.click(); return true; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`);
    if (!sent) throw new Error('Message was not sent; inspect the trial page.');
    console.log('Trial message submitted.');
  } else if (action === 'new') {
    await evaluate(`document.querySelector('button[aria-label="New session"]').click()`);
    const ready = await evaluate(`(async () => {
      for (let i=0; i<50; i++) {
        if (document.querySelector('[role="textbox"]')?.innerText === '' && !document.querySelector('button[aria-label="Stop"]')) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`);
    if (!ready) throw new Error('New session is not ready.');
    console.log('New session ready.');
  } else if (action === 'accept-delete') {
    await evaluate(`document.querySelector('button[title="Delete this memory"]').click()`);
    console.log('Candidate deletion confirmation accepted.');
  } else if (action === 'click') {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.innerText === ${JSON.stringify(argument)} || b.getAttribute('aria-label') === ${JSON.stringify(argument)});
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`);
    if (!clicked) throw new Error('Expected trial control is unavailable.');
    console.log('Trial control clicked.');
  } else if (action === 'snapshot') {
    console.log(await evaluate('document.body.innerText'));
  } else throw new Error('Use send, new, click, accept-delete or snapshot.');
} finally {
  clearTimeout(timeout);
  socket.close();
}
