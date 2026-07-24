/**
 * Qoder SDK Integration
 *
 * Provides SDK-based integration with Qoder CLI using @qoder-ai/qoder-agent-sdk.
 * Mirrors the interface of claude-sdk.js for the WebSocket chat dispatch layer.
 */

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

import { query, qodercliAuth, accessTokenFromEnv } from '@qoder-ai/qoder-agent-sdk';

import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import { QODER_FALLBACK_MODELS } from './modules/providers/list/qoder/qoder-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
const abortedSessionIds = new Set();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.QODER_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveQoderToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

function getQoderPendingApprovalsForSession(sessionId) {
  const approvals = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      approvals.push({
        requestId,
        toolName: resolver._toolName,
        input: resolver._input,
        receivedAt: resolver._receivedAt,
      });
    }
  }
  return approvals;
}

function resolveQoderAuth() {
  if (process.env.QODER_ACCESS_TOKEN?.trim()) {
    return accessTokenFromEnv('QODER_ACCESS_TOKEN');
  }
  return qodercliAuth();
}

function getQoderHome() {
  return process.env.QODER_CONFIG_DIR?.trim() || path.join(os.homedir(), '.qoder');
}

async function loadQoderMcpConfig(cwd) {
  try {
    const settingsPath = path.join(getQoderHome(), 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf8');
    const settings = JSON.parse(content);
    const servers = settings?.mcpServers;
    if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) {
      return null;
    }
    return servers;
  } catch {
    return null;
  }
}

function mapOptionsToQoderSDK(options = {}) {
  const { sessionId, cwd, permissionMode, model, effort } = options;

  const sdkOptions = {
    auth: resolveQoderAuth(),
    env: { ...process.env },
  };

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (model && model !== 'auto') {
    sdkOptions.model = model;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  sdkOptions.includePartialMessages = true;

  return sdkOptions;
}

function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer,
  });
}

function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const usage = sdkMessage.message?.usage || sdkMessage.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readNumber(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = readNumber(usage.output_tokens ?? usage.outputTokens);
  const cacheReadTokens = readNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheCreationTokens = readNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const totalUsed = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

async function buildPromptPayload(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const content = await buildClaudeUserContent(command, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
    };
  })();
}

/**
 * Main query function dispatched by the WebSocket chat handler.
 * @param {string} command - User prompt
 * @param {Object} options - Query options (sessionId, cwd, model, permissionMode, etc.)
 * @param {Object} ws - WebSocket writer
 */
async function queryQoderSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event,
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'qoder',
      sessionId,
      options.model,
    );

    const sdkOptions = mapOptionsToQoderSDK({
      ...options,
      model: resolvedModel || options.model,
    });

    const mcpServers = await loadQoderMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    sdkOptions.canUseTool = async (toolName, input, context) => {
      if (sdkOptions.permissionMode === 'bypassPermissions'
        || sdkOptions.permissionMode === 'auto'
        || !sdkOptions.permissionMode
        || sdkOptions.permissionMode === 'default') {
        return { behavior: 'allow', updatedInput: input };
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName,
        input,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'qoder',
      }));
      emitNotification(createNotificationEvent({
        provider: 'qoder',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `qoder:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`,
      }));

      const decision = await waitForToolApproval(requestId, {
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({
            kind: 'permission_cancelled',
            requestId,
            reason,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'qoder',
          }));
        },
      });

      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }
      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }
      if (decision.allow) {
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }
      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    const promptPayload = await buildPromptPayload(command, options.images, options.cwd);

    const queryInstance = query({
      prompt: promptPayload,
      options: sdkOptions,
    });

    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, ws);
    }

    let thinkingBuffer = '';
    let isThinking = false;

    for await (const message of queryInstance) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id && !capturedSessionId) {
        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, ws);

        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: capturedSessionId,
            sessionId: capturedSessionId,
            provider: 'qoder',
          }));
        }
      }

      const sid = capturedSessionId || sessionId || null;

      // Accumulate thinking deltas into a single block
      if (message.type === 'stream_event' && message.event?.delta?.type === 'thinking_delta') {
        thinkingBuffer += message.event.delta.thinking || '';
        isThinking = true;
        continue;
      }

      // Flush accumulated thinking when a non-thinking event arrives
      if (isThinking && thinkingBuffer) {
        ws.send(createNormalizedMessage({
          kind: 'thinking',
          content: thinkingBuffer,
          sessionId: sid,
          provider: 'qoder',
        }));
        thinkingBuffer = '';
        isThinking = false;
      }

      const normalized = sessionsService.normalizeMessage('qoder', message, sid);
      for (const msg of normalized) {
        ws.send(msg);
      }

      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget: tokenBudgetData,
          sessionId: sid,
          provider: 'qoder',
        }));
      }
    }

    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'qoder', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'qoder',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed',
    });

  } catch (error) {
    console.error('Qoder SDK query error:', error);

    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (wasAborted) {
      return;
    }

    const installed = await providerAuthService.isProviderInstalled('qoder');
    const errorContent = !installed
      ? 'Qoder CLI is not installed. Please install it first: https://docs.qoder.com'
      : error.message;

    ws.send(createNormalizedMessage({
      kind: 'error',
      content: errorContent,
      sessionId: capturedSessionId || sessionId || null,
      provider: 'qoder',
    }));
    ws.send(createCompleteMessage({ provider: 'qoder', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'qoder',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error,
    });
  }
}

async function abortQoderSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    return false;
  }

  try {
    abortedSessionIds.add(sessionId);
    await session.instance.interrupt();
    session.status = 'aborted';
    removeSession(sessionId);
    return true;
  } catch (error) {
    console.error(`Error aborting Qoder session ${sessionId}:`, error);
    removeSession(sessionId);
    return false;
  }
}

function isQoderSDKSessionActive(sessionId) {
  return activeSessions.has(sessionId);
}

function getActiveQoderSDKSessions() {
  return Array.from(activeSessions.keys());
}

function reconnectQoderSessionWriter(sessionId, writer) {
  const session = getSession(sessionId);
  if (session) {
    session.writer = writer;
    return true;
  }
  return false;
}

export {
  queryQoderSDK,
  abortQoderSDKSession,
  isQoderSDKSessionActive,
  getActiveQoderSDKSessions,
  resolveQoderToolApproval,
  getQoderPendingApprovalsForSession,
  reconnectQoderSessionWriter,
};
