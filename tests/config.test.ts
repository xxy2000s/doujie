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
      INFOHUNTER_DB_PATH: '/tmp/infohunter-test.db',
    }
  );

  assert.equal(config.codex.model, 'env-model');
  assert.match(config.codex.controlSessionDir, /\/\.doujie\/sessions$/);
  assert.deepEqual(config.feishu.chatIds, ['oc_1']);
  assert.equal(config.feishu.as, 'user');
  assert.deepEqual(config.feishu.botMentionIds, ['cli_bot']);
  assert.deepEqual(config.feishu.botMentionNames, ['豆姐']);
  assert.equal(config.storage.dbPath, '/tmp/doujie-test.db');
  assert.match(config.storage.backupDir, /backups$/);
  assert.match(config.storage.exportDir, /exports$/);
  assert.match(config.storage.attachmentCacheDir, /attachments$/);
  assert.deepEqual(config.privacy.skipPatterns, []);
  assert.equal(config.attachments.ocrCommand, null);
});

test('buildConfig accepts storage maintenance directories', () => {
  const config = buildConfig(
    {
      storage: {
        backup_dir: '~/infohunter-backups',
        export_dir: '/tmp/infohunter-exports',
        attachment_cache_dir: '/tmp/infohunter-attachments',
      },
      attachments: { ocr_command: 'ocr-local --plain' },
    },
    {}
  );

  assert.match(config.storage.backupDir, /infohunter-backups$/);
  assert.equal(config.storage.exportDir, '/tmp/infohunter-exports');
  assert.equal(config.storage.attachmentCacheDir, '/tmp/infohunter-attachments');
  assert.equal(config.attachments.ocrCommand, 'ocr-local --plain');
});

test('buildConfig leaves codex model empty by default', () => {
  const config = buildConfig({}, {});

  assert.equal(config.codex.model, '');
  assert.match(config.codex.controlSessionDir, /\/\.doujie\/sessions$/);
  assert.deepEqual(config.feishu.botMentionIds, []);
  assert.deepEqual(config.feishu.botMentionNames, []);
});

test('buildConfig accepts bot mention environment lists', () => {
  const config = buildConfig({}, {
    DOUJIE_FEISHU_BOT_MENTION_IDS: 'cli_1, ou_2',
    DOUJIE_FEISHU_BOT_MENTION_NAMES: '豆姐, Codex',
  });

  assert.deepEqual(config.feishu.botMentionIds, ['cli_1', 'ou_2']);
  assert.deepEqual(config.feishu.botMentionNames, ['豆姐', 'Codex']);
});

test('buildConfig accepts control session directory override', () => {
  const config = buildConfig({ codex: { control_session_dir: '~/doujie-control' } }, {
    DOUJIE_CODEX_CONTROL_SESSION_DIR: '/tmp/control-sessions',
  });

  assert.equal(config.codex.controlSessionDir, '/tmp/control-sessions');
});

test('buildConfig keeps legacy InfoHunter environment compatibility', () => {
  const config = buildConfig({}, {
    INFOHUNTER_FEISHU_BOT_MENTION_IDS: 'cli_legacy',
    INFOHUNTER_DB_PATH: '/tmp/infohunter-legacy.db',
    INFOHUNTER_CODEX_CONTROL_SESSION_DIR: '/tmp/legacy-control-sessions',
  });

  assert.deepEqual(config.feishu.botMentionIds, ['cli_legacy']);
  assert.equal(config.storage.dbPath, '/tmp/infohunter-legacy.db');
  assert.equal(config.codex.controlSessionDir, '/tmp/legacy-control-sessions');
});

test('buildConfig prefers Doujie YAML over legacy InfoHunter environment variables', () => {
  const config = buildConfig(
    {
      codex: {
        workdir: '/doujie/workdir',
        control_session_dir: '/doujie/sessions',
      },
      feishu: {
        bot_mention_ids: ['cli_doujie'],
      },
      storage: {
        db_path: '/doujie/data.db',
      },
    },
    {
      INFOHUNTER_CODEX_WORKDIR: '/legacy/workdir',
      INFOHUNTER_CODEX_CONTROL_SESSION_DIR: '/legacy/sessions',
      INFOHUNTER_FEISHU_BOT_MENTION_IDS: 'cli_legacy',
      INFOHUNTER_DB_PATH: '/legacy/data.db',
    }
  );

  assert.equal(config.codex.workdir, '/doujie/workdir');
  assert.equal(config.codex.controlSessionDir, '/doujie/sessions');
  assert.deepEqual(config.feishu.botMentionIds, ['cli_doujie']);
  assert.equal(config.storage.dbPath, '/doujie/data.db');
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

test('buildConfig rejects invalid privacy regex', () => {
  assert.throws(
    () => buildConfig({ privacy: { skip_patterns: [{ name: 'bad', pattern: '[' }] } }, {}),
    /privacy\.skip_patterns\[0\]\.pattern is not a valid regex/
  );
});
