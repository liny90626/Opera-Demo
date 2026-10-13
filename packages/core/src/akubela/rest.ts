// WBS-B3: REST router for /api/integrations/akubela/* — STUB. Keep this exported signature.
import type { AkubelaServiceApi } from './contract.ts';

export async function handleAkubelaRequest(svc: AkubelaServiceApi, method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  void svc; void method; void path; void body;
  return { status: 501, body: { error: 'not implemented' } };
}
