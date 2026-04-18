import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import {
  getLarkToken,
  formatBySchema,
  upsertRecord,
  getTableId,
  LARK_BASE_ID,
} from '../../_lib/lark-helpers';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, records } = req.body as { type: string; records: Record<string, unknown>[] };
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Danh sách bản ghi trống.' });
  }

  const token = await getLarkToken();
  if (!token || !LARK_BASE_ID) {
    return res.status(500).json({ error: 'Lark configuration missing' });
  }

  const tableId = getTableId(type);
  if (!tableId) return res.status(400).json({ error: 'Table ID missing for type: ' + type });

  // Lấy schema 1 lần cho toàn bộ batch
  let fields: any[] = [];
  try {
    const fieldsResp = await axios.get(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/fields`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    fields = fieldsResp.data?.data?.items || [];
  } catch { console.warn('Batch: schema fetch failed'); }

  let success = 0;
  let failed = 0;

  for (const record of records) {
    try {
      const formatted = await formatBySchema(record, fields, token, LARK_BASE_ID);
      if (!Object.keys(formatted).length) { failed++; continue; }
      await upsertRecord(token, LARK_BASE_ID, tableId, formatted);
      success++;
    } catch (err: any) {
      console.error('Batch record error:', err.response?.data || err.message);
      failed++;
    }
  }

  res.json({ success, failed, total: records.length });
}
