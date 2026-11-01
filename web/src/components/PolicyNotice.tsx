import {useState} from 'react';
import {X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useT} from '@/i18n';

/** Dismiss only this explanation. Validation and release gates remain authoritative.
 * App keys the notice by plan and scenario revision; new context shows it again. */
export function PolicyNotice(){
 const t=useT(),[dismissed,setDismissed]=useState(false);
 if(dismissed)return null;
 return <div role="status" data-testid="policy-notice" className="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-1 text-sm">
  <span className="min-w-0 flex-1">{t('manual.policyChanged')}</span>
  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t('manual.dismissPolicyNotice')} title={t('manual.dismissPolicyNotice')} onClick={()=>setDismissed(true)}><X aria-hidden="true"/></Button>
 </div>;
}
