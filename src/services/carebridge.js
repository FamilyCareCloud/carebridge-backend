import { randomUUID } from 'node:crypto';
import { fail, fields, text, choice, base64Audio } from '../domain.js';
import { CareGroupRepository, UserRepository } from '../repositories/index.js';
import { hash, categories, question, evidenceSegments, validateDraft, validateQa, validateReview, hasHold } from '../carebridge-contract.js';

const roleKey = g => 'carebridge-roles#'+g;
const indexKey = g => 'carebridge-index#'+g;
const noteKey = (g,id) => 'carebridge-note#'+g+'#'+id;
const versionKey = (g,id,v) => 'carebridge-version#'+g+'#'+id+'#'+v;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const requireVersion = (value, actual) => { if (!Number.isSafeInteger(value) || value < 1) fail(400,'대상 버전을 지정해 주세요.'); if (value !== actual) fail(409,'내용 또는 권한이 변경됐습니다. 다시 불러온 뒤 확인해 주세요.','CAREBRIDGE_STALE_VERSION'); };
const sourceText = value => { if (typeof value !== 'string' || !value.trim() || value.length > 4000 || evidenceSegments(value).length > 40) fail(400,'관찰 메모를 4,000자·40줄 이내로 입력해 주세요.'); return value; };
const languageCode = value => { if (typeof value !== 'string' || !/^(auto|[a-z]{2,3}(-[A-Za-z]{2,8})?)$/.test(value)) fail(400,'입력 언어를 확인해 주세요.'); return value; };
const attestation = body => { if (body.dataUse !== 'synthetic_deidentified') fail(400,'교육용 가상·비식별 메모 확인이 필요합니다.'); };
const summary = note => ({id:note.id,createdBy:note.createdBy,createdAt:note.createdAt,updatedAt:note.updatedAt,status:note.status,version:note.version,language:note.source.language,inputKind:note.inputKind,approvedAt:note.approvedAt});
const defaults = member => member.role === 'owner' ? 'reviewer' : member.role === 'elder' ? 'family' : 'author';

export class CarebridgeService {
  constructor(store, clock, ai) { this.store=store; this.clock=clock; this.ai=ai; }
  async access(tx, groupId, userId) {
    const {group,member} = await new CareGroupRepository(tx).forMember(groupId,userId);
    const policy = await tx.get(roleKey(groupId)) ?? {version:1,roles:{}};
    const role = member.role === 'owner' || member.role === 'elder' ? defaults(member) : policy.roles[userId] ?? defaults(member);
    return {group,member,policy,role};
  }
  canWrite(access) { if (!['author','reviewer'].includes(access.role)) fail(403,'작성자 또는 검토자 권한이 필요합니다.'); }
  canRead(access, note) { if (access.role !== 'reviewer' && !(access.role === 'author' && note.createdBy === access.member.userId)) fail(403,'이 초안을 확인할 권한이 없습니다.'); }
  async read(tx,g,id) {
    if (!uuid(id)) fail(404,'관찰 메모를 찾을 수 없습니다.');
    return await tx.get(noteKey(g,id)) ?? fail(404,'관찰 메모를 찾을 수 없습니다.');
  }
  async detail(tx,note) {
    const snapshot = await tx.get(versionKey(note.groupId,note.id,note.version));
    if (!snapshot) fail(500,'메모 버전을 읽지 못했습니다.');
    return {...note,draft:snapshot.draft,qa:snapshot.draft.qa};
  }
  async saveVersion(tx,note,draft,action,reason,actor) {
    const at = this.clock();
    const meta = {version:note.version,action,reason,by:actor,at,status:note.status};
    note.updatedAt=at;
    note.history.push({...meta,reason:reason.slice(0,48)});
    if (note.history.length > 500 && action !== 'hold') fail(413,'메모의 보관 버전 한도에 도달했습니다.');
    await tx.set(versionKey(note.groupId,note.id,note.version),{...meta,draft});
    await tx.set(noteKey(note.groupId,note.id),note);
    const index = await tx.get(indexKey(note.groupId)) ?? {items:[]};
    const atIndex = index.items.findIndex(n=>n.id===note.id);
    if (atIndex >= 0) index.items[atIndex]=summary(note); else index.items.push(summary(note));
    if (index.items.length > 500) fail(413,'교육용 그룹의 메모 한도에 도달했습니다.');
    await tx.set(indexKey(note.groupId),index);
    return {...note,draft,qa:draft.qa};
  }
  async handle(userId,g,method,path,body,query) {
    if (!uuid(g)) fail(404,'그룹을 찾을 수 없습니다.');
    const [resource,id,action,version] = path;
    const initial = await this.store.transaction(tx=>this.access(tx,g,userId));
    if (method !== 'GET' && resource !== 'roles') this.canWrite(initial);
    if (resource === 'roles' && path.length === 1) {
      if (method === 'GET') return {status:200,body:await this.roles(userId,g)};
      if (method === 'PATCH') return {status:200,body:await this.setRole(userId,g,body)};
    }
    if (resource === 'transcriptions' && path.length === 1 && method === 'POST') return {status:200,body:await this.transcribe(userId,g,body)};
    if (resource === 'family' && path.length === 1 && method === 'GET') return {status:200,body:await this.list(userId,g,query,true)};
    if (resource === 'notes' && path.length === 1) {
      if (method === 'GET') return {status:200,body:await this.list(userId,g,query,false)};
      if (method === 'POST') return {status:201,body:await this.create(userId,g,body)};
    }
    if (resource === 'notes' && path.length === 2 && method === 'GET') return {status:200,body:await this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId), note=await this.read(tx,g,id); this.canRead(a,note); return this.detail(tx,note);
    }, {validateReads:true})};
    if (resource === 'notes' && path.length === 2 && method === 'PATCH') return {status:200,body:await this.change(userId,g,id,'edit',body)};
    if (resource === 'notes' && path.length === 3 && ['review','check'].includes(action) && method === 'POST') return {status:200,body:await this.change(userId,g,id,action,body)};
    if (resource === 'notes' && path.length === 3 && action === 'preview' && method === 'GET') return {status:200,body:await this.preview(userId,g,id)};
    if (resource === 'notes' && action === 'versions' && [3,4].includes(path.length) && method === 'GET') return {status:200,body:await this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId), note=await this.read(tx,g,id); this.canRead(a,note);
      if (!version) return note.history;
      const v=Number(version);
      if (!Number.isSafeInteger(v) || v < 1 || v > note.version) fail(404,'버전을 찾을 수 없습니다.');
      return await tx.get(versionKey(g,id,v)) ?? fail(404,'버전을 찾을 수 없습니다.');
    }, {validateReads:true})};
    fail(404,'경로를 찾을 수 없습니다.');
  }
  async roles(userId,g) {
    return this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId), users=new UserRepository(tx), roles=[];
      for (const member of a.group.members) {
        const user=await users.findById(member.userId);
        roles.push({userId:member.userId,name:user?.name ?? '(탈퇴 사용자)',role:member.role === 'owner' || member.role === 'elder' ? defaults(member) : a.policy.roles[member.userId] ?? defaults(member),locked:member.role !== 'caregiver'});
      }
      return {version:a.policy.version,myRole:a.role,canManage:a.member.role === 'owner',roles,aiEnabled:Boolean(this.ai.enabled)};
    });
  }
  async setRole(userId,g,body) {
    fields(body,['expectedVersion','userId','role']);
    await this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId);
      if (a.member.role !== 'owner') fail(403,'그룹 소유자만 케어브릿지 역할을 지정할 수 있습니다.');
      requireVersion(body.expectedVersion,a.policy.version);
      const target=a.group.members.find(m=>m.userId===body.userId);
      if (!target || target.role !== 'caregiver') fail(400,'보호자 구성원만 역할을 변경할 수 있습니다.');
      a.policy.roles[body.userId]=choice(body.role,['author','reviewer','family'],'role');
      a.policy.version++;
      await tx.set(roleKey(g),a.policy);
    });
    return this.roles(userId,g);
  }
  async list(userId,g,query,family) {
    return this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId);
      if (!family) this.canWrite(a);
      const limit=Number(query.get('limit') ?? 20), cursor=query.get('cursor');
      if (!Number.isSafeInteger(limit)||limit<1||limit>50||cursor?.length>200) fail(400,'목록 범위를 확인해 주세요.');
      let items=(await tx.get(indexKey(g)))?.items ?? [];
      items=items.filter(n=>family ? n.status==='approved' : a.role==='reviewer'||n.createdBy===userId)
        .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
      if (cursor) {
        const i=items.findIndex(n=>n.id===cursor);
        if (i<0) fail(400,'목록이 변경됐습니다. 처음부터 다시 불러와 주세요.');
        items=items.slice(i+1);
      }
      const page=items.slice(0,limit);
      return {items:page,nextCursor:items.length>limit?page.at(-1).id:null};
    });
  }
  async create(userId,g,body) {
    fields(body,['memo','sourceLanguage','dataUse','requestId','inputKind']);
    attestation(body);
    const memo=sourceText(body.memo), language=languageCode(body.sourceLanguage??'auto');
    if (!uuid(body.requestId)) fail(400,'요청 식별자가 필요합니다.');
    const inputKind=choice(body.inputKind??'text',['text','transcript'],'inputKind');
    const fingerprint=hash(JSON.stringify({memo,language,inputKind}));
    const requestKey='carebridge-request#'+g+'#'+userId+'#'+body.requestId;
    const previous=await this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId); this.canWrite(a);
      const old=await tx.get(requestKey);
      if (!old) return null;
      if (old.fingerprint!==fingerprint) fail(409,'같은 요청 식별자로 다른 메모를 만들 수 없습니다.');
      const note=await this.read(tx,g,old.noteId); this.canRead(a,note); return this.detail(tx,note);
    });
    if (previous) return previous;
    const draft=validateDraft(await this.ai.draft({memo,source_language:language,data_use:'synthetic_deidentified'}),memo);
    return this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId); this.canWrite(a);
      const old=await tx.get(requestKey);
      if (old) {
        if(old.fingerprint!==fingerprint) fail(409,'요청 식별자가 변경됐습니다.');
        return this.detail(tx,await this.read(tx,g,old.noteId));
      }
      const at=this.clock();
      const note={id:randomUUID(),groupId:g,createdBy:userId,createdAt:at,updatedAt:at,source:structuredClone(draft.source),inputKind,version:1,status:draft.status,approvedVersion:null,approvedAt:null,approvedBy:null,history:[]};
      const result=await this.saveVersion(tx,note,draft,'create','검토 전 초안 생성',userId);
      await tx.set(requestKey,{fingerprint,noteId:note.id});
      return result;
    });
  }
  async transcribe(userId,g,body) {
    fields(body,['audioBase64','sourceLanguage','dataUse']);
    attestation(body);
    const language=languageCode(body.sourceLanguage??'auto');
    await this.store.transaction(async tx=>this.canWrite(await this.access(tx,g,userId)));
    if (typeof body.audioBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.audioBase64)) fail(400,'오디오 인코딩을 확인해 주세요.');
    const buffer=base64Audio(body.audioBase64,3*1024*1024-1024);
    const result=await this.ai.transcribe(buffer,language);
    if (typeof result?.text !== 'string'||!result.text.trim()||result.text.length>4000||result.requires_transcript_review!==true) fail(502,'전사 응답을 확인하지 못했습니다.','CAREBRIDGE_BAD_RESPONSE');
    // Membership/role may have been revoked during the network call.
    await this.store.transaction(async tx=>this.canWrite(await this.access(tx,g,userId)));
    return {text:result.text,requiresTranscriptReview:true};
  }
  async change(userId,g,id,operation,body) {
    const allowed=operation==='edit'?['expectedVersion','reason','segments']:operation==='check'?['expectedVersion']:['expectedVersion','decision','reason','confirmSource','confirmChecks'];
    fields(body,allowed);
    const decision=operation==='review'?choice(body.decision,['approve','hold'],'decision'):operation;
    const reason=operation==='check'?'QA 재검사':text(body.reason,'reason',1000);
    const captured=await this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId), note=await this.read(tx,g,id);
      this.canRead(a,note);
      if (operation==='review' && a.role!=='reviewer') fail(403,'검토자만 승인·보류할 수 있습니다.');
      if (decision==='approve' && note.createdBy===userId) fail(403,'자신이 작성한 메모는 다른 검토자가 승인해야 합니다.','CAREBRIDGE_SELF_APPROVAL');
      requireVersion(body.expectedVersion,note.version);
      if (decision==='approve' && note.status==='approved') fail(409,'이미 승인된 버전입니다.');
      return {note,...await this.detail(tx,note)};
    });
    const draft=structuredClone(captured.draft);
    if (operation==='edit') {
      if (!Array.isArray(body.segments)||body.segments.length!==draft.translation.segments.length) fail(400,'원문 구간을 모두 보존해야 합니다.');
      body.segments.forEach((segment,i)=>{
        fields(segment,['segmentId','text','category','needsConfirmation']);
        const translated=draft.translation.segments[i];
        if (segment.segmentId!==translated.evidence.segment_id||typeof segment.needsConfirmation!=='boolean') fail(400,'원문 구간 순서와 확인 여부를 확인해 주세요.');
        const value=sourceText(segment.text);
        if (!/[가-힣]/u.test(value)) fail(400,'한국어 관찰 초안을 입력해 주세요.');
        translated.text=value;
        draft.observations[i].text=value;
        draft.observations[i].category=choice(segment.category,categories,'category');
      });
      draft.translation.text=draft.translation.segments.map(t=>t.text).join('\n');
      draft.additional_checks=body.segments.flatMap((s,i)=>s.needsConfirmation?[{id:'c'+String(i+1).padStart(3,'0'),question,evidence:structuredClone(draft.translation.segments[i].evidence)}]:[]);
    }
    // Full source cannot be supplied by the caller. It is always the stored source.
    if (JSON.stringify(draft.source)!==JSON.stringify(captured.source)) fail(409,'저장된 원문이 일치하지 않습니다.');
    if (decision!=='hold') {
      draft.qa=validateReview(await this.ai.qa(draft));
      draft.status=hasHold(draft.qa)?'hold':'review_required';
    }
    if (decision==='approve') {
      if (body.confirmSource!==true || (draft.additional_checks.length && body.confirmChecks!==true)) fail(400,'원문 대조와 추가확인 완료를 표시해 주세요.');
      if (hasHold(draft.qa)) fail(409,'QA 보류 사유를 해결해야 승인할 수 있습니다.','CAREBRIDGE_QA_HOLD');
    }
    return this.store.transaction(async tx=>{
      const a=await this.access(tx,g,userId), note=await this.read(tx,g,id);
      this.canRead(a,note);
      if (operation==='review' && a.role!=='reviewer') fail(403,'검토자 권한이 변경됐습니다.');
      requireVersion(body.expectedVersion,note.version);
      if (JSON.stringify(note.source)!==JSON.stringify(captured.source)) fail(409,'원문이 변경됐습니다.');
      note.version++;
      note.status=decision==='approve'?'approved':decision==='hold'?'hold':draft.status;
      note.approvedVersion=decision==='approve'?note.version:null;
      note.approvedAt=decision==='approve'?this.clock():null;
      note.approvedBy=decision==='approve'?userId:null;
      return this.saveVersion(tx,note,draft,decision,reason,userId);
    });
  }
  async preview(userId,g,id) {
    return this.store.transaction(async tx=>{
      await this.access(tx,g,userId);
      const note=await this.read(tx,g,id);
      if (note.status!=='approved'||note.approvedVersion!==note.version) fail(409,'현재 버전은 승인되지 않아 가족 미리보기를 열 수 없습니다.','CAREBRIDGE_NOT_APPROVED');
      const snapshot=await tx.get(versionKey(g,id,note.version));
      if (!snapshot || hasHold(validateQa(snapshot.draft.qa,true))) fail(409,'승인 버전의 검사를 확인하지 못했습니다.');
      return {id:note.id,version:note.version,approvedAt:note.approvedAt,label:'담당자 검토 완료 · 교육용 미리보기 · 공식기록 아님',manualOnly:true,observations:snapshot.draft.observations.map(o=>({category:o.category,text:o.text}))};
    }, {validateReads:true});
  }
}
