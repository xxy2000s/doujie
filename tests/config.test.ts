import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConfig, ConfigError } from '../src/config.js';

test('buildConfig accepts valid YAML and environment overrides', () => {
  const config = buildConfig(
    {
      codex: { model: 'yaml-model' },
      feishu: {
        chat_ids: ['oc_1'],
        as: 'user',
        bot_mention_ids: ['cli_bot'],
        bot_mention_names: ['豆姐'],
      },
      storage: { db_path: '~/custom.db' },
    },
    {
      CODEX_MODEL: 'env-model',
      DOUJIE_DB_PATH: '/tmp/doujie-test.db',
    }
  );

  assert.equal(config.codex.model, 'env-model');
  assert.match(config.codex.controlSessionDir, /\/\.doujie\/sessions$/);
  assert.deepEqual(config.feishu.chatIds, ['oc_1']);
  assert.equal(config.feishu.as, 'user');
  assert.deepEqual(config.feishu.botMentionIds, ['cli_bot']);
  assert.deepEqual(config.feishu.botMentionNames, ['豆姐']);
  assert.equal(config.feishu.editPolling.enabled, false);
  assert.deepEqual(config.feishu.editPolling.chatIds, []);
  assert.equal(config.feishu.editPolling.as, 'user');
  assert.equal(config.storage.dbPath, '/tmp/doujie-test.db');
  assert.match(config.storage.backupDir, /backups$/);
  assert.match(config.storage.exportDir, /exports$/);
  assert.match(config.storage.attachmentCacheDir, /attachments$/);
  assert.deepEqual(config.privacy.skipPatterns, []);
  assert.deepEqual(config.privacy.adminUserIds, []);
  assert.equal(config.privacy.privateAllowUserIds, null);
  assert.deepEqual(config.privacy.groups, []);
  assert.equal(config.attachments.ocrCommand, null);
  assert.deepEqual(config.features.quotedMessage, {
    enabled: false, maxChars: 20000, maxDepth: 1, includeAttachments: false,
  });
  assert.equal(config.output.transport, 'card');
});

test('buildConfig accepts output transport and environment precedence', () => {
  assert.equal(buildConfig({ output: { transport: 'post' } }, {}).output.transport, 'post');
  assert.equal(
    buildConfig({ output: { transport: 'post' } }, { DOUJIE_OUTPUT_TRANSPORT: 'card' }).output.transport,
    'card'
  );
  assert.throws(
    () => buildConfig({ output: { transport: 'text' } }, {}),
    /output\.transport must be card or post/
  );
});

test('buildConfig accepts storage maintenance directories', () => {
  const config = buildConfig(
    {
      storage: {
        backup_dir: '~/doujie-backups',
        export_dir: '/tmp/doujie-exports',
        attachment_cache_dir: '/tmp/doujie-attachments',
      },
      attachments: { ocr_command: 'ocr-local --plain' },
    },
    {}
  );

  assert.match(config.storage.backupDir, /doujie-backups$/);
  assert.equal(config.storage.exportDir, '/tmp/doujie-exports');
  assert.equal(config.storage.attachmentCacheDir, '/tmp/doujie-attachments');
  assert.equal(config.attachments.ocrCommand, 'ocr-local --plain');
});

test('buildConfig leaves codex model empty by default', () => {
  const config = buildConfig({}, {});

  assert.equal(config.codex.model, '');
  assert.equal(config.codex.sandbox, 'danger-full-access');
  assert.match(config.codex.controlSessionDir, /\/\.doujie\/sessions$/);
  assert.deepEqual(config.feishu.botMentionIds, []);
  assert.deepEqual(config.feishu.botMentionNames, []);
});

test('buildConfig keeps startup compatibility for explicit null optional values', () => {
  const config = buildConfig({
    codex: { model: null },
    privacy: { allow_user_ids: null, admin_user_ids: null },
    feishu: { edit_polling: { enabled: null, chat_ids: null } },
  }, {});
  assert.equal(config.codex.model, '');
  assert.deepEqual(config.privacy.allowUserIds, []);
  assert.deepEqual(config.privacy.adminUserIds, []);
  assert.equal(config.feishu.editPolling.enabled, false);
  assert.deepEqual(config.feishu.editPolling.chatIds, []);
});

test('buildConfig accepts bot mention environment lists', () => {
  const config = buildConfig({}, {
    DOUJIE_FEISHU_BOT_MENTION_IDS: 'cli_1, ou_2',
    DOUJIE_FEISHU_BOT_MENTION_NAMES: '豆姐, Codex',
  });

  assert.deepEqual(config.feishu.botMentionIds, ['cli_1', 'ou_2']);
  assert.deepEqual(config.feishu.botMentionNames, ['豆姐', 'Codex']);
});

test('buildConfig accepts edited-message polling config', () => {
  const config = buildConfig({
    feishu: {
      as: 'bot',
      edit_polling: {
        enabled: true,
        chat_ids: ['oc_poll'],
        as: 'user',
        interval_ms: 3000,
        page_size: 12,
      },
    },
  }, {});

  assert.equal(config.feishu.editPolling.enabled, true);
  assert.deepEqual(config.feishu.editPolling.chatIds, ['oc_poll']);
  assert.equal(config.feishu.editPolling.as, 'user');
  assert.equal(config.feishu.editPolling.intervalMs, 3000);
  assert.equal(config.feishu.editPolling.pageSize, 12);
});

test('buildConfig accepts control session directory override', () => {
  const config = buildConfig({ codex: { control_session_dir: '~/doujie-control' } }, {
    DOUJIE_CODEX_CONTROL_SESSION_DIR: '/tmp/control-sessions',
  });

  assert.equal(config.codex.controlSessionDir, '/tmp/control-sessions');
});

test('buildConfig rejects invalid chat id shape', () => {
  assert.throws(
    () => buildConfig({ feishu: { chat_ids: 'oc_1' } }, {}),
    ConfigError
  );
});

test('buildConfig rejects invalid feishu identity', () => {
  assert.throws(
    () => buildConfig({ feishu: { as: 'admin' } }, {}),
    /feishu\.as must be either "bot" or "user"/
  );
});

test('buildConfig accepts and validates privacy rules', () => {
  const config = buildConfig(
    {
      privacy: {
        allow_chat_ids: ['oc_allowed'],
        deny_user_ids: ['ou_denied'],
        skip_patterns: [{ name: 'secret', pattern: 'SECRET-[0-9]+' }],
        redact_patterns: [{ name: 'email', pattern: '[^\\s]+@example\\.com', replacement: '[EMAIL]' }],
      },
    },
    {}
  );

  assert.deepEqual(config.privacy.allowChatIds, ['oc_allowed']);
  assert.deepEqual(config.privacy.denyUserIds, ['ou_denied']);
  assert.deepEqual(config.privacy.skipPatterns, [{ name: 'secret', pattern: 'SECRET-[0-9]+' }]);
  assert.deepEqual(config.privacy.redactPatterns, [
    { name: 'email', pattern: '[^\\s]+@example\\.com', replacement: '[EMAIL]' },
  ]);
});

test('buildConfig accepts private, group, admin, and context privacy rules', () => {
  const config = buildConfig({
    privacy: {
      admin_user_ids: ['ou_admin'],
      private: { allow_user_ids: ['ou_admin'] },
      groups: [{
        chat_id: 'oc_team',
        allow_user_ids: ['ou_admin', 'ou_member'],
        allow_agent_user_ids: ['ou_admin'],
        context: { enabled: true, max_messages: 25, max_chars: 12000 },
      }],
    },
  }, {});

  assert.deepEqual(config.privacy.adminUserIds, ['ou_admin']);
  assert.deepEqual(config.privacy.privateAllowUserIds, ['ou_admin']);
  assert.deepEqual(config.privacy.groups, [{
    chatId: 'oc_team',
    allowUserIds: ['ou_admin', 'ou_member'],
    allowAgentUserIds: ['ou_admin'],
    contextEnabled: true,
    contextMaxMessages: 25,
    contextMaxChars: 12000,
  }]);
});

test('buildConfig rejects invalid privacy regex', () => {
  assert.throws(
    () => buildConfig({ privacy: { skip_patterns: [{ name: 'bad', pattern: '[' }] } }, {}),
    /privacy\.skip_patterns\[0\]\.pattern is not a valid regex/
  );
});

test('buildConfig accepts global and per-group quoted-message settings', () => {
  const config = buildConfig({
    features: { quoted_message: { enabled: true, max_chars: 16000, max_depth: 4, include_attachments: true } },
    privacy: {
      groups: [{
        chat_id: 'oc_team',
        features: { quoted_message: { enabled: false, max_chars: 9000, max_depth: 2, include_attachments: false } },
      }],
    },
  }, {});

  assert.deepEqual(config.features.quotedMessage, {
    enabled: true, maxChars: 16000, maxDepth: 4, includeAttachments: true,
  });
  assert.deepEqual(config.privacy.groups?.[0]?.features, {
    quotedMessage: { enabled: false, maxChars: 9000, maxDepth: 2, includeAttachments: false },
  });
});

test('buildConfig validates quoted-message object fields and positive limits', () => {
  assert.throws(
    () => buildConfig({ features: true }, {}),
    /features must be an object/
  );
  assert.throws(
    () => buildConfig({ features: { quoted_message: { max_depth: 0 } } }, {}),
    /features\.quoted_message\.max_depth must be a positive integer/
  );
  assert.throws(
    () => buildConfig({ features: { quoted_message: { max_depth: 21 } } }, {}),
    /features\.quoted_message\.max_depth must be at most 20/
  );
  assert.throws(
    () => buildConfig({ features: { quoted_message: { include_attachments: 'sometimes' } } }, {}),
    /features\.quoted_message\.include_attachments must be a boolean/
  );
  assert.throws(
    () => buildConfig({ features: { quoted_message: true } }, {}),
    /features\.quoted_message must be an object/
  );
  assert.throws(
    () => buildConfig({ features: { quoted_message: { enabled: 'sometimes' } } }, {}),
    /features\.quoted_message\.enabled must be a boolean/
  );
  assert.throws(
    () => buildConfig({ features: { quoted_message: { max_chars: 0 } } }, {}),
    /features\.quoted_message\.max_chars must be a positive integer/
  );
  assert.throws(
    () => buildConfig({ privacy: { groups: [{ chat_id: 'oc_1', features: { quoted_message: { max_chars: 1.5 } } }] } }, {}),
    /privacy\.groups\[0\]\.features\.quoted_message\.max_chars must be a positive integer/
  );
});
