import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { getLarkToken, LARK_BASE_ID } from '../../_lib/lark-helpers';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const token = await getLarkToken();
  if (!token) {
    return res.status(500).json({ error: 'Không thể lấy Access Token. Kiểm tra LARK_APP_ID và LARK_APP_SECRET.' });
  }
  if (!LARK_BASE_ID) {
    return res.status(500).json({ error: 'Thiếu LARK_BASE_ID.' });
  }

  try {
    const response = await axios.get(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const tables = (response.data.data.items || []).map((t: any) => ({
      id: t.table_id, name: t.name,
    }));
    res.json({
      success: true,
      message: 'Kết nối Lark Base thành công!',
      baseId: LARK_BASE_ID,
      tablesFound: tables,
      configuredTables: {
        attendance: process.env.LARK_TABLE_ATTENDANCE || 'Chưa cấu hình',
        users:      process.env.LARK_TABLE_USERS      || 'Chưa cấu hình',
        sites:      process.env.LARK_TABLE_SITES      || 'Chưa cấu hình',
        requests:   process.env.LARK_TABLE_REQUESTS   || 'Chưa cấu hình',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Lỗi khi truy cập Lark Base.', details: error.response?.data });
  }
}
