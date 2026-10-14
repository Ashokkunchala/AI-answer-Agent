// Legacy Durable Object classes kept so the Worker can be redeployed without a
// destructive `delete-class` migration. They are no longer used by the current
// feature set but an existing deployed Durable Object namespace still depends on
// `AgentSession`, so the class must remain exported.

const SESSION_MAX_TURNS = 200;

export class AudioEncoder {
  async fetch(request) {
    if (request.method !== 'POST') {
      return json({ error: 'POST required' }, 405);
    }
    try {
      const buffer = await request.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return json({ base64: btoa(bin), bytes: bytes.length });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
}

export class AgentSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  async load() {
    const data = await this.storage.get('session');
    return data && typeof data === 'object'
      ? data
      : { turns: [], totals: { requests: 0, neurons: 0, tokens: 0 }, dropped_turns: 0 };
  }

  async save(data) {
    await this.storage.put('session', data);
  }

  async fetch(request) {
    const method = request.method.toUpperCase();

    if (method === 'DELETE') {
      await this.storage.delete('session');
      return json({ ok: true });
    }

    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const session = await this.load();

      const turn = {
        turn_id: body.turn_id ?? (session.turns.length + 1),
        question: body.input ?? body.question ?? null,
        answer: body.output ?? body.answer ?? null,
        model: body.model ?? null,
        model_id: body.model_id ?? null,
        task_type: body.task_type ?? null,
        latency_ms: body.latency_ms ?? null,
        neurons: body.neurons ?? 0,
        tokens: body.tokens ?? 0,
        ts: body.ts ?? Date.now(),
      };
      session.turns.push(turn);

      if (session.turns.length > SESSION_MAX_TURNS) {
        const overflow = session.turns.length - SESSION_MAX_TURNS;
        session.turns.splice(0, overflow);
        session.dropped_turns = (session.dropped_turns || 0) + overflow;
      }

      session.totals = {
        requests: (session.totals?.requests || 0) + 1,
        neurons: (session.totals?.neurons || 0) + (Number(turn.neurons) || 0),
        tokens: (session.totals?.tokens || 0) + (Number(turn.tokens) || 0),
      };
      await this.save(session);
      return json({ ok: true, turn_id: turn.turn_id, turns: session.turns.length });
    }

    const session = await this.load();
    return json(session);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
