/** Background Queue consumer for non-latency-sensitive interview work. */

export async function handleInterviewQueue(batch, env) {
  for (const message of batch.messages || []) {
    try {
      const job = message.body || {};
      switch (job.type) {
        case 'interview.completed':
          // Keep this intentionally small: detailed analysis belongs in the
          // Workflow layer. Queue acknowledgement should remain fast.
          console.log('[Interview Queue] completed session:', job.sessionId || 'unknown');
          break;
        case 'asset.index':
          console.log('[Interview Queue] asset indexing requested:', job.objectKey || 'unknown');
          break;
        default:
          console.log('[Interview Queue] ignored job type:', job.type || 'unknown');
      }
      message.ack();
    } catch (error) {
      console.error('[Interview Queue] processing failed:', error);
      message.retry();
    }
  }
}
