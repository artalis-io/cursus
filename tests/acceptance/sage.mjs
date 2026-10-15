// Test-only deterministic OpenAI-compatible protocol fixture. Not an LLM.
import { createServer } from 'node:http';
let mode = 'ok';
createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'acceptance-model' }] })); return; }
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}');
  if (req.url === '/control' && req.method === 'POST') { mode = body.mode; res.end('{}'); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end('{}'); return; }
  if (mode === 'error') { res.writeHead(503).end('{}'); return; }
  if (mode === 'empty') { res.end(JSON.stringify({ choices: [] })); return; }
  const [system, facts] = body.messages ?? [];
  if (body.model !== 'acceptance-model' || !system?.content || !facts?.content) { res.writeHead(400).end('{}'); return; }
  const comparison = facts.content.startsWith('Compare');
  const hu = system.content.includes('Hungarian');
  // Return supplied facts so browser tests can verify actual plan grounding.
  const text = `${hu ? 'Tervadatok' : comparison ? 'Comparison facts' : 'Plan facts'}: ${facts.content}`;
  const send = () => res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  if (mode === 'delayed') setTimeout(send, 1000);
  else send();
}).listen(8084, '0.0.0.0');
