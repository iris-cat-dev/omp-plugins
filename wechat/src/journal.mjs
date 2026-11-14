import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A single installation owns this database. Never acknowledge a receiver batch before ingest returns. */
export class Journal {
  constructor(filename, accountId) {
    if (!path.isAbsolute(filename) || !/^wxid_[A-Za-z0-9_-]{1,120}$/.test(accountId)) throw new TypeError('Invalid journal identity');
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), account TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY, peer TEXT NOT NULL, message TEXT NOT NULL, body TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','processing','completed','unknown','failed')), UNIQUE(peer,message)) STRICT;
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, inbox_seq INTEGER NOT NULL UNIQUE REFERENCES inbox(seq), peer TEXT NOT NULL,
          payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('unknown','submitted','failed'))) STRICT;
        CREATE TABLE IF NOT EXISTS image_outbox (id TEXT PRIMARY KEY, peer TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('unknown','submitted','failed'))) STRICT;
        CREATE TABLE IF NOT EXISTS send_reviews (id TEXT PRIMARY KEY, reviewed_at INTEGER NOT NULL, resolution TEXT NOT NULL CHECK(resolution='checked_no_retry')) STRICT;
        CREATE TABLE IF NOT EXISTS send_details (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, summary TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS text_parts (id TEXT PRIMARY KEY, inbox_seq INTEGER NOT NULL REFERENCES inbox(seq), ordinal INTEGER NOT NULL,
          peer TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','unknown','submitted','failed','canceled')),
          UNIQUE(inbox_seq,ordinal)) STRICT;`);
      this.transaction(() => {
        const identity = this.db.prepare('SELECT account FROM identity WHERE id=1').get();
        if (identity && identity.account !== accountId) throw new Error('Journal belongs to another account');
        if (!identity) this.db.prepare('INSERT INTO identity VALUES(1,?)').run(accountId);
        // A model or send interrupted by process loss must never be replayed automatically.
        this.db.exec("UPDATE inbox SET state='unknown' WHERE state='processing'");
      });
      this.accountId = accountId;
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  ingest(events, allowedTargets) {
    const allowed = new Set(allowedTargets);
    return this.transaction(() => {
      const find = this.db.prepare('SELECT body FROM inbox WHERE peer=? AND message=?');
      const insert = this.db.prepare('INSERT INTO inbox(peer,message,body,state) VALUES(?,?,?,?)');
      for (const event of events) {
        if (event.accountId !== this.accountId || !allowed.has(event.sessionId) || event.scope !== (event.sessionId.endsWith('@chatroom') ? 'group' : 'private') || (event.scope === 'private' && event.senderId !== event.sessionId) || event.senderId === this.accountId || !/^[1-9][0-9]{0,19}$/.test(event.messageId)) throw new Error('Unscoped inbound event');
        const body = JSON.stringify(event);
        const existing = find.get(event.sessionId, event.messageId);
        if (existing && existing.body !== body) throw new Error('Conflicting inbound message identity');
        if (!existing) insert.run(event.sessionId, event.messageId, body,
          event.scope === 'group' && !event.mentions.includes(this.accountId) ? 'completed' : 'queued');
      }
    });
  }
  unknownSends() {
    return this.db.prepare(`SELECT o.id,o.peer,'text' AS kind,d.created_at AS createdAt,COALESCE(d.summary,substr(o.payload,1,200)) AS summary FROM outbox o LEFT JOIN send_details d ON d.id=o.id WHERE o.state='unknown' AND o.id NOT IN (SELECT id FROM send_reviews)
      UNION ALL SELECT o.id,o.peer,'image' AS kind,d.created_at AS createdAt,d.summary FROM image_outbox o LEFT JOIN send_details d ON d.id=o.id WHERE o.state='unknown' AND o.id NOT IN (SELECT id FROM send_reviews)
      UNION ALL SELECT o.id,o.peer,'text' AS kind,d.created_at AS createdAt,d.summary FROM text_parts o LEFT JOIN send_details d ON d.id=o.id WHERE o.state='unknown' AND o.id NOT IN (SELECT id FROM send_reviews)`).all();
  }
  hasUnknownSend() { return this.unknownSends().length !== 0; }
  interruptedMessages() {
    const rows = this.db.prepare(`SELECT i.seq,i.peer,i.body,
      (SELECT COUNT(*) FROM text_parts p WHERE p.inbox_seq=i.seq AND p.state='submitted') AS submittedParts
      FROM inbox i WHERE i.state='unknown'
      AND NOT EXISTS (SELECT 1 FROM text_parts p WHERE p.inbox_seq=i.seq AND p.state='unknown' AND p.id NOT IN (SELECT id FROM send_reviews))
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.inbox_seq=i.seq AND o.state='unknown' AND o.id NOT IN (SELECT id FROM send_reviews))
      ORDER BY i.seq`).all();
    return rows.map(row => ({ seq: row.seq, peer: row.peer, message: Array.from(JSON.parse(row.body).text).slice(0, 200).join(''), submittedParts: row.submittedParts }));
  }
  closeInterrupted(seq) {
    this.transaction(() => {
      if (!this.interruptedMessages().some(row => row.seq === seq)) throw new Error('中断消息不存在，或仍有待核对的发送');
      this.db.prepare("UPDATE text_parts SET state='canceled' WHERE inbox_seq=? AND state='pending'").run(seq);
      this.db.prepare("UPDATE inbox SET state='failed' WHERE seq=? AND state='unknown'").run(seq);
    });
  }
  revokeExcept(targets) {
    if (!targets.length) this.db.prepare("UPDATE inbox SET state='failed' WHERE state='queued'").run();
    else this.db.prepare(`UPDATE inbox SET state='failed' WHERE state='queued' AND peer NOT IN (${targets.map(() => '?').join(',')})`).run(...targets);
  }
  claim() {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT i.seq,i.body FROM inbox i WHERE i.state='queued'
        AND NOT EXISTS (SELECT 1 FROM inbox earlier WHERE earlier.peer=i.peer AND earlier.seq<i.seq AND earlier.state IN ('queued','processing','unknown'))
        ORDER BY i.seq LIMIT 1`).get();
      if (!row) return null;
      this.db.prepare("UPDATE inbox SET state='processing' WHERE seq=?").run(row.seq);
      return { seq: row.seq, event: JSON.parse(row.body) };
    });
  }
  prepareText(seq, peer, chunks) {
    if (!Array.isArray(chunks) || !chunks.length || chunks.some(text => typeof text !== 'string' || !text || text.includes('\0') || Buffer.byteLength(text) > 4094 || text.length > 2047)) throw new Error('无效的文本分段');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT peer,state FROM inbox WHERE seq=?').get(seq);
      if (!row || row.peer !== peer || row.state !== 'processing') throw new Error('Invalid send authority');
      const insert = this.db.prepare("INSERT INTO text_parts VALUES(?,?,?,?,?,'pending')");
      const details = this.db.prepare('INSERT INTO send_details VALUES(?,?,?)');
      return chunks.map((text, ordinal) => {
        const id = randomUUID().replaceAll('-', '');
        insert.run(id, seq, ordinal, peer, text);
        details.run(id, Date.now(), text.slice(0, 200));
        return { id, text };
      });
    });
  }
  beginPart(id) {
    const result = this.db.prepare(`UPDATE text_parts AS p SET state='unknown' WHERE p.id=? AND p.state='pending'
      AND EXISTS (SELECT 1 FROM inbox WHERE seq=p.inbox_seq AND state='processing')
      AND NOT EXISTS (SELECT 1 FROM text_parts earlier WHERE earlier.inbox_seq=p.inbox_seq AND earlier.ordinal<p.ordinal AND earlier.state!='submitted')`).run(id);
    if (result.changes !== 1) throw new Error('文本分段不能重复提交');
  }
  finishPart(id, state) {
    if (!['submitted', 'failed'].includes(state)) throw new TypeError('Invalid send result');
    this.transaction(() => {
      const part = this.db.prepare("SELECT inbox_seq FROM text_parts WHERE id=? AND state='unknown'").get(id);
      if (!part) throw new Error('文本分段不在待确认状态');
      this.db.prepare('UPDATE text_parts SET state=? WHERE id=?').run(state, id);
      if (state === 'failed') {
        this.db.prepare("UPDATE text_parts SET state='canceled' WHERE inbox_seq=? AND state='pending'").run(part.inbox_seq);
        this.db.prepare("UPDATE inbox SET state='failed' WHERE seq=?").run(part.inbox_seq);
      } else if (!this.db.prepare("SELECT 1 FROM text_parts WHERE inbox_seq=? AND state!='submitted' LIMIT 1").get(part.inbox_seq)) {
        this.db.prepare("UPDATE inbox SET state='completed' WHERE seq=?").run(part.inbox_seq);
      }
    });
  }
  beginImage(peer, name = '') {
    return this.transaction(() => {
      const id = randomUUID().replaceAll('-', '');
      this.db.prepare("INSERT INTO image_outbox VALUES(?,?,'unknown')").run(id, peer);
      this.db.prepare('INSERT INTO send_details VALUES(?,?,?)').run(id, Date.now(), name.slice(0, 200));
      return id;
    });
  }
  finishImage(id, state) {
    if (!['submitted', 'failed'].includes(state)) throw new TypeError('Invalid send result');
    const result = this.db.prepare("UPDATE image_outbox SET state=? WHERE id=? AND state='unknown'").run(state, id);
    if (result.changes !== 1) throw new Error('Image send is not pending');
  }
  closeUnknown(id) {
    this.transaction(() => {
      const row = this.unknownSends().find(item => item.id === id);
      if (!row) throw new Error('未知发送记录不存在或已封口');
      this.db.prepare("INSERT INTO send_reviews VALUES(?,?,'checked_no_retry')").run(id, Date.now());
      if (row.kind === 'text') {
        const part = this.db.prepare('SELECT inbox_seq FROM text_parts WHERE id=?').get(id);
        if (part) {
          this.db.prepare("UPDATE text_parts SET state='canceled' WHERE inbox_seq=? AND state='pending'").run(part.inbox_seq);
          this.db.prepare("UPDATE inbox SET state='failed' WHERE seq=? AND state IN ('processing','unknown')").run(part.inbox_seq);
        } else this.db.prepare("UPDATE inbox SET state='failed' WHERE seq=(SELECT inbox_seq FROM outbox WHERE id=?) AND state IN ('processing','unknown')").run(id);
      }
    });
  }
  finishWithoutSend(seq, state) {
    if (!['failed', 'unknown'].includes(state)) throw new TypeError('Invalid result');
    const result = this.db.prepare("UPDATE inbox SET state=? WHERE seq=? AND state='processing'").run(state, seq);
    if (result.changes !== 1) throw new Error('Message is not processing');
  }
  close() { this.db.close(); }
}
