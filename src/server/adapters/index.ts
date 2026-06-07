import type { Adapter } from './base.js';
import { AntigravityAdapter } from './antigravity.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { AppId } from '../../shared/types.js';
import type { LauncherService } from '../launcher-service.js';

export class AdapterManager {
  private adapters: Record<AppId, Adapter>;

  constructor(launcher: LauncherService) {
    this.adapters = {
      codex: new CodexAdapter({ launcher }),
      claude: new ClaudeAdapter({ launcher }),
      antigravity: new AntigravityAdapter({ launcher })
    };
  }

  all(): Adapter[] {
    return Object.values(this.adapters);
  }

  get(appId: AppId): Adapter {
    return this.adapters[appId];
  }
}
