import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';
import type { StatefulStore } from './postgres.js';
import type { ObjectStore } from './objects.js';
import { loadConvertedDay, type ConvertedManifest } from './conversion.js';
import type { ManualDatasetContext } from '../plan/manual-adapter.js';
import type { ManualDatasetLoader } from './manual.js';
import { ProfileRepository } from './profiles.js';
import { manualSettings } from './manual-settings.js';

/** Admitted artifacts only; exact day/checksum match and no first-dataset fallback.
 * Fleet/tariff/reload snapshots are supplied by trusted deployment configuration. */
export function admittedManualDatasetLoader(store: StatefulStore, objects: ObjectStore, tenantId: string,
  settings?: Omit<ManualDatasetContext, 'day'>): ManualDatasetLoader {
  return async (parent: Plan, scenario: Scenario) => {
    const profiles=await new ProfileRepository(store,tenantId).resolve(scenario.planningProfiles??[]);
    const fleet=profiles.find(p=>p.kind==='fleet');
    const effectiveSettings=fleet?manualSettings(fleet.content.settings):settings;
    if(!effectiveSettings)throw new Error('Approved fleet settings are required.');
    const sha = parent.manual?.layout.datasetSha256 ?? parent.assignments?.layout.datasetSha256 ?? parent.provenance.datasetSha256 ?? parent.provenance.planningPolicy?.datasetRequestSha256;
    if (!sha || !/^[a-f0-9]{64}$/.test(sha)) throw new Error('parent dataset identity is unavailable');
    if(effectiveSettings.datasetSha256&&sha!==effectiveSettings.datasetSha256)throw new Error('fleet settings do not match the pinned dataset');
    const rows = await store.listDatasets(tenantId, true);
    const matches = rows.filter(row=>!scenario.datasetBinding||row.id===scenario.datasetBinding.datasetId).map(row => row.manifest as ConvertedManifest).filter(manifest =>
      manifest?.artifacts?.request?.sha256 === sha && manifest.days?.some(day => day.dayId === (scenario.datasetBinding?.dayId??scenario.day) && day.isoDate === parent.day));
    if (matches.length !== 1) throw new Error('exactly one admitted dataset must match parent identity and day');
    const day = await loadConvertedDay(objects, tenantId, matches[0]!, scenario,profiles);
    return { ...effectiveSettings, day };
  };
}
