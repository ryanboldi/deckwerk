#!/usr/bin/env node
// Uses the same preview/recovery protocol as the editor. No shell commands run on the server.
import { readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); if (i < 0) return undefined; const value = args[i + 1]; if (!value) throw new Error(`Missing value for ${name}`); args.splice(i, 2); return value; }
try {
  const server = flag('--server') || process.env.DECKWERK_SERVER;
  const deck = flag('--deck') || process.env.DECKWERK_DECK;
  const message = flag('-m');
  const choicesFile = flag('--choices');
  const output = flag('--output');
  const [command = 'status', ...rest] = args;
  if (!server || !deck || command === 'help') {
    console.log('Usage: node scripts/presentation-git.mjs --server URL --deck NAME COMMAND\n\nstatus | log | diff REV | commit -m MESSAGE | branch NAME [REV] | tag NAME [REV]\nmerge REV | cherry-pick REV | revert REV | rebase REV | reset REV | restore REV\nstash | stash-pop [STASH] | apply TOKEN [--choices choices.json] | abort TOKEN\npdf [REV] [--output checkpoint.pdf] | checkout [DECK]\n\nChanges are previewed first. Apply the returned token to proceed.\nchoices.json: {"choices":{"slide:ID":"local"},"files":{"assets/file.png":"remote"}}\nRevisions: branch name, commit SHA, tag, recovery name, HEAD, HEAD~N.');
    process.exitCode = command === 'help' ? 0 : 1;
  } else {
    const url = new URL('/api/git', server); url.searchParams.set('deck', deck);
    if (command === 'checkout') { const link = new URL('/', server); link.searchParams.set('deck', rest.join(' ') || deck); console.log(link.href); }
    else if (command === 'pdf') {
      url.pathname += '/pdf'; url.searchParams.set('revision', rest[0] || 'HEAD');
      if (!output) console.log(url.href);
      else { const response = await fetch(url, { headers: { 'x-deckwerk-bridge': '1' } }); if (!response.ok) throw new Error(await response.text()); await writeFile(output, Buffer.from(await response.arrayBuffer())); console.log(output); }
    } else {
      let request;
      if (['status', 'log'].includes(command)) request = { command };
      else if (command === 'commit') request = { command, message: message || rest.join(' ') };
      else if (['branch', 'tag'].includes(command)) request = { command, name: rest[0], revision: rest[1] };
      else if (command === 'diff') request = { command, revision: rest[0] || 'HEAD' };
      else if (command === 'apply') request = { command, ...(choicesFile ? JSON.parse(await readFile(choicesFile, 'utf8')) : {}), token: rest[0] };
      else if (command === 'abort') request = { command, token: rest[0] };
      else if (['merge', 'cherry-pick', 'revert', 'rebase', 'reset', 'restore', 'stash', 'stash-pop'].includes(command)) request = { command: 'preview', action: command, revision: rest.join(' ') || undefined };
      else throw new Error(`Unknown command: ${command}`);
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-deckwerk-bridge': '1' }, body: JSON.stringify(request) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      if (body.preview) { const { input: _input, ...plan } = body.preview.plan; console.log(JSON.stringify({ ...body, preview: { ...body.preview, plan } }, null, 2)); }
      else console.log(JSON.stringify(body, null, 2));
    }
  }
} catch (error) { console.error(error.message || String(error)); process.exitCode = 1; }
