import { createHash } from 'node:crypto';
import { manualSettings } from './state/manual-settings.js';

import type { ProfileContent } from './planning-profile-contract.js';
export type { ProfileKind,LocationRule,ProfileContent,ProfileRef,ApprovedProfile } from './planning-profile-contract.js';

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Strict admission boundary. No coordinates or travel matrices can be edited
 * through a profile: those changes require geographic preparation/admission. */
export function parseProfile(value: unknown): ProfileContent {
  if (!record(value) || !keys(value, ['schemaVersion','datasetSha256','label','reason','kind','settings','locations']) ||
      value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(String(value.datasetSha256 ?? '')) ||
      !text(value.label,120) || !text(value.reason,500) || !['fleet','locations'].includes(String(value.kind)))
    throw new Error('A versioned profile requires dataset identity, label, kind and change reason.');
  if (value.kind === 'fleet') {
    if (value.locations !== undefined || !record(value.settings)) throw new Error('Fleet settings are required.');
    const settings = value.settings;
    if (!keys(settings,['datasetSha256','vehicles','tariff']) || settings.datasetSha256 !== value.datasetSha256)
      throw new Error('Fleet settings must match the profile dataset.');
    if(!record(settings.tariff)||!keys(settings.tariff,['currency','source','model','perKmDefault','fixedPerVehicle','perKmByClass','fixedByClass','perTripBase','perKm','perDrop','includedDrops','subcontractorMultiplier','ownFleetMultiplier']))
      throw new Error('Unsupported tariff fields.');
    manualSettings(settings);
    for(const vehicle of settings.vehicles as unknown[]){
      if(!record(vehicle)||!keys(vehicle,['id','ref','vehicleClass','isSubcontractor','tonnage','hasTailLift','reloadSec','available','capacityKg','capacityPallets','configurationRef'])||
        ['capacityKg','capacityPallets'].some(key=>vehicle[key]!==undefined&&(typeof vehicle[key]!=='number'||!Number.isFinite(vehicle[key])||Number(vehicle[key])<=0))||
        vehicle.configurationRef!==undefined&&!text(vehicle.configurationRef,128))throw new Error('Invalid fleet capacity or configuration.');
      if(vehicle.available!==false&&(vehicle.tonnage===null||typeof vehicle.capacityKg==='number'&&vehicle.capacityKg>Number(vehicle.tonnage)*1000))
        throw new Error('Available vehicles require verified GVW and payload capacity no greater than GVW.');
    }
  } else {
    if (value.settings !== undefined || !Array.isArray(value.locations) || !value.locations.length || value.locations.length > 100000)
      throw new Error('Location rules are required.');
    const seen = new Set<number>();
    for (const rule of value.locations) {
      if (!record(rule) || !keys(rule,['label','locationId','maxGrossWeightKg','requiresTailLift','serviceSeconds','windowStartSeconds','windowEndSeconds','reason']) ||
          rule.label!==undefined&&!text(rule.label,240)||
          !integer(rule.locationId,2147483647) || seen.has(Number(rule.locationId)) ||
          rule.maxGrossWeightKg !== null && (!integer(rule.maxGrossWeightKg,100000) || Number(rule.maxGrossWeightKg) === 0) ||
          typeof rule.requiresTailLift !== 'boolean' || !integer(rule.serviceSeconds,86400) ||
          !integer(rule.windowStartSeconds,172800) || !integer(rule.windowEndSeconds,172800) ||
          Number(rule.windowStartSeconds) > Number(rule.windowEndSeconds) || !text(rule.reason,500))
        throw new Error('Invalid, duplicate or unsupported location rule.');
      seen.add(Number(rule.locationId));
    }
  }
  return JSON.parse(JSON.stringify(value)) as ProfileContent;
}

export function profileDigest(value: ProfileContent): string {
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` :
    record(v) ? `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null';
  return createHash('sha256').update(canonical(value)).digest('hex');
}
