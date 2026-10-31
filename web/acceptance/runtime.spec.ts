import type {Workflow} from '../../server/src/workflow-contract';
import {selectWorkspaceAction,openWorkspaceMenu} from '../tests/workspace-navigation';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { DaySummary, Plan, Scenario, PlacementSuggestions } from '../src/types';

const peer = process.env.CURSUS_ACCEPTANCE_PEER!;
const compose = JSON.parse(process.env.CURSUS_ACCEPTANCE_COMPOSE ?? 'null') as string[] | null;
const expectedOrders = ['PUBLIC-1', 'PUBLIC-2', 'PUBLIC-3', 'PUBLIC-5', 'PUBLIC-6', 'PUBLIC-7'];

async function manualStop(page:Page,plan:Plan,orderNo:string){
  const vehicle=plan.vehicles.find(v=>v.trips.some(tr=>tr.stops.some(s=>s.orderNo===orderNo)))!;
  const trip=vehicle.trips.find(tr=>tr.stops.some(s=>s.orderNo===orderNo))!;
  const stop=trip.stops.find(s=>s.orderNo===orderNo)!;
  await page.locator('aside').first().getByText(vehicle.ref,{exact:true}).click();
  const inspector=page.locator('aside').last();
  await inspector.getByRole('button',{name:new RegExp(`Trip ${trip.index+1} ·`)}).click();
  await inspector.locator('ol li > button').filter({hasText:stop.customer!}).click();
}
async function applyManualDialog(page:Page):Promise<Plan>{
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  const before=await get<Plan[]>(page.request,'/api/plans');
  await dialog.getByRole('button',{name:'Calculate preview',exact:true}).click();
  await expect(dialog.getByTestId('manual-preview')).toBeVisible();
  expect((await get<Plan[]>(page.request,'/api/plans')).length).toBe(before.length);
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/manual-plan'));
  await dialog.getByRole('button',{name:/^(Apply manual change|Save invalid draft)$/}).click();
  const result=await response;expect(result.status()).toBe(201);
  const plan=await result.json() as Plan;
  await expect(dialog).toHaveCount(0);
  return plan;
}
function independentManualKpis(plan:Plan){
  let distance=0,tripCount=0;
  const stops=plan.vehicles.flatMap(v=>v.trips.flatMap(t=>t.stops));
  expect(plan.stats.servedOrders).toBe(stops.length);
  expect(plan.stats.deliveryStops).toBe(stops.length);
  expect(plan.stats.vehiclesUsed).toBe(plan.vehicles.length);
  expect(new Set([...stops,...plan.unassigned].map(s=>s.requestId)).size).toBe(6);
  expect(plan.stats.totalOrders).toBe(6);
  for(const vehicle of plan.vehicles){
    expect(vehicle.tripCount).toBe(vehicle.trips.length);
    expect(vehicle.distanceKm).toBeCloseTo(vehicle.trips.reduce((sum,t)=>sum+t.distanceKm,0),8);
    expect(vehicle.peakKg).toBe(Math.max(...vehicle.trips.map(t=>t.loadKg)));
    for(const trip of vehicle.trips){
      expect(trip.loadKg).toBe(trip.stops.reduce((sum,s)=>sum+s.weightKg,0));
      expect(trip.loadPallets).toBe(trip.stops.reduce((sum,s)=>sum+s.pallets,0));
      for(const stop of trip.stops){expect(stop.serviceStartSec).toBeGreaterThanOrEqual(stop.arrivalSec);expect(stop.departureSec).toBeGreaterThanOrEqual(stop.serviceStartSec);}
    }
  }
  for(const vehicle of plan.vehicles)for(const trip of vehicle.trips){
    let previous=0;tripCount++;
    for(const stop of trip.stops){const location=Number(stop.orderNo.split('-')[1]);if(location!==previous)distance+=1+(previous*7+location*3)%9;previous=location;}
    if(previous)distance+=1+(previous*7)%9;
  }
  expect(plan.stats.totalDistanceKm).toBe(distance);
  expect(plan.stats.trips).toBe(tripCount);
  expect(plan.stats.servedOrders+plan.unassigned.length).toBe(6);
  expect(plan.cost?.total).toBe(plan.vehicles.length*38000+260*distance);
  expect(plan.cost!.fixed+plan.cost!.variable).toBe(plan.cost!.total);
  expect(plan.cost!.perVehicle.reduce((sum,v)=>sum+v.totalCost,0)).toBe(plan.cost!.total);
  expect(plan.vehicles.flatMap(v=>v.trips).reduce((sum,t)=>sum+(t.costFt??0),0)).toBe(plan.cost!.total);
}

test('manual: same-trip stop insertion refreshes schedule, distance, costs and peer retrieval',async({page})=>{
  await login(page);const base=await baseline(page);
  const vehicle=base.vehicles.find(v=>v.trips.some(t=>t.stops.length>=2))!;
  const trip=vehicle.trips.find(t=>t.stops.length>=2)!,first=trip.stops[0]!;
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();
  await manualStop(page,base,first.orderNo);
  await page.getByRole('button',{name:'Move to vehicle…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  await dialog.getByRole('combobox',{name:'Trip',exact:true}).selectOption(trip.manualTripId??`trip-${trip.index}`);
  await dialog.getByRole('combobox',{name:'Position',exact:true}).selectOption('');
  const moved=await applyManualDialog(page);independentManualKpis(moved);
  expect(moved.vehicles.find(v=>v.id===vehicle.id)!.trips.find(t=>t.manualTripId===(trip.manualTripId??`trip-${trip.index}`))!.stops.map(s=>s.requestId))
    .toEqual([...trip.stops.slice(1).map(s=>s.requestId),first.requestId]);
  const peerPlan=await get<Plan>(page.request,`${peer}/api/plans/${moved.id}`);
  expect(peerPlan.stats).toEqual(moved.stats);expect(peerPlan.cost).toEqual(moved.cost);
});

test('manual: unverified fleet entries have no restore, assign or drop path and the APIs reject bypasses',async({page})=>{
  await login(page);const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();
  const unavailable=page.getByRole('region',{name:'Unavailable',exact:true});
  await expect(unavailable.getByText('ACCEPT-99',{exact:true})).toBeVisible();
  await unavailable.getByRole('button',{name:'Expand trips',exact:true}).click();
  await expect(unavailable.getByRole('button',{name:'Restore',exact:true})).toHaveCount(0);
  await expect(unavailable.getByText('Fleet identity or capabilities need verification before assignment.',{exact:true})).toBeVisible();
  await manualStop(page,base,'PUBLIC-2');
  await page.getByRole('button',{name:'Move to vehicle…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  const picker=dialog.getByRole('combobox',{name:'Vehicle',exact:true}),option=picker.locator('option[value="99"]');
  await expect(option).toHaveJSProperty('disabled',true);
  // Even DOM tampering cannot turn the trusted unavailable policy into intent.
  await option.evaluate(el=>{(el as HTMLOptionElement).disabled=false;});
  await picker.selectOption('99');
  await expect(dialog.getByRole('button',{name:'Calculate preview',exact:true})).toBeDisabled();
  await expect(dialog.getByRole('button',{name:'Apply manual change',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  for(const suffix of ['manual-preview','manual-plan']){
    const response=await page.request.post(`/api/scenarios/${base.scenarioId}/${suffix}`,{headers:{origin:new URL(page.url()).origin,'if-match':`"${base.scenarioRevision}"`},
      data:{parentPlanId:base.id,vehicle:{id:99,excluded:false},batch:{operationId:'restore-unverified-'+suffix,datasetSha256:base.provenance.datasetSha256,commands:[]}}});
    expect(response.status()).toBe(409);
  }
});

for(const role of ['admin','planner'] as const){
test(`manual ${role}: keyboard move, deassign, reload, release and native replan preserve real state and KPIs`,async({page})=>{
  await login(page,`${role}@acceptance.example.test`);await shortBudget(page);
  const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();
  await expect(page.getByRole('region',{name:'Available',exact:true})).toBeVisible();
  await manualStop(page,base,'PUBLIC-2');
  await page.getByRole('button',{name:'Move to vehicle…',exact:true}).focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  await dialog.getByRole('combobox',{name:'Vehicle',exact:true}).selectOption('30');
  await dialog.getByRole('combobox',{name:'Trip',exact:true}).selectOption('');
  const moved=await applyManualDialog(page);independentManualKpis(moved);
  expect(moved.scenarioId).not.toBe(base.scenarioId);
  expect(moved.vehicles.find(v=>v.id===30)?.trips.some(t=>t.stops.some(s=>s.orderNo==='PUBLIC-2'))).toBe(true);
  expect((await get<Plan>(page.request,`${peer}/api/plans/${moved.id}`)).manual?.layout.history.length).toBe(1);
  expect((await get<Plan>(page.request,`/api/plans/${base.id}`)).stats).toEqual(base.stats);
  await manualStop(page,moved,'PUBLIC-2');
  await expect(page.getByText('Manual decision retained',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Return to unassigned',exact:true}).click();
  const unassigned=await applyManualDialog(page);independentManualKpis(unassigned);
  expect(unassigned.stats.servedOrders).toBe(5);
  expect(unassigned.unassigned.find(o=>o.orderNo==='PUBLIC-2')?.reasonCode).toBe('MANUAL_UNASSIGNED');
  await page.reload();await expect(page.getByText('5 / 6',{exact:true})).toBeVisible();
  const fleet=page.locator('aside').first();
  const unassignedOrder=fleet.getByRole('button').filter({hasText:'#PUBLIC-2'});
  if(!(await unassignedOrder.isVisible()))await fleet.getByRole('button',{name:/Unassigned orders/i}).click();
  await unassignedOrder.click();
  await page.getByRole('button',{name:'Let optimizer decide',exact:true}).click();
  const released=await applyManualDialog(page);expect(released.manual?.layout.history.length).toBe(3);
  const replanned=await finishSolve(page,()=>page.getByRole('button',{name:'Replan',exact:true}).click());
  independentManualKpis(replanned);expect(replanned.stats.servedOrders).toBe(6);
  expect(replanned.assignments?.layout.history.length).toBe(3);
  await manualStop(page,replanned,'PUBLIC-2');
  await page.getByRole('button',{name:'Return to unassigned',exact:true}).click();
  const afterAdoption=await applyManualDialog(page);
  expect((await get<Scenario>(page.request,`${peer}/api/scenarios/${afterAdoption.scenarioId}`)).selectedPlanId).toBe(afterAdoption.id);
  await page.reload();await expect(page.getByText('5 / 6',{exact:true})).toBeVisible();
});
}

test('manual: invalid drafts expose real access violations and cannot be approved',async({page})=>{
  await login(page);const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();
  await manualStop(page,base,'PUBLIC-1');
  await page.getByRole('button',{name:'Move to vehicle…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  await dialog.getByRole('combobox',{name:'Vehicle',exact:true}).selectOption('30');
  const invalid=await applyManualDialog(page);expect(invalid.provenance.validation.valid).toBe(false);
  expect(invalid.provenance.validation.violations.some(v=>v.type==='VEHICLE_SIZE')).toBe(true);
  independentManualKpis(invalid);
  const workflow=await get<{blockers:string[]}>(page.request,`/api/plans/${invalid.id}/workflow`);expect(workflow.blockers.length).toBeGreaterThan(0);
  await expect(page.getByRole('button',{name:/Approve plan/})).toHaveCount(0);
});

test('manual: Reviewer can inspect groups but cannot preview or publish',async({page})=>{
  await login(page,'reviewer@acceptance.example.test');const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();await manualStop(page,base,'PUBLIC-2');
  await expect(page.getByRole('button',{name:'Move to vehicle…',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Find feasible placements',exact:true})).toHaveCount(0);
  for(const suffix of ['manual-preview','manual-plan','placements'])expect((await page.request.post(`/api/scenarios/${base.scenarioId}/${suffix}`,{
    headers:{origin:new URL(page.url()).origin,'if-match':`"${base.scenarioRevision}"`},data:{}})).status()).toBe(403);
});

for(const role of ['admin','planner'] as const)test(`placements ${role}: unassigned order gets server-validated suggestions, preview and audited assignment`,async({page})=>{
  await login(page,`${role}@acceptance.example.test`);const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();await manualStop(page,base,'PUBLIC-2');
  await page.getByRole('button',{name:'Return to unassigned',exact:true}).click();const partial=await applyManualDialog(page);
  const fleet=page.locator('aside').first(),order=fleet.getByRole('button').filter({hasText:'#PUBLIC-2'});
  if(!await order.isVisible())await fleet.getByRole('button',{name:/Unassigned orders/i}).click();await order.click();
  await page.getByRole('button',{name:'Assign to vehicle…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true}),section=dialog.getByRole('region',{name:'Find a place for this order',exact:true});
  const before=(await get<Plan[]>(page.request,'/api/plans')).length;
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/placements'));
  await section.getByRole('button',{name:'Find feasible placements',exact:true}).click();const search=await response;expect(search.status()).toBe(200);
  const result=await search.json() as PlacementSuggestions;expect(result.suggestions.length).toBeGreaterThan(0);
  expect(result.parentPlanId).toBe(partial.id);expect(result.suggestions.some(s=>s.vehicleId===99)).toBe(false);
  await expect(section.getByRole('list',{name:'Feasible placements',exact:true})).toBeVisible();
  for(const suggestion of result.suggestions)if(suggestion.delta.finishSec===null)
    await expect(section.locator(`[data-vehicle-id="${suggestion.vehicleId}"]`)).toContainText('Newly used vehicle');
  await expect(section.locator('[data-vehicle-id="99"]')).toHaveCount(0);
  expect((await get<Plan[]>(page.request,'/api/plans')).length).toBe(before);
  expect((await get<Scenario>(page.request,`${peer}/api/scenarios/${partial.scenarioId}`)).revision).toBe(partial.scenarioRevision);
  if(role==='admin'){await page.setViewportSize({width:600,height:800});expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);}
  const best=result.suggestions[0],context=await get<{fleet:{id:number;ref:string}[]}>(page.request,`/api/plans/${partial.id}/manual-context`);
  await section.getByRole('button',{name:`Use placement on ${context.fleet.find(v=>v.id===best.vehicleId)!.ref}`,exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Apply manual change',exact:true})).toBeDisabled();
  const assigned=await applyManualDialog(page);independentManualKpis(assigned);
  expect(assigned.stats.servedOrders).toBe(6);expect(assigned.provenance.validation.valid).toBe(true);
  expect(assigned.stats.totalDistanceKm-partial.stats.totalDistanceKm).toBeCloseTo(best.delta.distanceKm,6);
  expect(assigned.cost!.total-partial.cost!.total).toBeCloseTo(best.delta.cost,6);
  expect(assigned.manual?.layout.history.at(-1)?.action).toBe('assign');
  expect((await get<Plan>(page.request,`${peer}/api/plans/${assigned.id}?geometry=stored`)).stats).toEqual(assigned.stats);
});

test('placements chaos: a late search response cannot restore controls after demotion',async({page})=>{
  await chaosLogin(page,'planner');const base=await baseline(page);const held=gate(),captured=gate();
  try{
    await page.getByRole('button',{name:'Manual planning',exact:true}).click();await manualStop(page,base,'PUBLIC-2');
    await page.getByRole('button',{name:'Return to unassigned',exact:true}).click();const partial=await applyManualDialog(page);
    const fleet=page.locator('aside').first(),order=fleet.getByRole('button').filter({hasText:'#PUBLIC-2'});
    if(!await order.isVisible())await fleet.getByRole('button',{name:/Unassigned orders/i}).click();await order.click();
    await page.getByRole('button',{name:'Assign to vehicle…',exact:true}).click();
    const plans=(await get<Plan[]>(page.request,'/api/plans')).length;
    await page.route('**/placements',async route=>{const result=await route.fetch();expect(result.status()).toBe(200);captured.release();await held.wait;await route.fulfill({response:result});});
    await page.getByRole('button',{name:'Find feasible placements',exact:true}).click();await captured.wait;
    chaosRole('reviewer');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('footer').getByText('Reviewer',{exact:true})).toBeVisible();
    await expect(page.getByRole('dialog',{name:'Manual planning',exact:true})).toHaveCount(0);held.release();
    await expect(page.getByRole('button',{name:/Use placement on|Find feasible placements/})).toHaveCount(0);
    expect((await get<Plan[]>(page.request,'/api/plans')).length).toBe(plans);
    expect((await get<Scenario>(page.request,`${peer}/api/scenarios/${partial.scenarioId}`)).revision).toBe(partial.scenarioRevision);
  }finally{held.release();chaosRole('planner');}
});

test('manual: exclusion, restore, bulk assignment and undo publish complete immutable drafts',async({page})=>{
  await login(page);const base=await baseline(page),vehicle=base.vehicles[0]!;
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();
  await page.locator('aside').first().getByText(vehicle.ref,{exact:true}).click();
  await page.getByRole('button',{name:`Mark ${vehicle.ref} unavailable`,exact:true}).click();
  const excluded=await applyManualDialog(page);expect(excluded.vehicles.some(v=>v.id===vehicle.id)).toBe(false);independentManualKpis(excluded);
  const region=page.getByRole('region',{name:'Excluded',exact:true});
  await region.getByRole('button',{name:'Expand trips',exact:true}).click();
  await region.getByRole('button',{name:'Restore',exact:true}).click();
  const restored=await applyManualDialog(page);expect(restored.stats.servedOrders).toBe(excluded.stats.servedOrders);
  const unassigned=restored.unassigned;
  const header=page.locator('aside').first().getByRole('button',{name:/Unassigned orders/i});
  if(!(await page.getByRole('checkbox').count()))await header.click();
  await page.getByRole('button',{name:'Select all',exact:true}).click();
  await page.getByRole('combobox',{name:'Assign to vehicle…',exact:true}).selectOption(String(vehicle.id));
  await page.getByRole('button',{name:'Assign',exact:true}).click();
  const assigned=await applyManualDialog(page);expect(assigned.stats.servedOrders).toBe(restored.stats.servedOrders+unassigned.length);independentManualKpis(assigned);
  await page.getByRole('button',{name:'Undo manual change',exact:true}).click();
  const undone=await applyManualDialog(page);expect(undone.unassigned.map(o=>o.requestId).sort()).toEqual(restored.unassigned.map(o=>o.requestId).sort());
  independentManualKpis(undone);expect(undone.manual?.layout.history.some(e=>e.action==='undo')).toBe(true);
});

test('manual: Hungarian narrow-screen dialog is accessible and a cancelled preview never writes',async({page})=>{
  await login(page);const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();await manualStop(page,base,'PUBLIC-2');
  await page.getByRole('group',{name:'Language',exact:true}).getByRole('button',{name:'HU',exact:true}).click();
  await page.setViewportSize({width:375,height:780});
  await page.getByRole('button',{name:'Collapse fleet panel',exact:true}).click();
  await page.getByRole('button',{name:'Áthelyezés másik járműre…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Kézi tervezés',exact:true});
  await expect(dialog.getByRole('combobox',{name:'Jármű',exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Kézi módosítás alkalmazása',exact:true})).toBeDisabled();
  const before=await get<unknown[]>(page.request,'/api/plans');
  await dialog.getByRole('button',{name:'Előnézet kiszámítása',exact:true}).click();
  await expect(dialog.getByTestId('manual-preview')).toBeVisible();
  expect(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth)).toBe(true);
  await dialog.getByRole('button',{name:'Mégse',exact:true}).click();
  expect((await get<unknown[]>(page.request,'/api/plans')).length).toBe(before.length);
});

test('manual: permission revocation while preview is in flight cannot expose Apply or publish',async({page})=>{
  await chaosLogin(page);const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();await manualStop(page,base,'PUBLIC-2');
  await page.getByRole('button',{name:'Move to vehicle…',exact:true}).click();
  const held=gate(),captured=gate();let writes=0;
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/manual-plan'))writes++;});
  await page.route('**/manual-preview',async route=>{const response=await route.fetch();captured.release();await held.wait;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'Calculate preview',exact:true}).click();await captured.wait;
    chaosRole('reviewer');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Read-only access',{exact:true})).toBeVisible();
    held.release();await expect(page.getByRole('dialog',{name:'Manual planning',exact:true})).toHaveCount(0);
    expect(writes).toBe(0);
  }finally{held.release();chaosRole('planner');}
});

test('manual: dragging a delivery to an available vehicle uses the same validated dialog',async({page})=>{
  await login(page);const base=await baseline(page),vehicle=base.vehicles.find(v=>v.trips.some(tr=>tr.stops.some(s=>s.orderNo==='PUBLIC-2')))!;
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();
  await page.locator('aside').first().getByText(vehicle.ref,{exact:true}).click();
  await page.locator('aside').last().getByRole('button',{name:/Trip 1 ·/}).click();
  const source=page.locator('aside').last().locator('ol li > button').filter({hasText:'Public fixture 2'});
  await source.dragTo(page.locator('[data-vehicle-id="30"]'));
  const moved=await applyManualDialog(page);
  expect(moved.vehicles.find(v=>v.id===30)?.trips.some(tr=>tr.stops.some(s=>s.orderNo==='PUBLIC-2'))).toBe(true);
  independentManualKpis(moved);
});

test('manual: lost Apply response retries the same operation without duplicate plans',async({page})=>{
  await login(page);const base=await baseline(page);
  await page.getByRole('button',{name:'Manual planning',exact:true}).click();await manualStop(page,base,'PUBLIC-2');
  await page.getByRole('button',{name:'Return to unassigned',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  await dialog.getByRole('button',{name:'Calculate preview',exact:true}).click();await expect(dialog.getByTestId('manual-preview')).toBeVisible();
  const before=(await get<unknown[]>(page.request,'/api/plans')).length;let first=true;const keys:string[]=[];
  await page.route('**/manual-plan',async route=>{
    keys.push((route.request().postDataJSON() as {batch:{operationId:string}}).batch.operationId);
    if(first){first=false;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await dialog.getByRole('button',{name:'Apply manual change',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button',{name:'Apply manual change',exact:true}).click();await expect(dialog).toHaveCount(0);
  expect((await get<unknown[]>(page.request,'/api/plans')).length).toBe(before+1);
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
});
type Job = { status: string; error?: string; planId?: string; scenarioRevision: number };

function dc(...args: string[]): string {
  if (!compose) throw Error('Use deploy/acceptance.py; never point this suite at a production endpoint');
  return execFileSync(compose[0], [...compose.slice(1), ...args], { encoding: 'utf8', timeout: 90_000 });
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  return response.json() as Promise<T>;
}
async function login(page: Page, email = 'admin@acceptance.example.test'): Promise<string> {
  await page.addInitScript(() => { try { localStorage.setItem('otto.helpSeen', '1'); } catch { /* no storage on error documents */ } });
  await page.goto('/');
  await expect(page.getByRole('contentinfo', { name: 'Account and build' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: /Email me a sign-in link/ }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  // Delivery is disabled. Read the actual test-only outbox instead of mocking
  // authentication or sending a message. GET and form POST follow production.
  const { link } = JSON.parse(dc('run', '--rm', '-T', 'fixture', 'link').trim().split('\n').at(-1)!) as { link: string };
  await page.goto(link);
  await expect(page.getByRole('banner', { name: 'Cursus' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to Cursus' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Cursus', exact: true })).toHaveCSS('background-color', 'rgb(45, 123, 85)');
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  await page.getByRole('button', { name: 'Continue to Cursus', exact: true }).click();
  await expect(page.getByText('Served / Total')).toBeVisible();
  return link;
}

function chaosRole(role: 'admin' | 'planner' | 'reviewer'): void {
  dc('run', '--rm', '-T', '--entrypoint', 'node', 'fixture', '/app/server/dist/manage-role.js',
    '--tenant', 'acceptance', '--email', 'planner@acceptance.example.test', '--role', role, '--approve');
}
async function chaosLogin(page: Page, role: 'admin' | 'planner' | 'reviewer' = 'planner') {
  // Establish the other Admin through real authentication, even in an isolated
  // test run; never weaken last-Admin protection to run a chaos fixture.
  await login(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
  await login(page, 'planner@acceptance.example.test');
  chaosRole(role);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('contentinfo').getByText(role === 'admin' ? 'Admin' : role === 'planner' ? 'Planner' : 'Reviewer', { exact: true })).toBeVisible();
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release: () => release() };
}
async function settleResponse(page: Page, response: import('@playwright/test').Response) {
  await response.finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('chaos: a delayed Admin identity cannot undo a newer real Reviewer demotion', async ({ page }) => {
  await chaosLogin(page, 'admin');
  const held = gate(), captured = gate(); let first = true;
  await page.route('**/api/auth/me', async route => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch(); captured.release(); await held.wait;
    await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await captured.wait;
    chaosRole('reviewer');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
    const late = page.waitForResponse(r => r.url().endsWith('/api/auth/me'));
    held.release(); await settleResponse(page, await late);
    const base = await baseline(page);
    expect((await page.request.post(`/api/scenarios/${base.scenarioId}/solve`, { headers: { origin: new URL(page.url()).origin }, data: {} })).status()).toBe(403);
    expect(await page.getByText('Read-only access', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: /^(Optimize|Replan|View as Planner|View as Reviewer)$/ }).count()).toBe(0);
  } finally { held.release(); chaosRole('planner'); }
});

test('chaos: late authenticated refresh cannot resurrect the workspace after real sign out', async ({ page }) => {
  await chaosLogin(page, 'admin');
  const held = gate(), captured = gate(); let first = true;
  await page.route('**/api/auth/me', async route => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch(); captured.release(); await held.wait; await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await captured.wait;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
    await page.evaluate(() => {
      const state = window as typeof window & { chaosResurrected?: boolean };
      state.chaosResurrected = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="workspace-content"]')) state.chaosResurrected = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const late = page.waitForResponse(r => r.url().endsWith('/api/auth/me'));
    held.release(); await settleResponse(page, await late);
    for (const origin of ['', peer]) expect((await page.request.get(`${origin}/api/days`)).status()).toBe(401);
    expect(await page.getByRole('contentinfo').count()).toBe(0);
    expect(await page.getByRole('heading', { name: 'Continue to Cursus' }).isVisible()).toBe(true);
    expect(await page.evaluate(() => (window as typeof window & { chaosResurrected?: boolean }).chaosResurrected)).toBe(false);
  } finally { held.release(); chaosRole('planner'); }
});

for (const transition of ['demoted', 'regranted', 'pending-replan'] as const) {
test(`chaos: queued edits are dropped after permission transition (${transition}) even when the first real edit completes late`, async ({ page }) => {
  await chaosLogin(page);
  const vehicle = (await baseline(page)).vehicles[0]!;
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  const held = gate(), captured = gate(); let edits = 0;
  let solves = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/solve')) solves++; });
  await page.route('**/api/scenarios/*/edit', async route => {
    edits++;
    const response = await route.fetch(); captured.release(); await held.wait; await route.fulfill({ response });
  });
  try {
    const exclude = page.getByRole('button', { name: `Mark ${vehicle.ref} unavailable` });
    await exclude.click(); await captured.wait;
    await exclude.click(); // queue a second edit behind the held response
    if (transition === 'pending-replan') await page.getByRole('button', { name: /^(Optimize|Replan)$/ }).click();
    chaosRole('reviewer');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
    if (transition === 'regranted') {
      chaosRole('planner'); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('contentinfo').getByText('Planner', { exact: true })).toBeVisible();
    }
    const late = page.waitForResponse(r => r.url().endsWith('/edit'));
    held.release(); await settleResponse(page, await late);
    // A read through the peer is a network barrier after the queued microtasks.
    await get(page.request, `${peer}/api/scenarios`);
    expect(edits).toBe(1);
    expect(solves).toBe(0);
    if (transition !== 'regranted') await expect(page.getByRole('button', { name: /Mark .* unavailable|Lock route|Unlock route/ })).toHaveCount(0);
  } finally { held.release(); chaosRole('planner'); }
});
}

test('chaos: open rename/upload dialogs lose their privileged controls immediately on demotion', async ({ page }) => {
  await chaosLogin(page, 'admin');
  try {
    await selectWorkspaceAction(page,'Data');
    await page.getByRole('tab', { name: 'Upload', exact: true }).click();
    await expect(page.locator('input[type=file]').first()).toBeAttached();
    chaosRole('planner'); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // Radix marks the background aria-hidden while the dialog is open.
    await expect(page.locator('footer').getByText('Planner', { exact: true })).toBeVisible();
    await expect(page.locator('input[type=file]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    const base = await baseline(page);
    const copy = await (await page.request.post('/api/scenarios', { headers: { origin: new URL(page.url()).origin }, data: { from: base.scenarioId, label: 'Chaos original' } })).json() as Scenario;
    await selectWorkspaceAction(page,'Scenarios');
    const row = page.getByText('Chaos original', { exact: true }).locator('..');
    await row.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('Must not be committed');
    chaosRole('reviewer'); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Rename|Delete/ })).toHaveCount(0);
    expect((await get<Scenario>(page.request, `${peer}/api/scenarios/${copy.id}`)).label).toBe('Chaos original');
    await page.keyboard.press('Escape');
    await page.reload(); await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
  } finally { chaosRole('planner'); }
});

test('chaos: shared preview and logout cookies converge across tabs without membership changes', async ({ page, context }) => {
  await chaosLogin(page, 'admin');
  const other = await context.newPage();
  try {
    await other.goto('/'); await expect(other.getByRole('button', { name: 'View as Reviewer', exact: true })).toBeVisible();
    for (const mode of ['Reviewer', 'Planner', 'Reviewer']) {
      await page.getByRole('button', { name: `View as ${mode}`, exact: true }).click();
      await expect(page.getByRole('button', { name: 'Return to Admin', exact: true })).toBeVisible();
      await other.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(other.getByRole('status')).toContainText(`Viewing as ${mode}`);
      expect((await get<{ role: string }>(other.request, `${peer}/api/auth/me`)).role).toBe('admin');
      if (mode === 'Reviewer') await expect(other.getByRole('button', { name: /^(Optimize|Replan)$/ })).toHaveCount(0);
      await page.getByRole('button', { name: 'Return to Admin', exact: true }).click();
      await expect(page.getByRole('button', { name: 'View as Planner', exact: true })).toBeVisible();
      await other.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(other.getByRole('button', { name: 'View as Planner', exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await other.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(other.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
    expect((await other.request.get(`${peer}/api/days`)).status()).toBe(401);
  } finally { await other.close(); chaosRole('planner'); }
});

test('chaos: failed preview request remains recoverable and rapid double clicks do not elevate access', async ({ page }) => {
  await chaosLogin(page, 'admin');
  try {
    await page.route('**/api/auth/view-as', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await page.getByRole('button', { name: 'View as Reviewer', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not change view');
    await expect(page.getByRole('button', { name: 'View as Reviewer', exact: true })).toBeEnabled();
    let previewRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/auth/view-as')) previewRequests++; });
    await page.getByRole('button', { name: 'View as Reviewer', exact: true }).evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
    await expect(page.getByRole('button', { name: 'Return to Admin', exact: true })).toBeVisible();
    expect(previewRequests).toBe(1);
    expect((await get<{ effectiveRole: string }>(page.request, '/api/auth/me')).effectiveRole).toBe('reviewer');
    for (const width of [320, 375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole('button', { name: 'Return to Admin', exact: true })).toBeInViewport();
      expect(await page.getByRole('contentinfo').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.getByRole('button', { name: 'Return to Admin', exact: true }).click();
  } finally { chaosRole('planner'); }
});

test('chaos: client role tampering and mixed API verbs cannot mutate Reviewer state through either replica', async ({ page, context }) => {
  await chaosLogin(page, 'reviewer');
  try {
    const base = await baseline(page);
    const before = await get<Scenario>(page.request, `/api/scenarios/${base.scenarioId}`);
    const scenariosBefore = await get<unknown[]>(page.request, '/api/scenarios');
    await page.evaluate(() => { localStorage.setItem('role', 'admin'); localStorage.setItem('permissions', JSON.stringify(['scenario.edit', 'dataset.admit'])); });
    await context.addCookies([{ name: 'cursus_view_as', value: 'admin', url: page.url() }]);
    await page.reload(); await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
    for (const origin of ['', peer]) {
      for (const [method, path] of [
        ['POST', `/api/scenarios/${base.scenarioId}/edit?role=admin`],
        ['POST', `/api/scenarios/${base.scenarioId}/edits`],
        ['POST', `/api/scenarios/${base.scenarioId}/solve`],
        ['PATCH', `/api/scenarios/${base.scenarioId}`],
        ['PUT', `/api/scenarios/${base.scenarioId}`],
        ['DELETE', `/api/scenarios/${base.scenarioId}`],
        ['POST', '/api/import/upload'], ['POST', '/api/import/datasets/no/convert'],
      ]) {
        const response = await page.request.fetch(`${origin}${path}`, { method,
          headers: { origin: new URL(page.url()).origin, 'x-role': 'admin', 'x-tenant-id': 'foreign', 'x-http-method-override': 'GET' },
          data: { role: 'admin', permissions: ['scenario.edit'], edit: { op: 'removeVehicle', vehicleId: base.vehicles[0]!.id } } });
        expect(response.status(), `${method} ${path}`).toBe(403);
      }
      expect(await get<Scenario>(page.request, `${origin}/api/scenarios/${base.scenarioId}`)).toEqual(before);
      expect(await get<unknown[]>(page.request, `${origin}/api/scenarios`)).toEqual(scenariosBefore);
      expect((await page.request.get(`${origin}/api/plans/${base.id}/handoff.json`)).status()).toBe(200);
    }
    const identity = await get<{ role: string; effectiveRole: string }>(page.request, '/api/auth/me');
    expect(identity.role).toBe('reviewer'); expect(identity.effectiveRole).toBe('reviewer');
    await expect(page.getByRole('button', { name: /^(Optimize|Replan|View as Planner|View as Reviewer)$/ })).toHaveCount(0);
  } finally { chaosRole('planner'); }
});
async function baseline(page: Page): Promise<Plan> {
  const days = await get<DaySummary[]>(page.request, '/api/days');
  expect(days).toHaveLength(2);
  const day = days.find(d => d.id === 'acceptance-day')!;
  return get<Plan>(page.request, `/api/plans/${day.baselinePlanId}`);
}
function assertPlan(plan: Plan): void {
  const assigned = plan.vehicles.flatMap(v => v.trips.flatMap(t => t.stops.map(s => s.orderNo)));
  const all = [...assigned, ...plan.unassigned.map(s => s.orderNo)];
  expect(all.sort()).toEqual([...expectedOrders].sort());
  expect(new Set(all).size).toBe(all.length);
  expect(plan.stats.servedOrders).toBe(assigned.length);
  expect(plan.stats.servedOrders).toBe(6); // known feasible public fixture; quality gate
  expect(plan.stats.totalOrders).toBe(6);
  expect(plan.unassigned).toHaveLength(0);
  expect(plan.provenance.validation.valid).toBe(true);
  expect(plan.provenance.validation.violations).toEqual([]);
  expect(plan.provenance.planningPolicy?.id).toBe('acceptance-approved-policy');
  expect(Number.isFinite(plan.stats.solveElapsedSeconds)).toBe(true);
  expect(plan.stats.solveElapsedSeconds).toBeGreaterThanOrEqual(0); // sub-50ms public fixture rounds to 0.0s
  const approved = plan.vehicles.flatMap(v => v.trips.flatMap(t => t.stops.map(s => ({ v, s })))).find(x => x.s.orderNo === 'PUBLIC-1');
  expect([10, 50]).toContain(approved?.v.id); // waiver does not waive the independent 5.5 t GVW restriction
  expect(approved?.s.maxTonnage).toBe(5.5);
  expect(Number.isFinite(plan.stats.totalDistanceKm)).toBe(true);
  expect(plan.stats.totalDistanceKm).toBeGreaterThan(0);
  for (const vehicle of plan.vehicles) {
    expect(vehicle.ref).toBe(`ACCEPT-${vehicle.id}`);
    for (const trip of vehicle.trips) {
      expect(trip.loadKg).toBeLessThanOrEqual(vehicle.capacityKg);
      expect(trip.stops.every(s => s.lateBySec === 0)).toBe(true);
    }
  }
  expect(plan.cost?.source).toBe('demo');
  expect(plan.cost?.total).toBeCloseTo((plan.cost?.fixed ?? 0) + (plan.cost?.variable ?? 0), 5);
}
async function shortBudget(page: Page) {
  await page.getByRole('button', { name: 'Solve settings' }).click();
  await page.getByRole('menu').locator('input[type=range]').fill('15');
  await page.keyboard.press('Escape');
}
async function finishSolve(page: Page, start: () => Promise<unknown>, options:{keep?:boolean;reload?:boolean}={}): Promise<Plan> {
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/scenarios\/[^/]+\/solve$/.test(new URL(response.url()).pathname));
  await start();
  const submission = await submitted;
  expect(submission.status()).toBe(202);
  const { jobId, scenarioId, scenarioRevision } = await submission.json() as { jobId: string; scenarioId: string; scenarioRevision: number };
  let job: Job;
  await expect.poll(async () => {
    job = await get<Job>(page.request, `${peer}/api/jobs/${jobId}`);
    if (job.status === 'failed') throw Error(`Native solve failed: ${job.error}`);
    return job.status;
  }, { timeout: 60_000, message: 'real native solver job must complete through the peer replica' }).toBe('completed');
  expect(job!.scenarioRevision).toBe(scenarioRevision);
  const plan = await get<Plan>(page.request, `${peer}/api/plans/${job!.planId}`);
  expect(plan.scenarioId).toBe(scenarioId);
  expect(plan.scenarioRevision).toBe(scenarioRevision);
  assertPlan(plan);
  // Wait for actual UI completion, including the comparison fetch.
  await expect(page.getByRole('dialog').getByText(/Plan comparison/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Comparing…')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const candidate = page.getByRole('region', { name: 'Plan candidate' });
  await expect(candidate).toBeVisible();
  const selectionBeforeNavigation=(await get<Scenario>(page.request,`${peer}/api/scenarios/${scenarioId}`)).selectedPlanId;
  for(const label of ['Prepare','Plan','Review & release','Library']){
    await openWorkspaceMenu(page,label);await page.keyboard.press('Escape');
    await expect(candidate).toBeVisible();
  }
  expect((await get<Scenario>(page.request,`${peer}/api/scenarios/${scenarioId}`)).selectedPlanId).toBe(selectionBeforeNavigation);
  if(options.reload){await page.reload();await expect(candidate).toBeVisible();}
  if (plan.unassigned.length) await candidate.getByRole('checkbox').check();
  await candidate.getByRole('button', { name: options.keep?'Keep previous':'Use candidate', exact: true }).click();
  await expect(candidate).toHaveCount(0);
  if(!options.keep){
    expect((await get<Scenario>(page.request,`${peer}/api/scenarios/${scenarioId}`)).selectedPlanId).toBe(plan.id);
  }
  const handoff = await get<{ summary: { servedOrders: number; totalOrders: number; cost: { total: number } }; routes: { stops: { orderNo: string }[] }[] }>(page.request, `${peer}/api/plans/${plan.id}/handoff.json`);
  expect(handoff.summary.servedOrders).toBe(plan.stats.servedOrders);
  expect(handoff.summary.totalOrders).toBe(plan.stats.totalOrders);
  expect(handoff.summary.cost.total).toBe(Math.round(plan.cost!.total));
  expect(handoff.routes.flatMap(r => r.stops.map(s => s.orderNo)).sort()).toEqual([...expectedOrders].sort());
  const comparison = await get<{ deltas: { servedOrders: number; costTotal: number } }>(page.request,
    `/api/compare?base=${(await baseline(page)).id}&revised=${plan.id}`);
  expect(comparison.deltas.servedOrders).toBe(0);
  expect(Number.isFinite(comparison.deltas.costTotal)).toBe(true);
  return plan;
}

test('pending native candidates survive reload and keeping the previous plan preserves both results',async({page})=>{
  await login(page);await shortBudget(page);
  const base=await baseline(page),vehicle=base.vehicles[0]!;
  await page.locator('aside').first().getByText(vehicle.ref,{exact:true}).click();
  await page.getByRole('button',{name:`Mark ${vehicle.ref} unavailable`}).click();
  const candidate=await finishSolve(page,()=>page.getByRole('button',{name:'Replan',exact:true}).click(),{keep:true,reload:true});
  expect((await get<Scenario>(page.request,`${peer}/api/scenarios/${candidate.scenarioId}`)).selectedPlanId).toBeUndefined();
  expect((await get<Plan>(page.request,`${peer}/api/plans/${base.id}`)).stats).toEqual(base.stats);
  expect((await get<Plan>(page.request,`${peer}/api/plans/${candidate.id}`)).id).toBe(candidate.id);
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  (page as Page & { runtimeErrors: string[] }).runtimeErrors = errors;
});

test('Hungarian public sign-in and confirmation preserve anonymous API protection', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tovább a Cursusba' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Munkahelyi e-mail-cím' })).toBeEditable();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hu');
  expect((await page.request.get('/api/days')).status()).toBe(401);
  await page.goto('/api/auth/verify?token=not-a-live-token&lang=hu');
  await expect(page.getByRole('heading', { name: 'Belépés a Cursusba' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tovább a Cursusba', exact: true })).toBeVisible();
  expect(await page.locator('form').getAttribute('method')).toBe('post');
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});
test.afterEach(async ({ page }) => {
  expect((page as Page & { runtimeErrors: string[] }).runtimeErrors).toEqual([]);
});

test('approved exceptions remain visible and cannot be injected through scenario imports', async ({ page }) => {
  await login(page);
  const plan = await baseline(page);
  assertPlan(plan);
  await selectWorkspaceAction(page,'Issues');
  await expect(page.getByRole('region', { name: 'Approved planning exceptions' })).toContainText('PUBLIC-1');
  await expect(page.getByRole('region', { name: 'Approved planning exceptions' })).toContainText('Tail-lift waived');
  await page.keyboard.press('Escape');
  const exported = await get<{ edits: { planningPolicyId: string } }>(page.request, '/api/scenarios/acceptance-day-base/export');
  expect(exported.edits.planningPolicyId).toBe('acceptance-approved-policy');
  const invalid = await page.request.post('/api/scenarios/import', { headers: { origin: new URL(page.url()).origin }, data: { ...exported, edits: { ...exported.edits, planningPolicyId: 'not-approved' } } });
  expect(invalid.status()).toBe(400);
});

test('Admin can preview Reviewer with enforced read-only API and return without changing membership', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'View as Planner', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to Admin', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Viewing as Planner');
  expect((await get<{ effectiveRole: string }>(page.request, '/api/auth/me')).effectiveRole).toBe('planner');
  expect((await page.request.post('/api/import/upload', { headers: { origin: new URL(page.url()).origin }, data: {} })).status()).toBe(403);
  await page.getByRole('button', { name: 'Return to Admin', exact: true }).click();
  await page.getByRole('button', { name: 'View as Reviewer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to Admin', exact: true })).toBeVisible();
  await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Optimize|Replan|Solve settings)$/ })).toHaveCount(0);
  const identity = await get<{ role: string; effectiveRole: string }>(page.request, '/api/auth/me');
  expect(identity.role).toBe('admin'); expect(identity.effectiveRole).toBe('reviewer');
  const denied = await page.request.post('/api/solve', { headers: { origin: new URL(page.url()).origin }, data: {} });
  expect(denied.status()).toBe(403);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Return to Admin', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Return to Admin', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View as Reviewer', exact: true })).toBeVisible();
  expect((await get<{ effectiveRole: string }>(page.request, '/api/auth/me')).effectiveRole).toBe('admin');
});

test('Planner can manage scenario edits but cannot administer shared data or elevate access', async ({ page }) => {
  await login(page, 'planner@acceptance.example.test');
  const me = await get<{ role: string; permissions: string[] }>(page.request, '/api/auth/me');
  expect(me.role).toBe('planner'); expect(me.permissions).toContain('scenario.edit');
  expect(me.permissions).not.toContain('dataset.upload');
  await expect(page.getByRole('contentinfo')).toContainText('Planner');
  await expect(page.getByRole('button', { name: /^View as / })).toHaveCount(0);
  await selectWorkspaceAction(page,'Data');
  await expect(page.getByRole('tab', { name: 'Upload', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const plan = await baseline(page);
  const response = await page.request.post('/api/scenarios', { headers: { origin: new URL(page.url()).origin }, data: { from: plan.scenarioId, label: 'Planner copy' } });
  expect(response.status()).toBe(201);
  const scenario = await response.json() as Scenario;
  const renamed = await page.request.post(`/api/scenarios/${scenario.id}/rename`, { headers: { origin: new URL(page.url()).origin, 'if-match': `"${scenario.revision}"` }, data: { label: 'Planner renamed' } });
  expect(renamed.status()).toBe(200);
  const bundle = await get<unknown>(page.request, `/api/scenarios/${scenario.id}/export`);
  expect((await page.request.post('/api/scenarios/import', { headers: { origin: new URL(page.url()).origin }, data: bundle })).status()).toBe(200);
  await selectWorkspaceAction(page,'Scenarios');
  await expect(page.getByRole('button', { name: 'Rename', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  for (const origin of ['', peer]) {
    for (const [method, path] of [['POST', '/api/import/upload'], ['POST', '/api/import/admit'],
      ['POST', '/api/import/datasets/anything/convert'], ['POST', '/api/auth/view-as'],
      ['DELETE', `/api/scenarios/${scenario.id}`], ['DELETE', '/api/import/datasets/anything']]) {
      const denied = await page.request.fetch(`${origin}${path}`, { method, headers: { origin: new URL(page.url()).origin }, data: { role: 'admin' } });
      expect(denied.status(), path).toBe(403);
    }
  }
  expect((await get<Scenario>(page.request, `${peer}/api/scenarios/${scenario.id}`)).label).toBe('Planner renamed');
  await page.getByRole('group', { name: 'Language', exact: true }).getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Tervező');
});

test('Reviewer can inspect and export but cannot edit, upload, compute or drag stops', async ({ page }) => {
  // Ensure a second, real Admin membership exists even when this test runs
  // alone, so the operator command can safely demote the promoted Reviewer.
  await login(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
  await login(page, 'reviewer@acceptance.example.test');
  const principal = await get<{ role: string }>(page.request, '/api/auth/me');
  expect(principal.role).toBe('reviewer');
  await expect(page.getByRole('contentinfo')).toContainText('Reviewer');
  await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
  const mutations: string[] = [];
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url()); });
  const plan = await baseline(page), vehicle = plan.vehicles[0]!;
  await expect(page.getByRole('button', { name: /^(Optimize|Replan|Solve settings|Generate|Cancel)$/ })).toHaveCount(0);
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  await expect(page.getByRole('button', { name: /Mark .* unavailable|Lock route|Unlock route/ })).toHaveCount(0);
  await expect(page.locator('aside').last().locator('input[type=number]')).toHaveCount(0);
  await page.locator('aside').first().getByRole('button', { name: 'Expand trips' }).first().click();
  await page.locator('aside').first().getByRole('button', { name: /Trip 1/ }).first().click();
  await expect(page.locator('[draggable=true]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Move .* (earlier|later)/ })).toHaveCount(0);
  await selectWorkspaceAction(page,'Data');
  await expect(page.getByRole('tab', { name: 'Upload', exact: true })).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await selectWorkspaceAction(page,'Scenarios');
  await expect(page.getByRole('button', { name: /Rename|Delete/ })).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Language', exact: true }).getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Megtekintő');
  await expect(page.getByText('Csak olvasási hozzáférés', { exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Nyelv', exact: true }).getByRole('button', { name: 'EN', exact: true }).click();
  expect(mutations).toEqual([]);
  for (const suffix of ['export.csv', 'routes.csv', 'routesheet.html', 'handoff.json'])
    expect((await page.request.get(`/api/plans/${plan.id}/${suffix}`)).status()).toBe(200);
  for (const base of ['', peer]) {
    for (const [method, path, data] of [
      ['POST', `/api/scenarios/${plan.scenarioId}/edit`, { edit: { op: 'removeVehicle', vehicleId: vehicle.id }, role: 'admin' }],
      ['POST', `/api/scenarios/${plan.scenarioId}/solve`, {}], ['POST', `/api/plans/${plan.id}/evaluate`, {}],
      ['POST', '/api/import/upload', {}], ['POST', `/api/plans/${plan.id}/narrate`, {}],
      ['DELETE', `/api/scenarios/${plan.scenarioId}`, undefined],
    ] as const) {
      const response = await page.request.fetch(`${base}${path}`, { method, data, headers: { origin: new URL(page.url()).origin } });
      expect(response.status(), path).toBe(403);
    }
  }
  expect((await get<Plan>(page.request, `/api/plans/${plan.id}`)).stats).toEqual(plan.stats);
  const changeRole = (role: 'admin' | 'reviewer') => dc('run', '--rm', '-T', '--entrypoint', 'node', 'fixture',
    '/app/server/dist/manage-role.js', '--tenant', 'acceptance', '--email', 'reviewer@acceptance.example.test', '--role', role, '--approve');
  const initialIdentity = await get<{ userId: string }>(page.request, '/api/auth/me');
  changeRole('admin');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeVisible();
  changeRole('reviewer');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('Reviewer');
  expect((await get<{ userId: string }>(page.request, `${peer}/api/auth/me`)).userId).toBe(initialIdentity.userId);
  expect((await page.request.post(`/api/scenarios/${plan.scenarioId}/solve`, { headers: { origin: new URL(page.url()).origin }, data: {} })).status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
});

test('a hard GVW access violation is visible and cannot be labelled Baseline OK', async ({ page }) => {
  await login(page);
  await page.route('**/api/plans/*', async route => {
    const response = await route.fetch();
    const plan = await response.json() as Plan;
    if (!plan.vehicles?.length) return route.fulfill({ response });
    plan.source = 'saved'; plan.provenance.termination = 'OK';
    plan.provenance.validation = { valid: false, violations: [{ type: 'VEHICLE_SIZE', soft: false,
      vehicle_id: plan.vehicles[0]!.id, actual: 24, limit: 7.5 }] };
    await route.fulfill({ response, json: plan });
  });
  await page.reload();
  await expect(page.getByText('Baseline · Constraint violation', { exact: true })).toBeVisible();
  await expect(page.getByTestId('status-coverage')).toContainText('Constraint checks failed');
  await expect(page.locator('#cursus-status-details')).not.toHaveAttribute('open','');
  await expect(page.getByText('Baseline · OK', { exact: true })).toHaveCount(0);
  await selectWorkspaceAction(page,'Issues');
  await expect(page.getByRole('dialog')).toContainText('Constraint violations');
  await expect(page.getByRole('dialog').getByText(/24t.*7.5t/)).toBeVisible();
});

test('real authentication, shared sessions, origin checks, and tenant isolation', async ({ page }) => {
  for (const origin of ['', peer]) {
    expect((await page.request.get(`${origin}/api/days`)).status()).toBe(401);
    expect((await page.request.get(`${origin}/health/ready`)).status()).toBe(200);
  }
  const usedLink = await login(page);
  // Reopening an already-used emailed link must never create another session.
  const mobile = await page.context().browser()!.newContext({ viewport: { width: 375, height: 667 } });
  try {
    const confirmation = await mobile.newPage();
    await confirmation.goto(usedLink);
    await expect(confirmation.getByRole('heading', { name: 'Sign in to Cursus' })).toBeVisible();
    expect(await confirmation.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await confirmation.keyboard.press('Tab');
    await expect(confirmation.getByRole('button', { name: 'Continue to Cursus', exact: true })).toBeFocused();
    await confirmation.keyboard.press('Enter');
    await expect(confirmation.getByRole('alert')).toContainText('Link unavailable');
    expect((await confirmation.request.get('/api/auth/me')).status()).toBe(401);
    await confirmation.getByRole('textbox', { name: 'Work email' }).fill('admin@acceptance.example.test');
    await confirmation.getByRole('button', { name: /Email me a sign-in link/ }).click();
    await expect(confirmation.getByRole('status')).toContainText('Check your inbox');
    const { link } = JSON.parse(dc('run', '--rm', '-T', 'fixture', 'expire-link').trim().split('\n').at(-1)!) as { link: string };
    await confirmation.goto(link);
    await confirmation.getByRole('button', { name: 'Continue to Cursus', exact: true }).click();
    await expect(confirmation.getByRole('alert')).toContainText('Link unavailable');
    expect((await confirmation.request.get('/api/auth/me')).status()).toBe(401);
  } finally { await mobile.close(); }
  expect((await get<{ tenantId: string }>(page.request, `${peer}/api/auth/me`)).tenantId).toBe('acceptance');
  for (const path of ['/api/plans/foreign-plan', '/api/plans/foreign-plan/handoff.json', '/api/scenarios/foreign-scenario'])
    expect((await page.request.get(`${peer}${path}`)).status()).toBe(404);
  const blocked = await page.request.post('/api/scenarios', { headers: { origin: 'https://untrusted.example.test' }, data: { day: 'acceptance-day' } });
  expect(blocked.status()).toBe(403);
  assertPlan(await baseline(page));
});

test('account bar shows image provenance, fits desktop and mobile, and revokes the shared session on sign out', async ({ page }) => {
  await login(page);
  const me = await get<{ email: string; role: string; tenantId: string; tenantName: string; build: { version: string; revision: string } }>(page.request, '/api/auth/me');
  expect(me.tenantName).toBe('Acceptance workspace');
  expect((await get<typeof me>(page.request, `${peer}/api/auth/me`)).tenantName).toBe(me.tenantName);
  const workspace = page.getByRole('group', { name: 'Current workspace', exact: true });
  await expect(workspace.getByText(me.tenantName, { exact: true })).toBeVisible();
  await expect(workspace.getByRole('button')).toHaveCount(0);
  await expect(workspace.getByRole('combobox')).toHaveCount(0);
  expect((await page.request.get('/api/auth/me')).headers()['cache-control']).toBe('private, no-store');
  expect(me.build.revision).toBe(process.env.CURSUS_ACCEPTANCE_REVISION);
  expect(me.build.revision).toMatch(/^[a-f0-9]{40}$/i);
  expect((await get<typeof me>(page.request, `${peer}/api/auth/me`)).build).toEqual(me.build);
  const bar = page.getByRole('contentinfo', { name: 'Account and build' });
  await expect(bar.getByText(me.email, { exact: true })).toBeVisible();
  await expect(bar.getByText('AD', { exact: true })).toBeVisible();
  await expect(bar.getByText('Admin', { exact: true })).toBeVisible();
  await expect(bar.getByLabel('Application build')).toHaveAttribute('title', `${me.build.version} · ${me.build.revision}`);
  await expect(bar.getByText(`v${me.build.version}`, { exact: true })).toBeVisible();
  await expect(bar.getByText(me.build.revision.slice(0, 7), { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('account-desktop.png') });
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 667 });
    await expect(bar).toBeInViewport();
    await expect(bar.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport();
    await expect(workspace).toBeInViewport();
    expect(await workspace.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
    await expect(workspace.getByText(me.tenantName, { exact: true })).toHaveAttribute('title', me.tenantName);
    expect(await bar.evaluate(el => {
      const footer = el.getBoundingClientRect();
      const workspace = document.querySelector('[data-testid="workspace-content"]')!.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && footer.left >= 0 && footer.right <= innerWidth
        && footer.bottom <= innerHeight && workspace.bottom <= footer.top;
    })).toBe(true);
    if (width === 375) await page.screenshot({ path: test.info().outputPath('account-mobile.png') });
  }
  await expect(bar.getByText(me.email, { exact: true })).toHaveAttribute('title', me.email);
  expect(await bar.getByText(me.email, { exact: true }).evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'Language', exact: true }).getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Aktuális munkaterület', exact: true })).toContainText(me.tenantName);
  await expect(page.getByRole('contentinfo', { name: 'Fiók és verzió' }).getByRole('button', { name: 'Kijelentkezés', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Nyelv', exact: true }).getByRole('button', { name: 'EN', exact: true }).click();
  // Display-only edge cases: retain the real authenticated response and change
  // only its label. No login, tenant authorization or data API is mocked here.
  const longName = 'A very long workspace name <not markup> & partner company';
  await page.route('**/api/auth/me', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), tenantName: longName } });
  });
  await page.reload();
  await expect(workspace.getByText(longName, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 667 });
  await expect(workspace).toBeInViewport();
  expect(await workspace.getByText(longName, { exact: true }).evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), tenantName: null } });
  });
  await page.reload();
  await expect(page.getByText('Served / Total')).toBeVisible();
  await expect(workspace).toHaveCount(0);
  await page.unroute('**/api/auth/me');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(workspace.getByText(me.tenantName, { exact: true })).toBeVisible();
  expect((await get<typeof me>(page.request, '/api/auth/me')).tenantId).toBe(me.tenantId);
  // A transient failure must not pretend to have signed the user out.
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await bar.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(bar.getByRole('alert')).toContainText('Could not sign out');
  expect((await page.request.get(`${peer}/api/auth/me`)).status()).toBe(200);
  // The retry is real: shared PostgreSQL session revocation, no API mock.
  await bar.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(workspace).toHaveCount(0);
  for (const origin of ['', peer]) {
    expect((await page.request.get(`${origin}/api/auth/me`)).status()).toBe(401);
    expect((await page.request.get(`${origin}/api/days`)).status()).toBe(401);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Continue to Cursus' })).toBeVisible();
});

for (const role of ['admin', 'planner'] as const) {
test(`${role}: reorder requires recomputed preview and a correct native replan with peer export`, async ({ page }) => {
  await login(page, `${role}@acceptance.example.test`); await shortBudget(page);
  const base = await baseline(page);
  const vehicle = base.vehicles.find(v => v.trips[0]?.stops.length >= 2)!;
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  const inspector = page.locator('aside').last();
  await inspector.getByRole('button', { name: /Trip 1/ }).click();
  const evaluated = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/evaluate'));
  await inspector.locator('ol li').first().locator('button[data-move$=":1"]').click();
  expect((await evaluated).status()).toBe(200);
  await expect(inspector.getByText('Preview of this order (recomputed). Apply it with Replan.')).toBeVisible();
  const plan = await finishSolve(page, () => page.getByRole('button', { name: 'Replan', exact: true }).click());
  const stops = plan.vehicles.find(v => v.id === vehicle.id)!.trips.flatMap(t => t.stops.map(s => s.orderNo));
  const original = vehicle.trips[0]!.stops.map(s => s.orderNo);
  expect(stops).toEqual([original[1], original[0], ...original.slice(2)]);
});

test(`${role}: excluding a vehicle preserves service and stable identities through the real worker`, async ({ page }) => {
  await login(page, `${role}@acceptance.example.test`); await shortBudget(page);
  const vehicle = (await baseline(page)).vehicles[0]!;
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  await page.getByRole('button', { name: `Mark ${vehicle.ref} unavailable` }).click();
  const plan = await finishSolve(page, () => page.getByRole('button', { name: 'Replan', exact: true }).click());
  expect(plan.vehicles.some(v => v.id === vehicle.id || v.ref === vehicle.ref)).toBe(false);
});

test(`${role}: locking a route preserves its vehicle and exact stop order`, async ({ page }) => {
  await login(page, `${role}@acceptance.example.test`); await shortBudget(page);
  const vehicle = (await baseline(page)).vehicles[0]!;
  const original = vehicle.trips.flatMap(t => t.stops.map(s => s.orderNo));
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  await page.getByRole('button', { name: 'Lock route', exact: true }).click();
  const plan = await finishSolve(page, () => page.getByRole('button', { name: 'Replan', exact: true }).click());
  expect(plan.vehicles.find(v => v.id === vehicle.id)!.trips.flatMap(t => t.stops.map(s => s.orderNo))).toEqual(original);
});
}

test('an immediate Replan waits for a delayed real edit response', async ({ page }) => {
  await login(page); await shortBudget(page);
  const vehicle = (await baseline(page)).vehicles[0]!;
  await page.locator('aside').first().getByText(vehicle.ref, { exact: true }).click();
  const inspector = page.locator('aside').last();
  await inspector.getByRole('button', { name: /Trip 1/ }).click();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const intercepted = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/scenarios/*/edit', async route => { captured(); await held; await route.continue(); });
  const edited = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/edit'));
  await inspector.locator('ol li').first().locator('button[data-move$=":1"]').click();
  await intercepted;
  // Even before the edit response arrives, readiness cannot certify the old
  // snapshot as current. This also covers the queue-to-server race window.
  const readiness = page.locator('details[aria-label="Dispatch readiness"]');
  await expect(readiness.locator('summary')).toContainText('Action required');
  const solving = finishSolve(page, async () => {
    await page.getByRole('button', { name: /^(Optimize|Replan)$/ }).click();
    release();
  });
  const scenario = await (await edited).json() as Scenario;
  const plan = await solving;
  expect(plan.scenarioId).toBe(scenario.id);
  expect(plan.scenarioRevision).toBe(scenario.revision);
  await expect(readiness.locator('summary')).toContainText('Matches the loaded scenario revision');
});

test('Reviewer can review snapshot readiness, baseline metrics and Hungarian details without write controls', async ({ page }) => {
  await login(page, 'reviewer@acceptance.example.test');
  const plan = await baseline(page);
  const panel = page.locator('details[aria-label="Dispatch readiness"]');
  await expect(panel.locator('summary')).toContainText(`${plan.stats.servedOrders}/${plan.stats.totalOrders} orders served`);
  await panel.locator('summary').click();
  await expect(panel.getByRole('region', { name: 'Coverage', exact: true })).toBeVisible();
  const constraints = panel.getByRole('region', { name: 'Constraints', exact: true });
  for (const label of ['Gross vehicle weight (GVW)', 'Tail-lift', 'Payload / pallet capacity', 'Time windows', 'Locked routes'])
    await expect(constraints.getByText(label, { exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Freshness', exact: true })).toContainText('Matches the loaded scenario revision');
  await expect(panel.getByRole('region', { name: 'Comparison with day baseline' })).toContainText(plan.id);
  await expect(panel).toContainText('not necessarily the original handwritten plan');
  await expect(panel.getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('readiness-en.png'), fullPage: true });
  await page.getByRole('button', { name: 'HU', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const magyar = page.locator('details[aria-label="Indítás előtti ellenőrzés"]');
  await expect(magyar.getByText('Jármű-össztömeg (GVW)', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('readiness-hu.png'), fullPage: true });
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await magyar.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
});

test('timeline and KPI collapse persist, preserve dimensions, restore and never submit planning writes', async ({ page }) => {
  await login(page, 'reviewer@acceptance.example.test');
  async function expectControlCross() {
    const boxes = await page.locator('[data-panel-controls]').evaluate(el => Array.from(el.querySelectorAll('button')).map(button => {
      const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    expect(boxes).toHaveLength(5);
    const [top, left, center, right, bottom] = boxes;
    for (const box of boxes) { expect(box.width).toBe(32); expect(box.height).toBe(32); }
    expect(top.x).toBe(center.x); expect(bottom.x).toBe(center.x);
    expect(left.y).toBe(center.y); expect(right.y).toBe(center.y);
    expect(top.y + top.height).toBeLessThan(center.y);
    expect(left.x + left.width).toBeLessThan(center.x);
    expect(center.x + center.width).toBeLessThan(right.x);
    expect(center.y + center.height).toBeLessThan(bottom.y);
    expect(await page.locator('[data-panel-controls]').evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + 1, r.y + 1));
    })).toBe(false); // The unused corner must not block the map.
  }
  await expect(page.getByRole('group', { name: 'Panel controls', exact: true })).toBeVisible();
  await expectControlCross();
  const original = await baseline(page);
  const writes: string[] = [];
  page.on('request', r => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method())) writes.push(r.url()); });
  const timeline = page.locator('#cursus-timeline-pane'), kpis = page.locator('#cursus-kpi-pane');
  const handle = page.getByRole('separator', { name: 'Resize timeline', exact: true });
  await handle.focus(); await page.keyboard.press('ArrowUp');
  const height = await handle.getAttribute('aria-valuenow');
  const mapBefore = (await page.locator('#cursus-map-pane').boundingBox())!.height;
  await timeline.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(timeline.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  const collapseTimeline = page.getByRole('button', { name: 'Collapse timeline', exact: true });
  await expect(collapseTimeline).toHaveAttribute('aria-expanded', 'true');
  await collapseTimeline.focus(); await page.keyboard.press('Enter');
  await expect(timeline).toBeHidden(); await expect(handle).toHaveCount(0);
  await page.getByRole('button', { name: 'Open timeline', exact: true }).click();
  await expect(timeline.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(timeline.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Collapse timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse KPI bar', exact: true }).click();
  await expect(kpis).toBeHidden();
  expect((await page.locator('#cursus-map-pane').boundingBox())!.height).toBeGreaterThan(mapBefore);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open timeline', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(timeline).toBeHidden(); await expect(kpis).toBeHidden();
  await expectControlCross();
  await page.getByRole('button', { name: 'Open timeline', exact: true }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', height!);
  await expect(timeline.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(timeline.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await expect(kpis).toBeHidden();
  await page.getByRole('button', { name: 'Collapse timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await expect(timeline).toBeVisible(); await expect(kpis).toBeVisible();
  await expect(handle).toHaveAttribute('aria-valuenow', '192');
  await page.getByRole('button', { name: 'Collapse fleet panel', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Panelvezérlők', exact: true })).toBeVisible();
  await expectControlCross();
  await expect(page.getByRole('button', { name: 'Elrendezés alaphelyzetbe', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Idővonal összecsukása', exact: true }).click();
  await page.getByRole('button', { name: 'Mutatósáv összecsukása', exact: true }).click();
  await expect(timeline).toBeHidden(); await expect(kpis).toBeHidden();
  await page.getByRole('button', { name: 'Idővonal megnyitása', exact: true }).click();
  await page.getByRole('button', { name: 'Mutatósáv megnyitása', exact: true }).click();
  await expect(timeline).toBeVisible(); await expect(kpis).toBeVisible();
  expect(writes).toEqual([]); expect(await baseline(page)).toEqual(original);
});

test('workspace panels resize by pointer and keyboard, persist, reset and never submit planning writes', async ({ page }) => {
  await login(page, 'reviewer@acceptance.example.test');
  const original = await baseline(page);
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  const fleet = page.getByRole('separator', { name: 'Resize fleet panel', exact: true });
  const inspector = page.getByRole('separator', { name: 'Resize inspector panel', exact: true });
  const timeline = page.getByRole('separator', { name: 'Resize timeline', exact: true });
  const size = async (selector: string, dimension: 'width' | 'height') => (await page.locator(selector).boundingBox())![dimension];
  async function drag(handle: import('@playwright/test').Locator, dx: number, dy: number) {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
    await page.mouse.up();
  }
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
  await drag(fleet, 80, 0);
  await expect(fleet).toHaveAttribute('aria-valuenow', '390');
  expect(await size('#cursus-fleet-pane', 'width')).toBe(390);
  await drag(inspector, -60, 0);
  await expect(inspector).toHaveAttribute('aria-valuenow', '400');
  expect(await size('#cursus-inspector-pane', 'width')).toBe(400);
  await drag(timeline, 0, -50);
  await expect(timeline).toHaveAttribute('aria-valuenow', '242');
  expect(await size('#cursus-timeline-pane', 'height')).toBe(242);
  await expect.poll(async () => Math.abs((await page.locator('#cursus-map-pane canvas').boundingBox())!.width - await size('#cursus-map-pane', 'width'))).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('resizable-workspace.png'), fullPage: true });
  await page.reload();
  await expect(fleet).toHaveAttribute('aria-valuenow', '390');
  await expect(inspector).toHaveAttribute('aria-valuenow', '400');
  await expect(timeline).toHaveAttribute('aria-valuenow', '242');
  await fleet.focus(); await page.keyboard.press('ArrowRight');
  await expect(fleet).toHaveAttribute('aria-valuenow', '400');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(fleet).toHaveAttribute('aria-valuenow', '360');
  await page.keyboard.press('Home');
  await expect(fleet).toHaveAttribute('aria-valuenow', '240');
  await page.keyboard.press('End');
  await expect(fleet).toHaveAttribute('aria-valuenow', '520');
  await fleet.dblclick();
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
  await inspector.focus(); await page.keyboard.press('ArrowLeft');
  await expect(inspector).toHaveAttribute('aria-valuenow', '410');
  await timeline.focus(); await page.keyboard.press('ArrowUp');
  await expect(timeline).toHaveAttribute('aria-valuenow', '252');
  await page.getByRole('button', { name: 'Collapse fleet panel' }).click();
  await expect(fleet).toHaveCount(0);
  await page.getByRole('button', { name: 'Open fleet panel' }).click();
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
  // Resizing never persisted a scenario change, nor attempted a forbidden API.
  expect(writes).toEqual([]);
  expect(await baseline(page)).toEqual(original);
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await expect(inspector).toHaveAttribute('aria-valuenow', '340');
  await expect(timeline).toHaveAttribute('aria-valuenow', '192');
  await page.reload();
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
  await expect(inspector).toHaveAttribute('aria-valuenow', '340');
  await expect(timeline).toHaveAttribute('aria-valuenow', '192');
});

test('workspace resizing clamps to the viewport, cancels safely and leaves mobile and other roles usable', async ({ page }) => {
  await login(page);
  const original = await baseline(page);
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  const fleet = page.getByRole('separator', { name: 'Resize fleet panel', exact: true });
  const inspector = page.getByRole('separator', { name: 'Resize inspector panel', exact: true });
  const timeline = page.getByRole('separator', { name: 'Resize timeline', exact: true });
  const box = (await fleet.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 103, box.y + 30, { steps: 4 });
  await expect(fleet).toHaveAttribute('aria-valuenow', '410');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
  await fleet.focus(); await page.keyboard.press('End');
  await inspector.focus(); await page.keyboard.press('End');
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(async () => (await page.locator('#cursus-map-pane').boundingBox())!.width).toBeGreaterThanOrEqual(320);
  await page.locator('details[aria-label="Dispatch readiness"] summary').click();
  await expect.poll(async () => (await page.locator('#cursus-map-pane').boundingBox())!.height).toBeGreaterThanOrEqual(120);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(fleet).toHaveCount(0); await expect(inspector).toHaveCount(0); await expect(timeline).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('details[aria-label="Dispatch readiness"] summary').click();
  await expect(fleet).toHaveAttribute('aria-valuenow', '520');
  // A resize at a constrained desktop width must follow the user's gesture,
  // not shrink due to the sibling's larger saved desktop preference.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(async () => Number(await fleet.getAttribute('aria-valuenow'))).toBeLessThan(520);
  const fitted = Number(await fleet.getAttribute('aria-valuenow'));
  const max = Number(await fleet.getAttribute('aria-valuemax'));
  await fleet.focus(); await page.keyboard.press('ArrowRight');
  await expect(fleet).toHaveAttribute('aria-valuenow', String(Math.min(max, fitted + 10)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'HU', exact: true }).click();
  await expect(page.getByRole('separator', { name: 'Flottapanel átméretezése' })).toBeVisible();
  await page.getByRole('button', { name: 'Elrendezés alaphelyzetbe', exact: true }).click();
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  expect(writes).toEqual([]);
  expect(await baseline(page)).toEqual(original);
});

test('workspace layout tolerates corrupted preferences and unavailable browser storage', async ({ page }) => {
  await login(page, 'planner@acceptance.example.test');
  await page.evaluate(() => localStorage.setItem('cursus.workspace-layout.v1', '{broken'));
  await page.reload();
  const fleet = page.getByRole('separator', { name: 'Resize fleet panel', exact: true });
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (key === 'cursus.workspace-layout.v1') throw new Error('storage unavailable'); return get.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key === 'cursus.workspace-layout.v1') throw new Error('storage full'); set.call(this, key, value); };
  });
  await page.reload();
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
  await fleet.focus(); await page.keyboard.press('ArrowRight');
  await expect(fleet).toHaveAttribute('aria-valuenow', '320');
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await expect(fleet).toHaveAttribute('aria-valuenow', '310');
});

test('native reduced-fleet result reports unassigned orders without claiming efficiency savings', async ({ page }) => {
  await login(page);
  const headers = { origin: new URL(page.url()).origin };
  // The public fixture has exactly two GVW-eligible vehicles for PUBLIC-1.
  // Removing both creates a genuinely unserviceable order, not a mocked plan.
  const edited = await page.request.post('/api/scenarios/acceptance-day-base/edits', {
    headers: { ...headers, 'if-match': '"0"' }, data: { label: 'Readiness service-loss regression', edits: [
      { op: 'removeVehicle', vehicleId: 10 }, { op: 'removeVehicle', vehicleId: 50 },
    ] },
  });
  expect(edited.status()).toBe(200);
  const scenario = await edited.json() as Scenario;
  const submitted = await page.request.post(`/api/scenarios/${scenario.id}/solve`, { headers: { ...headers, 'if-match': `"${scenario.revision}"` }, data: { budgetSec: 1 } });
  expect(submitted.status()).toBe(202);
  const { jobId } = await submitted.json() as { jobId: string };
  let job: Job;
  await expect.poll(async () => {
    job = await get<Job>(page.request, `${peer}/api/jobs/${jobId}`);
    if (job.status === 'failed') throw Error(job.error);
    return job.status;
  }, { timeout: 60000 }).toBe('completed');
  const revised = await get<Plan>(page.request, `${peer}/api/plans/${job!.planId}`);
  expect(revised.unassigned.some(order => order.orderNo === 'PUBLIC-1')).toBe(true);
  const delta = await get<{ deltas: { costTotal: number } }>(page.request,
    `/api/compare?base=${(await baseline(page)).id}&revised=${revised.id}`);
  expect(delta.deltas.costTotal).toBeLessThan(0); // exercises the former false "saved" branch
  // Open details while the real plan response is held: changing the displayed
  // plan must not remount and collapse the user's readiness disclosure.
  const navigation=gate();
  await page.route(`**/api/plans/${revised.id}`,async route=>{await navigation.wait;await route.continue();});
  // Open through the real history UI, including its real scenario context.
  await selectWorkspaceAction(page,'Plans');
  const history = page.getByRole('dialog');
  await history.locator(`[data-plan-id="${revised.id}"]`).getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(history).toHaveCount(0);
  const panel = page.locator('details[aria-label="Dispatch readiness"]');
  await expect(panel.locator('summary')).toContainText('Action required');
  await panel.locator('summary').click();
  await expect(panel).toHaveAttribute('open','');navigation.release();
  const coverage = panel.getByRole('region', { name: 'Coverage', exact: true });
  await expect(coverage).toContainText('PUBLIC-1');
  await expect(panel).toHaveAttribute('open','');
  await page.unroute(`**/api/plans/${revised.id}`);
  await expect(coverage).toContainText('Unassigned orders are reported by Surge');
  await expect(panel).toContainText('Lower distance or cost must not be interpreted as efficiency savings');
  await selectWorkspaceAction(page,'Compare');
  const comparison = page.getByRole('dialog');
  await expect(comparison).toContainText('Lower distance or cost must not be interpreted as efficiency savings');
  await expect(comparison.getByText(/% saved/)).toHaveCount(0);
});

test('native plan review, Admin-only approval and cross-replica stale-edit protection', async ({ page }) => {
  await login(page);
  const original = await baseline(page);
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const created = await page.request.post('/api/scenarios', { headers, data: { from: original.scenarioId, label: 'Collaborative review regression' } });
  expect(created.status()).toBe(201);
  const scenario = await created.json() as Scenario;
  const submitted = await page.request.post(`/api/scenarios/${scenario.id}/solve`, { headers: { ...headers, 'if-match': `"${scenario.revision}"` }, data: { budgetSec: 1 } });
  expect(submitted.status()).toBe(202);
  const { jobId } = await submitted.json() as { jobId: string };
  let job: Job;
  await expect.poll(async () => { job = await get<Job>(page.request, `/api/jobs/${jobId}`); return job.status; }).toBe('completed');
  const planId = job!.planId!;
  const navigation = gate();
  await page.route(`**/api/plans/${planId}`, async route => { await navigation.wait; await route.continue(); });
  await selectWorkspaceAction(page,'Plans');
  await page.getByRole('dialog').locator(`[data-plan-id="${planId}"]`).getByRole('button', { name: 'Reopen', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Plan approval', exact: true });
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review & release', exact: true })).toBeDisabled();
  for(const label of ['Prepare','Plan','Library'])await expect(page.getByRole('navigation',{name:'Workspace tools'}).getByRole('button',{name:label,exact:true})).toBeDisabled();
  navigation.release();
  await expect(page.getByRole('button', { name: 'Review & release', exact: true })).toBeEnabled();
  await selectWorkspaceAction(page,'Plan approval');
  await expect(panel).toHaveAttribute('data-plan-id', planId);
  await page.unroute(`**/api/plans/${planId}`);
  await expect(panel).toContainText('Draft');
  const handoffUrl = `/api/plans/${planId}/handoff.json`;
  expect((await get<{ handoff: { status: string } }>(page.request, `${peer}${handoffUrl}`)).handoff.status).toBe('Draft');
  // A rolling-upgrade peer may ignore approval=required and return HTTP 200.
  // Missing receipts must never produce a download labelled Approved.
  let badDownloads = 0;
  const countBadDownload = () => { badDownloads++; };
  page.on('download', countBadDownload);
  await page.route(`**${handoffUrl}?approval=required`, route => route.fulfill({ json: { otto_dispatch_plan: 1, routes: [] } }));
  await page.getByRole('button', { name: 'Review & release', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Approved handoff only (JSON)', exact: true }).click();
  await expect(page.getByRole('menu').getByRole('alert')).toContainText('not currently approved');
  expect(badDownloads).toBe(0);
  page.off('download', countBadDownload);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Review & release',exact:true})).toBeFocused();
  await page.unroute(`**${handoffUrl}?approval=required`);
  await page.getByRole('button', { name: 'Review & release', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Approved handoff only (JSON)', exact: true }).click();
  await expect(page.getByRole('menu').getByRole('alert')).toContainText('not currently approved');
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await selectWorkspaceAction(page,'Plan approval');
  await expect(panel.getByRole('checkbox')).toBeChecked();
  await panel.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(panel).toContainText('Reviewed');
  expect((await get<{ handoff: { status: string } }>(page.request, `${peer}${handoffUrl}`)).handoff.status).toBe('Draft');
  const reviewed = await get<{ state: string; actor: string }>(page.request, `${peer}/api/plans/${planId}/workflow`);
  expect(reviewed.state).toBe('reviewed');
  expect(reviewed.actor).toBe((await get<{ userId: string }>(page.request, '/api/auth/me')).userId);
  for (const role of ['reviewer', 'planner']) {
    expect((await page.request.post('/api/auth/view-as', { headers, data: { role } })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(panel.getByRole('button', { name: 'Approve plan', exact: true })).toHaveCount(0);
    expect((await page.request.post(`${peer}/api/plans/${planId}/approve`, { headers, data: { version: 1, revision: scenario.revision, acknowledgeExceptions: true, role: 'admin' } })).status()).toBe(403);
    if (role === 'reviewer') expect((await page.request.post(`/api/plans/${planId}/review`, { headers, data: {} })).status()).toBe(403);
  }
  expect((await page.request.post('/api/auth/view-as', { headers, data: { role: null } })).status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(panel.getByRole('button', { name: 'Approve plan', exact: true })).toBeVisible();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(panel).toContainText('Approved');
  const receipt = await get<{ handoff: { status: string; planId: string; scenarioRevision: number; approval: { approver: { email: string; identitySource: string } } } }>(page.request, `${peer}${handoffUrl}?approval=required`);
  expect(receipt.handoff.status).toBe('Approved'); expect(receipt.handoff.planId).toBe(planId);
  expect(receipt.handoff.scenarioRevision).toBe(scenario.revision);
  expect(receipt.handoff.approval.approver.email).toBe('admin@acceptance.example.test');
  expect(receipt.handoff.approval.approver.identitySource).toBe('approval-event');
  // Reviewer may receive an approved handoff but cannot grant approval.
  expect((await page.request.post('/api/auth/view-as', { headers, data: { role: 'reviewer' } })).status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(panel.getByRole('button', { name: 'Approve plan', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review & release', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Approved handoff only (JSON)', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`cursus-${planId}-approved.json`);
  const saved = JSON.parse(readFileSync((await download.path())!, 'utf8')) as typeof receipt;
  expect(saved.handoff.approval).toEqual(receipt.handoff.approval);
  expect(saved.handoff.planId).toBe(planId);
  expect((await page.request.post('/api/auth/view-as', { headers, data: { role: null } })).status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const updated = await page.request.post(`${peer}/api/scenarios/${scenario.id}/edit`, { headers: { ...headers, 'if-match': `"${scenario.revision}"` }, data: { edit: { op: 'removeVehicle', vehicleId: 10 } } });
  expect(updated.status()).toBe(200);
  await expect(page.getByText('This scenario changed in another workspace. Reload before continuing.', { exact: false })).toBeVisible();
  await expect(panel).toContainText('Superseded');
  expect((await page.request.get(`${peer}${handoffUrl}?approval=required`)).status()).toBe(409);
  expect((await get<{ handoff: { status: string } }>(page.request, handoffUrl)).handoff.status).toBe('Superseded');
  await page.getByRole('button', { name: 'Review & release', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Approved handoff only (JSON)', exact: true }).click();
  await expect(page.getByRole('menu').getByRole('alert')).toContainText('not currently approved');
  await page.keyboard.press('Escape');
  expect((await page.request.post(`/api/scenarios/${scenario.id}/solve`, { headers: { ...headers, 'if-match': `"${scenario.revision}"` }, data: {} })).status()).toBe(409);
  await expect(page.getByRole('button', { name: /^Replan/ })).toHaveCount(0);
  expect((await get<Plan>(page.request, `${peer}/api/plans/${planId}`)).id).toBe(planId);
  expect(await baseline(page)).toEqual(original);
});

test('restart retains authentication, plans, and exports while the peer stays ready', async ({ page }) => {
  await login(page);
  const original = await baseline(page);
  dc('restart', '--timeout', '40', 'app-a');
  await expect.poll(async () => {
    try { return (await page.request.get('/health/ready')).status(); }
    catch { return 0; } // connection resets are expected while the process restarts
  }).toBe(200);
  expect((await page.request.get(`${peer}/health/ready`)).status()).toBe(200);
  const restored = await get<Plan>(page.request, `/api/plans/${original.id}`);
  expect(restored).toEqual(original);
  expect((await get<{ tenantId: string }>(page.request, '/api/auth/me')).tenantId).toBe('acceptance');
  const exportA = await get<{ handoff: { checkedAt: string } }>(page.request, `/api/plans/${original.id}/handoff.json`);
  const exportB = await get<{ handoff: { checkedAt: string } }>(page.request, `${peer}/api/plans/${original.id}/handoff.json`);
  expect(Number.isFinite(Date.parse(exportA.handoff.checkedAt))).toBe(true);
  expect(exportA).toEqual({ ...exportB, handoff: { ...exportB.handoff, checkedAt: exportA.handoff.checkedAt } });
  await page.reload();
  await expect(page.getByText('Served / Total')).toBeVisible();
});

test('history, week, provenance, and upload render with real stateful responses', async ({ page }) => {
  await login(page);
  await selectWorkspaceAction(page,'Plans');
  await expect(page.getByRole('dialog').getByText('Saved plans')).toBeVisible();
  await expect(page.getByRole('dialog').locator('[data-plan-id]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await selectWorkspaceAction(page,'Week');
  await expect(page.getByRole('dialog').getByText('Week overview')).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/Not found/)).toHaveCount(0);
  await page.keyboard.press('Escape');
  const summary = await get<{ sources: { sha256: string }[] }>(page.request, '/api/import/summary');
  await selectWorkspaceAction(page,'Data');
  const checksum = page.getByText(new RegExp(`sha ${summary.sources[0]!.sha256}`));
  await expect(checksum).toBeVisible();
  // Read both boxes in one frame; separate browser round trips can straddle
  // the dialog's entrance animation and compare different coordinate systems.
  const bounds = await checksum.evaluate(el => ({ text: el.getBoundingClientRect().right,
    card: el.parentElement!.getBoundingClientRect().right }));
  expect(bounds.text).toBeLessThanOrEqual(bounds.card + 1);
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'public-orders.csv', mimeType: 'text/csv',
    buffer: Buffer.from('order_no,customer,city,delivery_date,address\nPUBLIC-UPLOAD,Public fixture,Budapest,2026-05-06,Test utca 1\n') });
  await expect(page.getByText('Map columns')).toBeVisible();
  await expect(page.getByText('1 rows')).toBeVisible();
  expect(await page.locator('table select').count()).toBeGreaterThan(0);
  // An uploaded but unvalidated source must not become a solver dataset.
  expect(await get<unknown[]>(page.request, `${peer}/api/import/datasets`)).toHaveLength(1);
});

test('approved fleet profiles are explicitly pinned, replan with native Surge and preserve earlier revisions',async({page})=>{
 await login(page);await shortBudget(page);
 await selectWorkspaceAction(page,'Planning profiles');
 const dialog=page.getByRole('dialog',{name:'Planning profiles',exact:true});
 await dialog.getByRole('button',{name:'New fleet profile',exact:true}).click();
 const label='Public approved fleet '+Date.now();
 await dialog.getByRole('textbox',{name:'Profile name',exact:true}).fill(label);
 await dialog.getByRole('textbox',{name:'Change reason',exact:true}).fill('Verified public fleet and capacity evidence');
 await dialog.getByRole('button',{name:'Propose revision',exact:true}).click();
 const card=dialog.locator('article').filter({hasText:label});
 await expect(card).toContainText('Proposed');
 await card.getByText('Profile details',{exact:true}).click();
 await expect(card).toContainText('Payload'); // accessible business values, not raw JSON
 await card.getByRole('button',{name:'Approve and activate',exact:true}).click();
 await expect(card).toContainText('Active');
 await card.getByRole('checkbox',{name:'Use in this scenario',exact:true}).check();
 await dialog.getByRole('button',{name:'Apply profile selection — Replan required',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 const plan=await finishSolve(page,()=>page.getByRole('button',{name:'Replan',exact:true}).click());
 expect(plan.provenance.planningProfiles).toHaveLength(1);expect(plan.provenance.planningProfiles![0].revision).toBe(1);
 await selectWorkspaceAction(page,'Planning profiles');
 await dialog.locator('article').filter({hasText:label}).getByRole('button',{name:'Propose changes',exact:true}).click();
 await dialog.getByRole('textbox',{name:'Change reason',exact:true}).fill('Later proposed revision, not activated');
 await dialog.getByRole('button',{name:'Propose revision',exact:true}).click();
 await expect(dialog.locator('article').filter({hasText:label})).toHaveCount(2);
 expect((await get<Scenario>(page.request,`${peer}/api/scenarios/${plan.scenarioId}`)).planningProfiles).toEqual(plan.provenance.planningProfiles);
 expect((await get<Plan>(page.request,`${peer}/api/plans/${plan.id}`)).provenance.planningProfiles![0].revision).toBe(1);
});

test('Planner may propose profiles but cannot activate them; Reviewer cannot propose',async({page})=>{
 await login(page,'planner@acceptance.example.test');
 await selectWorkspaceAction(page,'Planning profiles');
 const dialog=page.getByRole('dialog',{name:'Planning profiles',exact:true});
 await dialog.getByRole('button',{name:'New fleet profile',exact:true}).click();
 await dialog.getByRole('textbox',{name:'Profile name',exact:true}).fill('Planner proposal');
 await dialog.getByRole('textbox',{name:'Change reason',exact:true}).fill('Requires Admin verification');
 const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/profiles');
 await dialog.getByRole('button',{name:'Propose revision',exact:true}).click();
 const response=await submitted;expect(response.status()).toBe(201);const profile=await response.json() as {id:string;revision:number;version:number};
 await expect(dialog.getByRole('button',{name:'Approve and activate',exact:true})).toHaveCount(0);
 expect((await page.request.post(`/api/profiles/${profile.id}/activate`,{headers:{origin:new URL(page.url()).origin,'if-match':`"${profile.version}"`},data:{revision:profile.revision}})).status()).toBe(403);
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Sign out',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Continue to Cursus',exact:true})).toBeVisible();
 await login(page,'reviewer@acceptance.example.test');
 await selectWorkspaceAction(page,'Planning profiles');
 await expect(dialog.getByRole('button',{name:'New fleet profile',exact:true})).toHaveCount(0);
 await expect(dialog.getByRole('button',{name:'Propose changes',exact:true})).toHaveCount(0);
 expect((await page.request.post('/api/profiles',{headers:{origin:new URL(page.url()).origin,'if-match':'"0"'},data:{content:{}}})).status()).toBe(403);
});

test('shipment detail preserves source line items and load units without changing order KPIs',async({page})=>{
 await login(page);const plan=await baseline(page),stop=plan.vehicles[0].trips[0].stops[0];
 await manualStop(page,plan,stop.orderNo);
 const details=page.getByRole('region',{name:'Shipment details',exact:true});
 await expect(details).toContainText('Gross');await expect(details).toContainText('case');await expect(details).toContainText('EUR pallet');
 await expect(details).toContainText('Spatial loading feasibility and axle loads have not been verified.');
 const delivery=plan.shipmentMetadata!.deliveries.find(d=>d.requestId===stop.requestId)!;
 await expect(details).toContainText(delivery.id);
 const handoff=await get<{shipmentMetadata:Plan['shipmentMetadata'];summary:{servedOrders:number}}>(page.request,`${peer}/api/plans/${plan.id}/handoff.json`);
 expect(handoff.shipmentMetadata).toEqual(plan.shipmentMetadata);expect(handoff.summary.servedOrders).toBe(plan.stats.servedOrders);
});

test('saved manual workspace survives failed metadata reads and slow road geometry without losing its preview',async({page})=>{
 await login(page);const base=await baseline(page);
 await page.getByRole('button',{name:'Manual planning',exact:true}).click();await manualStop(page,base,'PUBLIC-2');
 await page.getByRole('button',{name:'Return to unassigned',exact:true}).click();const saved=await applyManualDialog(page);
 const key='cursus.manual-workspace.v1:acceptance';await expect.poll(()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)??'null')?.planId,key)).toBe(saved.id);
 let failStored=true;const roads=gate(),finished=gate();
 await page.route(`**/api/plans/${saved.id}*`,async route=>{
  const url=new URL(route.request().url());
  if(url.pathname!==`/api/plans/${saved.id}`){await route.continue();return;}
  if(url.searchParams.get('geometry')==='stored'){
   if(failStored){await route.fulfill({status:503,json:{error:'Temporary snapshot outage'}});return;}
   await route.continue();return;
  }
  await roads.wait;const response=await route.fetch();const value=await response.json();
  value.stats.servedOrders=999;
  for(const vehicle of value.vehicles)for(const trip of vehicle.trips)if(trip.stops.length)trip.geometry={type:'LineString',coordinates:[[19,47],[19.01,47.01]]};
  await route.fulfill({response,json:value});finished.release();
 });
 try{
  const outage=page.waitForResponse(r=>r.url().includes(`/api/plans/${saved.id}?geometry=stored`)&&r.status()===503);
  await page.reload();await outage;await expect(page.getByText('Served / Total',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)??'null')?.planId,key)).toBe(saved.id);
  failStored=false;await page.reload();await expect(page.getByText('5 / 6',{exact:true})).toBeVisible();
  await expect(page.locator('section[aria-label="Plan approval"]')).toHaveAttribute('data-plan-id',saved.id);
  await page.getByRole('button',{name:'Undo manual change',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Manual planning',exact:true});
  const previewRequest=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/manual-preview'));
  await dialog.getByRole('button',{name:'Calculate preview',exact:true}).click();const intent=(await previewRequest).postDataJSON();
  await expect(dialog.getByTestId('manual-preview')).toBeVisible();roads.release();await finished.wait;
  await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  await expect(page.getByText('5 / 6',{exact:true})).toBeVisible();await expect(dialog.getByTestId('manual-preview')).toBeVisible();
  const applied=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/manual-plan'));
  await dialog.getByRole('button',{name:'Apply manual change',exact:true}).click();const response=await applied;
  expect(response.status()).toBe(201);expect(response.request().postDataJSON().batch.operationId).toBe(intent.batch.operationId);
  await expect(page.getByText('6 / 6',{exact:true})).toBeVisible();
 }finally{roads.release();}
});

test('duplicate display references survive keyboard reordering, native replanning and individual bulk assignment',async({page})=>{
 await login(page);await shortBudget(page);
 const days=await get<DaySummary[]>(page.request,'/api/days'),day=days.find(d=>d.id==='acceptance-day-two')!;
 const base=await get<Plan>(page.request,`/api/plans/${day.baselinePlanId}`);
 await page.getByRole('combobox').first().click();await page.getByRole('option',{name:/7 May 2026/}).click();
 await expect(page.getByText('2 / 2',{exact:true})).toBeVisible();
 const vehicle=base.vehicles.find(v=>v.trips.some(t=>t.stops.length===2))!,trip=vehicle.trips.find(t=>t.stops.length===2)!;
 expect(new Set(trip.stops.map(s=>s.orderNo)).size).toBe(1);
 await page.locator('aside').first().getByText(vehicle.ref,{exact:true}).click();
 const inspector=page.locator('aside').last();await inspector.getByRole('button',{name:/Trip 1 ·/}).click();
 const evaluated=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/evaluate'));
 await inspector.locator('ol li').first().locator('button[data-move$=":1"]').click();expect((await evaluated).status()).toBe(200);
 const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/solve'));
 await page.getByRole('button',{name:'Replan',exact:true}).click();const submission=await submitted;expect(submission.status()).toBe(202);
 const {jobId}=await submission.json() as {jobId:string};let job:Job;
 await expect.poll(async()=>{job=await get<Job>(page.request,`${peer}/api/jobs/${jobId}`);if(job.status==='failed')throw Error(job.error);return job.status;},{timeout:60000}).toBe('completed');
 const candidate=await get<Plan>(page.request,`${peer}/api/plans/${job!.planId}`);
 expect(candidate.vehicles.find(v=>v.id===vehicle.id)!.trips.flatMap(t=>t.stops.map(s=>s.requestId))).toEqual(trip.stops.map(s=>s.requestId).reverse());
 await expect(page.getByRole('dialog')).toContainText('Plan comparison');await page.keyboard.press('Escape');
 await page.getByRole('region',{name:'Plan candidate'}).getByRole('button',{name:'Use candidate',exact:true}).click();
 await expect(page.getByRole('region',{name:'Plan candidate'})).toHaveCount(0);
 // Keep the sequenced scenario intact and reopen the untouched day snapshot
 // for independent manual deassignment checks.
 await selectWorkspaceAction(page,'Plans');
 page.once('dialog',dialog=>void dialog.accept());
 const reopenedContext=page.waitForResponse(r=>r.url().endsWith(`/api/plans/${base.id}/manual-context`));
 await page.getByRole('dialog').locator(`[data-plan-id="${base.id}"]`).getByRole('button',{name:'Reopen',exact:true}).click();
 expect((await reopenedContext).status()).toBe(200);
 await page.getByRole('button',{name:'Manual planning',exact:true}).click();
 await expect(page.getByRole('button',{name:'Manual planning',exact:true})).toHaveAttribute('aria-pressed','true');
 let current=base;
 for(const requestId of [170,130]){
  const v=current.vehicles.find(v=>v.trips.some(t=>t.stops.some(s=>s.requestId===requestId)))!,tr=v.trips.find(t=>t.stops.some(s=>s.requestId===requestId))!,s=tr.stops.find(s=>s.requestId===requestId)!;
  await page.locator('aside').first().getByText(v.ref,{exact:true}).click();
  await inspector.getByRole('button',{name:new RegExp(`Trip ${tr.index+1} ·`)}).click();
  const target=inspector.locator('ol li > button').filter({hasText:s.customer!});
  await expect(target).toHaveAttribute('data-request-id',String(requestId));await target.click();
  await expect(inspector.getByRole('region',{name:'Shipment details',exact:true})).toContainText(`delivery-${requestId}`);
  await page.getByRole('button',{name:'Return to unassigned',exact:true}).click();current=await applyManualDialog(page);
  expect(current.manual?.layout.history.at(-1)?.requestId).toBe(requestId);
 }
 expect(current.unassigned.map(o=>o.requestId).sort()).toEqual([130,170]);
 const target=page.getByRole('checkbox',{name:'Select order PUBLIC-REPEAT · 170',exact:true});
 if(!(await target.count()))await page.locator('aside').first().getByRole('button',{name:/Unassigned orders/i}).click();
 await target.check();await expect(page.getByRole('checkbox',{name:'Select order PUBLIC-REPEAT · 130',exact:true})).not.toBeChecked();
 await page.getByRole('combobox',{name:'Assign to vehicle…',exact:true}).selectOption('10');await page.getByRole('button',{name:'Assign',exact:true}).click();
 const assigned=await applyManualDialog(page);expect(assigned.unassigned.map(o=>o.requestId)).toEqual([130]);
 expect(assigned.stats.servedOrders).toBe(1);expect(assigned.stats.totalOrders).toBe(2);
 const handoff=await get<{routes:{stops:{requestId:number}[]}[]}>(page.request,`${peer}/api/plans/${assigned.id}/handoff.json`);
 expect(handoff.routes.flatMap(r=>r.stops.map(s=>s.requestId))).toEqual([170]);
});

test('approved handoff is durable across replicas, read-only for Planner/Reviewer, acknowledged and explicitly cancelled',async({page})=>{
 await login(page);await shortBudget(page);
 const plan=await finishSolve(page,()=>page.getByRole('button',{name:'Optimize',exact:true}).click());
 await selectWorkspaceAction(page,'Plan approval');
 const approval=page.getByRole('region',{name:'Plan approval',exact:true});
 await approval.getByRole('checkbox').check();await approval.getByRole('button',{name:'Mark reviewed',exact:true}).click();
 await expect(approval).toContainText('Reviewed');await approval.getByRole('checkbox').check();await approval.getByRole('button',{name:'Approve plan',exact:true}).click();await expect(approval).toContainText('Approved');
 await selectWorkspaceAction(page,'Acknowledged handoff');
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Acceptance warehouse');
 await expect(dialog.getByRole('button',{name:'Send approved plan',exact:true})).toBeDisabled();
 await dialog.getByRole('textbox',{name:'Handoff reason',exact:true}).fill('Public acceptance dispatch');await dialog.getByRole('checkbox').check();
 const queued=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/transfers/publish'));
 await dialog.getByRole('button',{name:'Send approved plan',exact:true}).click();const response=await queued;expect(response.status()).toBe(202);const intent=await response.json() as {id:string};
 const status=()=>get<{intents:{id:string;state:string;receipt:{receiptId:string}|null}[];heads:{acceptedIntentId:string}[]}>(page.request,`${peer}/api/plans/${plan.id}/transfers`);
 await expect.poll(async()=>(await status()).intents.find(i=>i.id===intent.id)?.state).toBe('acknowledged');
 await expect(dialog).toContainText(`test-receipt-${intent.id}`);
 await page.keyboard.press('Escape');
 const headers={origin:new URL(page.url()).origin};
 for(const role of ['planner','reviewer']){
  expect((await page.request.post('/api/auth/view-as',{headers,data:{role}})).status()).toBe(200);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('contentinfo')).toContainText(role==='planner'?'Planner':'Reviewer');
  await selectWorkspaceAction(page,'Acknowledged handoff');await expect(dialog).toContainText(`test-receipt-${intent.id}`);
  await expect(dialog.getByRole('textbox',{name:'Handoff reason',exact:true})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'Cancel accepted instruction',exact:true})).toHaveCount(0);
  expect((await page.request.post(`${peer}/api/plans/${plan.id}/transfers/cancel`,{headers:{...headers,'if-match':`"${plan.scenarioRevision}"`},data:{}})).status()).toBe(403);
  expect((await page.request.post(`/api/handoff/${intent.id}/retry`,{headers,data:{mode:'lookup'}})).status()).toBe(403);await page.keyboard.press('Escape');
 }
 expect((await page.request.post('/api/auth/view-as',{headers,data:{role:null}})).status()).toBe(200);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.getByRole('contentinfo')).toContainText('Admin');await selectWorkspaceAction(page,'Acknowledged handoff');
 await dialog.getByRole('textbox',{name:'Handoff reason',exact:true}).fill('Public acceptance cancellation');await dialog.getByRole('checkbox').check();
 const cancelled=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/transfers/cancel'));
 await dialog.getByRole('button',{name:'Cancel accepted instruction',exact:true}).click();const cancellation=await cancelled;expect(cancellation.status()).toBe(202);const second=await cancellation.json() as {id:string};
 await expect.poll(async()=>(await status()).intents.find(i=>i.id===second.id)?.state).toBe('acknowledged');
 expect((await status()).heads[0]!.acceptedIntentId).toBe(second.id);await expect(dialog).toContainText(`test-receipt-${second.id}`);
});

// Navigation is presentation-only: no writes, lost focus or reset state.
test('workspace navigation: keyboard and dialog focus preserve state without writes',async({page},testInfo)=>{
 await login(page);
 const writes:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method()))writes.push(r.method()+' '+new URL(r.url()).pathname);});
 const before=await get<Scenario[]>(page.request,'/api/scenarios');
 const selected=await page.evaluate(()=>localStorage.getItem('cursus.manual-workspace.v1:acceptance'));
 const nav=page.getByRole('navigation',{name:'Workspace tools'}),prepare=nav.getByRole('button',{name:'Prepare',exact:true});
 await prepare.focus();await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitem',{name:'Data',exact:true})).toBeFocused();
 await page.keyboard.press('End');await expect(page.getByRole('menuitem').last()).toBeFocused();
 await page.keyboard.press('Home');await expect(page.getByRole('menuitem',{name:'Data',exact:true})).toBeFocused();
 await page.keyboard.press('ArrowUp');await expect(page.getByRole('menuitem').last()).toBeFocused();
 await page.keyboard.press('Escape');await expect(prepare).toBeFocused();await expect(page.getByRole('menu')).toHaveCount(0);
 await prepare.click();await prepare.click();await expect(page.getByRole('menu')).toHaveCount(0);
 await prepare.focus();await page.keyboard.press('ArrowUp');await expect(page.getByRole('menuitem').last()).toBeFocused();
 await page.keyboard.press('Tab');await expect(page.getByRole('menu')).toHaveCount(0);await expect(nav.getByRole('button',{name:'Plan',exact:true})).toBeFocused();
 await prepare.click();await page.keyboard.press('Shift+Tab');await expect(page.getByRole('menu')).toHaveCount(0);await expect(prepare).toBeFocused();
 for(const [action,group] of [['Data','Prepare'],['Scenarios','Library'],['Issues','Plan']] as const){
  await selectWorkspaceAction(page,action);await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(nav.getByRole('button',{name:group,exact:true})).toBeFocused();
 }
 await selectWorkspaceAction(page,'Plan approval');await expect(page.locator('#cursus-plan-review')).toBeFocused();
 await prepare.click();await page.locator('header').getByText('Cursus',{exact:true}).click();await expect(page.getByRole('menu')).toHaveCount(0);
 expect(await get<Scenario[]>(page.request,'/api/scenarios')).toEqual(before);expect(await page.evaluate(()=>localStorage.getItem('cursus.manual-workspace.v1:acceptance'))).toBe(selected);expect(writes).toEqual([]);
 await page.screenshot({path:testInfo.outputPath('workspace-desktop.png')});
});

for(const role of ['admin','planner','reviewer'] as const)test(`workspace navigation: ${role} narrow EN/HU menus preserve permission boundaries`,async({page},testInfo)=>{
 await chaosLogin(page,role);
 try{
  const writes:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method()))writes.push(r.url());});
  for(const width of [375,600,1440])for(const hu of [false,true]){
   await page.setViewportSize({width,height:900});await page.getByRole('button',{name:hu?'HU':'EN',exact:true}).click();
   const labels=hu?['Előkészítés','Tervezés','Ellenőrzés és átadás','Tervek és munkaterületek']:['Prepare','Plan','Review & release','Library'];
   const nav=page.getByRole('navigation',{name:hu?'Munkaterület eszközei':'Workspace tools'});
   for(const label of labels){
    const trigger=nav.getByRole('button',{name:label,exact:true});await trigger.click();const menu=page.getByRole('menu',{name:label,exact:true});await expect(menu).toBeVisible();
    const box=await menu.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);expect(box!.y+box!.height).toBeLessThanOrEqual(901);
    await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
   }
   expect(await page.locator('header').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   if(width===375)await page.screenshot({path:testInfo.outputPath(`workspace-${role}-${hu?'hu':'en'}-375.png`)});
  }
  await page.getByRole('button',{name:'EN',exact:true}).click();await selectWorkspaceAction(page,'Data');await expect(page.getByRole('dialog').getByRole('tab',{name:'Upload',exact:true})).toHaveCount(role==='admin'?1:0);await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Optimize',exact:true})).toHaveCount(role==='reviewer'?0:1);expect(writes).toEqual([]);
 }finally{chaosRole('planner');}
});


test('workspace navigation: first outside click starts one native solve without losing its candidate',async({page})=>{
 await login(page);await shortBudget(page);
 let submissions=0;page.on('request',r=>{if(r.method()==='POST'&&/\/api\/scenarios\/[^/]+\/solve$/.test(new URL(r.url()).pathname))submissions++;});
 await openWorkspaceMenu(page,'Prepare');
 await finishSolve(page,()=>page.getByRole('button',{name:'Optimize',exact:true}).click());
 expect(submissions).toBe(1);
});

for(const role of ['admin','planner','reviewer'] as const)test(`compact status: ${role} EN/HU disclosure is compact, keyboard reachable and read-only`,async({page},testInfo)=>{
 await chaosLogin(page,role);
 try{
  const base=await baseline(page),writes:string[]=[];
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method()))writes.push(r.url());});
  const details=page.locator('#cursus-status-details'),summary=details.locator('summary');
  await expect(summary.getByTestId('status-approval')).toContainText('Draft');
  await expect(details).not.toHaveAttribute('open','');
  await expect(page.getByRole('region',{name:'Plan approval',exact:true})).toHaveCount(0);
  const startHeight=(await page.locator('#cursus-map-pane').boundingBox())!.height;
  await summary.focus();await page.keyboard.press('Enter');await expect(details).toHaveAttribute('open','');
  await expect(page.getByRole('region',{name:'Coverage',exact:true})).toBeVisible();
  const approval=page.getByRole('region',{name:'Plan approval',exact:true});await expect(approval).toBeVisible();
  if(role==='reviewer')await expect(approval.getByRole('button')).toHaveCount(0);
  else await approval.getByRole('checkbox').check();
  await summary.focus();await page.keyboard.press('Space');await expect(details).not.toHaveAttribute('open','');
  await expect.poll(async()=>(await page.locator('#cursus-map-pane').boundingBox())!.height).toBe(startHeight);
  await selectWorkspaceAction(page,'Plan approval');await expect(page.locator('#cursus-plan-review')).toBeFocused();
  if(role!=='reviewer')await expect(approval.getByRole('checkbox')).toBeChecked();
  await summary.click();
  for(const width of [375,600,1440])for(const hu of [false,true]){
   await page.setViewportSize({width,height:900});await page.getByRole('button',{name:hu?'HU':'EN',exact:true}).click();
   for(const id of ['status-coverage','status-freshness','status-approval'])await expect(summary.getByTestId(id)).toBeVisible();
   expect(await details.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   const box=(await summary.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);
   if(width===1440)expect(box.height).toBeLessThan(80);
   await page.screenshot({path:testInfo.outputPath(`compact-${role}-${hu?'hu':'en'}-${width}.png`)});
   await summary.click();await expect(details).toHaveAttribute('open','');
   expect(await details.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   await summary.click();
  }
  expect(writes).toEqual([]);expect(await baseline(page)).toEqual(base);
 }finally{chaosRole('planner');}
});

async function statusScenario(page:Page,label:string){
 const base=await baseline(page),headers={origin:new URL(page.url()).origin};
 const response=await page.request.post('/api/scenarios',{headers,data:{from:base.scenarioId,label}});expect(response.status()).toBe(201);
 const scenario=await response.json() as Scenario;
 const submitted=await page.request.post(`/api/scenarios/${scenario.id}/solve`,{headers:{...headers,'if-match':`"${scenario.revision}"`},data:{budgetSec:1}});expect(submitted.status()).toBe(202);
 const {jobId}=await submitted.json() as {jobId:string};let job:Job;
 await expect.poll(async()=>{job=await get<Job>(page.request,`${peer}/api/jobs/${jobId}`);return job.status;},{timeout:60000}).toBe('completed');
 return {plan:await get<Plan>(page.request,`${peer}/api/plans/${job!.planId}`),scenario,headers};
}
async function reopenStatusPlan(page:Page,id:string){
 await selectWorkspaceAction(page,'Plans');
 const dialog=page.getByRole('dialog'),target=dialog.locator(`[data-plan-id="${id}"]`).getByRole('button',{name:'Reopen',exact:true});
 await expect(target).toBeVisible();
 // Exercise the actual CSS entrance at both intermediate points. Its center
 // must stay anchored even while a long list changes the dialog's height.
 const geometry=await dialog.evaluate(element=>{
  // CI may finish the short entrance before Playwright reaches evaluate.
  // Replay the element's real stylesheet animation synchronously, then sample
  // its actual keyframes without depending on runner scheduling.
  const inlineAnimation=(element as HTMLElement).style.animation;
  (element as HTMLElement).style.animation='none';
  void (element as HTMLElement).offsetWidth;
  (element as HTMLElement).style.animation=inlineAnimation;
  const animation=element.getAnimations().find(a=>a instanceof CSSAnimation&&a.animationName==='enter');
  if(!animation||!animation.effect)throw Error('Expected the real dialog entrance animation');
  const duration=Number(animation.effect.getTiming().duration),samples=[];
  animation.pause();
  try{for(const progress of [0.25,0.75]){animation.currentTime=duration*progress;const r=element.getBoundingClientRect();samples.push({x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight});}}
  finally{animation.finish();}
  const viewport=element.querySelector('[data-radix-scroll-area-viewport]')!;
  return {samples,listHeight:viewport.getBoundingClientRect().height,maxListHeight:innerHeight*0.6};
 });
 for(const sample of geometry.samples){expect(Math.abs(sample.x-sample.width/2)).toBeLessThan(2);expect(Math.abs(sample.y-sample.height/2)).toBeLessThan(2);}
 expect(geometry.listHeight).toBeLessThanOrEqual(geometry.maxListHeight+1);
 await target.scrollIntoViewIfNeeded();await expect(target).toBeInViewport({ratio:1});await target.click();
 await expect(dialog).toHaveCount(0);await expect(page.locator('section[aria-label="Plan approval"]')).toHaveAttribute('data-plan-id',id);
}

test('compact status: unavailable or corrupt approval stays Unknown, retry is read-only and old responses cannot certify another plan',async({page})=>{
 await login(page);
 const {plan,scenario,headers}=await statusScenario(page,'Approval status recovery');
 let version=0;
 for(const action of ['review','approve']){
  const response=await page.request.post(`${peer}/api/plans/${plan.id}/${action}`,{headers,data:{version,revision:scenario.revision,acknowledgeExceptions:true}});expect(response.status(),await response.text()).toBe(200);version++;
 }
 await reopenStatusPlan(page,plan.id);
 const status=page.getByTestId('status-approval');await expect(status).toContainText('Approved');
 const writes:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method()))writes.push(r.url());});
 const authoritative=await get<Workflow>(page.request,`/api/plans/${plan.id}/workflow`);
 let mode:'503'|'404'|'invalid'|'older'|'success'|'held'='503',reads=0;
 let held=gate(),captured=gate(),finished=gate();
 const path=`**/api/plans/${plan.id}/workflow`;
 await page.route(path,async route=>{
  reads++;
  if(mode==='503'||mode==='404'){await route.fulfill({status:Number(mode),json:{error:'Public fixture approval outage'}});return;}
  if(mode==='invalid'){await route.fulfill({json:{state:'approved'}});return;}
  if(mode==='older'){await route.fulfill({json:{...authoritative,state:'draft',version:0}});return;}
  if(mode==='held'){const response=await route.fetch();captured.release();await held.wait;await route.fulfill({response});finished.release();return;}
  await route.continue();
 });
 try{
  await expect(status).toContainText('Unknown');await expect(status).not.toContainText('Approved');
  await selectWorkspaceAction(page,'Plan approval');
  for(const failure of ['503','404','invalid','older'] as const){
   mode=failure;await page.getByRole('button',{name:'Retry approval status',exact:true}).click();
   await expect(status).toContainText('Unknown');await expect(status).not.toContainText('Approved');
   await expect(page.getByRole('button',{name:'Approve plan',exact:true})).toHaveCount(0);
  }
  mode='held';
  await page.getByRole('button',{name:'Retry approval status',exact:true}).click();await captured.wait;const heldReadCount=reads;
  await expect(status).toContainText('Loading');
  // A timer tick during a held read must not start overlapping refreshes.
  await page.waitForTimeout(5200);expect(reads).toBe(heldReadCount);
  held.release();await finished.wait;await expect(status).toContainText('Approved');
  held=gate();captured=gate();finished=gate();
  await captured.wait;
  const base=await baseline(page);await reopenStatusPlan(page,base.id);
  await expect(status).toContainText('Draft');held.release();await finished.wait;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(status).toContainText('Draft');await expect(status).not.toContainText('Approved');expect(writes).toEqual([]);
 }finally{held.release();await page.unroute(path);}
});

test('compact status: another replica changes approval evidence and invalidates an earlier acknowledgement',async({page})=>{
 await login(page);const {plan,scenario,headers}=await statusScenario(page,'Concurrent status evidence');
 await reopenStatusPlan(page,plan.id);await selectWorkspaceAction(page,'Plan approval');
 const panel=page.getByRole('region',{name:'Plan approval',exact:true});await panel.getByRole('checkbox').check();
 const response=await page.request.post(`${peer}/api/plans/${plan.id}/review`,{headers,data:{version:0,revision:scenario.revision,acknowledgeExceptions:true}});expect(response.status()).toBe(200);
 await expect(page.getByTestId('status-approval')).toContainText('Reviewed');await expect(panel.getByRole('checkbox')).not.toBeChecked();await expect(panel.getByRole('button',{name:'Approve plan',exact:true})).toBeDisabled();
 await panel.getByRole('checkbox').check();await page.locator('#cursus-status-details summary').click();
 await selectWorkspaceAction(page,'Plan approval');await expect(panel.getByRole('checkbox')).toBeChecked();
 // Use the real preview API plus auth refresh to exercise a permission change
 // in the same mounted workspace; the account buttons intentionally reload.
 expect((await page.request.post('/api/auth/view-as',{headers,data:{role:'reviewer'}})).status()).toBe(200);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('button',{name:'Return to Admin',exact:true})).toBeVisible();
 await expect(panel.getByRole('checkbox')).toHaveCount(0);
 expect((await page.request.post('/api/auth/view-as',{headers,data:{role:null}})).status()).toBe(200);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('button',{name:'View as Reviewer',exact:true})).toBeVisible();
 await expect(panel.getByRole('checkbox')).not.toBeChecked();await expect(panel.getByRole('button',{name:'Approve plan',exact:true})).toBeDisabled();
 const heldReads=gate();let approvalWrites=0;
 await page.route(`**/api/plans/${plan.id}/workflow`,async route=>{await heldReads.wait;await route.continue();});
 await page.route(`**/api/plans/${plan.id}/approve`,async route=>{
  approvalWrites++;const response=await route.fetch();expect(response.status()).toBe(200);
  // The authoritative write succeeds, but the client receives an incomplete
  // response. Retry is a GET of evidence, never a second approval submission.
  await route.fulfill({json:{state:'approved'}});
 });
 try{
  await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'Approve plan',exact:true}).click();
  await expect(page.getByTestId('status-approval')).toContainText('Unknown');
  expect((await get<Workflow>(page.request,`${peer}/api/plans/${plan.id}/workflow`)).state).toBe('approved');
  await page.getByRole('button',{name:'Retry approval status',exact:true}).click();heldReads.release();
  await expect(page.getByTestId('status-approval')).toContainText('Approved');expect(approvalWrites).toBe(1);
 }finally{heldReads.release();}
});


test('compact status: manual eligibility warnings stay visible without changing independent approval eligibility',async({page})=>{
 await page.route('**/api/plans/*/manual-context',route=>route.fulfill({json:{enabled:false,reason:'fresh_plan_required'}}));
 await login(page);
 await expect(page.getByText('This historical plan has no unambiguous delivery identities. Replan to create a fresh plan before manual editing.',{exact:true})).toBeVisible();
 const details=page.locator('#cursus-status-details');await expect(details).not.toHaveAttribute('open','');
 await expect(page.getByTestId('status-freshness')).toContainText('Matches the loaded scenario revision');
 await expect(page.getByTestId('status-approval')).toContainText('Draft');
 await selectWorkspaceAction(page,'Plan approval');await expect(page.getByRole('region',{name:'Plan approval',exact:true}).getByRole('checkbox')).toBeVisible();
 await details.locator('summary').click();
 await expect(page.getByText('This historical plan has no unambiguous delivery identities. Replan to create a fresh plan before manual editing.',{exact:true})).toBeVisible();
});


test('compact status: long history stays centered and its last plan reopens by pointer',async({page})=>{
 await login(page);const {plan}=await statusScenario(page,'Last plan in long history');
 const response=await page.request.get('/api/plans?day=acceptance-day');expect(response.status()).toBe(200);
 const plans=await response.json() as {id:string;label:string}[],target=plans.find(p=>p.id===plan.id)!;
 expect(target).toBeTruthy();
 // A layout fixture supplies many cards, while the target remains a real
 // native plan and Reopen still goes through the real scenario/plan handlers.
 await page.route('**/api/plans?day=*',route=>route.fulfill({json:[...Array.from({length:60},(_,i)=>({...target,id:`layout-only-${i}`,label:`History card ${i+1}`})),target]}));
 await reopenStatusPlan(page,plan.id);
 await expect(page.getByTestId('status-approval')).toContainText('Draft');
});
