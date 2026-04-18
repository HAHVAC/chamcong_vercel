import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../firebase';
import {
  collection, query, where, orderBy, onSnapshot, getDocs, doc, getDoc
} from 'firebase/firestore';
import { AttendanceRecord, WorkRequest } from '../types';
import { ChevronLeft, ChevronRight, CalendarDays, List } from 'lucide-react';
import { cn } from '../lib/utils';

// ===================== Helpers =====================

const MONTH_NAMES = [
  'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

const DAY_NAMES = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

/** Tính số giờ tăng ca từ check-out và đề xuất đã duyệt */
function calcOvertimeHours(
  checkOutTs: number | undefined,
  overtimeReq: WorkRequest | undefined
): number {
  if (!checkOutTs) return 0;
  if (!overtimeReq || overtimeReq.status !== 'approved') return 0;

  // Giờ bắt đầu tăng ca: ưu tiên startTime trên đề xuất nếu sau 17:30
  const DEFAULT_OT_START = '17:30';
  const startTimeStr = overtimeReq.startTime || DEFAULT_OT_START;
  const [sh, sm] = startTimeStr.split(':').map(Number);

  // Đảm bảo giờ bắt đầu không sớm hơn 17:30
  const BASE_H = 17, BASE_M = 30;
  let startH = sh, startM = sm;
  if (sh < BASE_H || (sh === BASE_H && sm < BASE_M)) {
    startH = BASE_H;
    startM = BASE_M;
  }

  // Lấy ngày từ timestamp checkout
  const coDate = new Date(checkOutTs);
  const otStart = new Date(coDate);
  otStart.setHours(startH, startM, 0, 0);

  const diffMs = coDate.getTime() - otStart.getTime();
  if (diffMs <= 0) return 0;
  return Math.round((diffMs / 3_600_000) * 10) / 10; // làm tròn 1 chữ số thập phân
}

// ===================== Types =====================

interface DayData {
  dateStr: string; // YYYY-MM-DD
  checkIn?: AttendanceRecord;
  checkOut?: AttendanceRecord;
  leaveReq?: WorkRequest;    // nghỉ phép đã duyệt
  overtimeReq?: WorkRequest; // tăng ca đã duyệt
  otherReqs: WorkRequest[];  // các đề xuất khác đã duyệt hoặc pending
}

interface Props {
  isManager: boolean;
  isAdmin: boolean;
}

// ===================== Component =====================

export const AttendanceCalendar: React.FC<Props> = ({ isManager, isAdmin }) => {
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth()); // 0-based

  const [viewMode, setViewMode] = useState<'month' | 'week'>('month');
  // Tuần hiện tại: chứa ngày nào
  const [weekAnchor, setWeekAnchor] = useState<Date>(new Date());

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [requests, setRequests] = useState<WorkRequest[]>([]);
  const [managedRequests, setManagedRequests] = useState<WorkRequest[]>([]);
  const [uidToName, setUidToName] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // Fetch dữ liệu
  useEffect(() => {
    if (!auth.currentUser) return;
    const uid = auth.currentUser.uid;
    const unsubs: (() => void)[] = [];

    const init = async () => {
      // Tải profile
      const profileSnap = await getDoc(doc(db, 'users', uid));
      const profile = profileSnap.exists() ? profileSnap.data() : null;
      const role = profile?.role ?? 'worker';
      const currentEmail = auth.currentUser?.email?.toLowerCase() ?? '';
      const isAdminRole = role === 'admin' || currentEmail === 'hahvac@gmail.com';
      const isManagerRole = role === 'manager';

      // UID → tên thật (cho manager/admin)
      if (isAdminRole || isManagerRole) {
        const allUsers = await getDocs(collection(db, 'users'));
        const nameMap: Record<string, string> = {};
        allUsers.docs.forEach(d => {
          const data = d.data();
          if (data.uid) nameMap[data.uid] = data.fullName || data.displayName || '';
        });
        setUidToName(nameMap);
      }

      // Khoảng thời gian đủ rộng: 90 ngày về trước
      const from = Date.now() - 90 * 24 * 3_600_000;

      // --- Attendance records ---
      if (isAdminRole) {
        const q = query(collection(db, 'attendance'), where('timestamp', '>=', from), orderBy('timestamp', 'desc'));
        unsubs.push(onSnapshot(q, snap => {
          setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[]);
          setLoading(false);
        }));
      } else if (isManagerRole) {
        // Lịch sử của chính manager
        const qOwn = query(
          collection(db, 'attendance'),
          where('userId', '==', uid),
          where('timestamp', '>=', from),
          orderBy('timestamp', 'desc')
        );

        // Lấy danh sách nhân viên được quản lý
        const usersSnap = await getDocs(collection(db, 'users'));
        const managedUids = usersSnap.docs
          .filter(d => {
            const data = d.data();
            return data.managerUid === uid || (data.managerEmail || '').toLowerCase() === currentEmail;
          })
          .map(d => d.data().uid as string)
          .filter(u => u && u !== uid);

        let ownRecs: AttendanceRecord[] = [];
        let managedRecs: AttendanceRecord[] = [];

        const mergeRecords = () => {
          const all = [...ownRecs, ...managedRecs];
          const unique = Array.from(new Map(all.map(r => [r.id, r])).values());
          setRecords(unique);
          setLoading(false);
        };

        unsubs.push(onSnapshot(qOwn, snap => {
          ownRecs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[];
          mergeRecords();
        }));

        if (managedUids.length > 0) {
          const CHUNK = 30;
          const chunks: AttendanceRecord[][] = Array.from({ length: Math.ceil(managedUids.length / CHUNK) }, () => []);
          for (let i = 0; i < managedUids.length; i += CHUNK) {
            const idx = Math.floor(i / CHUNK);
            const chunk = managedUids.slice(i, i + CHUNK);
            const q = query(
              collection(db, 'attendance'),
              where('userId', 'in', chunk),
              where('timestamp', '>=', from),
              orderBy('timestamp', 'desc')
            );
            unsubs.push(onSnapshot(q, snap => {
              chunks[idx] = snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[];
              managedRecs = chunks.flat();
              mergeRecords();
            }));
          }
        }
      } else {
        // Nhân viên thường
        const q = query(
          collection(db, 'attendance'),
          where('userId', '==', uid),
          where('timestamp', '>=', from),
          orderBy('timestamp', 'desc')
        );
        unsubs.push(onSnapshot(q, snap => {
          setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() })) as AttendanceRecord[]);
          setLoading(false);
        }));
      }

      // --- Requests ---
      // Đề xuất của chính mình
      const qSelf = query(
        collection(db, 'requests'),
        where('userId', '==', uid),
        orderBy('createdAt', 'desc')
      );
      unsubs.push(onSnapshot(qSelf, snap => {
        setRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })) as WorkRequest[]);
      }));

      // Đề xuất của nhân viên (cho manager/admin)
      if (isAdminRole) {
        const qAll = query(collection(db, 'requests'), orderBy('createdAt', 'desc'));
        unsubs.push(onSnapshot(qAll, snap => {
          setManagedRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })) as WorkRequest[]);
        }));
      } else if (isManagerRole) {
        // Đề xuất của nhân viên thuộc quyền quản lý
        const qManaged = query(
          collection(db, 'requests'),
          where('managerId', '==', uid),
          orderBy('createdAt', 'desc')
        );
        unsubs.push(onSnapshot(qManaged, snap => {
          setManagedRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })) as WorkRequest[]);
        }));
      }
    };

    init().catch(() => setLoading(false));
    return () => unsubs.forEach(fn => fn());
  }, []);

  // ===================== Compute day data (cho nhân viên — lịch tháng) =====================

  /** Map dateStr → DayData cho user hiện tại */
  const selfDayMap = useMemo<Record<string, DayData>>(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return {};
    const map: Record<string, DayData> = {};

    const ensure = (dateStr: string): DayData => {
      if (!map[dateStr]) map[dateStr] = { dateStr, otherReqs: [] };
      return map[dateStr];
    };

    // Chấm công
    for (const rec of records) {
      if (rec.userId !== uid) continue;
      const d = new Date(rec.timestamp);
      const ds = toDateStr(d);
      const day = ensure(ds);
      if (rec.type === 'check-in') {
        if (!day.checkIn || rec.timestamp < day.checkIn.timestamp) day.checkIn = rec;
      } else {
        if (!day.checkOut || rec.timestamp > day.checkOut.timestamp) day.checkOut = rec;
      }
    }

    // Đề xuất của bản thân
    for (const req of requests) {
      if (req.type === 'leave' && req.endDate && req.endDate > req.date) {
        // Nghỉ phép multi-day: fill tất cả các ngày trong khoảng
        const startD = new Date(req.date);
        const endD = new Date(req.endDate);
        const cur = new Date(startD);
        while (cur <= endD) {
          const ds = toDateStr(cur);
          const day = ensure(ds);
          if (!day.leaveReq || req.status === 'approved') day.leaveReq = req;
          cur.setDate(cur.getDate() + 1);
        }
      } else {
        const day = ensure(req.date);
        if (req.type === 'leave') {
          if (!day.leaveReq || req.status === 'approved') day.leaveReq = req;
        } else if (req.type === 'overtime') {
          if (!day.overtimeReq || req.status === 'approved') day.overtimeReq = req;
        } else {
          day.otherReqs.push(req);
        }
      }
    }

    return map;
  }, [records, requests]);

  // ===================== Compute day data (cho manager — lịch tháng/tuần) =====================

  /** Map dateStr → { uid: DayData } — cho manager view */
  const managerDayMap = useMemo<Record<string, Record<string, DayData>>>(() => {
    if (!isManager && !isAdmin) return {};
    const map: Record<string, Record<string, DayData>> = {};

    const ensure = (dateStr: string, uid: string): DayData => {
      if (!map[dateStr]) map[dateStr] = {};
      if (!map[dateStr][uid]) map[dateStr][uid] = { dateStr, otherReqs: [] };
      return map[dateStr][uid];
    };

    // Chỉ lấy nhân viên (không phải bản thân)
    const selfUid = auth.currentUser?.uid;
    for (const rec of records) {
      if (rec.userId === selfUid) continue;
      const d = new Date(rec.timestamp);
      const ds = toDateStr(d);
      const day = ensure(ds, rec.userId);
      if (rec.type === 'check-in') {
        if (!day.checkIn || rec.timestamp < day.checkIn.timestamp) day.checkIn = rec;
      } else {
        if (!day.checkOut || rec.timestamp > day.checkOut.timestamp) day.checkOut = rec;
      }
    }

    // Đề xuất của nhân viên
    for (const req of managedRequests) {
      if (req.userId === selfUid) continue;
      if (req.type === 'leave' && req.endDate && req.endDate > req.date) {
        // Nghỉ phép multi-day: fill tất cả các ngày trong khoảng
        const startD = new Date(req.date);
        const endD = new Date(req.endDate);
        const cur = new Date(startD);
        while (cur <= endD) {
          const ds = toDateStr(cur);
          const day = ensure(ds, req.userId);
          if (!day.leaveReq || req.status === 'approved') day.leaveReq = req;
          cur.setDate(cur.getDate() + 1);
        }
      } else {
        const day = ensure(req.date, req.userId);
        if (req.type === 'leave') {
          if (!day.leaveReq || req.status === 'approved') day.leaveReq = req;
        } else if (req.type === 'overtime') {
          if (!day.overtimeReq || req.status === 'approved') day.overtimeReq = req;
        } else {
          day.otherReqs.push(req);
        }
      }
    }

    return map;
  }, [records, managedRequests, isManager, isAdmin]);

  // ===================== Calendar helpers =====================

  /** Danh sách các ngày hiển thị trong lưới tháng (T2-CN) */
  const monthGrid = useMemo<Date[]>(() => {
    const first = new Date(year, month, 1);
    // Thứ 2 = 1, CN = 0. Shift để T2 là cột đầu
    const startDay = (first.getDay() + 6) % 7; // 0=Mon .. 6=Sun
    const days: Date[] = [];
    const start = new Date(first);
    start.setDate(1 - startDay);
    for (let i = 0; i < 42; i++) {
      days.push(new Date(start));
      start.setDate(start.getDate() + 1);
    }
    return days;
  }, [year, month]);

  /** Tuần hiện tại (T2 → CN) */
  const weekDays = useMemo<Date[]>(() => {
    const d = new Date(weekAnchor);
    const dow = (d.getDay() + 6) % 7; // 0=Mon
    d.setDate(d.getDate() - dow);
    return Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(d);
      dd.setDate(d.getDate() + i);
      return dd;
    });
  }, [weekAnchor]);

  // ===================== Navigation =====================

  const prevMonth = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };
  const prevWeek = () => setWeekAnchor(d => { const nd = new Date(d); nd.setDate(d.getDate() - 7); return nd; });
  const nextWeek = () => setWeekAnchor(d => { const nd = new Date(d); nd.setDate(d.getDate() + 7); return nd; });

  // ===================== Cell renderers =====================

  const today = toDateStr(new Date());

  /** Cell nhân viên (lịch tháng) */
  const renderEmployeeCell = (date: Date) => {
    const ds = toDateStr(date);
    const isCurrentMonth = date.getMonth() === month;
    const isToday = ds === today;
    const day = selfDayMap[ds];

    const overtimeHours = day
      ? calcOvertimeHours(day.checkOut?.timestamp, day.overtimeReq)
      : 0;

    const isLeave = !!day?.leaveReq;

    return (
      <div
        key={ds}
        className={cn(
          'min-h-[80px] p-1.5 border-b border-r border-gray-100 text-xs flex flex-col',
          !isCurrentMonth && 'opacity-30',
          isToday && 'bg-blue-50',
        )}
      >
        {/* Số ngày */}
        <span className={cn(
          'w-6 h-6 flex items-center justify-center rounded-full font-bold mb-1 self-start text-xs',
          isToday ? 'bg-blue-600 text-white' : 'text-gray-700',
          !isCurrentMonth && 'text-gray-400'
        )}>{date.getDate()}</span>

        {isLeave && (
          <span className="px-1 py-0.5 bg-blue-100 text-blue-700 rounded text-[9px] font-bold leading-tight mb-0.5 truncate">
            Nghỉ {day.leaveReq?.status === 'approved' ? '✓' : '⏳'}
          </span>
        )}

        {!isLeave && day?.checkIn && (
          <span className="text-green-700 font-mono text-[9px] leading-tight">
            ▶ {formatTime(day.checkIn.timestamp)}
          </span>
        )}
        {!isLeave && day?.checkOut && (
          <span className="text-red-600 font-mono text-[9px] leading-tight">
            ■ {formatTime(day.checkOut.timestamp)}
          </span>
        )}
        {overtimeHours > 0 && (
          <span className="mt-0.5 px-1 py-0.5 bg-purple-100 text-purple-700 rounded text-[9px] font-bold leading-tight">
            +{overtimeHours}h TC
          </span>
        )}
      </div>
    );
  };

  /** Cell manager (lịch tháng hoặc tuần) — hiển thị danh sách người xin nghỉ */
  const renderManagerCell = (date: Date, compact = false, inWeekView = false) => {
    const ds = toDateStr(date);
    // Trong week view không dim ngày ngoài tháng (vì có thể tuần vắt sang tháng khác)
    const isCurrentMonth = inWeekView ? true : date.getMonth() === month;
    const isToday = ds === today;
    const perUser = managerDayMap[ds] ?? {};
    const leaveEntries = Object.entries(perUser).filter(([, d]) => !!d.leaveReq);

    return (
      <div
        key={ds}
        className={cn(
          'border-b border-r border-gray-100 p-1.5 flex flex-col',
          compact ? 'min-h-[60px] text-[10px]' : 'min-h-[100px] text-xs',
          !isCurrentMonth && 'opacity-30',
          isToday && 'bg-blue-50',
        )}
      >
        {/* Số ngày */}
        <span className={cn(
          'w-6 h-6 flex items-center justify-center rounded-full font-bold mb-1 self-start',
          isToday ? 'bg-blue-600 text-white' : 'text-gray-700',
          !isCurrentMonth && 'text-gray-400'
        )}>{date.getDate()}</span>

        <div className="space-y-0.5 overflow-hidden">
          {leaveEntries.map(([uid, dayData]) => {
            const name = uidToName[uid] || uid;
            const req = dayData.leaveReq!;
            const leaveDays = req.endDate && req.endDate !== req.date
              ? (() => {
                  const start = new Date(req.date);
                  const end = new Date(req.endDate!);
                  const diff = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
                  return `${diff} ngày`;
                })()
              : '1 ngày';
            return (
              <div key={uid} className="leading-tight">
                <span className={cn(
                  'font-medium',
                  req.status === 'approved' ? 'text-red-600' : 'text-amber-600'
                )}>
                  - {name}: nghỉ {leaveDays}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ===================== Render =====================

  const isManagerOrAdmin = isManager || isAdmin;

  if (loading) {
    return <div className="p-8 text-center text-gray-500 font-medium">Đang tải lịch...</div>;
  }

  return (
    <div className="p-4 space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-gray-400 uppercase tracking-widest">Lịch</h3>
        <div className="flex items-center gap-2">
          {isManagerOrAdmin && (
            <div className="flex bg-gray-100 p-0.5 rounded-xl">
              <button
                onClick={() => setViewMode('month')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-all',
                  viewMode === 'month' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'
                )}
              >
                <CalendarDays size={12} /> Tháng
              </button>
              <button
                onClick={() => setViewMode('week')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-all',
                  viewMode === 'week' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'
                )}
              >
                <List size={12} /> Tuần
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Month/Week navigator */}
      <div className="flex items-center justify-between bg-white rounded-2xl px-4 py-3 shadow-sm border border-gray-100">
        <button
          onClick={viewMode === 'month' ? prevMonth : prevWeek}
          className="p-2 hover:bg-gray-100 rounded-xl transition-colors"
        >
          <ChevronLeft size={18} className="text-gray-600" />
        </button>
        <span className="font-black text-gray-900 text-sm">
          {viewMode === 'month'
            ? `${MONTH_NAMES[month]} ${year}`
            : (() => {
                const wds = weekDays;
                return `${wds[0].getDate()}/${wds[0].getMonth() + 1} – ${wds[6].getDate()}/${wds[6].getMonth() + 1}/${wds[6].getFullYear()}`;
              })()
          }
        </span>
        <button
          onClick={viewMode === 'month' ? nextMonth : nextWeek}
          className="p-2 hover:bg-gray-100 rounded-xl transition-colors"
        >
          <ChevronRight size={18} className="text-gray-600" />
        </button>
      </div>

      {/* Calendar grid */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        {/* Header ngày */}
        <div className="grid grid-cols-7 border-b border-gray-100">
          {DAY_NAMES.map(d => (
            <div key={d} className={cn(
              'py-2 text-center text-[10px] font-black uppercase tracking-widest',
              d === 'CN' ? 'text-red-400' : 'text-gray-400'
            )}>{d}</div>
          ))}
        </div>

        {/* Nội dung */}
        {viewMode === 'month' && (
          <div className="grid grid-cols-7">
            {monthGrid.map(date => (
              isManagerOrAdmin
                ? renderManagerCell(date)
                : renderEmployeeCell(date)
            ))}
          </div>
        )}

        {viewMode === 'week' && isManagerOrAdmin && (
          <div className="grid grid-cols-7">
            {weekDays.map(date => renderManagerCell(date, false, true))}
          </div>
        )}
      </div>

      {/* Chú thích */}
      <div className="flex flex-wrap gap-3 px-1">
        {isManagerOrAdmin ? (
          <>
            <span className="flex items-center gap-1 text-[10px] text-red-600 font-bold">
              <span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> Nghỉ phép (đã duyệt)
            </span>
            <span className="flex items-center gap-1 text-[10px] text-amber-600 font-bold">
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Chờ duyệt
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1 text-[10px] text-green-600 font-bold">
              <span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> Giờ vào
            </span>
            <span className="flex items-center gap-1 text-[10px] text-red-500 font-bold">
              <span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> Giờ ra
            </span>
            <span className="flex items-center gap-1 text-[10px] text-blue-600 font-bold">
              <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> Nghỉ phép
            </span>
            <span className="flex items-center gap-1 text-[10px] text-purple-600 font-bold">
              <span className="w-2 h-2 rounded-full bg-purple-400 inline-block" /> Tăng ca
            </span>
          </>
        )}
      </div>
    </div>
  );
};
