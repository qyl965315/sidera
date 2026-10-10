import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrateCompatibleProviderStorage, migrateDeepSeekCallAccounting } from "../core/db.ts";

for (const oldLimit of [1024, 4096]) test(
  `DeepSeek call accounting migration preserves ${oldLimit}-cap history`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE deepseek_api_calls (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
        model_id TEXT NOT NULL,
        max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND ${oldLimit}),
        state TEXT NOT NULL CHECK (state IN ('started','accepted','completed','rejected','uncertain')),
        host_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO deepseek_api_calls VALUES
        ('old','session','message','deepseek-flash',${oldLimit},'uncertain',NULL,'now','now');`);
      migrateDeepSeekCallAccounting(db);
      migrateDeepSeekCallAccounting(db);
      db.exec("CREATE TABLE deepseek_session_history (session_id TEXT PRIMARY KEY, messages_json TEXT, updated_at TEXT); INSERT INTO deepseek_session_history VALUES ('session','[]','now')");
      migrateCompatibleProviderStorage(db);
      migrateCompatibleProviderStorage(db);
      assert.equal(db.prepare("SELECT max_tokens FROM api_calls WHERE call_id='old'")
        .get()?.max_tokens, oldLimit);
      assert.equal(db.prepare("SELECT provider_id FROM api_calls WHERE call_id='old'")
        .get()?.provider_id, "deepseek");
      assert.equal(db.prepare("SELECT messages_json FROM api_session_history WHERE session_id='session'")
        .get()?.messages_json, "[]");
      db.prepare(`INSERT INTO api_calls
        (call_id,session_id,message_id,model_id,max_tokens,state,created_at,updated_at)
        VALUES ('next','session','message-next','deepseek-flash',8192,'started','now','now')`).run();
      db.prepare(`UPDATE api_calls SET finish_reason='stop', prompt_tokens=120,
        completion_tokens=40, total_tokens=160 WHERE call_id='next'`).run();
      assert.deepEqual({ ...db.prepare(`SELECT finish_reason,prompt_tokens,
        completion_tokens,total_tokens FROM api_calls WHERE call_id='next'`).get() },
      { finish_reason: "stop", prompt_tokens: 120,
        completion_tokens: 40, total_tokens: 160 });
    } finally { db.close(); }
  });
