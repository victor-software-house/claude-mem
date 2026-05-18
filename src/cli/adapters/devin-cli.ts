import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { extractFilePaths } from './codex-file-context.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

type DevinEventName =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'Stop';

const EVENT_NAMES = new Set<DevinEventName>([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
]);

const MAX_AGENT_FIELD_LEN = 128;

function eventName(value: unknown): DevinEventName | undefined {
  return typeof value === 'string' && EVENT_NAMES.has(value as DevinEventName)
    ? value as DevinEventName
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function pickAgentField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_AGENT_FIELD_LEN
    ? value
    : undefined;
}

function cloneToolInput(toolInput: unknown): unknown {
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    return { ...(toolInput as Record<string, unknown>) };
  }
  return toolInput;
}

function extractDevinFilePaths(toolName: string, toolInput: unknown, cwd: string): string[] {
  const extracted = extractFilePaths(toolName, toolInput, cwd);
  if (extracted.length > 0) return extracted;
  if (!/^(read|Read)$/.test(toolName) || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return [];
  }
  const input = toolInput as Record<string, unknown>;
  const candidates = [input.file_path, input.filePath, input.path];
  return candidates.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function buildBaseOutput(result: HookResult): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (result.continue !== undefined) output.continue = result.continue;
  if (result.suppressOutput !== undefined) output.suppressOutput = result.suppressOutput;
  if (result.systemMessage) output.systemMessage = result.systemMessage;
  if (result.decision === 'block') output.decision = 'block';
  if (result.reason) output.reason = result.reason;
  return output;
}

function inferOutputEvent(result: HookResult): DevinEventName | undefined {
  return eventName(result.hookSpecificOutput?.hookEventName);
}

export const devinCliAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = stringOrUndefined(r.cwd)
      ?? stringOrUndefined(r.project_dir)
      ?? stringOrUndefined(process.env.DEVIN_PROJECT_DIR)
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const hookEventName = eventName(r.hook_event_name);
    const toolName = stringOrUndefined(r.tool_name) ?? stringOrUndefined(r.toolName);
    let toolInput = cloneToolInput(r.tool_input ?? r.toolInput);

    if (hookEventName === 'PreToolUse' && toolName) {
      const filePaths = extractDevinFilePaths(toolName, toolInput, cwd);
      if (filePaths.length > 0 && toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
        toolInput = { ...(toolInput as Record<string, unknown>), filePaths };
      }
    }

    const source = r.source;
    const sessionSource =
      source === 'startup' || source === 'resume' || source === 'clear'
        ? source
        : undefined;

    return {
      sessionId: stringOrUndefined(r.session_id) ?? stringOrUndefined(r.sessionId) ?? stringOrUndefined(r.id) ?? 'unknown',
      cwd,
      platform: 'devin-cli',
      prompt: stringOrUndefined(r.prompt) ?? stringOrUndefined(r.user_prompt) ?? stringOrUndefined(r.message),
      toolName,
      toolInput,
      toolResponse: r.tool_response ?? r.toolResponse,
      transcriptPath: stringOrUndefined(r.transcript_path) ?? stringOrUndefined(r.transcriptPath),
      lastAssistantMessage: stringOrUndefined(r.last_assistant_message) ?? stringOrUndefined(r.lastAssistantMessage),
      turnId: stringOrUndefined(r.turn_id) ?? stringOrUndefined(r.turnId),
      stopHookActive: booleanOrUndefined(r.stop_hook_active) ?? booleanOrUndefined(r.stopHookActive),
      permissionMode: stringOrUndefined(r.permission_mode) ?? stringOrUndefined(r.permissionMode),
      model: stringOrUndefined(r.model),
      sessionSource,
      agentId: pickAgentField(r.agent_id ?? r.agentId),
      agentType: pickAgentField(r.agent_type ?? r.agentType),
    };
  },

  formatOutput(result): unknown {
    const r = result ?? {};
    const output = buildBaseOutput(r);
    const hookSpecific = r.hookSpecificOutput;
    const outputEvent = inferOutputEvent(r);

    if (!hookSpecific || !outputEvent || outputEvent === 'Stop') {
      return output;
    }

    const specific: Record<string, unknown> = {
      hookEventName: outputEvent,
    };

    if (hookSpecific.additionalContext) {
      specific.additionalContext = hookSpecific.additionalContext;
    }

    if (outputEvent === 'PreToolUse') {
      if (hookSpecific.permissionDecision === 'deny') {
        specific.permissionDecision = 'deny';
        if (hookSpecific.permissionDecisionReason) {
          specific.permissionDecisionReason = hookSpecific.permissionDecisionReason;
        }
      }
      if (hookSpecific.updatedInput) {
        specific.updatedInput = hookSpecific.updatedInput;
      }
    }

    output.hookSpecificOutput = specific;
    return output;
  },
};
