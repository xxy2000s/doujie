import type {
  AppConfig,
  PrivacyGroupRule,
  QuotedMessageFeatureConfig,
} from './types.js';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type RuntimeConfigSnapshot = Readonly<{
  version: number;
  loadedAt: number;
  config: DeepReadonly<AppConfig>;
}>;

export type ConfigReloadResult = {
  ok: boolean;
  previousVersion: number;
  version: number;
  changed: boolean;
  restartRequired: string[];
  error?: string;
};

export type RuntimeConfigLoader = () => AppConfig | Promise<AppConfig>;

export interface RuntimeConfigSource {
  getSnapshot(): RuntimeConfigSnapshot;
}

export class RuntimeConfigManager implements RuntimeConfigSource {
  private snapshot: RuntimeConfigSnapshot;
  private reloadQueue: Promise<unknown> = Promise.resolve();

  constructor(
    initialConfig: AppConfig,
    private readonly loader: RuntimeConfigLoader,
    private readonly clock: () => number = Date.now
  ) {
    this.snapshot = createSnapshot(initialConfig, 1, this.clock());
  }

  getSnapshot(): RuntimeConfigSnapshot {
    return this.snapshot;
  }

  reload(): Promise<ConfigReloadResult> {
    const result = this.reloadQueue.then(
      () => this.performReload(),
      () => this.performReload()
    );
    this.reloadQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performReload(): Promise<ConfigReloadResult> {
    const previous = this.snapshot;
    let candidate: AppConfig;
    try {
      candidate = await this.loader();
    } catch {
      return {
        ok: false,
        previousVersion: previous.version,
        version: previous.version,
        changed: false,
        restartRequired: [],
        error: 'configuration validation failed',
      };
    }

    const restartRequired = findRestartRequiredPaths(previous.config, candidate);
    const applied = mergeReloadableConfig(previous.config, candidate);
    const changed = !valuesEqual(previous.config.features, applied.features) ||
      !valuesEqual(groupFeatureProjection(previous.config.privacy.groups), groupFeatureProjection(applied.privacy.groups));

    if (changed) {
      this.snapshot = createSnapshot(applied, previous.version + 1, this.clock());
    }

    return {
      ok: true,
      previousVersion: previous.version,
      version: this.snapshot.version,
      changed,
      restartRequired,
    };
  }
}

export function resolveQuotedMessageFeature(
  snapshot: RuntimeConfigSnapshot,
  chatId: string
): QuotedMessageFeatureConfig {
  const global = snapshot.config.features.quotedMessage;
  const group = snapshot.config.privacy.groups?.find((rule) => rule.chatId === chatId);
  const override = group?.features?.quotedMessage;
  return {
    enabled: override?.enabled ?? global.enabled,
    maxChars: override?.maxChars ?? global.maxChars,
  };
}

function createSnapshot(config: AppConfig, version: number, loadedAt: number): RuntimeConfigSnapshot {
  const cloned = structuredClone(config);
  return deepFreeze({ version, loadedAt, config: cloned });
}

function mergeReloadableConfig(current: DeepReadonly<AppConfig>, candidate: AppConfig): AppConfig {
  const applied = structuredClone(current) as AppConfig;
  applied.features = structuredClone(candidate.features);
  applied.privacy.groups = applied.privacy.groups?.map((group) => {
    const candidateGroup = candidate.privacy.groups?.find((item) => item.chatId === group.chatId);
    if (!candidateGroup) return group;
    const copy = { ...group };
    if (candidateGroup.features) {
      copy.features = structuredClone(candidateGroup.features);
    } else {
      delete copy.features;
    }
    return copy;
  });
  return applied;
}

function findRestartRequiredPaths(current: DeepReadonly<AppConfig>, candidate: AppConfig): string[] {
  const paths: string[] = [];
  collectChangedPaths(current.codex, candidate.codex, 'codex', paths);
  collectChangedPaths(current.feishu, candidate.feishu, 'feishu', paths);
  collectChangedPaths(current.storage, candidate.storage, 'storage', paths);
  collectChangedPaths(current.attachments, candidate.attachments, 'attachments', paths);

  const privacyKeys: Array<Exclude<keyof AppConfig['privacy'], 'groups'>> = [
    'allowChatIds', 'denyChatIds', 'allowUserIds', 'denyUserIds', 'adminUserIds',
    'privateAllowUserIds', 'skipPatterns', 'redactPatterns',
  ];
  for (const key of privacyKeys) {
    collectChangedPaths(current.privacy[key], candidate.privacy[key], `privacy.${key}`, paths);
  }
  if (!valuesEqual(stripGroupFeatures(current.privacy.groups), stripGroupFeatures(candidate.privacy.groups))) {
    paths.push('privacy.groups');
  }
  return [...new Set(paths.map(toConfigFieldPath))].sort();
}

function toConfigFieldPath(path: string): string {
  return path
    .split('.')
    .map((segment) => segment.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
    .join('.');
}

function collectChangedPaths(current: unknown, candidate: unknown, path: string, paths: string[]): void {
  if (valuesEqual(current, candidate)) return;
  if (isPlainObject(current) && isPlainObject(candidate)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(candidate)]);
    for (const key of [...keys].sort()) {
      collectChangedPaths(current[key], candidate[key], `${path}.${key}`, paths);
    }
    return;
  }
  paths.push(path);
}

function stripGroupFeatures(groups: DeepReadonly<PrivacyGroupRule[]> | undefined): unknown[] {
  return (groups ?? []).map((group) => {
    const { features: _features, ...rest } = group;
    return rest;
  });
}

function groupFeatureProjection(groups: DeepReadonly<PrivacyGroupRule[]> | undefined): Array<{
  chatId: string;
  features?: DeepReadonly<PrivacyGroupRule['features']>;
}> {
  return (groups ?? []).map((group) => ({ chatId: group.chatId, features: group.features }));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
