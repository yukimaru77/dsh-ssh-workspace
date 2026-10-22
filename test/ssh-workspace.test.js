import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, quote } from '../ssh.js';
import { apply } from '../index.js';

test('targets follow pi-ssh-remote: [user@]host[:port][:path]', () => {
  assert.deepEqual(parseTarget('devbox'), { user: undefined, host: 'devbox', port: undefined, path: undefined });
  assert.deepEqual(parseTarget('deploy@devbox:2201:/srv/project'), { user: 'deploy', host: 'devbox', port: 2201, path: '/srv/project' });
  assert.deepEqual(parseTarget('macmini:~/work'), { user: undefined, host: 'macmini', port: undefined, path: '~/work' });
  assert.deepEqual(parseTarget('macmini:22'), { user: undefined, host: 'macmini', port: 22, path: undefined });
  assert.throws(() => parseTarget(''));
  assert.throws(() => parseTarget('bad host'));
  assert.equal(quote("it's"), `'it'\\''s'`);
});

function harness() {
  const tools = new Map(), commands = new Map();
  let route;
  const ctx = {
    on: (event, fn) => { if (event === 'tools/execute') route = fn; return () => {}; },
    effect: fn => fn(),
    tools: { register: t => { tools.set(t.name, t); return () => {}; }, get: n => tools.get(n) },
    commands: { register: c => { commands.set(c.name, c); return () => {}; } },
    jobs: {},
    systemPrompt: { context: () => () => {}, getContextOrder: () => 100 },
  };
  process.env.DSH_HOME = process.env.DSH_HOME_TEST ?? '/tmp/dsh-ssh-workspace-test';
  apply(ctx);
  return { tools, commands, route };
}

test('registers the four controls as tools and commands, and leaves local sessions untouched', async () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()], ['ssh_connect', 'ssh_exit', 'ssh_cd', 'ssh_status']);
  assert.deepEqual([...h.commands.keys()], ['ssh-connect', 'ssh-exit', 'ssh-cd', 'ssh-status']);
  let called = false;
  const result = await h.route({ name: 'bash', arguments: {}, agent: { id: 'local-session' } }, async () => { called = true; return 'local'; });
  assert.equal(result, 'local');
  assert.ok(called);
  assert.match((await h.commands.get('ssh-status').handler({ agent: { id: 'local-session' }, rawInput: '' })).text, /Local workspace/);
});
