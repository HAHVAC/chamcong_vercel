import { getDocs, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { Site } from '../types';

// Cache sites ở module level — dùng chung giữa các component trong cùng session
// Tránh Firestore reads lặp lại khi chuyển tab hoặc render lại component
let cachedSites: Site[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút

export const getCachedSites = async (): Promise<Site[]> => {
  const now = Date.now();
  if (cachedSites && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSites;
  }

  const snap = await getDocs(collection(db, 'sites'));
  cachedSites = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
  cacheTimestamp = now;
  return cachedSites;
};

// Gọi khi admin cập nhật sites để invalidate cache ngay lập tức
export const invalidateSitesCache = (): void => {
  cachedSites = null;
  cacheTimestamp = 0;
};
