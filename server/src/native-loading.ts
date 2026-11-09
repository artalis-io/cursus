import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requireNativeCapabilities} from './axle-loading.js';
import type {NativeLoadingCapabilities} from './loading-contract.js';
const run=promisify(execFile);
/** Explicit capability negotiation, bounded and abortable. Never infer support
 * from a version string, file name, or a successful non-loading solve. */
export async function probeLoadingCapabilities(binary:string,nodeBudget=10000,signal?:AbortSignal):Promise<NativeLoadingCapabilities>{
 const result=await run(binary,['--capabilities'],{signal,timeout:5000,maxBuffer:65536});
 const caps:unknown=JSON.parse(result.stdout);requireNativeCapabilities(caps,nodeBudget);return caps;
}
