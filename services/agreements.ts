// Agent legal agreements (sp_agent_agreements) and Terms & Conditions
// acceptance records (sp_tnc_records). Owns the AGREEMENT_DOC_VERSION constant.

import { supabase, callGateway } from './db';
import { TNC_VERSION, buildTncText } from '../src/tnc-content';
import type { AcceptAgreementResult, TncRecord } from './dbTypes';

// ─── Agent Legal Agreement (sp_agent_agreements) ────────────────────────────
export const AGREEMENT_DOC_VERSION = 'v1.0-2026';

export interface SpAgentAgreement {
  id: string;
  agent_id: string;
  agreement_no: string;
  doc_version: string;
  full_name: string;
  ktp_number: string;
  accepted_at: string;
  user_agent?: string | null;
  created_at?: string;
  // Arsip PDF (audit 28 Okt 2026) — diunggah ke agent-docs saat persetujuan.
  pdf_bucket?: string | null;
  pdf_path?: string | null;
  pdf_url?: string | null;
}

// Returns the current agent's signed agreement for the active doc version, or null.
export async function getMyAgreement(): Promise<SpAgentAgreement | null> {
  const status = await getMyAgreementStatus();
  return status.agreement;
}

export interface MyAgreementStatus {
  /** Rekaman untuk versi dokumen yang aktif, atau null bila belum/tidak berlaku. */
  agreement: SpAgentAgreement | null;
  /** false = perjanjian kemitraan tidak berlaku untuk peran ini (admin/operator). */
  required: boolean;
  activeVersion: string | null;
  /** Terisi hanya bila pengecekan GAGAL — bukan bila memang belum menandatangani. */
  error: string | null;
}

/**
 * Status perjanjian dengan tiga keadaan yang dulu tercampur jadi satu:
 *   • required=false            → tidak berlaku (admin membuka app mitra)
 *   • required=true, error=null → berlaku; `agreement` menentukan sudah/belum
 *   • error terisi              → tidak tahu; pemanggil JANGAN menyimpulkan
 *                                 "belum menandatangani"
 * Sebelum ini semua kegagalan menjadi `null` dan gerbang menahan mitra yang
 * sudah tanda tangan — keluhan "sudah sign tapi ditanya lagi".
 */
export async function getMyAgreementStatus(): Promise<MyAgreementStatus> {
  const res = await callGateway('get_my_agreement');
  if (res.error) {
    console.error('getMyAgreementStatus:', res.error);
    // required=true adalah nilai aman: pemanggil yang lebih tua tetap fail-closed,
    // tetapi AgentPortal memperlakukan error sebagai "tidak tahu", bukan "belum".
    return { agreement: null, required: true, activeVersion: null, error: String(res.error) };
  }
  return {
    agreement: (res.data ?? null) as SpAgentAgreement | null,
    // Server lama tidak mengirim `required`; anggap berlaku (fail-closed).
    required: res.required !== false,
    activeVersion: typeof res.active_version === 'string' ? res.active_version : null,
    error: null,
  };
}

// Records the agent's acceptance. Routed through the data-gateway
// (service_role) to bypass RLS — the previous direct client-side insert
// was silently failing for some agents due to RLS/foreign-key issues.
export async function acceptAgreement(
  fullName: string,
  ktpNumber: string,
): Promise<AcceptAgreementResult> {
  const { data, error } = await callGateway('accept_agreement', {
    full_name: fullName.trim(),
    ktp_number: ktpNumber.trim(),
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 255) : null,
  });
  if (error) {
    console.error('acceptAgreement:', error);
    // Map gateway errors to error codes the UI can handle
    if (error === 'ALREADY_ACCEPTED') {
      return { rec: null, error: { code: '23505', message: 'Already accepted' } };
    }
    return { rec: null, error: { code: 'UNKNOWN', message: error } };
  }
  if (!data) return { rec: null, error: { code: 'UNKNOWN', message: 'No data returned' } };
  return { rec: data as SpAgentAgreement, error: null };
}

// Arsipkan PDF perjanjian hasil generate klien ke bucket agent-docs lalu
// daftarkan path-nya pada baris e-consent (audit 28 Okt 2026: sebelumnya PDF
// hanya ada di browser agent dan tidak pernah tersimpan server-side).
// Kegagalan arsip tidak boleh menggagalkan persetujuan — e-consent tetap sah.
export async function attachAgreementPdf(
  agreementId: string,
  pdf: { bucket: string; path: string; url: string | null },
): Promise<boolean> {
  const { error } = await callGateway('agreements_attach_pdf', {
    agreement_id: agreementId,
    bucket: pdf.bucket,
    path: pdf.path,
    url: pdf.url,
  });
  if (error) { console.warn('attachAgreementPdf:', error); return false; }
  return true;
}

// Admin/CMS: list all signed agreements with agent contact info for audit.
export async function getAllAgreements(): Promise<Array<SpAgentAgreement & { agent_email?: string; agent_phone?: string }>> {
  const { data, error } = await supabase
    .from('sp_agent_agreements')
    .select('*, sp_users(email, phone)')
    .order('accepted_at', { ascending: false });
  if (error) { console.error('getAllAgreements:', error); return []; }
  return (data ?? []).map((r: any) => ({
    ...r,
    agent_email: r.sp_users?.email,
    agent_phone: r.sp_users?.phone,
  }));
}

// ─── Terms & Conditions ───────────────────────────────────────────────────────

function generateTncRef(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SP-TNC-${date}-${rand}`;
}

export async function recordTcAcceptance(userId: string): Promise<string> {
  const refNumber = generateTncRef();
  const now = new Date().toISOString();
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';

  await Promise.all([
    supabase.from('sp_tnc_records').insert({
      user_id: userId,
      reference_number: refNumber,
      tnc_version: TNC_VERSION,
      tnc_content: buildTncText(),
      accepted_at: now,
      user_agent: userAgent,
    }),
    supabase.from('sp_users').update({
      tc_accepted: true,
      tc_accepted_at: now,
      tnc_ref_number: refNumber,
    }).eq('id', userId),
  ]);

  return refNumber;
}

export async function getUserTcStatus(userId: string): Promise<boolean> {
  // Primary: sp_users flag
  const { data } = await supabase.from('sp_users').select('tc_accepted').eq('id', userId).single();
  if (data?.tc_accepted === true) return true;
  // Fallback: a row in sp_tnc_records means they accepted even if sp_users update
  // failed silently due to RLS (common when policies restrict self-UPDATE).
  const { data: rec } = await supabase
    .from('sp_tnc_records')
    .select('id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  return !!rec;
}

export async function getTncRecord(userId: string): Promise<TncRecord | null> {
  const { data } = await supabase
    .from('sp_tnc_records')
    .select('reference_number, tnc_version, accepted_at')
    .eq('user_id', userId)
    .order('accepted_at', { ascending: false })
    .limit(1)
    .single();
  return data ?? null;
}
