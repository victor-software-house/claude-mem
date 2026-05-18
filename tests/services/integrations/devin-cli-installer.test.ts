import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

function createFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const plugin = join(root, 'plugin');
  const fakeBun = join(root, 'fake-bun');

  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  writeFileSync(join(plugin, 'scripts', 'worker-service.cjs'), '');
  writeFileSync(fakeBun, `#!/bin/sh\nif [ -n "$RECORD_PATH" ]; then printf '%s\\n' "$CLAUDE_CONFIG_DIR" "$PLUGIN_ROOT" "$@" > "$RECORD_PATH"; fi\n`);
  chmodSync(fakeBun, 0o755);

  return { root, home, plugin, fakeBun };
}

function runInstall(home: string, plugin: string, fakeBun: string, env: NodeJS.ProcessEnv = {}) {
  const installerUrl = pathToFileURL(join(__dirname, '..', '..', '..', 'src', 'services', 'integrations', 'DevinCliInstaller.ts')).href;
  const runner = [
    `import { installDevinCliIntegration } from ${JSON.stringify(installerUrl)};`,
    `process.exit(await installDevinCliIntegration(process.env.SOURCE_PLUGIN, process.env.FAKE_BUN));`,
  ].join('\n');

  execFileSync(process.execPath, ['-e', runner], {
    env: {
      ...process.env,
      ...env,
      HOME: home,
      SOURCE_PLUGIN: plugin,
      FAKE_BUN: fakeBun,
    },
  });
}

describe('installDevinCliIntegration', () => {
  it('single-quotes persisted POSIX hook commands', async () => {
    const fixture = createFixture('claude-mem-devin-quote-test-');
    const root = fixture.root;
    const home = join(root, 'home.$(touch pwned).x');
    const { plugin, fakeBun } = fixture;
    const recordPath = join(root, 'record.txt');
    const markerPath = join(root, 'pwned');
    const previousHome = process.env.HOME;
    const previousRecordPath = process.env.RECORD_PATH;

    process.env.RECORD_PATH = recordPath;
    try {
      runInstall(home, plugin, fakeBun, { RECORD_PATH: '' });

      const configPath = join(home, '.config', 'devin', 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const command = config.hooks.SessionStart[0].hooks[0].command;

      execFileSync('/bin/sh', ['-c', command], {
        cwd: root,
        env: { ...process.env, RECORD_PATH: recordPath },
      });

      const record = readFileSync(recordPath, 'utf-8');
      expect(existsSync(markerPath)).toBe(false);
      expect(record).toContain(join(home, '.config', 'devin'));
      expect(record).toContain(join(home, '.config', 'devin', 'plugins', 'claude-mem'));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousRecordPath === undefined) {
        delete process.env.RECORD_PATH;
      } else {
        process.env.RECORD_PATH = previousRecordPath;
      }
    }
  });

  it('preserves existing Devin config file permissions', () => {
    const { home, plugin, fakeBun } = createFixture('claude-mem-devin-mode-test-');
    const configDir = join(home, '.config', 'devin');
    const configPath = join(configDir, 'config.json');

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({
      mcpServers: {
        existing: {
          type: 'stdio',
          command: 'node',
          env: { SECRET_TOKEN: 'keep-private' },
        },
      },
    }, null, 2)}\n`);
    chmodSync(configPath, 0o600);

    runInstall(home, plugin, fakeBun, { RECORD_PATH: '' });

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(config.mcpServers.existing.env.SECRET_TOKEN).toBe('keep-private');
    expect(config.mcpServers['claude-mem']).toBeDefined();
  });

  it('preserves unrelated hooks while replacing installer-owned hooks', () => {
    const { home, plugin, fakeBun } = createFixture('claude-mem-devin-hook-test-');
    const configDir = join(home, '.config', 'devin');
    const configPath = join(configDir, 'config.json');
    const workerPath = join(home, '.config', 'devin', 'plugins', 'claude-mem', 'scripts', 'worker-service.cjs');

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: 'echo keep claude-mem audit hook', timeout: 5 },
              { type: 'command', command: `'bun' '${workerPath}' 'hook' 'devin-cli' 'observation'`, timeout: 120 },
            ],
          },
        ],
      },
    }, null, 2)}\n`);

    runInstall(home, plugin, fakeBun, { RECORD_PATH: '' });

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const commands = config.hooks.PostToolUse.flatMap((group: { hooks: { command: string }[] }) =>
      group.hooks.map((hook) => hook.command)
    );

    expect(commands).toContain('echo keep claude-mem audit hook');
    expect(commands.some((command: string) =>
      command.includes(workerPath) && !command.includes('CLAUDE_MEM_DEVIN_HOOK=1')
    )).toBe(false);
    expect(commands.some((command: string) =>
      command.includes(workerPath) && command.includes('CLAUDE_MEM_DEVIN_HOOK=1')
    )).toBe(true);
  });
});
