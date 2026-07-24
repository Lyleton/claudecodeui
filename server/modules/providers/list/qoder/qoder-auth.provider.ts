import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const resolveQoderCliPath = (): string =>
  process.env.QODER_CLI_PATH?.trim() || 'qodercli';

const getQoderHome = (): string =>
  process.env.QODER_CONFIG_DIR?.trim() || path.join(os.homedir(), '.qoder');

export class QoderProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    const cliPath = resolveQoderCliPath();
    try {
      spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'qoder',
        authenticated: false,
        email: null,
        method: null,
        error: 'Qoder CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'qoder',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  private async checkCredentials(): Promise<{
    authenticated: boolean;
    email: string | null;
    method: string | null;
    error?: string;
  }> {
    if (process.env.QODER_ACCESS_TOKEN?.trim()) {
      return { authenticated: true, email: 'Access Token', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.QODER_ACCESS_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    try {
      const authDir = path.join(getQoderHome(), '.auth');
      const userFile = path.join(authDir, 'user');
      const content = await readFile(userFile, 'utf8');

      if (content.trim()) {
        return { authenticated: true, email: 'Authenticated', method: 'credentials_file' };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: 'Qoder CLI is not authenticated. Run qodercli auth login.',
      };
    } catch (error) {
      const isNotFound = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      return {
        authenticated: false,
        email: null,
        method: null,
        error: isNotFound
          ? 'Qoder CLI is not authenticated. Run qodercli auth login.'
          : 'Unable to read Qoder credentials. Run qodercli auth login again.',
      };
    }
  }

  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(getQoderHome(), 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }
}
