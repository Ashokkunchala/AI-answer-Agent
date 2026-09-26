/**
 * SQLite-backed Durable Object for one live interview session.
 *
 * The Worker entrypoint should export this class and bind it as
 * INTERVIEW_SESSIONS after the resource is created. It is intentionally
 * isolated so existing voice WebSocket behavior is unchanged until enabled.
 */
export class InterviewSession {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.ready = state.blockConcurrencyWhile(async () => {
      await this.initialize();
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/state') {
      const rows = this.sql.exec(
        `SELECT key, value FROM session_state ORDER BY key`
      ).toArray();
      return Response.json({
        session_id: this.state.id.toString(),
        state: Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)])),
      });
    }

    if (request.method === 'POST' && url.pathname === '/state') {
      const body = await request.json();
      for (const [key, value] of Object.entries(body || {})) {
        this.sql.exec(
          `INSERT INTO session_state(key, value) VALUES(?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          key,
          JSON.stringify(value),
        );
      }
      return Response.json({ ok: true });
    }

    if (request.method === 'DELETE' && url.pathname === '/state') {
      this.sql.exec('DELETE FROM session_state');
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }

  async initialize() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }
}
