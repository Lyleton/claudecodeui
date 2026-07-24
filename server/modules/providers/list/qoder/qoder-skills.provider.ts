import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

const getQoderHome = (): string =>
  process.env.QODER_CONFIG_DIR?.trim() || path.join(os.homedir(), '.qoder');

export class QoderSkillsProvider extends SkillsProvider {
  constructor() {
    super('qoder');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'user',
        rootDir: path.join(getQoderHome(), 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.qoder', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getQoderHome(), 'skills'),
      commandPrefix: '/',
    };
  }
}
