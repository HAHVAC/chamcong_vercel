import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { getLarkToken, LARK_BASE_ID } from '../../_lib/lark-helpers';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const envVars = {
    LARK_APP_ID:           !!process.env.LARK_APP_ID,
    LARK_APP_SECRET:       !!process.env.LARK_APP_SECRET,
    LARK_BASE_ID:          !!process.env.LARK_BASE_ID,
    LARK_TABLE_ATTENDANCE: !!process.env.LARK_TABLE_ATTENDANCE,
    LARK_TABLE_USERS:      !!process.env.LARK_TABLE_USERS,
    LARK_TABLE_SITES:      !!process.env.LARK_TABLE_SITES,
    LARK_TABLE_REQUESTS:   !!process.env.LARK_TABLE_REQUESTS,
  };

  const token = await getLarkToken();
  const tokenStatus = token ? 'OK' : 'FAIL';

  const tableCheck: Record<string, string> = {};
  if (token && LARK_BASE_ID) {
    const tableMap: Record<string, string | undefined> = {
      attendance: process.env.LARK_TABLE_ATTENDANCE,
      users:      process.env.LARK_TABLE_USERS,
      sites:      process.env.LARK_TABLE_SITES,
      requests:   process.env.LARK_TABLE_REQUESTS,
    };
    for (const [name, tableId] of Object.entries(tableMap)) {
      if (!tableId) { tableCheck[name] = 'MISSING'; continue; }
      try {
        await axios.get(
          `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_BASE_ID}/tables/${tableId}/fields`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        tableCheck[name] = 'OK';
      } catch (err: any) {
        const code = err.response?.data?.code;
        tableCheck[name] = code ? `FAIL (code: ${code})` : `FAIL (${err.message})`;
      }
    }
  }

  res.json({ envVars, tokenStatus, tableCheck });
}
