import { loadEffectiveConfig } from './config-repository.js';
import type { FullConfig } from './types.js';

export { getDefaultConfig } from './config-codec.js';

export function loadWorkflowConfig(projectRoot: string, options: { profile?: string } = {}): FullConfig {
  return loadEffectiveConfig(projectRoot, options);
}
