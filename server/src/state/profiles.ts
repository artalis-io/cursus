import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth.js';
import { hasPermission, type Permission } from '../roles.js';
import { parseProfile, profileDigest, type ProfileRef, type ApprovedProfile, type ProfileContent } from '../planning-profiles.js';
import { WorkflowError } from './plan-workflow.js';
import type { StatefulStore } from './postgres.js';
import type { Scenario } from '../store.js';

/** Content is append-only. Activation selects an approved revision; existing
 * scenarios keep their explicit references until a dispatcher changes them. */
export class ProfileRepository {
  constructor(private store: StatefulStore, private tenantId: string) {}

  private async authorize(client: PoolClient, actor: Principal | undefined, permission: Permission) {
    if (!actor) return; // Explicit unauthenticated local development mode only.
    if (actor.tenantId !== this.tenantId) throw new WorkflowError(403,'Tenant mismatch.');
    const found=await client.query<{role:string}>('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[this.tenantId,actor.userId]);
    if(!hasPermission(found.rows[0]?.role,permission))throw new WorkflowError(403,'Profile permission changed.');
  }

  async list() {
    const result=await this.store.pool.query(`SELECT p.id,p.kind,p.version,p.active_revision,
      r.revision,r.body,r.sha256,r.proposed_at,r.approved_at,r.proposed_by,r.approved_by
      FROM planning_profiles p JOIN planning_profile_revisions r ON r.tenant_id=p.tenant_id AND r.profile_id=p.id
      WHERE p.tenant_id=$1 ORDER BY p.id,r.revision DESC`,[this.tenantId]);
    return result.rows;
  }

  async propose(value: unknown, version: number, id?: string, actor?: Principal) {
    const content=parseProfile(value),profileId=id??`profile_${randomUUID()}`;
    if(!Number.isSafeInteger(version)||version<0||!/^profile_[a-zA-Z0-9_-]{1,100}$/.test(profileId))throw new WorkflowError(400,'Invalid profile identity/version.');
    return this.store.tx(async client=>{
      await this.authorize(client,actor,'profile.propose');
      if(!id)await client.query('INSERT INTO planning_profiles(tenant_id,id,kind) VALUES($1,$2,$3)',[this.tenantId,profileId,content.kind]);
      const head=await client.query<{version:number;kind:string}>('SELECT version,kind FROM planning_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[this.tenantId,profileId]);
      if(!head.rows[0])throw new WorkflowError(404,'Profile not found.');
      if(head.rows[0].version!==version||head.rows[0].kind!==content.kind)throw new WorkflowError(409,'Profile changed; reload before proposing.');
      const next=await client.query<{revision:number}>('SELECT coalesce(max(revision),0)+1 revision FROM planning_profile_revisions WHERE tenant_id=$1 AND profile_id=$2',[this.tenantId,profileId]);
      const revision=next.rows[0]!.revision,sha256=profileDigest(content);
      await client.query('INSERT INTO planning_profile_revisions(tenant_id,profile_id,revision,body,sha256,proposed_by) VALUES($1,$2,$3,$4,$5,$6)',[this.tenantId,profileId,revision,content,sha256,actor?.userId??null]);
      await client.query('UPDATE planning_profiles SET version=version+1 WHERE tenant_id=$1 AND id=$2',[this.tenantId,profileId]);
      await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'profile.propose',$3)",[this.tenantId,actor?.userId??null,{profileId,revision,sha256}]);
      return {id:profileId,kind:content.kind,revision,sha256,version:version+1};
    });
  }

  async activate(id: string, revision: number, version: number, actor?: Principal) {
    if(!Number.isSafeInteger(revision)||revision<1||!Number.isSafeInteger(version)||version<0)throw new WorkflowError(400,'Invalid profile version.');
    return this.store.tx(async client=>{
      await this.authorize(client,actor,'profile.approve');
      const head=await client.query<{version:number;active_revision:number|null}>('SELECT version,active_revision FROM planning_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[this.tenantId,id]);
      if(!head.rows[0])throw new WorkflowError(404,'Profile not found.');
      if(head.rows[0].version!==version)throw new WorkflowError(409,'Profile changed; reload before approving.');
      const row=await client.query<{body:ProfileContent;sha256:string}>('SELECT body,sha256 FROM planning_profile_revisions WHERE tenant_id=$1 AND profile_id=$2 AND revision=$3',[this.tenantId,id,revision]);
      if(!row.rows[0])throw new WorkflowError(404,'Profile revision not found.');
      if(profileDigest(parseProfile(row.rows[0].body))!==row.rows[0].sha256)throw new WorkflowError(409,'Profile integrity check failed.');
      const admitted=await client.query("SELECT 1 FROM datasets WHERE tenant_id=$1 AND status='admitted' AND manifest->'artifacts'->'request'->>'sha256'=$2 LIMIT 1",[this.tenantId,row.rows[0].body.datasetSha256]);
      if(!admitted.rowCount)throw new WorkflowError(409,'Profile dataset is not admitted in this tenant.');
      if(head.rows[0].active_revision===revision)return {id,kind:row.rows[0].body.kind,revision,sha256:row.rows[0].sha256,version};
      await client.query('UPDATE planning_profile_revisions SET approved_at=coalesce(approved_at,now()),approved_by=CASE WHEN approved_at IS NULL THEN $4 ELSE approved_by END WHERE tenant_id=$1 AND profile_id=$2 AND revision=$3',[this.tenantId,id,revision,actor?.userId??null]);
      await client.query('UPDATE planning_profiles SET active_revision=$3,version=version+1 WHERE tenant_id=$1 AND id=$2',[this.tenantId,id,revision]);
      await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'profile.activate',$3)",[this.tenantId,actor?.userId??null,{profileId:id,revision,sha256:row.rows[0].sha256}]);
      return {id,kind:row.rows[0].body.kind,revision,sha256:row.rows[0].sha256,version:version+1};
    });
  }

  async resolve(refs: ProfileRef[]): Promise<ApprovedProfile[]> {
    if(!Array.isArray(refs)||refs.length>2)throw new WorkflowError(400,'At most one fleet and one location profile may be pinned.');
    const result:ApprovedProfile[]=[],kinds=new Set<string>();
    for(const ref of refs){
      if(!ref||!/^profile_[a-zA-Z0-9_-]{1,100}$/.test(ref.id)||!Number.isSafeInteger(ref.revision)||ref.revision<1||ref.revision>2147483647||!/^[a-f0-9]{64}$/.test(ref.sha256))
        throw new WorkflowError(400,'Invalid profile reference.');
      const found=await this.store.pool.query<{body:unknown;sha256:string;approved_at:Date|null;approved_by:string|null}>(
        'SELECT body,sha256,approved_at,approved_by FROM planning_profile_revisions WHERE tenant_id=$1 AND profile_id=$2 AND revision=$3',[this.tenantId,ref.id,ref.revision]);
      const row=found.rows[0];
      if(!row?.approved_at||row.sha256!==ref.sha256)throw new WorkflowError(409,'Approved profile revision unavailable.');
      const content=parseProfile(row.body);
      if(profileDigest(content)!==row.sha256||kinds.has(content.kind)||ref.kind!==content.kind)throw new WorkflowError(409,'Profile integrity or kind mismatch.');
      kinds.add(content.kind);result.push({...ref,content,approvedAt:row.approved_at.toISOString(),approvedBy:row.approved_by});
    }
    return result;
  }

  async assertDaySource(day:string,sha:string,client:Pick<PoolClient,'query'>=this.store.pool):Promise<void>{
    const sources=await client.query<{sha:string}>(`SELECT DISTINCT manifest->'artifacts'->'request'->>'sha256' sha FROM datasets
      WHERE tenant_id=$1 AND status='admitted' AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(manifest->'days')='array' THEN manifest->'days' ELSE '[]'::jsonb END) d
        WHERE d->>'dayId'=$2)`,[this.tenantId,day]);
    if(sources.rows.length!==1||sources.rows[0]!.sha!==sha)throw new WorkflowError(409,'Profile does not match the unambiguous admitted source for this planning day.');
  }

  async bind(scenarioId:string,revision:number,refs:ProfileRef[],actor?:Principal):Promise<Scenario>{
    const resolved=await this.resolve(refs);
    const checksums=new Set(resolved.map(p=>p.content.datasetSha256));
    if(checksums.size>1)throw new WorkflowError(409,'Profiles refer to different datasets.');
    return this.store.tx(async client=>{
      await this.authorize(client,actor,'scenario.edit');
      const found=await client.query<{body:Scenario;revision:string}>('SELECT body,revision FROM scenarios WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[this.tenantId,scenarioId]);
      const current=found.rows[0];
      if(!current)throw new WorkflowError(404,'Scenario not found.');
      if(Number(current.revision)!==revision)throw new WorkflowError(409,'Scenario changed; reload before selecting profiles.');
      const ordered=(values:ProfileRef[])=>JSON.stringify([...values].sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:0));
      if(ordered(refs)===ordered(current.body.planningProfiles??[]))return current.body;
      const sha=[...checksums][0];
      if(sha)await this.assertDaySource(current.body.day,sha,client);
      const bound=current.body.deliveryDatasetSha256??current.body.manualDecisions?.datasetSha256??current.body.planningPolicy?.datasetRequestSha256;
      if(sha&&bound&&sha!==bound)throw new WorkflowError(409,'Profile does not match the scenario dataset.');
      if(current.body.manualDecisions)throw new WorkflowError(409,'Create a clean scenario before changing profiles with retained manual decisions.');
      const updated:Scenario={...structuredClone(current.body),planningProfiles:structuredClone(refs),revision:revision+1};
      if(sha)updated.deliveryDatasetSha256=sha;
      if(updated.kind==='base'){
        updated.id=`scn_${randomUUID()}`;updated.kind='copy';updated.parentId=scenarioId;updated.label+= ' (profiles)';updated.createdAt=new Date().toISOString();
        delete updated.selectedPlanId;delete updated.selectionVersion;
        await client.query('INSERT INTO scenarios(tenant_id,id,revision,body) VALUES($1,$2,$3,$4)',[this.tenantId,updated.id,updated.revision,updated]);
      }else await client.query('UPDATE scenarios SET revision=$3,body=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2',[this.tenantId,scenarioId,updated.revision,updated]);
      await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'scenario.profiles',$3)",[this.tenantId,actor?.userId??null,{scenarioId:updated.id,revision:updated.revision,profiles:refs}]);
      return updated;
    });
  }
}
