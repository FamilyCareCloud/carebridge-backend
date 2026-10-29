import { createHash } from 'node:crypto';
import { fail } from './domain.js';

export const categories = ['meal','hydration','mobility','sleep','hygiene','medication','condition','other'];
export const question = '이 관찰의 의미와 빠진 정보를 원문 작성자에게 확인해 주세요.';
export const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const baseChecks = ['SOURCE_INTEGRITY','SOURCE_COVERAGE','EVIDENCE_PRESERVED','TRANSLATION_CONSISTENCY','OBSERVATION_GROUNDING','NUMERIC_FACTS_PRESERVED','ASSISTANCE_FACT_PRESERVED','NEGATION_SIGNAL_PRESERVED','UNCERTAINTY_SIGNAL_PRESERVED','FOLLOW_UP_GROUNDING','NO_IDENTIFIERS_DETECTED','NO_MEDICAL_JUDGMENT','NO_INSTRUCTIONS','SHARING_BLOCKED'];
const semanticChecks = ['SEMANTIC_NEGATION','SEMANTIC_UNCERTAINTY','SEMANTIC_ADDED_FACTS','SEMANTIC_MEDICAL','SEMANTIC_OMITTED_FACTS'];
const bad = () => fail(502, 'AI 응답의 근거·형식을 확인하지 못했습니다.', 'CAREBRIDGE_BAD_RESPONSE');
const ensure = value => { if (!value) bad(); };
const bounded = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const hasHold = qa => qa.checks.some(c => !c.passed) || qa.issues.some(i => i.severity === 'hold');
export function validateQa(qa, semantic = false) {
  ensure(object(qa) && qa.external_share_allowed === false && qa.requires_human_review === true);
  ensure(Array.isArray(qa.checks) && qa.checks.length <= 40 && Array.isArray(qa.issues) && qa.issues.length <= 200);
  ensure(qa.checks.every(c => object(c) && bounded(c.code,100) && typeof c.passed === 'boolean'));
  ensure(new Set(qa.checks.map(c => c.code)).size === qa.checks.length);
  ensure([...baseChecks,...(semantic ? semanticChecks : [])].every(code => qa.checks.some(c => c.code === code)));
  ensure(qa.issues.every(i => object(i) && bounded(i.code,100) && ['hold','review'].includes(i.severity) && bounded(i.message,2000)));
  ensure(qa.issues.some(i => i.code === 'HUMAN_REVIEW_REQUIRED' && i.severity === 'review'));
  return qa;
}
export function evidenceSegments(source) {
  const points = Array.from(source), result = [];
  let start = 0;
  while (start < points.length) {
    let end = start;
    while (end < points.length && points[end] !== '\r' && points[end] !== '\n') end++;
    let left = start, right = end;
    while (left < right && /\s/u.test(points[left])) left++;
    while (right > left && /\s/u.test(points[right-1])) right--;
    if (right > left) result.push({segment_id:'s'+String(result.length+1).padStart(3,'0'),start:left,end:right,quote:points.slice(left,right).join('')});
    start = end + 1;
  }
  return result;
}
const sameEvidence = (a,b) => object(a) && a.segment_id === b.segment_id && a.start === b.start && a.end === b.end && a.quote === b.quote;
export function validateDraft(draft, expectedSource) {
  ensure(object(draft) && Buffer.byteLength(JSON.stringify(draft)) <= 240000);
  ensure(draft.schema_version === 'carebridge.v1' && ['hold','review_required'].includes(draft.status));
  ensure(draft.label === '검토 전 초안 · 공식기록 아님' && bounded(draft.id,100));
  ensure(['source_preserving','model_translation'].includes(draft.mode));
  ensure(object(draft.source) && draft.source.kind === 'text' && bounded(draft.source.text));
  ensure(draft.source.text === expectedSource && draft.source.sha256 === hash(expectedSource));
  ensure(/^(auto|[a-z]{2,3}(-[A-Za-z]{2,8})?)$/.test(draft.source.language));
  const expected = evidenceSegments(expectedSource);
  ensure(expected.length > 0 && expected.length <= 40);
  ensure(object(draft.translation) && draft.translation.language === 'ko' && Array.isArray(draft.translation.segments));
  const translated = draft.translation.segments;
  ensure(translated.length === expected.length);
  ensure(translated.every((t,i) => object(t) && bounded(t.text) && /[가-힣]/u.test(t.text) && sameEvidence(t.evidence,expected[i])));
  ensure(draft.translation.text === translated.map(t => t.text).join('\n'));
  ensure(Array.isArray(draft.observations) && draft.observations.length === translated.length);
  ensure(draft.observations.every((o,i) => object(o) && bounded(o.id,100) && categories.includes(o.category) && o.text === translated[i].text && sameEvidence(o.evidence,expected[i])));
  ensure(new Set(draft.observations.map(o => o.id)).size === translated.length);
  ensure(Array.isArray(draft.additional_checks) && draft.additional_checks.length <= 40);
  ensure(draft.additional_checks.every(c => object(c) && bounded(c.id,100) && c.question === question && expected.some(e => sameEvidence(c.evidence,e))));
  ensure(new Set(draft.additional_checks.map(c => c.evidence.segment_id)).size === draft.additional_checks.length);
  validateQa(draft.qa);
  ensure(draft.status === (hasHold(draft.qa) ? 'hold' : 'review_required'));
  return structuredClone(draft);
}
export function validateReview(value, draft) {
  ensure(object(value) && ['hold','review_required'].includes(value.status) && typeof value.model_checked === 'boolean');
  validateQa(value.qa, value.model_checked);
  ensure(value.status === (hasHold(value.qa) ? 'hold' : 'review_required'));
  ensure(Array.isArray(value.segments));
  if (value.model_checked) {
    const expected = draft?.translation?.segments;
    ensure(Array.isArray(expected) && expected.length > 0 && value.segments.length === expected.length);
    ensure(value.segments.every((s,i) => object(s) && sameEvidence(s.evidence,expected[i].evidence)
      && Array.isArray(s.checks) && s.checks.length === semanticChecks.length
      && s.checks.every(c=>object(c) && semanticChecks.includes(c.code) && typeof c.passed === 'boolean')
      && new Set(s.checks.map(c=>c.code)).size === semanticChecks.length));
    ensure(semanticChecks.every(code => value.qa.checks.find(c=>c.code===code).passed
      === value.segments.every(s=>s.checks.find(c=>c.code===code).passed)));
  } else {
    ensure(value.status === 'hold' && value.segments.length === 0);
    const explicitOmissionHold = value.qa.checks.some(c=>c.code==='SEMANTIC_OMITTED_FACTS' && c.passed===false)
      && value.qa.issues.some(i=>i.code==='SEMANTIC_OMITTED_FACTS' && i.severity==='hold');
    ensure(baseChecks.some(code=>value.qa.checks.find(c=>c.code===code).passed===false) || explicitOmissionHold);
  }
  return value.qa;
}
