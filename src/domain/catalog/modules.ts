/**
 * Every Stackroost module and gated feature the app knows. Ids match the
 * desktop app's `ModuleId` (src/shared/modules/modules.config.ts) exactly — the
 * app gates on these strings, so renaming one is a breaking change. Admins
 * compose plans only from this list (validated at the API).
 */
export const MODULE_IDS = [
  'homebrew',
  'ports',
  'doctor',
  'maclean',
  'claude',
  'docker',
  'projects',
  'toolbox',
  'remote',
  'databases',
  'kafka',
  'cloud',
  'domains',
  'network',
  'secrets',
  'releases',
  'devices',
  'backups',
] as const;

/** Capabilities inside a module that a plan can grant separately. */
export const FEATURE_IDS = ['maclean.deep_scan', 'maclean.clean', 'remote.terminal'] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
export type FeatureId = (typeof FEATURE_IDS)[number];
