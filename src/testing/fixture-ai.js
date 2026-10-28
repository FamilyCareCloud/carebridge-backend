import { randomUUID } from 'node:crypto';
import { evidenceSegments, hash } from '../carebridge-contract.js';

// Explicit synthetic fixture. Never imported by a production or normal local server.
export const fixtureAi = {
  enabled: true,
  async draft({ memo }) {
    const segments = evidenceSegments(memo).map(evidence => ({text:evidence.quote,evidence}));
    const codes = ['SOURCE_INTEGRITY','SOURCE_COVERAGE','EVIDENCE_PRESERVED','TRANSLATION_CONSISTENCY','OBSERVATION_GROUNDING','NUMERIC_FACTS_PRESERVED','NEGATION_SIGNAL_PRESERVED','UNCERTAINTY_SIGNAL_PRESERVED','FOLLOW_UP_GROUNDING','NO_IDENTIFIERS_DETECTED','NO_MEDICAL_JUDGMENT','NO_INSTRUCTIONS','SHARING_BLOCKED'];
    return {schema_version:'carebridge.v1',id:randomUUID(),status:'review_required',label:'검토 전 초안 · 공식기록 아님',mode:'source_preserving',source:{kind:'text',language:'ko',text:memo,sha256:hash(memo)},translation:{language:'ko',text:segments.map(s=>s.text).join('\n'),segments},observations:segments.map((s,i)=>({id:`o${i}`,category:'meal',...s})),additional_checks:[],qa:{checks:codes.map(code=>({code,passed:true})),issues:[{code:'HUMAN_REVIEW_REQUIRED',severity:'review',message:'합성 테스트 fixture · 실제 AI 검사 아님'}],requires_human_review:true,external_share_allowed:false}};
  },
  async qa(draft) {
    const qa = structuredClone(draft.qa);
    qa.checks.push(...['SEMANTIC_NEGATION','SEMANTIC_UNCERTAINTY','SEMANTIC_ADDED_FACTS','SEMANTIC_MEDICAL'].map(code=>({code,passed:true})));
    return {status:'review_required',model_checked:true,qa};
  },
};
