import fs from 'node:fs';
import path from 'node:path';
import type {
  AppConfig,
  OutputTransport,
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

export type RuntimeConfigSourceKind = 'startup' | 'manual' | 'output_command' | 'watcher';
export type RuntimeConfigWatcherState = 'disabled' | 'starting' | 'watching' | 'degraded' | 'stopped';
export type ConfigLifecycleAction =
  | 'poller:start'
  | 'poller:stop'
  | 'poller:replace'
  | 'poller:error';
export type SanitizedConfigReloadError =
  | 'configuration validation failed'
  | 'component reconciliation failed';

export type ConfigReloadAuditEntry = Readonly<{
  attemptedAt: number;
  source: RuntimeConfigSourceKind;
  ok: boolean;
  previousVersion: number;
  version: number;
  changedFields: readonly string[];
  restartRequired: readonly string[];
  lifecycleActions: readonly ConfigLifecycleAction[];
  error?: SanitizedConfigReloadError;
}>;

export type RuntimeConfigStatus = Readonly<{
  version: number;
  loadedAt: number;
  source: RuntimeConfigSourceKind;
  watcherState: RuntimeConfigWatcherState;
  lastLifecycleActions: readonly ConfigLifecycleAction[];
  lastReloadFailure: ConfigReloadAuditEntry | null;
}>;

export type EffectiveFeatureProjection = Readonly<{
  quotedMessage: Readonly<{
    enabled: boolean;
    maxChars: number;
    maxDepth: number;
    includeAttachments: boolean;
    scope: 'global' | 'group_override';
  }>;
}>;

export type ConfigReloadResult = {
  ok: boolean;
  previousVersion: number;
  version: number;
  changed: boolean;
  changedFields: string[];
  restartRequired: string[];
  lifecycleActions: ConfigLifecycleAction[];
  error?: string;
};

export type RuntimeConfigLoader = (
  source?: Extract<RuntimeConfigSourceKind, 'manual' | 'watcher'>
) => AppConfig | Promise<AppConfig>;
export type RuntimeConfigReconciler = (
  config: DeepReadonly<AppConfig>
) => Promise<ConfigLifecycleAction[]>;

export interface RuntimeConfigSource {
  getSnapshot(): RuntimeConfigSnapshot;
  getStatus?(): RuntimeConfigStatus;
  getEffectiveFeatures?(chatId: string): EffectiveFeatureProjection;
  setOutputTransport?(transport: OutputTransport): Promise<RuntimeConfigSnapshot>;
}

const RELOAD_AUDIT_LIMIT = 20;
const CONFIG_VALIDATION_ERROR = 'configuration validation failed';

export class RuntimeConfigManager implements RuntimeConfigSource {
  private snapshot: RuntimeConfigSnapshot;
  private reloadQueue: Promise<unknown> = Promise.resolve();
  private source: RuntimeConfigSourceKind = 'startup';
  private watcherState: RuntimeConfigWatcherState = 'disabled';
  private readonly reloadAudit: ConfigReloadAuditEntry[] = [];
  private reconciler: RuntimeConfigReconciler | null = null;

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

  getStatus(): RuntimeConfigStatus {
    const lastReloadFailure = [...this.reloadAudit].reverse().find((entry) => !entry.ok) ?? null;
    const lastReload = this.reloadAudit.at(-1);
    return deepFreeze({
      version: this.snapshot.version,
      loadedAt: this.snapshot.loadedAt,
      source: this.source,
      watcherState: this.watcherState,
      lastLifecycleActions: lastReload?.lifecycleActions ?? [],
      lastReloadFailure,
    });
  }

  getReloadAudit(): readonly ConfigReloadAuditEntry[] {
    return Object.freeze([...this.reloadAudit]);
  }

  getEffectiveFeatures(chatId: string): EffectiveFeatureProjection {
    const resolved = resolveQuotedMessageFeature(this.snapshot, chatId);
    const group = this.snapshot.config.privacy.groups?.find((rule) => rule.chatId === chatId);
    return deepFreeze({
      quotedMessage: {
        ...resolved,
        scope: group?.features?.quotedMessage ? 'group_override' : 'global',
      },
    });
  }

  setWatcherState(state: RuntimeConfigWatcherState): void {
    this.watcherState = state;
  }

  setReconciler(reconciler: RuntimeConfigReconciler): void {
    this.reconciler = reconciler;
  }

  setOutputTransport(transport: OutputTransport): Promise<RuntimeConfigSnapshot> {
    const result = this.reloadQueue.then(
      () => this.performOutputTransportChange(transport),
      () => this.performOutputTransportChange(transport)
    );
    this.reloadQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private performOutputTransportChange(transport: OutputTransport): RuntimeConfigSnapshot {
    if (this.snapshot.config.output.transport === transport) return this.snapshot;
    const next = structuredClone(this.snapshot.config) as AppConfig;
    next.output.transport = transport;
    this.snapshot = createSnapshot(next, this.snapshot.version + 1, this.clock());
    this.source = 'output_command';
    return this.snapshot;
  }

  reload(source: Extract<RuntimeConfigSourceKind, 'manual' | 'watcher'> = 'manual'): Promise<ConfigReloadResult> {
    const result = this.reloadQueue.then(
      () => this.performReload(source),
      () => this.performReload(source)
    );
    this.reloadQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performReload(source: Extract<RuntimeConfigSourceKind, 'manual' | 'watcher'>): Promise<ConfigReloadResult> {
    const previous = this.snapshot;
    let candidate: AppConfig;
    try {
      candidate = await this.loader(source);
    } catch {
      const current = this.snapshot;
      const result: ConfigReloadResult = {
        ok: false,
        previousVersion: previous.version,
        version: current.version,
        changed: false,
        changedFields: [],
        restartRequired: [],
        lifecycleActions: [],
        error: CONFIG_VALIDATION_ERROR,
      };
      this.recordReload(result, source);
      return result;
    }

    const current = this.snapshot;
    if (source === 'watcher' && isUnsafeWatcherDowngrade(current.config, candidate)) {
      const result: ConfigReloadResult = {
        ok: false,
        previousVersion: previous.version,
        version: current.version,
        changed: false,
        changedFields: [],
        restartRequired: [],
        lifecycleActions: [],
        error: CONFIG_VALIDATION_ERROR,
      };
      this.recordReload(result, source);
      return result;
    }
    const restartRequired = findRestartRequiredPaths(current.config, candidate);
    const applied = mergeReloadableConfig(current.config, candidate);
    if (source === 'watcher') {
      // Equality may depend on a symlink that can later be retargeted without a
      // config event. Automatic reload must not introduce that mutable spelling.
      applied.codex.workdir = current.config.codex.workdir;
    }
    if (!valuesEqual(previous.config.output, current.config.output)) {
      applied.output = structuredClone(current.config.output) as AppConfig['output'];
    }
    const changedFields = findReloadableChangedPaths(current.config, applied);
    const changed = changedFields.length > 0;

    if (changed) {
      this.snapshot = createSnapshot(applied, current.version + 1, this.clock());
      this.source = source;
    }

    let lifecycleActions: ConfigLifecycleAction[] = [];
    try {
      lifecycleActions = this.reconciler ? await this.reconciler(this.snapshot.config) : [];
    } catch {
      const result: ConfigReloadResult = {
        ok: false,
        previousVersion: previous.version,
        version: this.snapshot.version,
        changed,
        changedFields,
        restartRequired,
        lifecycleActions: ['poller:error'],
        error: 'component reconciliation failed',
      };
      this.recordReload(result, source);
      return result;
    }

    const result: ConfigReloadResult = {
      ok: true,
      previousVersion: previous.version,
      version: this.snapshot.version,
      changed,
      changedFields,
      restartRequired,
      lifecycleActions,
    };
    this.recordReload(result, source);
    return result;
  }

  private recordReload(result: ConfigReloadResult, source: RuntimeConfigSourceKind): void {
    const entry = deepFreeze({
      attemptedAt: this.clock(),
      source,
      ok: result.ok,
      previousVersion: result.previousVersion,
      version: result.version,
      changedFields: [...result.changedFields],
      restartRequired: [...result.restartRequired],
      lifecycleActions: [...result.lifecycleActions],
      ...(result.error ? { error: sanitizeReloadError(result.error) } : {}),
    });
    this.reloadAudit.push(entry);
    if (this.reloadAudit.length > RELOAD_AUDIT_LIMIT) {
      this.reloadAudit.splice(0, this.reloadAudit.length - RELOAD_AUDIT_LIMIT);
    }
  }
}

export function isUnsafeWatcherDowngrade(
  current: DeepReadonly<AppConfig>,
  candidate: AppConfig
): boolean {
  const currentPrivacy = current.privacy;
  const candidatePrivacy = candidate.privacy;
  if (!sameStringSet(currentPrivacy.allowChatIds, candidatePrivacy.allowChatIds)) return true;
  if (!sameStringSet(currentPrivacy.allowUserIds, candidatePrivacy.allowUserIds)) return true;
  if (!sameStringSet(currentPrivacy.adminUserIds ?? [], candidatePrivacy.adminUserIds ?? [])) return true;
  if (!sameNullableStringSet(currentPrivacy.privateAllowUserIds, candidatePrivacy.privateAllowUserIds)) return true;
  if (!sameGroupAuthorization(currentPrivacy.groups ?? [], candidatePrivacy.groups ?? [])) return true;
  if (!isStringSetSubset(currentPrivacy.denyChatIds, candidatePrivacy.denyChatIds)) return true;
  if (!isStringSetSubset(currentPrivacy.denyUserIds, candidatePrivacy.denyUserIds)) return true;
  if (!arePatternsPreserved(currentPrivacy.skipPatterns, candidatePrivacy.skipPatterns)) return true;
  if (!arePatternsPreserved(currentPrivacy.redactPatterns, candidatePrivacy.redactPatterns)) return true;

  if (!sameStringSet(current.feishu.botMentionIds, candidate.feishu.botMentionIds)) return true;
  if (!sameStringSet(current.feishu.botMentionNames, candidate.feishu.botMentionNames)) return true;
  if (current.codex.model.trim() && !candidate.codex.model.trim()) return true;
  if (!sameCanonicalWorkdir(current.codex.workdir, candidate.codex.workdir)) return true;
  if (sandboxRank(candidate.codex.sandbox) > sandboxRank(current.codex.sandbox)) return true;
  if (!current.codex.skipGitRepoCheck && candidate.codex.skipGitRepoCheck) return true;
  return false;
}

export function canonicalizeWorkdir(value: string): string {
  const rawAbsolute = path.isAbsolute(value)
    ? value
    : `${process.cwd()}${path.sep}${value}`;
  const root = path.parse(rawAbsolute).root;
  const segments = rawAbsolute
    .slice(root.length)
    .split(path.sep)
    .filter((segment) => segment.length > 0);

  let resolved = root;
  try {
    resolved = fs.realpathSync.native(root);
  } catch {
    return path.resolve(rawAbsolute);
  }

  // Walk components in filesystem order. Lexically resolving the whole input
  // first would turn `symlink/..` into the symlink's lexical parent instead of
  // the real target's parent.
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === '.') continue;
    if (segment === '..') {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, segment);
    try {
      const stat = fs.lstatSync(next);
      resolved = stat.isSymbolicLink()
        ? fs.realpathSync.native(next)
        : next;
    } catch {
      return path.resolve(resolved, ...segments.slice(index));
    }
  }
  return resolved;
}

function sameCanonicalWorkdir(current: string, candidate: string): boolean {
  return canonicalizeWorkdir(current) === canonicalizeWorkdir(candidate);
}

function sameGroupAuthorization(
  current: DeepReadonly<NonNullable<AppConfig['privacy']['groups']>>,
  candidate: NonNullable<AppConfig['privacy']['groups']>
): boolean {
  const currentByChat = uniqueGroupsByChatId(current);
  const candidateByChat = uniqueGroupsByChatId(candidate);
  if (!currentByChat || !candidateByChat || currentByChat.size !== candidateByChat.size) return false;
  return [...currentByChat.entries()].every(([chatId, group]) => {
    const next = candidateByChat.get(chatId);
    return Boolean(
      next &&
      sameStringSet(group.allowUserIds, next.allowUserIds) &&
      sameStringSet(group.allowAgentUserIds ?? [], next.allowAgentUserIds ?? [])
    );
  });
}

function uniqueGroupsByChatId<T extends { readonly chatId: string }>(groups: readonly T[]): Map<string, T> | null {
  const result = new Map<string, T>();
  for (const group of groups) {
    if (result.has(group.chatId)) return null;
    result.set(group.chatId, group);
  }
  return result;
}

function sameNullableStringSet(
  current: readonly string[] | null | undefined,
  candidate: readonly string[] | null | undefined
): boolean {
  if (current == null || candidate == null) return current == null && candidate == null;
  return sameStringSet(current, candidate);
}

function sameStringSet(current: readonly string[], candidate: readonly string[]): boolean {
  const currentSet = new Set(current);
  const candidateSet = new Set(candidate);
  return currentSet.size === candidateSet.size && [...currentSet].every((value) => candidateSet.has(value));
}

function isStringSetSubset(current: readonly string[], candidate: readonly string[]): boolean {
  const next = new Set(candidate);
  return current.every((value) => next.has(value));
}

function arePatternsPreserved(
  current: readonly DeepReadonly<AppConfig['privacy']['skipPatterns'][number]>[],
  candidate: AppConfig['privacy']['skipPatterns']
): boolean {
  const signatures = new Set(candidate.map(patternSignature));
  return current.every((pattern) => signatures.has(patternSignature(pattern)));
}

function patternSignature(pattern: DeepReadonly<AppConfig['privacy']['skipPatterns'][number]>): string {
  return JSON.stringify([pattern.name, pattern.pattern, pattern.replacement ?? null]);
}

function sandboxRank(value: AppConfig['codex']['sandbox']): number {
  if (value === 'read-only') return 0;
  if (value === 'workspace-write') return 1;
  return 2;
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
    maxDepth: override?.maxDepth ?? global.maxDepth,
    includeAttachments: override?.includeAttachments ?? global.includeAttachments,
  };
}

function createSnapshot(config: AppConfig, version: number, loadedAt: number): RuntimeConfigSnapshot {
  const cloned = structuredClone(config);
  return deepFreeze({ version, loadedAt, config: cloned });
}

function mergeReloadableConfig(current: DeepReadonly<AppConfig>, candidate: AppConfig): AppConfig {
  const applied = structuredClone(current) as AppConfig;
  applied.output = structuredClone(candidate.output);
  applied.features = structuredClone(candidate.features);
  applied.privacy = structuredClone(candidate.privacy);
  applied.codex.model = candidate.codex.model;
  applied.codex.workdir = candidate.codex.workdir;
  applied.codex.sandbox = candidate.codex.sandbox;
  applied.codex.skipGitRepoCheck = candidate.codex.skipGitRepoCheck;
  applied.feishu.botMentionIds = structuredClone(candidate.feishu.botMentionIds);
  applied.feishu.botMentionNames = structuredClone(candidate.feishu.botMentionNames);
  applied.feishu.editPolling = structuredClone(candidate.feishu.editPolling);
  applied.attachments = structuredClone(candidate.attachments);
  return applied;
}

function findRestartRequiredPaths(current: DeepReadonly<AppConfig>, candidate: AppConfig): string[] {
  const paths: string[] = [];
  collectChangedPaths(current.codex.controlSessionDir, candidate.codex.controlSessionDir, 'codex.controlSessionDir', paths);
  collectChangedPaths(current.feishu.chatIds, candidate.feishu.chatIds, 'feishu.chatIds', paths);
  collectChangedPaths(current.feishu.as, candidate.feishu.as, 'feishu.as', paths);
  collectChangedPaths(current.storage, candidate.storage, 'storage', paths);
  return [...new Set(paths.map(toConfigFieldPath))].sort();
}

function findReloadableChangedPaths(
  current: DeepReadonly<AppConfig>,
  applied: AppConfig
): string[] {
  const paths: string[] = [];
  collectChangedPaths(current.output, applied.output, 'output', paths);
  collectChangedPaths(current.features, applied.features, 'features', paths);
  collectChangedPaths(current.privacy, applied.privacy, 'privacy', paths);
  collectChangedPaths(current.codex.model, applied.codex.model, 'codex.model', paths);
  collectChangedPaths(current.codex.workdir, applied.codex.workdir, 'codex.workdir', paths);
  collectChangedPaths(current.codex.sandbox, applied.codex.sandbox, 'codex.sandbox', paths);
  collectChangedPaths(current.codex.skipGitRepoCheck, applied.codex.skipGitRepoCheck, 'codex.skipGitRepoCheck', paths);
  collectChangedPaths(current.feishu.botMentionIds, applied.feishu.botMentionIds, 'feishu.botMentionIds', paths);
  collectChangedPaths(current.feishu.botMentionNames, applied.feishu.botMentionNames, 'feishu.botMentionNames', paths);
  collectChangedPaths(current.feishu.editPolling, applied.feishu.editPolling, 'feishu.editPolling', paths);
  collectChangedPaths(current.attachments, applied.attachments, 'attachments', paths);
  return [...new Set(paths.map(toConfigFieldPath))].sort();
}

function sanitizeReloadError(error: string): SanitizedConfigReloadError {
  return error === 'component reconciliation failed'
    ? 'component reconciliation failed'
    : CONFIG_VALIDATION_ERROR;
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
