import React, { useEffect, useState, useMemo } from 'react';
import { db, auth } from '../firebase';
import { collection, query, where, orderBy, limit, onSnapshot, getDoc, getDocs, doc } from 'firebase/firestore';
import { AttendanceRecord, Site } from '../types';
import { cn } from '../lib/utils';
import { DEFAULT_ADMIN_EMAIL } from '../constants';
import {
  Clock, CheckCircle2, AlertTriangle, X, Filter, Download, Calendar,
  MapPin, ChevronDown, ChevronRight, Users, TrendingUp
} from 'lucide-react';

interface GroupedRecord {
  userId: string;
  userName: string;
  siteId: string;
  siteName: string;
  checkIn?: AttendanceRecord;
  checkOut?: AttendanceRecord;
  date: string;
}

interface SiteStats {
  total: number;
  complete: number;
  late: number;
  early: number;
  missing: number;
}

interface SiteGroup {
  siteId: string;
  siteName: string;
  site?: Site;
  dates: Record<string, GroupedRecord[]>; // date -> records
  stats: SiteStats;
}

// Ngưỡng tính đến trễ / về sớm (phút)
const LATE_THRESHOLD_MINUTES = 15;
const EARLY_THRESHOLD_MINUTES = 15;

// Kiểm tra trễ/sớm cho một record
function getRecordFlags(group: GroupedRecord, site?: Site) {
  let isLate = false;
  let isEarly = false;
  if (typeof site?.checkInTime === 'string' && site.checkInTime.includes(':') && group.checkIn) {
    const checkInDate = new Date(group.checkIn.timestamp);
    const [h, m] = site.checkInTime.split(':').map(Number);
    const expected = new Date(checkInDate);
    expected.setHours(h, m, 0, 0);
    // Chỉ tính đến trễ khi muộn hơn ngưỡng cho phép
    const lateMs = checkInDate.getTime() - expected.getTime();
    if (lateMs > LATE_THRESHOLD_MINUTES * 60 * 1000) isLate = true;
  }
  if (typeof site?.checkOutTime === 'string' && site.checkOutTime.includes(':') && group.checkOut) {
    const checkOutDate = new Date(group.checkOut.timestamp);
    const [h, m] = site.checkOutTime.split(':').map(Number);
    const expected = new Date(checkOutDate);
    expected.setHours(h, m, 0, 0);
    // Chỉ tính về sớm khi về trước ngưỡng cho phép
    const earlyMs = expected.getTime() - checkOutDate.getTime();
    if (earlyMs > EARLY_THRESHOLD_MINUTES * 60 * 1000) isEarly = true;
  }
  return { isLate, isEarly };
}

function formatDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export const AttendanceHistory: React.FC = () => {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [sitesData, setSitesData] = useState<Record<string, Site>>({});
  // Map uid → fullName để hiển thị tên thật thay tên Google
  const [uidToFullName, setUidToFullName] = useState<Record<string, string>>({});
  // Có xem nhiều người (admin/manager) hay không — dùng để hiện filter thành viên
  const [isMultiUser, setIsMultiUser] = useState(false);

  // Mở rộng/thu gọn từng site
  const [expandedSites, setExpandedSites] = useState<Record<string, boolean>>({});

  // Filters
  const [showFilters, setShowFilters] = useState(false);
  const [filterSite, setFilterSite] = useState('all');
  const [filterMember, setFilterMember] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    if (!auth.currentUser) return;
    let unsubscribe: () => void = () => {};
    let unsubscribeSites: () => void = () => {};

    const setup = async () => {
      try {
        unsubscribeSites = onSnapshot(collection(db, 'sites'), (snap) => {
          const map: Record<string, Site> = {};
          snap.docs.forEach(d => { map[d.id] = { id: d.id, ...d.data() } as Site; });
          setSitesData(map);
        });

        const userSnap = await getDoc(doc(db, 'users', auth.currentUser!.uid));
        const profile = userSnap.exists() ? userSnap.data() : null;
        const currentEmail = auth.currentUser?.email?.toLowerCase() ?? '';
        const isAdmin = profile?.role === 'admin' || currentEmail === DEFAULT_ADMIN_EMAIL;
        const isManager = profile?.role === 'manager';
        if (isAdmin || isManager) setIsMultiUser(true);
        const siteRoles = profile?.siteRoles || {};
        const viewOnlySiteIds = Object.keys(siteRoles).filter(id => siteRoles[id] === 'view_only');

        // Load tất cả users để build map uid → fullName (dùng cho admin/manager)
        if (isAdmin || isManager) {
          const allUsersSnap = await getDocs(collection(db, 'users'));
          const nameMap: Record<string, string> = {};
          allUsersSnap.docs.forEach(d => {
            const data = d.data();
            const uid = data.uid as string;
            if (uid) nameMap[uid] = data.fullName || data.displayName || '';
          });
          setUidToFullName(nameMap);
        }

        let ownRecords: AttendanceRecord[] = [];
        let viewOnlyRecords: AttendanceRecord[] = [];
        let managedRecords: AttendanceRecord[] = [];
        const unsubList: Array<() => void> = [];

        const merge = () => {
          const merged = [...ownRecords, ...viewOnlyRecords, ...managedRecords];
          const unique = Array.from(new Map(merged.map(r => [r.id, r])).values());
          unique.sort((a, b) => b.timestamp - a.timestamp);
          setRecords(unique.slice(0, 500));
          setLoading(false);
        };

        if (isAdmin) {
          // Admin xem toàn bộ
          const q = query(collection(db, 'attendance'), orderBy('timestamp', 'desc'), limit(500));
          const unsub = onSnapshot(q, snap => {
            ownRecords = snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[];
            merge();
          }, () => setLoading(false));
          unsubList.push(unsub);

        } else if (isManager) {
          // Manager xem lịch sử của chính mình
          const qOwn = query(
            collection(db, 'attendance'),
            where('userId', '==', auth.currentUser!.uid),
            orderBy('timestamp', 'desc'),
            limit(200)
          );
          const unsubOwn = onSnapshot(qOwn, snap => {
            ownRecords = snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[];
            merge();
          }, () => setLoading(false));
          unsubList.push(unsubOwn);

          // Manager xem lịch sử nhân viên trong nhóm quản lý
          // Ưu tiên match managerUid (UID), fallback email
          const usersSnap = await getDocs(collection(db, 'users'));
          const currentUid = auth.currentUser!.uid;
          const managedUids = usersSnap.docs
            .filter(d => {
              const data = d.data();
              // Ưu tiên so sánh UID manager
              if (data.managerUid && data.managerUid === currentUid) return true;
              // Fallback: so sánh email
              return (data.managerEmail || '').toLowerCase() === currentEmail;
            })
            .map(d => d.data().uid as string)
            .filter(uid => uid && uid !== auth.currentUser!.uid); // loại chính mình để tránh trùng

          if (managedUids.length > 0) {
            // Chia thành các chunk ≤30 (giới hạn Firestore `in`)
            const CHUNK = 30;
            const chunkRecordSets: AttendanceRecord[][] = [];
            for (let i = 0; i < managedUids.length; i += CHUNK) {
              chunkRecordSets.push([]);
            }

            for (let i = 0; i < managedUids.length; i += CHUNK) {
              const idx = Math.floor(i / CHUNK);
              const chunk = managedUids.slice(i, i + CHUNK);
              const q = query(
                collection(db, 'attendance'),
                where('userId', 'in', chunk),
                orderBy('timestamp', 'desc'),
                limit(500)
              );
              const unsub = onSnapshot(q, snap => {
                chunkRecordSets[idx] = snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[];
                managedRecords = chunkRecordSets.flat();
                merge();
              }, () => { /* bỏ qua lỗi chunk, own records vẫn hiện */ });
              unsubList.push(unsub);
            }
          }

        } else {
          // Nhân viên thường: xem lịch sử của bản thân
          const qOwn = query(
            collection(db, 'attendance'),
            where('userId', '==', auth.currentUser!.uid),
            orderBy('timestamp', 'desc'),
            limit(200)
          );
          const unsubOwn = onSnapshot(qOwn, snap => {
            ownRecords = snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[];
            merge();
          }, () => setLoading(false));
          unsubList.push(unsubOwn);

          if (viewOnlySiteIds.length > 0 && viewOnlySiteIds.length <= 10) {
            const qView = query(
              collection(db, 'attendance'),
              where('siteId', 'in', viewOnlySiteIds),
              orderBy('timestamp', 'desc'),
              limit(200)
            );
            const unsubView = onSnapshot(qView, snap => {
              viewOnlyRecords = snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[];
              merge();
            });
            unsubList.push(unsubView);
          }
        }

        unsubscribe = () => unsubList.forEach(fn => fn());
      } catch {
        setLoading(false);
      }
    };

    setup();
    return () => { unsubscribe(); unsubscribeSites(); };
  }, []);

  // Helper: lấy tên hiển thị — ưu tiên fullName từ map, fallback userName trên record
  const getDisplayName = (userId: string, fallbackName: string) =>
    uidToFullName[userId] || fallbackName || 'Không rõ';

  // Danh sách công trường có trong dữ liệu
  const uniqueSiteNames = useMemo(
    () => Array.from(new Set(records.map(r => r.siteName))).filter(Boolean).sort(),
    [records]
  );

  // Danh sách thành viên theo fullName (chỉ dùng khi isMultiUser)
  // Key = userId để filter chính xác, label = fullName
  const uniqueMembers = useMemo(() => {
    const map = new Map<string, string>(); // uid → displayName
    records.forEach(r => {
      if (r.userId && !map.has(r.userId)) {
        map.set(r.userId, getDisplayName(r.userId, r.userName));
      }
    });
    return Array.from(map.entries())
      .sort((a, b) => a[1].localeCompare(b[1], 'vi'))
      .map(([uid, name]) => ({ uid, name }));
  }, [records, uidToFullName]);

  // Lọc records theo filter (filterMember dùng userId thay userName)
  const filteredRecords = useMemo(() => records.filter(r => {
    if (filterSite !== 'all' && r.siteName !== filterSite) return false;
    if (filterMember !== 'all' && r.userId !== filterMember) return false;
    if (dateFrom || dateTo) {
      const d = new Date(r.timestamp);
      d.setHours(0, 0, 0, 0);
      if (dateFrom && d < new Date(dateFrom)) return false;
      if (dateTo && d > new Date(dateTo)) return false;
    }
    return true;
  }), [records, filterSite, filterMember, dateFrom, dateTo]);

  // Group: siteId -> date -> GroupedRecord[]
  const siteGroups = useMemo<SiteGroup[]>(() => {
    const map: Record<string, { dates: Record<string, GroupedRecord[]> }> = {};

    for (const record of filteredRecords) {
      const d = new Date(record.timestamp);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const sid = record.siteId || 'unknown';

      if (!map[sid]) map[sid] = { dates: {} };
      if (!map[sid].dates[dateStr]) map[sid].dates[dateStr] = [];

      const dateRecords = map[sid].dates[dateStr];
      let group = dateRecords.find(g => g.userId === record.userId);
      if (!group) {
        group = { userId: record.userId, userName: record.userName, siteId: sid, siteName: record.siteName, date: dateStr };
        dateRecords.push(group);
      }

      if (record.type === 'check-in') {
        if (!group.checkIn || record.timestamp < group.checkIn.timestamp) group.checkIn = record;
      } else {
        if (!group.checkOut || record.timestamp > group.checkOut.timestamp) group.checkOut = record;
      }
    }

    return Object.entries(map).map(([siteId, { dates }]) => {
      const site = sitesData[siteId];
      const siteName = Object.values(dates)[0]?.[0]?.siteName ?? siteId;

      const stats: SiteStats = { total: 0, complete: 0, late: 0, early: 0, missing: 0 };
      for (const dayRecords of Object.values(dates)) {
        for (const g of dayRecords) {
          stats.total++;
          const { isLate, isEarly } = getRecordFlags(g, site);
          if (g.checkIn && g.checkOut) stats.complete++;
          else stats.missing++;
          if (isLate) stats.late++;
          if (isEarly) stats.early++;
        }
      }

      return { siteId, siteName, site, dates, stats };
    }).sort((a, b) => a.siteName.localeCompare(b.siteName, 'vi'));
  }, [filteredRecords, sitesData]);

  // Tổng toàn bộ
  const globalStats = useMemo(() => siteGroups.reduce(
    (acc, sg) => ({
      total: acc.total + sg.stats.total,
      complete: acc.complete + sg.stats.complete,
      late: acc.late + sg.stats.late,
      early: acc.early + sg.stats.early,
      missing: acc.missing + sg.stats.missing,
    }),
    { total: 0, complete: 0, late: 0, early: 0, missing: 0 }
  ), [siteGroups]);

  const toggleSite = (siteId: string) =>
    setExpandedSites(prev => ({ ...prev, [siteId]: !prev[siteId] }));

  const isSiteExpanded = (siteId: string) =>
    siteId in expandedSites ? expandedSites[siteId] : true; // mặc định mở

  const exportToCSV = () => {
    const headers = ['Công trường', 'Ngày', 'Nhân viên', 'Vào ca', 'Ra ca', 'Trạng thái'];
    const rows: string[][] = [];

    for (const sg of siteGroups) {
      for (const [date, dayRecords] of Object.entries(sg.dates).sort((a, b) => b[0].localeCompare(a[0]))) {
        for (const g of dayRecords) {
          const { isLate, isEarly } = getRecordFlags(g, sg.site);
          const statuses = [];
          if (isLate) statuses.push('Đến trễ');
          if (isEarly) statuses.push('Về sớm');
          if (!isLate && !isEarly && g.checkIn && g.checkOut) statuses.push('Đúng giờ');
          if (!g.checkIn || !g.checkOut) statuses.push('Thiếu dữ liệu');
          rows.push([
            sg.siteName,
            formatDate(date),
            getDisplayName(g.userId, g.userName),
            g.checkIn ? new Date(g.checkIn.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '-',
            g.checkOut ? new Date(g.checkOut.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '-',
            statuses.join(', ') || '-',
          ]);
        }
      }
    }

    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cham_cong_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const hasActiveFilter = filterSite !== 'all' || filterMember !== 'all' || !!dateFrom || !!dateTo;

  if (loading) return (
    <div className="p-8 text-center text-gray-500 font-medium">Đang tải lịch sử...</div>
  );

  if (records.length === 0) return (
    <div className="p-12 text-center space-y-4">
      <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto text-gray-400">
        <Clock size={40} />
      </div>
      <p className="text-gray-500 font-medium">Chưa có dữ liệu chấm công.</p>
    </div>
  );

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-black text-gray-400 uppercase tracking-widest">Lịch sử chấm công</h3>
        <div className="flex items-center gap-3">
          <button onClick={exportToCSV} className="flex items-center gap-1 text-xs font-bold uppercase text-green-600 hover:text-green-700 transition-colors">
            <Download size={14} /> Xuất CSV
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              "flex items-center gap-1 text-xs font-bold uppercase transition-colors",
              showFilters || hasActiveFilter ? "text-blue-600" : "text-gray-400 hover:text-blue-600"
            )}
          >
            <Filter size={14} /> Lọc {hasActiveFilter && <span className="w-1.5 h-1.5 rounded-full bg-blue-600 inline-block" />}
          </button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className={cn("grid gap-3", isMultiUser ? "grid-cols-2" : "grid-cols-3")}>
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Công trường</label>
              <select value={filterSite} onChange={e => setFilterSite(e.target.value)} className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="all">Tất cả</option>
                {uniqueSiteNames.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {isMultiUser && (
              <div>
                <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Thành viên</label>
                <select value={filterMember} onChange={e => setFilterMember(e.target.value)} className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="all">Tất cả</option>
                  {uniqueMembers.map(m => <option key={m.uid} value={m.uid}>{m.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Từ ngày</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Đến ngày</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          {hasActiveFilter && (
            <button onClick={() => { setFilterSite('all'); setFilterMember('all'); setDateFrom(''); setDateTo(''); }} className="w-full text-xs text-red-500 font-bold uppercase tracking-widest pt-1 hover:text-red-600 transition-colors">
              Xóa bộ lọc
            </button>
          )}
        </div>
      )}

      {/* Tổng quan toàn bộ */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'Tổng lượt', value: globalStats.total, color: 'bg-blue-50 text-blue-700', icon: <Users size={14} /> },
          { label: 'Đầy đủ', value: globalStats.complete, color: 'bg-green-50 text-green-700', icon: <CheckCircle2 size={14} /> },
          { label: 'Đến trễ', value: globalStats.late, color: 'bg-red-50 text-red-700', icon: <Clock size={14} /> },
          { label: 'Về sớm', value: globalStats.early, color: 'bg-orange-50 text-orange-700', icon: <TrendingUp size={14} /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className={cn("rounded-2xl p-3 flex flex-col items-center gap-1", color)}>
            <div className="flex items-center gap-1 opacity-70">{icon}<span className="text-[10px] font-bold uppercase tracking-widest">{label}</span></div>
            <span className="text-2xl font-black">{value}</span>
          </div>
        ))}
      </div>

      {/* Danh sách theo công trường */}
      {filteredRecords.length === 0 ? (
        <div className="p-8 text-center text-gray-500 font-medium bg-white rounded-2xl border border-dashed border-gray-200">
          Không tìm thấy kết quả phù hợp.
        </div>
      ) : (
        <div className="space-y-4">
          {siteGroups.map(sg => {
            const expanded = isSiteExpanded(sg.siteId);
            const sortedDates = Object.keys(sg.dates).sort((a, b) => b.localeCompare(a));

            return (
              <div key={sg.siteId} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                {/* Site header – click để collapse */}
                <button
                  onClick={() => toggleSite(sg.siteId)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100 hover:bg-gray-100/80 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {sg.site?.imageUrl ? (
                      <img src={sg.site.imageUrl} alt={sg.siteName} className="w-8 h-8 rounded-full object-cover border border-gray-200 shrink-0" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                        <MapPin size={14} className="text-blue-600" />
                      </div>
                    )}
                    <div className="text-left min-w-0">
                      <p className="font-black text-gray-900 truncate">{sg.siteName}</p>
                      <p className="text-[10px] text-gray-400 font-medium">{sortedDates.length} ngày · {sg.stats.total} lượt</p>
                    </div>
                  </div>

                  {/* Mini stats */}
                  <div className="flex items-center gap-2 mr-3 shrink-0">
                    <span className="flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-[10px] font-bold">
                      <CheckCircle2 size={10} /> {sg.stats.complete}
                    </span>
                    {sg.stats.late > 0 && (
                      <span className="flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[10px] font-bold">
                        <Clock size={10} /> {sg.stats.late} trễ
                      </span>
                    )}
                    {sg.stats.early > 0 && (
                      <span className="flex items-center gap-1 px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full text-[10px] font-bold">
                        <TrendingUp size={10} /> {sg.stats.early} sớm
                      </span>
                    )}
                    {sg.stats.missing > 0 && (
                      <span className="flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-[10px] font-bold">
                        <AlertTriangle size={10} /> {sg.stats.missing}
                      </span>
                    )}
                  </div>

                  {expanded ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
                </button>

                {/* Bảng dữ liệu — ẩn khi collapsed */}
                {expanded && (
                  <div className="overflow-x-auto">
                    {sortedDates.map((date, idx) => (
                      <div key={date}>
                        {/* Ngày sub-header */}
                        <div className={cn("flex items-center gap-2 px-4 py-2 bg-gray-50/60", idx > 0 && "border-t border-gray-100")}>
                          <Calendar size={13} className="text-gray-400" />
                          <span className="text-xs font-bold text-gray-500">{formatDate(date)}</span>
                          <span className="text-[10px] text-gray-400">({sg.dates[date].length} người)</span>
                        </div>

                        <table className="w-full text-sm text-left">
                          <thead className="text-[10px] text-gray-400 uppercase bg-white border-b border-gray-50">
                            <tr>
                              <th className="px-4 py-2 font-bold whitespace-nowrap">Nhân viên</th>
                              <th className="px-4 py-2 font-bold text-center whitespace-nowrap">Vào ca</th>
                              <th className="px-4 py-2 font-bold text-center whitespace-nowrap">Ra ca</th>
                              <th className="px-4 py-2 font-bold text-center whitespace-nowrap">Trạng thái</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sg.dates[date].map(group => {
                              const { isLate, isEarly } = getRecordFlags(group, sg.site);
                              const isComplete = !!group.checkIn && !!group.checkOut;
                              return (
                                <tr key={`${group.userId}-${date}`} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{getDisplayName(group.userId, group.userName)}</td>

                                  {/* Vào ca */}
                                  <td className="px-4 py-3 text-center">
                                    {group.checkIn ? (
                                      <div className="flex flex-col items-center">
                                        <span className={cn("font-mono text-sm", isLate ? "text-red-600 font-bold" : "text-gray-900")}>
                                          {new Date(group.checkIn.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                        {group.checkIn.photoUrl && (
                                          <button onClick={() => setSelectedPhoto(group.checkIn!.photoUrl)} className="text-[10px] text-blue-500 hover:underline mt-0.5">Ảnh</button>
                                        )}
                                      </div>
                                    ) : <span className="text-gray-300">-</span>}
                                  </td>

                                  {/* Ra ca */}
                                  <td className="px-4 py-3 text-center">
                                    {group.checkOut ? (
                                      <div className="flex flex-col items-center">
                                        <span className={cn("font-mono text-sm", isEarly ? "text-orange-600 font-bold" : "text-gray-900")}>
                                          {new Date(group.checkOut.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                        {group.checkOut.photoUrl && (
                                          <button onClick={() => setSelectedPhoto(group.checkOut!.photoUrl)} className="text-[10px] text-blue-500 hover:underline mt-0.5">Ảnh</button>
                                        )}
                                      </div>
                                    ) : <span className="text-gray-300">-</span>}
                                  </td>

                                  {/* Trạng thái */}
                                  <td className="px-4 py-3 text-center">
                                    <div className="flex flex-col items-center gap-1">
                                      {isLate && <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-bold whitespace-nowrap">Đến trễ</span>}
                                      {isEarly && <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-[10px] font-bold whitespace-nowrap">Về sớm</span>}
                                      {!isLate && !isEarly && isComplete && (
                                        <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-[10px] font-bold whitespace-nowrap">Đúng giờ</span>
                                      )}
                                      {!isComplete && (
                                        <span className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px] font-bold whitespace-nowrap">Thiếu dữ liệu</span>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))}

                    {/* Footer tổng của site */}
                    <div className="flex items-center justify-between px-4 py-3 bg-gray-50/80 border-t border-gray-100 text-xs font-bold text-gray-500">
                      <span>Tổng cộng: {sg.stats.total} lượt</span>
                      <div className="flex gap-3">
                        <span className="text-green-600">{sg.stats.complete} đầy đủ</span>
                        {sg.stats.late > 0 && <span className="text-red-500">{sg.stats.late} đến trễ</span>}
                        {sg.stats.early > 0 && <span className="text-orange-500">{sg.stats.early} về sớm</span>}
                        {sg.stats.missing > 0 && <span className="text-gray-400">{sg.stats.missing} thiếu dữ liệu</span>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Photo Modal */}
      {selectedPhoto && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSelectedPhoto(null)}>
          <div className="relative w-full max-w-md bg-gray-900 rounded-3xl overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <button onClick={() => setSelectedPhoto(null)} className="absolute top-4 right-4 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors">
              <X size={20} />
            </button>
            <img src={selectedPhoto} alt="Selfie xác thực" className="w-full h-auto max-h-[80vh] object-contain" referrerPolicy="no-referrer" />
          </div>
        </div>
      )}
    </div>
  );
};
