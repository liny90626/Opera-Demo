// WBS-B1: GRMS simulator — STUB, replaced by the implementation. Keep this exported signature.
import type { Snapshot } from '../types.ts';
import type { GrmsSimulatorApi } from './contract.ts';

export interface GrmsSimulatorOptions {
  now?: () => number;
  faults?: 'none' | 'uat';
  latencyMs?: number;
}

/** Build a simulated GRMS whose rooms mirror the OPERA rooms (residence_name = room number). */
export function createGrmsSimulator(pms: Snapshot, opts: GrmsSimulatorOptions = {}): GrmsSimulatorApi {
  void pms; void opts;
  throw new Error('GRMS simulator not implemented yet');
}
