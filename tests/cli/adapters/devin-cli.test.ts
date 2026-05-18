import { describe, expect, it } from 'bun:test';
import { devinCliAdapter } from '../../../src/cli/adapters/devin-cli.js';
import { getPlatformAdapter } from '../../../src/cli/adapters/index.js';

describe('devinCliAdapter.normalizeInput', () => {
  it('normalizes Devin hook payloads with snake_case fields', () => {
    const normalized = devinCliAdapter.normalizeInput({
      hook_event_name: 'PostToolUse',
      session_id: 'devin-session',
      cwd: '/tmp',
      prompt: 'remember this',
      tool_name: 'read',
      tool_input: { file_path: '/tmp/a.ts' },
      tool_response: { ok: true },
      transcript_path: '/tmp/session.jsonl',
      model: 'swe-1',
    });

    expect(normalized).toMatchObject({
      sessionId: 'devin-session',
      cwd: '/tmp',
      platform: 'devin-cli',
      prompt: 'remember this',
      toolName: 'read',
      toolInput: { file_path: '/tmp/a.ts' },
      toolResponse: { ok: true },
      transcriptPath: '/tmp/session.jsonl',
      model: 'swe-1',
    });
  });

  it('falls back to DEVIN_PROJECT_DIR and an unknown session sentinel', () => {
    const previous = process.env.DEVIN_PROJECT_DIR;
    process.env.DEVIN_PROJECT_DIR = '/tmp';
    try {
      const normalized = devinCliAdapter.normalizeInput({
        hook_event_name: 'SessionStart',
      });

      expect(normalized.cwd).toBe('/tmp');
      expect(normalized.sessionId).toBe('unknown');
    } finally {
      if (previous === undefined) {
        delete process.env.DEVIN_PROJECT_DIR;
      } else {
        process.env.DEVIN_PROJECT_DIR = previous;
      }
    }
  });

  it('adds filePaths on PreToolUse for file-reading tools', () => {
    const normalized = devinCliAdapter.normalizeInput({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/tmp',
      tool_name: 'read',
      tool_input: { file_path: '/tmp/example.ts' },
    });

    expect(normalized.toolInput).toMatchObject({
      file_path: '/tmp/example.ts',
      filePaths: ['/tmp/example.ts'],
    });
  });

  it('drops oversized agent fields', () => {
    const normalized = devinCliAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      agent_id: 'a'.repeat(129),
      agent_type: 'builder',
    });

    expect(normalized.agentId).toBeUndefined();
    expect(normalized.agentType).toBe('builder');
  });
});

describe('devinCliAdapter.formatOutput', () => {
  it('emits Devin-compatible hookSpecificOutput context', () => {
    const output = devinCliAdapter.formatOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'memory context',
      },
      systemMessage: 'shown in terminal',
    });

    expect(output).toEqual({
      systemMessage: 'shown in terminal',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'memory context',
      },
    });
  });
});

describe('getPlatformAdapter', () => {
  it('resolves devin aliases', () => {
    expect(getPlatformAdapter('devin')).toBe(devinCliAdapter);
    expect(getPlatformAdapter('devin-cli')).toBe(devinCliAdapter);
  });
});
