import {createContext,useContext,useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {ChevronDown} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useT} from '@/i18n';

interface MenuSelection {close:()=>void}
const MenuContext=createContext<MenuSelection|null>(null);

/** Keep anchored controls reachable when the responsive header wraps. */
export function useAnchoredPanel(open:boolean,panel:RefObject<HTMLElement>,anchor?:RefObject<HTMLElement>){
 useLayoutEffect(()=>{
  if(!open)return;
  const position=()=>{
   const element=panel.current,target=anchor?.current??element?.parentElement;if(!element||!target)return;
   const rect=target.getBoundingClientRect();
   element.style.position='fixed';element.style.marginTop='0';element.style.right='auto';
   element.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-element.offsetWidth-8))}px`;
   element.style.top=`${Math.max(8,Math.min(rect.bottom+6,innerHeight-element.offsetHeight-8))}px`;
  };
  position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
  return()=>{window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);};
 },[open,panel,anchor]);
}

/** A disclosure of existing commands, not a planning stage or business state.
 * No backdrop: clicking Optimize outside an open menu must work the first time.
 * The root includes the trigger so its own mousedown cannot reopen the menu. */
export function WorkspaceMenu({label,open,onOpenChange,disabled=false,count=0,warn=false,children}:{
 label:string;open:boolean;onOpenChange:(open:boolean)=>void;disabled?:boolean;count?:number;warn?:boolean;children:ReactNode;
}){
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const initial=useRef<'first'|'last'>('first'),tabTimer=useRef<ReturnType<typeof setTimeout>>();
 const id=useId();
 useAnchoredPanel(open,panel,trigger);
 const items=()=>Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')??[]);
 useLayoutEffect(()=>{if(open){const enabled=items();(initial.current==='last'?enabled.at(-1):enabled[0])?.focus();}},[open]);
 useEffect(()=>{
  if(!open)return;
  const outside=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))onOpenChange(false);};
  // Disabling a pending async command can move focus to the document. Escape
  // must still dismiss the menu after a rejected/stale export response.
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onOpenChange(false);trigger.current?.focus();}};
  document.addEventListener('mousedown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',escape);clearTimeout(tabTimer.current);};
 },[open,onOpenChange]);
 const close=()=>{onOpenChange(false);trigger.current?.focus();};
 return <div ref={root} className="relative min-w-0">
  <Button ref={trigger} type="button" variant="graphite" size="sm" disabled={disabled}
   aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined}
   className={`gap-1.5 border ${warn?'border-warning/60 text-warning':'border-white/15'}`}
   onClick={()=>{initial.current='first';onOpenChange(!open);}}
   onKeyDown={event=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
     event.preventDefault();initial.current=event.key==='ArrowUp'?'last':'first';
     if(open){const enabled=items();(initial.current==='last'?enabled.at(-1):enabled[0])?.focus();}else onOpenChange(true);
    }
   }}>
   {label}{count>0&&<span aria-hidden className="rounded bg-warning px-1 text-[10px] text-graphite">{count>99?'99+':count}</span>}<ChevronDown aria-hidden className="h-3 w-3 opacity-70"/>
  </Button>
  {open&&<MenuContext.Provider value={{close}}><div ref={panel} id={id} role="menu" aria-label={label}
   className="absolute left-0 top-full z-50 mt-1.5 max-h-[65vh] w-max min-w-[220px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-divider bg-card p-2 text-foreground shadow-lg"
   onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.key==='Tab'){
     // Let native Tab move past tabindex=-1 items before removing the panel.
     tabTimer.current=setTimeout(()=>onOpenChange(false),0);return;
    }
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const enabled=items();if(!enabled.length)return;
    const index=enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(index+(event.key==='ArrowDown'?1:-1)+enabled.length)%enabled.length;
    enabled[next]?.focus();
   }}>{children}</div></MenuContext.Provider>}
 </div>;
}

export function WorkspaceMenuItem({label,onSelect,disabled=false,icon,count,closeOnSelect=true}:{
 label:string;onSelect:()=>void;disabled?:boolean;icon?:ReactNode;count?:number;closeOnSelect?:boolean;
}){
 const menu=useContext(MenuContext);
 return <button type="button" role="menuitem" tabIndex={-1} aria-label={label} disabled={disabled}
  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
  onClick={()=>{if(disabled)return;if(closeOnSelect)menu?.close();onSelect();}}>
  {icon&&<span aria-hidden className="shrink-0 text-muted-foreground">{icon}</span>}<span className="min-w-0 whitespace-normal">{label}</span>
  {!!count&&<span aria-hidden className="ml-auto rounded bg-muted px-1 text-[10px]">{count}</span>}
 </button>;
}

export interface WorkspaceCommand {label:string;onSelect:()=>void;disabled?:boolean;icon?:ReactNode;count?:number}
export function WorkspaceNavigation({prepare,planning,library,review,contextKey,issuesCount,pending=false}:{
 prepare:WorkspaceCommand[];planning:WorkspaceCommand[];library:WorkspaceCommand[];review:ReactNode;contextKey:string;issuesCount:number;pending?:boolean;
}){
 const t=useT(),[open,setOpen]=useState<string|null>(null);
 useLayoutEffect(()=>{setOpen(null);},[contextKey]);
 const group=(id:string,label:string,commands:WorkspaceCommand[])=><WorkspaceMenu key={id} label={label} disabled={pending} open={open===id} onOpenChange={next=>setOpen(next?id:null)} count={id==='plan'?issuesCount:0} warn={id==='plan'&&issuesCount>0}>
  {commands.map(command=><WorkspaceMenuItem key={command.label} {...command}/>)}</WorkspaceMenu>;
 return <nav aria-label={t('nav.workspace')} aria-busy={pending} className="flex min-w-0 flex-wrap items-center gap-1.5">
  {group('prepare',t('nav.prepare'),prepare)}{group('plan',t('nav.plan'),planning)}{review}{group('library',t('nav.library'),library)}
 </nav>;
}
