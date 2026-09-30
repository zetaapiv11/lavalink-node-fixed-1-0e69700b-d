import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const url = 'postgresql://fixture:literal$dollar%23secret@db.example.invalid/resonance';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'resonance-installer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'deploy/vps'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  copyFileSync(new URL('install-vps.sh', root), join(dir, 'install-vps.sh'));
  const bin = (name, content) => writeFileSync(join(dir, 'bin', name), '#!/bin/bash\n' + content, { mode: 0o700 });
  bin('docker', `printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *' run '* && "\${FAIL_DB:-}" == 1 ]]; then exit 1; fi
exit 0\n`);
  bin('curl', '[[ "${FAIL_TLS:-}" != 1 ]]\n');
  bin('sleep', 'exit 0\n');
  const log = join(dir, 'commands');
  const run = (input = `audio.example.com\noperator@example.com\n${url}\n`, args = [], env = {}) => spawnSync('bash', ['install-vps.sh', ...args], {
    cwd: dir, input, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, COMMAND_LOG: log, ...env },
  });
  return { dir, run, config: join(dir, 'deploy/vps/.env'), log, output: r => r.stdout + r.stderr };
}
test('first install creates private unique secrets, preserves URI literally, and checks database before startup', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, f.output(result));
  const config = readFileSync(f.config, 'utf8');
  assert.equal(statSync(f.config).mode & 0o777, 0o600);
  assert.ok(config.includes(`DATABASE_URL='${url}'`));
  const password = config.match(/^LAVALINK_SERVER_PASSWORD=([a-f0-9]{64})$/m)?.[1];
  const monitor = config.match(/^MONITOR_TOKEN=([a-f0-9]{64})$/m)?.[1];
  assert.ok(password); assert.ok(monitor); assert.notEqual(password, monitor);
  for (const secret of [url, password, monitor]) assert.ok(!f.output(result).includes(secret));
  const commands = readFileSync(f.log, 'utf8');
  assert.ok(commands.indexOf(' run ') < commands.indexOf(' up '));
  assert.match(f.output(result), /merespons melalui HTTPS/);
  assert.match(f.output(result), /belum membuktikan audio/);
});
test('rerun reuses configuration without prompts or rotation', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const before = readFileSync(f.config, 'utf8');
  const result = f.run('');
  assert.equal(result.status, 0, f.output(result));
  assert.equal(readFileSync(f.config, 'utf8'), before);
  assert.doesNotMatch(f.output(result), /External Database URL Render \(input/);
});
test('invalid domain and database URL reprompt, configure-only never starts containers', t => {
  const f = fixture(t);
  const result = f.run(`https://bad.example/path\n-bad.example\naudio.example.com\nbad\noperator@example.com\nnot-a-url\npostgresql://a:'bad'@host/db\n${url}\n`, ['--configure-only']);
  assert.equal(result.status, 0, f.output(result));
  assert.match(f.output(result), /Format email tidak valid/);
  assert.match(readFileSync(f.config, 'utf8'), /^VPS_DOMAIN=audio.example.com/m);
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), / build | run | up /);
});
test('EOF leaves no partial config or containers', t => {
  const f = fixture(t); const result = f.run('audio.example.com\n');
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.config), false);
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), / build | run | up /);
});
test('existing env is never executed as shell code', t => {
  const f = fixture(t);
  writeFileSync(f.config, 'VPS_DOMAIN=audio.example.com\nMALICIOUS=$(touch pwned)\n');
  assert.equal(f.run('', ['--configure-only']).status, 0);
  assert.equal(existsSync(join(f.dir, 'pwned')), false);
});
test('config symlink is rejected without modifying target', t => {
  const f = fixture(t); const target = join(f.dir, 'keep');
  writeFileSync(target, 'do not change'); symlinkSync(target, f.config);
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'do not change');
});
test('database failure prevents startup and does not print secrets', t => {
  const f = fixture(t); const result = f.run(undefined, [], { FAIL_DB: '1' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), / up /);
  assert.ok(!f.output(result).includes(url));
});
test('failed public TLS never reports successful installation', t => {
  const f = fixture(t); const result = f.run(undefined, [], { FAIL_TLS: '1' });
  assert.notEqual(result.status, 0);
  assert.match(f.output(result), /HTTPS publik belum siap/);
  assert.doesNotMatch(f.output(result), /merespons melalui HTTPS/);
});
test('empty configuration is preserved and fails clearly', t => {
  const f = fixture(t); writeFileSync(f.config, '');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.config, 'utf8'), '');
});
test('real Docker Compose preserves generated database URI and keeps secrets out of Caddy', t => {
  const f = fixture(t);
  assert.equal(f.run(undefined, ['--configure-only']).status, 0);
  copyFileSync(new URL('deploy/vps/compose.yaml', root), join(f.dir, 'deploy/vps/compose.yaml'));
  const result = spawnSync('docker', ['compose', '--env-file', f.config, '-f', join(f.dir, 'deploy/vps/compose.yaml'), 'config', '--format', 'json'], {
    cwd: f.dir, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  // Canonical Compose output doubles dollars so it can be safely loaded again.
  assert.equal(config.services.audio.environment.DATABASE_URL, url.replaceAll('$', () => '$$'));
  assert.equal(config.services.audio.environment.DATABASE_SSL, 'true');
  assert.equal(config.services.caddy.environment.VPS_DOMAIN, 'audio.example.com');
  for (const key of ['DATABASE_URL', 'MONITOR_TOKEN', 'LAVALINK_SERVER_PASSWORD']) {
    assert.equal(config.services.caddy.environment[key], undefined);
  }
});
test('actual database preflight fails cleanly on invalid credentials without exposing input', () => {
  const script = readFileSync(new URL('install-vps.sh', root), 'utf8');
  const code = script.split("--input-type=module -e '\n")[1].split("\n' || fail")[0];
  const secret = 'invalid-private-database-credential';
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, DATABASE_URL: secret, DATABASE_SSL: 'true' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Database belum siap/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
  assert.doesNotMatch(result.stderr, /at new URL/);
});
