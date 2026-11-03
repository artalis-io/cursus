/** One bound for API admission and native execution, including previously queued work. */
export function solveBudget(value:unknown,fallback:number,maximum:number,clamp=false):number{
 const seconds=value===undefined?Math.min(fallback,maximum):value;
 if(typeof seconds!=='number'||!Number.isFinite(seconds)||!Number.isInteger(seconds)||seconds<1)
  throw new Error('Optimization time must be a positive whole number of seconds');
 if(seconds>maximum&&!clamp)throw new Error(`Optimization time exceeds the server limit (${maximum}s)`);
 return Math.min(seconds,maximum);
}
