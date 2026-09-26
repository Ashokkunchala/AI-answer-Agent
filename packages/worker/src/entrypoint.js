import app from './index.js';
import { InterviewSession } from './durable/interview-session.js';
import { InterviewAnalysisWorkflow } from './workflows/interview-analysis.js';
import { handleInterviewQueue } from './queues/interview.js';
import { handleInterviewAPI } from './interview-api.js';
import { handleInterviewVoiceSocket } from './voice/interview-socket.js';

const worker = {
  ...app,
  async fetch(request, env, ctx) {
    return handleInterviewAPI(request, env, ctx, (nextRequest) => app.fetch(nextRequest, env, ctx));
  },
  async queue(batch, env, ctx) {
    await handleInterviewQueue(batch, env, ctx);
  },
  websocket: {
    async handle(webSocket, env, ctx) {
      await handleInterviewVoiceSocket(webSocket, env, ctx);
    },
  },
};

export default worker;
export { InterviewSession, InterviewAnalysisWorkflow };
