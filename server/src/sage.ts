import { config } from './config.js';
import type { Plan } from './types.js';
import type { Comparison } from './plan/compare.js';

/* Sage narration via the DGX Spark LLM (OpenAI-compatible /v1 endpoint). The
 * narration is built from the PLAN's own figures and the model is asked to use
 * only those - so it summarizes, it does not invent. enable_thinking must be off
 * for the sgdflash demo engine (fast, clean output). Everything here degrades
 * gracefully: if Sage is unreachable the endpoints report it and the UI hides
 * the feature. */

export type Lang = 'en' | 'hu';
const langName = (l: Lang): string => (l === 'hu' ? 'Hungarian' : 'English');

async function chat(messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(`${config.sageOrigin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: config.sageModel,
      messages,
      temperature: 0.3,
      max_tokens: 400,
      stream: false,
      // sgdflash (Qwen-family): disable the thinking trace for fast, clean text.
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) throw new Error(`sage ${res.status}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content ?? '';
  return String(text).trim();
}

export async function sageReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${config.sageOrigin}/v1/models`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

const fmtSolve = (s: number | null): string => (s == null ? 'a saved prior result' : `${s}s`);

export async function narratePlan(plan: Plan, lang: Lang): Promise<string> {
  const s = plan.stats;
  const facts = [
    `Planning day: ${plan.day}`,
    `Result type: ${plan.source === 'saved' ? 'committed baseline' : 'live solve'} (status ${plan.provenance.termination})`,
    `Orders served: ${s.servedOrders} of ${s.totalOrders}; unassigned: ${plan.unassigned.length}`,
    `Vehicles used: ${s.vehiclesUsed}; trips: ${s.trips}; delivery stops: ${s.deliveryStops}`,
    `Total distance: ${s.totalDistanceKm} km`,
    `Solve time: ${fmtSolve(s.solveElapsedSeconds)}`,
    `Validation: ${plan.provenance.validation.valid ? 'all hard constraints satisfied' : `${plan.provenance.validation.violations.length} constraint issue(s)`}`,
    ...plan.vehicles.slice(0, 3).map((v) => `- ${v.ref} (${(v.vehicleClass ?? '').replace(/_/g, ' ')}): ${v.tripCount} trips, ${v.distanceKm} km, finish ${Math.floor(v.finishTimeSec / 3600)}:${String(Math.floor((v.finishTimeSec % 3600) / 60)).padStart(2, '0')}`),
  ].join('\n');

  return chat([
    { role: 'system', content: `You are Cursus, a logistics dispatch assistant. Write a concise (2-4 sentences), factual briefing for a fleet dispatcher in ${langName(lang)}. Use ONLY the figures provided; do not invent numbers or names. Plain prose, no markdown, no preamble.` },
    { role: 'user', content: `Summarize this delivery plan:\n${facts}` },
  ]);
}

export async function narrateComparison(cmp: Comparison, lang: Lang): Promise<string> {
  const b = cmp.base.stats, r = cmp.revised.stats, d = cmp.deltas;
  const facts = [
    `Baseline: ${b.servedOrders}/${b.totalOrders} served, ${b.vehiclesUsed} vehicles, ${b.totalDistanceKm} km, ${b.trips} trips.`,
    `Revised: ${r.servedOrders}/${r.totalOrders} served, ${r.vehiclesUsed} vehicles, ${r.totalDistanceKm} km, ${r.trips} trips.`,
    `Change: served ${d.servedOrders >= 0 ? '+' : ''}${d.servedOrders}, unassigned ${d.unassigned >= 0 ? '+' : ''}${d.unassigned}, vehicles ${d.vehiclesUsed >= 0 ? '+' : ''}${d.vehiclesUsed}, distance ${d.totalDistanceKm >= 0 ? '+' : ''}${d.totalDistanceKm} km.`,
    `Newly unassigned orders: ${cmp.newlyUnassigned.length}. Vehicles no longer used: ${cmp.removedVehicles.join(', ') || 'none'}.`,
  ].join('\n');

  return chat([
    { role: 'system', content: `You are Cursus, a logistics dispatch assistant. In ${langName(lang)}, write a concise (2-4 sentences) comparison for a dispatcher. Use ONLY the figures provided. If fewer orders are served, say so clearly and do not frame the distance reduction as pure efficiency. Plain prose, no markdown.` },
    { role: 'user', content: `Compare the baseline and revised plans:\n${facts}` },
  ]);
}
