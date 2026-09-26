import app from './index.js';
import { InterviewSession } from './durable/interview-session.js';
import { InterviewAnalysisWorkflow } from './workflows/interview-analysis.js';
import { handleInterviewQueue } from './queues/interview.js';

const worker = {
  ...app,
  async queue(batch, env, ctx) {
    await handleInterviewQueue(batch, env, ctx);
  },
};

export default worker;
export { InterviewSession, InterviewAnalysisWorkflow };
