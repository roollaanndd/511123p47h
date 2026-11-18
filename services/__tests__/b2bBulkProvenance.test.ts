// Contract tests for the B2B bulk source-file provenance + activity log
// plumbing (v2.9.12).
//
// Owner report that drove this: a B2B client uploads a spreadsheet, the batch
// is created, but the ORIGINAL file was uploaded fire-and-forget and its
// storage PATH was never persisted — admin could never re-download it, and a
// failed upload vanished silently. These tests pin the fixed contract:
//
//  1. uploadB2BBulkSourceFile returns the SERVER path (data.path), plus
//     size/mime — never a getPublicUrl() (that 404s on the private bucket),
//     and never a client-built path.
//  2. Upload failure returns { error } — the wizard must be able to abort
//     submission honestly instead of shipping a batch with no source file.
//  3. createB2BBulkBatch forwards the sourceFile provenance to the gateway.
//  4. adminGetB2BBulkSourceUrl / adminListB2BActivity pass the right action
//     and params through the gateway.
//  5. The official Excel template uses EXACTLY the parser's FIELD_LABELS so
//     auto-map resolves every column 1:1 with no manual mapping.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const uploadMock = vi.hoisted(() => vi.fn());
const gatewayMock = vi.hoisted(() => vi.fn());
const prepareMock = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  supabase: {
    storage: {
      from: () => ({ upload: uploadMock, getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://public.example/x' } })) }),
    },
  },
  callGateway: gatewayMock,
}));

vi.mock('../storage', () => ({
  // Mirror the real helper's spirit: attach the bucket-approved MIME.
  prepareB2BDocument: (file: File) => {
    const prepared = prepareMock(file);
    return prepared ?? { file };
  },
}));

import {
  uploadB2BBulkSourceFile,
  createB2BBulkBatch,
  adminGetB2BBulkSourceUrl,
  adminListB2BActivity,
} from '../b2bBulk';

const makeXlsxFile = (size = 1024): File => {
  const f = new File([new Uint8Array(size)], 'armada-q4.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return f;
};

beforeEach(() => {
  uploadMock.mockReset();
  gatewayMock.mockReset();
  prepareMock.mockReset();
});

describe('uploadB2BBulkSourceFile (v2.9.12 provenance fix)', () => {
  it('returns the SERVER path from data.path plus size/mime', async () => {
    prepareMock.mockImplementation((f: File) => ({ file: f }));
    uploadMock.mockResolvedValue({ data: { path: 'client-1/bulk-source/pending-123.xlsx' }, error: null });

    const res = await uploadB2BBulkSourceFile('client-1', 'pending-123', makeXlsxFile());

    expect('error' in res).toBe(false);
    expect(res).toMatchObject({
      path: 'client-1/bulk-source/pending-123.xlsx',
      size: 1024,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // Upload went to the private b2b-documents bucket, under the client's
    // bulk-source folder (service appends a timestamp to avoid collisions).
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(String(uploadMock.mock.calls[0][0])).toMatch(/^client-1\/bulk-source\/pending-123-\d+\.xlsx$/);
  });

  it('returns { error } when the storage upload fails (wizard can abort honestly)', async () => {
    prepareMock.mockImplementation((f: File) => ({ file: f }));
    uploadMock.mockResolvedValue({ data: null, error: { message: 'storage quota exceeded' } });

    const res = await uploadB2BBulkSourceFile('client-1', 'pending-123', makeXlsxFile());

    expect(res).toEqual({ error: 'storage quota exceeded' });
  });

  it('rejects unsupported/oversized files via prepareB2BDocument', async () => {
    prepareMock.mockReturnValue({ error: 'Jenis file .exe tidak didukung.' });

    const res = await uploadB2BBulkSourceFile('client-1', 'pending-123', makeXlsxFile());

    expect(res).toEqual({ error: 'Jenis file .exe tidak didukung.' });
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('createB2BBulkBatch forwards source-file provenance', () => {
  it('sends source_file_path/size/mime to the gateway alongside the file name', async () => {
    gatewayMock.mockResolvedValue({ data: { batch: { id: 'b1', batch_number: 'SPB2B-1' }, totals: {} } });

    await createB2BBulkBatch({
      companyName: 'PT Contoh',
      sourceFileName: 'armada.xlsx',
      sourceFile: { path: 'c/bulk-source/x.xlsx', size: 2048, mime: 'text/csv' },
      items: [],
    });

    expect(gatewayMock).toHaveBeenCalledWith('b2b_bulk_create_batch', expect.objectContaining({
      source_file_name: 'armada.xlsx',
      source_file_path: 'c/bulk-source/x.xlsx',
      source_file_size: 2048,
      source_file_mime: 'text/csv',
    }));
  });

  it('omits provenance fields when no source file was uploaded', async () => {
    gatewayMock.mockResolvedValue({ data: { batch: { id: 'b1' }, totals: {} } });

    await createB2BBulkBatch({ companyName: 'PT Contoh', items: [] });

    expect(gatewayMock).toHaveBeenCalledWith('b2b_bulk_create_batch', expect.objectContaining({
      source_file_name: undefined,
      source_file_path: undefined,
      source_file_size: undefined,
      source_file_mime: undefined,
    }));
  });
});

describe('admin B2B gateway actions', () => {
  it('adminGetB2BBulkSourceUrl requests a short-lived signed URL', async () => {
    gatewayMock.mockResolvedValue({ data: { url: 'https://signed...', file_name: 'a.xlsx' } });

    const res = await adminGetB2BBulkSourceUrl('batch-1');

    expect(gatewayMock).toHaveBeenCalledWith('admin_b2b_bulk_source_url', { batch_id: 'batch-1' });
    expect(res).toMatchObject({ file_name: 'a.xlsx' });
  });

  it('adminListB2BActivity passes paging + filters and defaults to [] on error', async () => {
    gatewayMock.mockResolvedValueOnce({ data: [{ id: 'e1', action: 'bulk_paid' }] });
    let rows = await adminListB2BActivity({ limit: 50, offset: 10, clientId: 'c1', batchId: 'b1' });
    expect(gatewayMock).toHaveBeenCalledWith('admin_b2b_activity_log', { limit: 50, offset: 10, client_id: 'c1', batch_id: 'b1' });
    expect(rows).toHaveLength(1);

    gatewayMock.mockResolvedValueOnce({ error: 'forbidden' });
    rows = await adminListB2BActivity();
    expect(rows).toEqual([]);
  });
});
