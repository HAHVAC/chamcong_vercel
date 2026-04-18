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

  const { type, data } = req.body as { type: string; data: Record<string, unknown> };
  const token = await getLarkToken();
  if (!token || !LARK_BASE_ID) {
    return res.status(500).json({ error: 'Lark configuration missing' });
  }

  const tableId = getTableId(type);
  if (!tableId) return res.status(400).json({ error: 'Table ID missing for type: ' + type });

  try {
    let cleanData: Record<string, unknown> = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v != null && v !== '')
    );

    try {
      const fieldsResp = await axios.get(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/fields`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const fields = fieldsResp.data?.data?.items || [];
      cleanData = await formatBySchema(cleanData, fields, token, LARK_BASE_ID);
    } catch { console.warn('Schema fetch failed, using raw data'); }

    if (!Object.keys(cleanData).length) {
      return res.status(400).json({
        error: 'Không có trường dữ liệu nào khớp với bảng Lark.',
        details: { msg: 'Kiểm tra tên cột trong Lark Base.' },
      });
    }

    await upsertRecord(token, LARK_BASE_ID, tableId, cleanData);
    res.json({ success: true, action: 'upserted' });
  } catch (error: any) {
    console.error('Sync error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Sync failed', details: error.response?.data });
  }
}
