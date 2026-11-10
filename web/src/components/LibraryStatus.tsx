import {Button} from '@/components/ui/button';
import {useT,describeApiError} from '@/i18n';
import {LibraryReadTimeout,type LibraryPhase} from '@/hooks/useLibraryList';

export function LibraryStatus({phase,error,hasSnapshot,onRefresh}:{phase:LibraryPhase;error:unknown;hasSnapshot:boolean;onRefresh:()=>void}){
  const t=useT(),failed=phase==='failed'||phase==='denied',pending=phase==='loading'||phase==='refreshing';
  return <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
    {failed?<div role="alert" className="min-w-0 flex-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive">
      <p>{phase==='denied'?t('library.denied'):t('library.failed')}</p>
      {phase==='failed'&&error!=null&&<p>{error instanceof LibraryReadTimeout?t('library.timeout'):describeApiError(error,t)}</p>}
      {hasSnapshot&&<p className="mt-1">{t('library.stale')}</p>}
    </div>:pending?<p role="status" className="text-muted-foreground">{t(phase==='refreshing'?'library.refreshing':'history.loading')}</p>:<span/>}
    {(hasSnapshot||failed)&&<Button size="sm" variant="outline" disabled={pending} onClick={onRefresh}>{t(failed?'library.retry':pending?'library.refreshing':'library.refresh')}</Button>}
  </div>;
}
