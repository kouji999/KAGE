// Mode logic (T14): mapping mode + risk + takeover → aksi final.
// Sumber kebenaran tunggal — dipakai send stage dan bisa dipakai ulang API lane.

import type { Mode, RiskLevel } from '../../domain/entities.js';

export type ModeAction = 'send' | 'approval' | 'hold' | 'skip';

export interface ResolvedAction {
  action: ModeAction;
  note: string;
}

/**
 * Prioritas (atas menang):
 * 1. takenOver        → skip   (KAGE mundur, owner pegang kendali)
 * 2. mode OFF         → skip
 * 3. mode APPROVAL    → approval (selalu, berapa pun risk)
 * 4. risk HIGH        → approval (di mode apa pun, termasuk AUTO/ASSIST)
 * 5. mode ASSIST      → hold   (draft disimpan, tidak pernah kirim)
 * 6. mode AUTO + LOW/MEDIUM → send
 */
export function resolveAction(mode: Mode, risk: RiskLevel, takenOver: boolean): ResolvedAction {
  if (takenOver) return { action: 'skip', note: 'conversation taken over by owner' };
  if (mode === 'OFF') return { action: 'skip', note: 'mode OFF' };
  if (mode === 'APPROVAL') {
    return { action: 'approval', note: 'mode APPROVAL — semua balasan butuh persetujuan owner' };
  }
  if (risk === 'HIGH') {
    return { action: 'approval', note: 'risk HIGH — butuh persetujuan owner' };
  }
  if (mode === 'ASSIST') {
    return { action: 'hold', note: 'mode ASSIST — draft disimpan untuk owner, tidak dikirim' };
  }
  return { action: 'send', note: `AUTO + risk ${risk}` };
}
