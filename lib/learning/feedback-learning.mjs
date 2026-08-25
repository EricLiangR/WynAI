import { randomUUID } from 'node:crypto';

const CATEGORIES = new Set(['correct', 'wrong_data', 'wrong_understanding', 'wrong_metric', 'wrong_display', 'other']);
function text(value, length = 1000) { return String(value || '').trim().slice(0, length); }

export class FeedbackLearningService {
  constructor({ feedbackPersistence = null, candidatePersistence = null, maxItems = 5000 } = {}) {
    this.feedbackPersistence = feedbackPersistence;
    this.candidatePersistence = candidatePersistence;
    this.maxItems = Math.max(100, Number(maxItems) || 5000);
    this.feedback = [];
    this.candidates = [];
  }

  async init() {
    if (this.feedbackPersistence) this.feedback = (await this.feedbackPersistence.init()).slice(0, this.maxItems);
    if (this.candidatePersistence) this.candidates = (await this.candidatePersistence.init()).slice(0, this.maxItems);
    return this;
  }

  async submit(input = {}, context = {}) {
    const category = CATEGORIES.has(input.category) ? input.category : 'other';
    const feedback = {
      id: `feedback-${randomUUID()}`, schema: 'wynai.user-feedback/v1', conversationId: text(context.conversationId, 120), turnId: text(input.turnId || context.turnId, 120) || null,
      traceId: text(input.traceId || context.traceId, 120) || null, datasetId: text(context.datasetId, 120), organizationId: text(context.organizationId, 120) || null,
      userId: text(context.userId, 120) || null, category, helpful: category === 'correct', comment: text(input.comment, 2000), correction: text(input.correction, 2000),
      question: text(context.question, 2000), answer: text(context.answer, 4000), semanticSnapshot: context.semanticSnapshot || null, createdAt: new Date().toISOString(),
    };
    this.feedback.unshift(feedback);
    this.feedback = this.feedback.slice(0, this.maxItems);
    if (this.feedbackPersistence) await this.feedbackPersistence.save(feedback);
    const candidate = {
      id: `learning-candidate-${randomUUID()}`, schema: 'wynai.learning-candidate/v1', kind: category === 'wrong_metric' ? 'skill-rule' : 'evaluation-case', status: 'pending_review',
      sourceFeedbackId: feedback.id, datasetId: feedback.datasetId, organizationId: feedback.organizationId, proposedBy: feedback.userId || 'anonymous', question: feedback.question,
      expectedCorrection: feedback.correction || feedback.comment || (category === 'correct' ? '保持当前意图和结果' : ''), semanticSnapshot: feedback.semanticSnapshot,
      createdAt: feedback.createdAt, reviewedAt: null, reviewedBy: null, reviewReason: '',
    };
    this.candidates.unshift(candidate);
    this.candidates = this.candidates.slice(0, this.maxItems);
    if (this.candidatePersistence) await this.candidatePersistence.save(candidate);
    return { feedback, candidate };
  }

  listFeedback({ limit = 100 } = {}) { return this.feedback.slice(0, Math.max(1, Math.min(this.maxItems, Number(limit) || 100))); }
  listCandidates({ limit = 100, status = null } = {}) { return this.candidates.filter(item => !status || item.status === status).slice(0, Math.max(1, Math.min(this.maxItems, Number(limit) || 100))); }
  async review(id, status, { actor = 'system', reason = '' } = {}) {
    if (!['approved_for_authoring', 'rejected'].includes(status)) throw Object.assign(new Error('候选知识审核状态无效'), { status: 400 });
    const current = this.candidates.find(item => item.id === id);
    if (!current) throw Object.assign(new Error('候选知识不存在'), { status: 404 });
    const reviewed = { ...current, status, reviewedAt: new Date().toISOString(), reviewedBy: text(actor, 120), reviewReason: text(reason, 1000) };
    this.candidates = [reviewed, ...this.candidates.filter(item => item.id !== id)].slice(0, this.maxItems);
    if (this.candidatePersistence) await this.candidatePersistence.save(reviewed);
    return reviewed;
  }
}

