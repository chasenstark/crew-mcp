import { loadEffectiveConfig, getGlobalConfigPath } from './config-repository.js';
import type { FullConfig } from './types.js';

export {
  getDefaultConfig,
  mergeConfigs,
  parseWorkflowYaml,
  serializeWorkflowYaml,
} from './config-codec.js';

export { getGlobalConfigPath };

export function loadWorkflowConfig(projectRoot: string): FullConfig {
  return loadEffectiveConfig(projectRoot);
}
