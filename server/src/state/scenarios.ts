import { randomUUID } from 'node:crypto';
import type { StatefulStore } from './postgres.js';
import { applyScenarioEdits, type Scenario, type ScenarioEdit, type ScenarioEditsBundle } from '../store.js';

export class ScenarioRepository {
  constructor(private store: StatefulStore, private tenantId: string) {}

  get(id: string): Promise<Scenario | null> { return this.store.getScenario(this.tenantId, id); }
  list(day?: string): Promise<Scenario[]> { return this.store.listScenarios(this.tenantId, day); }

  async ensureBase(day: string, label: string): Promise<Scenario> {
    const id = `${day}-base`;
    const existing = await this.get(id);
    if (existing) return existing;
    const scenario: Scenario = { id, day, kind: 'base', parentId: null, revision: 0, label,
      removedVehicleIds: [], pins: [], forbids: [], vehicleOverrides: [], sequences: [], createdAt: new Date().toISOString() };
    try { await this.store.createScenario(this.tenantId, id, scenario); }
    catch (error) { if ((error as { code?: string }).code !== '23505') throw error; }
    return (await this.get(id))!;
  }

  async copy(parent: Scenario, label?: string): Promise<Scenario> {
    const scenario: Scenario = { ...structuredClone(parent), id: `scn_${randomUUID().slice(0, 8)}`, kind: 'copy',
      parentId: parent.id, revision: 1, label: label ?? `${parent.label} (edited)`, createdAt: new Date().toISOString() };
    await this.store.createScenario(this.tenantId, scenario.id, scenario);
    return scenario;
  }

  async edit(id: string, edits: ScenarioEdit[]): Promise<Scenario> {
    const current = await this.get(id);
    if (!current) throw new Error('scenario not found');
    const target = current.kind === 'base' ? await this.copy(current) : current;
    const updated = applyScenarioEdits(target, edits);
    await this.store.updateScenario(this.tenantId, target.id, target.revision, updated);
    return updated;
  }

  async rename(id: string, label: string): Promise<Scenario> {
    const current = await this.get(id); if (!current) throw new Error('scenario not found');
    const updated = { ...current, label };
    const revision = await this.store.updateScenario(this.tenantId, id, current.revision, updated);
    return { ...updated, revision };
  }

  async import(base: Scenario, label: string, edits: ScenarioEditsBundle): Promise<Scenario> {
    if (edits.planningPolicyId && edits.planningPolicyId !== base.planningPolicy?.id) throw new Error('planning policy reference is not approved in this workspace');
    const copy = await this.copy(base, label);
    const updated = { ...copy, removedVehicleIds: [...edits.removedVehicleIds], pins: structuredClone(edits.pins),
      forbids: structuredClone(edits.forbids), vehicleOverrides: structuredClone(edits.vehicleOverrides), sequences: structuredClone(edits.sequences), revision: copy.revision + 1 };
    await this.store.updateScenario(this.tenantId, copy.id, copy.revision, updated);
    return updated;
  }

  delete(id: string): Promise<boolean> { return this.store.deleteScenario(this.tenantId, id); }
}
