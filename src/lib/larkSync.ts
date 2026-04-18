export type LarkSyncType = 'attendance' | 'users' | 'sites' | 'requests';

export interface BulkSyncResult {
  success: number;
  failed: number;
  total: number;
}

/**
 * Utility to sync data to Lark Base via the backend API.
 */
export async function syncToLark(type: LarkSyncType, data: any) {
  try {
    const response = await fetch('/api/sync/lark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, data }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.warn(`Lark sync failed for ${type}:`, errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Lark sync error for ${type}:`, error);
    return false;
  }
}

/**
 * Sync nhiều bản ghi cùng lúc sang Lark Base (batch).
 * Token và schema chỉ được lấy 1 lần cho toàn bộ batch.
 */
export async function bulkSyncToLark(
  type: LarkSyncType,
  records: any[]
): Promise<BulkSyncResult | null> {
  try {
    const response = await fetch('/api/sync/lark/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, records }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.warn(`Bulk Lark sync failed for ${type}:`, errorData);
      return null;
    }

    return await response.json() as BulkSyncResult;
  } catch (error) {
    console.error(`Bulk Lark sync error for ${type}:`, error);
    return null;
  }
}
