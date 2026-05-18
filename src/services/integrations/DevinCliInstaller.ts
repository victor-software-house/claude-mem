import path from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { findBunPath } from './CursorHooksInstaller.js';

interface DevinHookEntry {
  type: 'command';
  command: string;
  timeout: number;
  statusMessage?: string;
}

interface DevinHookGroup {
  matcher?: string;
  hooks: DevinHookEntry[];
}

interface DevinConfig {
  hooks?: Record<string, DevinHookGroup[]>;
  mcpServers?: Record<string, unknown>;
  plugin_dirs?: string[];
  [key: string]: unknown;
}

const DEVIN_CONFIG_DIR = path.join(homedir(), '.config', 'devin');
const DEVIN_CONFIG_PATH = path.join(DEVIN_CONFIG_DIR, 'config.json');
const DEVIN_PLUGIN_DIR = path.join(DEVIN_CONFIG_DIR, 'plugins', 'claude-mem');
const DEVIN_HOOK_MARKER = 'CLAUDE_MEM_DEVIN_HOOK=1';
const IS_WINDOWS = process.platform === 'win32';

function readDevinConfig(): DevinConfig {
  if (!existsSync(DEVIN_CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(DEVIN_CONFIG_PATH, 'utf-8')) as DevinConfig;
}

function resolveWriteTarget(filepath: string): string {
  try {
    if (lstatSync(filepath).isSymbolicLink()) {
      try {
        return realpathSync(filepath);
      } catch {
        return path.resolve(path.dirname(filepath), readlinkSync(filepath));
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return filepath;
}

function configFileMode(filepath: string): number {
  try {
    return statSync(filepath).mode & 0o777;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return 0o600;
  }
}

function fsyncDirectory(filepath: string): void {
  if (IS_WINDOWS) return;
  let fd: number | undefined;
  try {
    fd = openSync(path.dirname(filepath), 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeDevinConfig(config: DevinConfig): void {
  mkdirSync(DEVIN_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const targetPath = resolveWriteTarget(DEVIN_CONFIG_PATH);
  mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const mode = configFileMode(targetPath);
  const payload = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'wx', mode);
    let written = 0;
    while (written < payload.length) {
      const next = writeSync(fd, payload, written, payload.length - written);
      if (next === 0) throw new Error(`writeSync stalled at ${written}/${payload.length} bytes`);
      written += next;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, targetPath);
    fsyncDirectory(targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { }
    }
    try { unlinkSync(tmpPath); } catch { }
    throw error;
  }
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function windowsShellQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function envAssignment(key: string, value: string): string {
  return `${key}=${posixShellQuote(value)}`;
}

function buildCommand(bunPath: string, workerServicePath: string, args: string[]): string {
  if (IS_WINDOWS) {
    const command = [bunPath, workerServicePath, ...args].map(windowsShellQuote).join(' ');
    return `set "CLAUDE_CONFIG_DIR=${DEVIN_CONFIG_DIR}" && set "PLUGIN_ROOT=${DEVIN_PLUGIN_DIR}" && set "${DEVIN_HOOK_MARKER}" && ${command}`;
  }
  const command = [bunPath, workerServicePath, ...args].map(posixShellQuote).join(' ');
  const env = [
    envAssignment('CLAUDE_CONFIG_DIR', DEVIN_CONFIG_DIR),
    envAssignment('PLUGIN_ROOT', DEVIN_PLUGIN_DIR),
    DEVIN_HOOK_MARKER,
  ].join(' ');
  return `${env} ${command}`;
}

function hook(command: string, timeout: number, statusMessage: string): DevinHookEntry {
  return {
    type: 'command',
    command,
    timeout,
    statusMessage,
  };
}

function isInstallerOwnedHook(entry: DevinHookEntry): boolean {
  const legacyWorkerPath = path.join(DEVIN_PLUGIN_DIR, 'scripts', 'worker-service.cjs');
  return entry.command.includes(DEVIN_HOOK_MARKER)
    || entry.command.includes(legacyWorkerPath);
}

function replaceHookGroups(
  hooks: Record<string, DevinHookGroup[]>,
  eventName: string,
  newGroups: DevinHookGroup[],
): void {
  const existing = hooks[eventName] ?? [];
  hooks[eventName] = [
    ...existing.flatMap((group) => {
      const retainedHooks = group.hooks.filter((entry) => !isInstallerOwnedHook(entry));
      return retainedHooks.length > 0 ? [{ ...group, hooks: retainedHooks }] : [];
    }),
    ...newGroups,
  ];
}

function mergeDevinHooks(config: DevinConfig, bunPath: string, pluginDir = DEVIN_PLUGIN_DIR): void {
  const workerServicePath = path.join(pluginDir, 'scripts', 'worker-service.cjs');
  const hooks = config.hooks ?? {};

  replaceHookGroups(hooks, 'SessionStart', [
    {
      hooks: [
        hook(
          buildCommand(bunPath, workerServicePath, ['start']),
          60,
          'Starting claude-mem worker...',
        ),
        hook(
          buildCommand(bunPath, workerServicePath, ['hook', 'devin-cli', 'context']),
          60,
          'Loading claude-mem context...',
        ),
      ],
    },
  ]);

  replaceHookGroups(hooks, 'UserPromptSubmit', [
    {
      hooks: [
        hook(
          buildCommand(bunPath, workerServicePath, ['hook', 'devin-cli', 'session-init']),
          60,
          'Initializing claude-mem session...',
        ),
      ],
    },
  ]);

  replaceHookGroups(hooks, 'PostToolUse', [
    {
      matcher: '*',
      hooks: [
        hook(
          buildCommand(bunPath, workerServicePath, ['hook', 'devin-cli', 'observation']),
          120,
          'Recording observation to memory...',
        ),
      ],
    },
  ]);

  replaceHookGroups(hooks, 'PreToolUse', [
    {
      matcher: 'read|Read',
      hooks: [
        hook(
          buildCommand(bunPath, workerServicePath, ['hook', 'devin-cli', 'file-context']),
          60,
          'Loading file memory context...',
        ),
      ],
    },
  ]);

  replaceHookGroups(hooks, 'Stop', [
    {
      hooks: [
        hook(
          buildCommand(bunPath, workerServicePath, ['hook', 'devin-cli', 'summarize']),
          120,
          'Summarizing session to memory...',
        ),
      ],
    },
  ]);

  config.hooks = hooks;
}

function mergeDevinMcp(config: DevinConfig): void {
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    'claude-mem': {
      type: 'stdio',
      command: process.execPath,
      args: [
        path.join(DEVIN_PLUGIN_DIR, 'scripts', 'mcp-server.cjs'),
      ],
      env: {
        CLAUDE_CONFIG_DIR: DEVIN_CONFIG_DIR,
        PLUGIN_ROOT: DEVIN_PLUGIN_DIR,
      },
    },
  };
}

function mergePluginDir(config: DevinConfig): void {
  const pluginDirs = config.plugin_dirs ?? [];
  config.plugin_dirs = Array.from(new Set([...pluginDirs, DEVIN_PLUGIN_DIR]));
}

function installPluginDependencies(targetDir: string, bunPath: string): void {
  execFileSync(bunPath, ['install'], {
    cwd: targetDir,
    stdio: 'pipe',
  });
}

export function devinCliPluginDirectory(): string {
  return DEVIN_PLUGIN_DIR;
}

export async function installDevinCliIntegration(sourcePluginDirectory: string, bunPath = findBunPath()): Promise<number> {
  console.log('\nInstalling Claude-Mem for Devin CLI...\n');

  if (!existsSync(sourcePluginDirectory)) {
    console.error(`Plugin source not found: ${sourcePluginDirectory}`);
    return 1;
  }

  const stagingDir = `${DEVIN_PLUGIN_DIR}.tmp-${process.pid}`;
  const backupDir = `${DEVIN_PLUGIN_DIR}.backup-${process.pid}`;
  let replacedExisting = false;

  try {
    mkdirSync(path.dirname(DEVIN_PLUGIN_DIR), { recursive: true });
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
    cpSync(sourcePluginDirectory, stagingDir, { recursive: true, force: true });
    installPluginDependencies(stagingDir, bunPath);

    const config = readDevinConfig();
    mergeDevinMcp(config);
    mergePluginDir(config);
    mergeDevinHooks(config, bunPath);

    if (existsSync(DEVIN_PLUGIN_DIR)) {
      renameSync(DEVIN_PLUGIN_DIR, backupDir);
      replacedExisting = true;
    }
    renameSync(stagingDir, DEVIN_PLUGIN_DIR);
    writeDevinConfig(config);
    rmSync(backupDir, { recursive: true, force: true });

    console.log(`  Plugin files: ${DEVIN_PLUGIN_DIR}`);
    console.log(`  Devin config: ${DEVIN_CONFIG_PATH}`);
    console.log(`  Using Bun runtime: ${bunPath}`);
    console.log(`
Installation complete!

Next steps:
  1. Restart Devin CLI so MCP tools and hooks reload
  2. Run /mcp or ask Devin to search memory
  3. Memory will be captured automatically during sessions
`);
    return 0;
  } catch (error) {
    if (replacedExisting && existsSync(backupDir)) {
      rmSync(DEVIN_PLUGIN_DIR, { recursive: true, force: true });
      renameSync(backupDir, DEVIN_PLUGIN_DIR);
    }
    rmSync(stagingDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}
