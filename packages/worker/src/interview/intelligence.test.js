import { strict as assert } from 'node:assert';
import { answerShield, interviewMode, scoreAnswerHeuristically } from './intelligence.js';
import { shouldGenerateAnswer, transcriptDelta } from '../voice/interview-pipeline.js';

assert.equal(interviewMode('How would you design an EKS platform?', 'interview'), 'system-design');
assert.equal(interviewMode('Tell me about a conflict with your team', 'interview'), 'behavioral');
assert.equal(transcriptDelta('How do you use', 'How do you use Terraform?'), 'Terraform?');
assert.equal(shouldGenerateAnswer({ currentTranscript: 'How do you use Terraform?', silenceMs: 700 }).ready, true);
assert.equal(answerShield('I would use Terraform to define infrastructure.', { question: 'How would you use Terraform?' }).passed, true);
assert.equal(scoreAnswerHeuristically('Explain Terraform', 'Terraform defines infrastructure as code.').overall > 0, true);

console.log('Interview intelligence tests passed.');
