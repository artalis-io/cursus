import {useCallback,useContext,useLayoutEffect,useRef,useState} from 'react';
import {ApiError} from '@/lib/api';
import {WorkspaceActorContext,WorkspaceTenantContext} from '@/workspace';
import {PermissionsContext,RoleContext,usePermission} from '@/permissions';

export type LibraryPhase='loading'|'refreshing'|'ready'|'failed'|'denied';
interface Snapshot<T>{key:string;items:T[]|null;phase:LibraryPhase;error:unknown}
/** One in-memory snapshot, never shared between identities, permissions or days. */
export function useLibraryList<T>(open:boolean,dayId:string,fetchList:(signal:AbortSignal)=>Promise<T[]>){
  const tenant=useContext(WorkspaceTenantContext),actor=useContext(WorkspaceActorContext);
  const role=useContext(RoleContext),permissions=useContext(PermissionsContext);
  const allowed=usePermission('workspace.read');
  const key=JSON.stringify([tenant,actor,dayId,role,permissions]);
  const [snapshot,setSnapshot]=useState<Snapshot<T>|null>(null);
  const active=useRef({key:'',open:false,epoch:0});
  const request=useRef(0),controller=useRef<AbortController|null>(null);
  // Action completions (rename/delete/import/export) must obey the same scope
  // boundary as GETs, including close/reopen and permission changes.
  const capture=useCallback(()=>{
    const epoch=active.current.epoch;
    return ()=>active.current.open&&active.current.key===key&&active.current.epoch===epoch;
  },[key]);
  const refresh=useCallback(()=>{
    if(!allowed||!active.current.open||active.current.key!==key)return;
    controller.current?.abort();const ctrl=new AbortController();controller.current=ctrl;
    const id=++request.current,current=capture();
    setSnapshot(previous=>({key,items:previous?.key===key?previous.items:null,
      phase:previous?.key===key&&previous.items!==null?'refreshing':'loading',error:null}));
    void (async()=>{
      try{
        const items=await fetchList(ctrl.signal);
        if(!Array.isArray(items))throw new ApiError(null,'server','Invalid library response');
        if(current()&&id===request.current&&!ctrl.signal.aborted)setSnapshot({key,items,phase:'ready',error:null});
      }catch(error){
        if(!current()||id!==request.current||ctrl.signal.aborted)return;
        const denied=error instanceof ApiError&&[401,403].includes(error.status??0);
        setSnapshot(previous=>({key,items:denied?null:previous?.key===key?previous.items:null,phase:denied?'denied':'failed',error}));
      }
    })();
  },[allowed,key,capture,fetchList]);
  useLayoutEffect(()=>{
    if(active.current.key!==key||!allowed)setSnapshot(null);
    active.current={key,open:open&&allowed,epoch:active.current.epoch+1};
    if(open&&allowed)refresh();
    return()=>{active.current.open=false;active.current.epoch++;controller.current?.abort();};
  },[open,allowed,key,refresh]);
  // Hide old state during render, before effects can invalidate old requests.
  const current=allowed&&snapshot?.key===key?snapshot:null;
  const phase:LibraryPhase=!allowed?'denied':current?.phase??'loading';
  return {items:current?.items??null,phase,error:current?.error??null,refresh,capture,key,
    pending:phase==='loading'||phase==='refreshing',verified:phase==='ready'};
}
