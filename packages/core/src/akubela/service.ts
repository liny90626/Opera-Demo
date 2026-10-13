// WBS-B3: Akubela service (mode switching, wiring connector + transport) — STUB. Keep this exported signature.
import type { AkubelaServiceApi, AkubelaServiceDeps } from './contract.ts';

export function createAkubelaService(deps: AkubelaServiceDeps): AkubelaServiceApi {
  void deps;
  throw new Error('Akubela service not implemented yet');
}
