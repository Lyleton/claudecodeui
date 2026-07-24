import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const QODER_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'auto',
      label: 'Auto (recommended)',
      description: 'Vision · 1.00x Credit',
    },
    {
      value: 'ultimate',
      label: 'Ultimate',
      description: 'Reasoning · Vision · 0.80x Credit',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'performance',
      label: 'Performance',
      description: 'Vision · 1.10x Credit',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'efficient',
      label: 'Efficient',
      description: 'Vision · 0.30x Credit',
    },
    {
      value: 'lite',
      label: 'Lite',
      description: '0.00x Credit',
    },
    {
      value: 'cmodel',
      label: 'Cantus',
      description: 'Reasoning · Vision · 1.60x Credit',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'qmodel_preview',
      label: 'Qwen3.8-Max-Preview',
      description: 'Reasoning · Vision · 0.05x Credit',
    },
    {
      value: 'qmodel_latest',
      label: 'Qwen3.7-Max',
      description: 'Vision · 0.25x Credit',
    },
    {
      value: 'qmodel',
      label: 'Qwen3.7-Plus',
      description: 'Vision · 0.10x Credit',
    },
    {
      value: 'kmodel_latest',
      label: 'Kimi-K3',
      description: 'Vision · 0.80x Credit',
      effort: {
        default: 'max',
        values: [
          { value: 'low' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'kmodel',
      label: 'Kimi-K2.7-Code',
      description: 'Vision · 0.30x Credit',
    },
    {
      value: 'gm51model',
      label: 'GLM-5.2',
      description: 'Reasoning · Vision · 0.60x Credit',
      effort: {
        default: 'max',
        values: [
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'dmodel',
      label: 'DeepSeek-V4-Pro',
      description: 'Reasoning · Vision · 0.50x Credit',
      effort: {
        default: 'max',
        values: [
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'dfmodel',
      label: 'DeepSeek-V4-Flash',
      description: 'Reasoning · Vision · 0.10x Credit',
      effort: {
        default: 'max',
        values: [
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'mmodel',
      label: 'MiniMax-M3',
      description: 'Vision · 0.20x Credit',
    },
  ],
  DEFAULT: 'auto',
};

type QoderSdkModelInfo = {
  value: string;
  displayName: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  isDefault?: boolean;
  isEnabled?: boolean;
};

const transformSdkModelsToDefinition = (models: QoderSdkModelInfo[]): ProviderModelsDefinition => {
  const options: ProviderModelOption[] = models
    .filter((m) => m.isEnabled !== false)
    .map((m) => {
      const option: ProviderModelOption = {
        value: m.value,
        label: m.displayName,
        description: m.description,
      };

      if (m.efforts && m.efforts.length > 0) {
        option.effort = {
          default: m.defaultEffort || 'high',
          values: m.efforts.map((e) => ({ value: e })),
        };
      }

      return option;
    });

  const defaultModel = models.find((m) => m.isDefault)?.value || 'auto';

  return { OPTIONS: options, DEFAULT: defaultModel };
};

type QoderInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    model?: string;
  };
};

const extractQoderEventModel = (event: QoderInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  return event.message?.model?.trim() || null;
};

const readQoderSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as QoderInitEvent;
      const model = extractQoderEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines.
    }
  }

  return null;
};

export class QoderProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const { query, qodercliAuth } = await import('@qoder-ai/qoder-agent-sdk');
      const q = query({ prompt: '', options: { auth: qodercliAuth() } });
      const models = await q.getAvailableModels() as QoderSdkModelInfo[];
      if (models && models.length > 0) {
        return transformSdkModelsToDefinition(models);
      }
    } catch {
      // Fall through to static fallback.
    }

    return QODER_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readQoderSessionModelFromJsonl(sessionId, jsonlPath)
        : null;

      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to default.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('qoder', input);
  }
}
