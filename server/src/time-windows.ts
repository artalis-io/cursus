/** Explicit, disjoint service-start windows. Envelope fields are display and
 * compatibility bounds only; they must never authorize service in a gap. */
export interface ServiceWindow {early:number;late:number}
export interface WindowFields {tw_early:number;tw_late:number;time_windows?:ServiceWindow[]}
const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=2147483647;
export function serviceWindows(task:WindowFields):ServiceWindow[]{
 const intervals=task.time_windows;
 if(intervals!==undefined){
  if(!Array.isArray(intervals)||intervals.length<2||intervals.length>255||intervals.some((w,i)=>!w||!Number.isSafeInteger(w.early)||!Number.isSafeInteger(w.late)||!valid(w.early)||!valid(w.late)||w.late<w.early||i>0&&w.early<=intervals[i-1]!.late))throw Error('Invalid disjoint service windows');
  if(task.tw_early!==undefined&&task.tw_early!==intervals[0]!.early||task.tw_late!==undefined&&task.tw_late!==intervals.at(-1)!.late)throw Error('Service-window envelope differs from intervals');
  return intervals.map(w=>({...w}));
 }
 if(!valid(task.tw_early)||!valid(task.tw_late)||task.tw_late<task.tw_early)throw Error('Invalid service window');
 return [{early:task.tw_early,late:task.tw_late}];
}
export function windowContains(start:number,windows:ServiceWindow[],epsilon=1e-6){return windows.some(w=>start>=w.early-epsilon&&start<=w.late+epsilon);}
export function serviceWindowStart(arrival:number,windows:ServiceWindow[]){
 for(const w of windows)if(arrival<=w.late)return Math.max(arrival,w.early);
 return arrival;
}
export function windowLateSeconds(start:number,windows:ServiceWindow[]){
 if(windowContains(start,windows))return 0;
 const past=windows.filter(w=>w.late<start);return past.length?start-past.at(-1)!.late:0;
}

/** Existing evaluators report contradictory legacy scalar bounds as invalid
 * Draft evidence. Admission still uses the strict serviceWindows validator. */
export function planningWindows(task:WindowFields):ServiceWindow[]{
 return task.time_windows?serviceWindows(task):[{early:task.tw_early,late:task.tw_late===0?Number.MAX_SAFE_INTEGER:task.tw_late}];
}
