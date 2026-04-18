import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../firebase';
import { collection, addDoc, query, where, orderBy, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { WorkRequest, WorkRequestType } from '../types';
import { syncToLark } from '../lib/larkSync';
import { Calendar, Clock, FileText, Send, CheckCircle, XCircle, AlertCircle, Loader2, LogIn, LogOut, Sun } from 'lucide-react';
import { cn } from '../lib/utils';

// --- Cấu hình loại đề xuất ---
interface RequestTypeConfig {
  label: string;
  color: 'blue' | 'purple' | 'amber' | 'orange' | 'rose' | 'green' | 'teal';
  icon: React.ReactNode;
  hasTimeRange: boolean; // hiển thị từ giờ / đến giờ
  dateLabel?: string;
}

const REQUEST_TYPES: Record<WorkRequestType, RequestTypeConfig> = {
  leave: {
    label: 'Nghỉ phép',
    color: 'blue',
    icon: <Calendar size={18} />,
    hasTimeRange: false,
  },
  overtime: {
    label: 'Tăng ca',
    color: 'purple',
    icon: <Clock size={18} />,
    hasTimeRange: true,
    dateLabel: 'Ngày tăng ca',
  },
  late: {
    label: 'Đi muộn',
    color: 'amber',
    icon: <AlertCircle size={18} />,
    hasTimeRange: true,
    dateLabel: 'Ngày đi muộn',
  },
  early_leave: {
    label: 'Về sớm',
    color: 'orange',
    icon: <LogOut size={18} />,
    hasTimeRange: true,
    dateLabel: 'Ngày về sớm',
  },
  forgot_checkin: {
    label: 'Quên check-in',
    color: 'rose',
    icon: <LogIn size={18} />,
    hasTimeRange: false,
  },
  forgot_checkout: {
    label: 'Quên check-out',
    color: 'teal',
    icon: <LogOut size={18} />,
    hasTimeRange: false,
  },
  sunday_holiday: {
    label: 'Làm CN/Lễ',
    color: 'green',
    icon: <Sun size={18} />,
    hasTimeRange: true,
    dateLabel: 'Ngày làm việc',
  },
};

const COLOR_VARIANTS: Record<string, { border: string; bg: string; text: string; badge: string; badgeText: string; submitBg: string }> = {
  blue:   { border: 'border-blue-600',   bg: 'bg-blue-50',   text: 'text-blue-700',   badge: 'bg-blue-100',   badgeText: 'text-blue-700',   submitBg: 'bg-blue-600'   },
  purple: { border: 'border-purple-600', bg: 'bg-purple-50', text: 'text-purple-700', badge: 'bg-purple-100', badgeText: 'text-purple-700', submitBg: 'bg-purple-600' },
  amber:  { border: 'border-amber-600',  bg: 'bg-amber-50',  text: 'text-amber-700',  badge: 'bg-amber-100',  badgeText: 'text-amber-700',  submitBg: 'bg-amber-600'  },
  orange: { border: 'border-orange-500', bg: 'bg-orange-50', text: 'text-orange-700', badge: 'bg-orange-100', badgeText: 'text-orange-700', submitBg: 'bg-orange-500' },
  rose:   { border: 'border-rose-500',   bg: 'bg-rose-50',   text: 'text-rose-700',   badge: 'bg-rose-100',   badgeText: 'text-rose-700',   submitBg: 'bg-rose-500'   },
  teal:   { border: 'border-teal-500',   bg: 'bg-teal-50',   text: 'text-teal-700',   badge: 'bg-teal-100',   badgeText: 'text-teal-700',   submitBg: 'bg-teal-500'   },
  green:  { border: 'border-green-600',  bg: 'bg-green-50',  text: 'text-green-700',  badge: 'bg-green-100',  badgeText: 'text-green-700',  submitBg: 'bg-green-600'  },
};

// --- Helpers ---
function formatDateLabel(dateStr: string) {
  return dateStr.split('-').reverse().join('/');
}

function formatDateGroup(ts: number) {
  return new Date(ts).toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'approved':
      return (
        <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1">
          <CheckCircle size={12} /> Đã duyệt
        </span>
      );
    case 'rejected':
      return (
        <span className="px-2 py-1 bg-red-100 text-red-700 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1">
          <XCircle size={12} /> Từ chối
        </span>
      );
    default:
      return (
        <span className="px-2 py-1 bg-amber-100 text-amber-700 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1">
          <Clock size={12} /> Chờ duyệt
        </span>
      );
  }
}

function formatTimeRange(req: WorkRequest): string {
  const cfg = REQUEST_TYPES[req.type];
  if (req.type === 'leave') {
    return req.endDate
      ? `${formatDateLabel(req.date)} → ${formatDateLabel(req.endDate)}`
      : formatDateLabel(req.date);
  }
  if (cfg.hasTimeRange && req.startTime && req.endTime) {
    return `${formatDateLabel(req.date)} (${req.startTime} – ${req.endTime})`;
  }
  return formatDateLabel(req.date);
}

// --- Component ---
export const WorkRequests: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'new' | 'history'>('new');
  const [requests, setRequests] = useState<WorkRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [type, setType] = useState<WorkRequestType>('leave');
  const [date, setDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [userProfile, setUserProfile] = useState<any>(null);

  useEffect(() => {
    if (!auth.currentUser) return;

    // Tải hồ sơ người dùng
    const userDocRef = doc(db, 'users', auth.currentUser.uid);
    getDoc(userDocRef).then(snap => {
      if (snap.exists()) setUserProfile(snap.data());
    });

    const q = query(
      collection(db, 'requests'),
      where('userId', '==', auth.currentUser.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const reqData = snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as WorkRequest[];
      setRequests(reqData);
      setLoading(false);
    }, () => setLoading(false));

    return () => unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;

    setError(null);
    setSuccess(null);

    if (!date || !reason) {
      setError('Vui lòng điền đầy đủ ngày và lý do.');
      return;
    }

    const cfg = REQUEST_TYPES[type];
    if (cfg.hasTimeRange && (!startTime || !endTime)) {
      setError('Vui lòng điền giờ bắt đầu và kết thúc.');
      return;
    }

    setSubmitting(true);

    try {
      const newRequest: Omit<WorkRequest, 'id'> = {
        userId: auth.currentUser.uid,
        userName: auth.currentUser.displayName || userProfile?.displayName || 'Unknown',
        fullName: userProfile?.fullName || '',
        type,
        date,
        reason,
        status: 'pending',
        createdAt: Date.now(),
        managerEmail: userProfile?.managerEmail || '',
        managerName: userProfile?.managerName || '',
        managerId: userProfile?.managerUid || '',
      };

      if (type === 'leave' && endDate) newRequest.endDate = endDate;
      if (cfg.hasTimeRange) {
        newRequest.startTime = startTime;
        newRequest.endTime = endTime;
      }

      const docRef = await addDoc(collection(db, 'requests'), newRequest);

      try {
        await syncToLark('requests', {
          'ID': docRef.id,
          'Người đề xuất': newRequest.fullName || newRequest.userName,
          'Người quản lý': userProfile?.managerName || '',
          'Email người quản lý': userProfile?.managerEmail || '',
          'Loại': REQUEST_TYPES[type].label,
          'Từ': newRequest.date,
          'Đến': newRequest.endDate || newRequest.date,
          'Giờ bắt đầu': newRequest.startTime || '',
          'Giờ kết thúc': newRequest.endTime || '',
          'Lý do': newRequest.reason,
          'Trạng thái': 'Chờ duyệt',
        });
      } catch { /* Lỗi sync Lark không chặn luồng chính */ }

      setSuccess('Đã gửi đề xuất thành công!');
      setDate('');
      setEndDate('');
      setStartTime('');
      setEndTime('');
      setReason('');
      setActiveTab('history');
    } catch {
      setError('Đã xảy ra lỗi khi gửi đề xuất.');
    } finally {
      setSubmitting(false);
    }
  };

  // Nhóm lịch sử theo ngày gửi rồi theo loại
  const groupedHistory = useMemo(() => {
    type Group = { dateLabel: string; ts: number; byType: Map<WorkRequestType, WorkRequest[]> };
    const dateMap = new Map<string, Group>();

    for (const req of requests) {
      const d = new Date(req.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!dateMap.has(key)) {
        dateMap.set(key, { dateLabel: formatDateGroup(req.createdAt), ts: req.createdAt, byType: new Map() });
      }
      const group = dateMap.get(key)!;
      if (!group.byType.has(req.type)) group.byType.set(req.type, []);
      group.byType.get(req.type)!.push(req);
    }

    return Array.from(dateMap.values()).sort((a, b) => b.ts - a.ts);
  }, [requests]);

  const cfg = REQUEST_TYPES[type];
  const colors = COLOR_VARIANTS[cfg.color];

  return (
    <div className="p-4 space-y-6 pb-24">
      {/* Header Tabs */}
      <div className="flex bg-gray-100 p-1 rounded-2xl">
        <button
          onClick={() => setActiveTab('new')}
          className={cn(
            'flex-1 py-3 text-sm font-bold rounded-xl transition-all',
            activeTab === 'new' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          )}
        >
          Tạo đề xuất
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={cn(
            'flex-1 py-3 text-sm font-bold rounded-xl transition-all',
            activeTab === 'history' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          )}
        >
          Lịch sử
        </button>
      </div>

      {activeTab === 'new' ? (
        <div className="bg-white p-6 rounded-[32px] shadow-sm border border-gray-100">
          <h2 className="text-xl font-black text-gray-900 mb-6 uppercase tracking-tighter flex items-center gap-2">
            <FileText size={24} className="text-blue-600" />
            Đề xuất mới
          </h2>

          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-2xl flex items-start gap-3 text-sm font-medium">
              <AlertCircle size={20} className="shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          )}

          {success && (
            <div className="mb-6 p-4 bg-green-50 text-green-600 rounded-2xl flex items-start gap-3 text-sm font-medium">
              <CheckCircle size={20} className="shrink-0 mt-0.5" />
              <p>{success}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Loại đề xuất — 2 hàng, mỗi hàng 4 nút */}
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Loại đề xuất</label>
              <div className="grid grid-cols-4 gap-2 mb-2">
                {(['leave', 'overtime', 'late', 'early_leave'] as WorkRequestType[]).map(t => {
                  const c = REQUEST_TYPES[t];
                  const cv = COLOR_VARIANTS[c.color];
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setType(t)}
                      className={cn(
                        'py-2.5 px-1 rounded-xl font-bold text-xs border-2 transition-all flex flex-col items-center justify-center gap-1',
                        type === t ? `${cv.border} ${cv.bg} ${cv.text}` : 'border-gray-100 text-gray-500 hover:border-gray-200'
                      )}
                    >
                      {c.icon}
                      <span className="leading-tight text-center">{c.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(['forgot_checkin', 'forgot_checkout', 'sunday_holiday'] as WorkRequestType[]).map(t => {
                  const c = REQUEST_TYPES[t];
                  const cv = COLOR_VARIANTS[c.color];
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setType(t)}
                      className={cn(
                        'py-2.5 px-1 rounded-xl font-bold text-xs border-2 transition-all flex flex-col items-center justify-center gap-1',
                        type === t ? `${cv.border} ${cv.bg} ${cv.text}` : 'border-gray-100 text-gray-500 hover:border-gray-200'
                      )}
                    >
                      {c.icon}
                      <span className="leading-tight text-center">{c.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Ngày / giờ */}
            {type === 'leave' ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Từ ngày</label>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Đến ngày (Tùy chọn)</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
                    {cfg.dateLabel ?? 'Ngày'}
                  </label>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                    required
                  />
                </div>
                {cfg.hasTimeRange && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
                        {type === 'late' ? 'Giờ quy định' : 'Từ giờ'}
                      </label>
                      <input
                        type="time"
                        value={startTime}
                        onChange={e => setStartTime(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
                        {type === 'late' ? 'Giờ thực tế vào' : type === 'early_leave' ? 'Giờ về thực tế' : 'Đến giờ'}
                      </label>
                      <input
                        type="time"
                        value={endTime}
                        onChange={e => setEndTime(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        required
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Lý do / Ghi chú</label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Nhập lý do chi tiết..."
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all min-h-[100px] resize-none"
                required
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className={cn(
                'w-full rounded-xl py-4 font-bold text-lg shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:active:scale-100 text-white',
                colors.submitBg
              )}
            >
              {submitting ? <Loader2 size={24} className="animate-spin" /> : <Send size={24} />}
              {submitting ? 'Đang gửi...' : 'Gửi đề xuất'}
            </button>
          </form>
        </div>
      ) : (
        /* ---- Lịch sử ---- */
        <div className="space-y-6">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={32} className="animate-spin text-blue-600" />
            </div>
          ) : groupedHistory.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-[32px] border border-gray-100">
              <FileText size={48} className="mx-auto text-gray-200 mb-4" />
              <p className="text-gray-500 font-medium">Chưa có đề xuất nào.</p>
            </div>
          ) : (
            groupedHistory.map(group => (
              <div key={group.dateLabel} className="space-y-3">
                {/* Tiêu đề ngày */}
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-gray-200" />
                  <span className="text-xs font-bold text-gray-400 uppercase tracking-widest whitespace-nowrap">
                    {group.dateLabel}
                  </span>
                  <div className="h-px flex-1 bg-gray-200" />
                </div>

                {/* Nhóm theo loại */}
                {Array.from(group.byType.entries()).map(([reqType, reqs]) => {
                  const typeCfg = REQUEST_TYPES[reqType];
                  const typeColors = COLOR_VARIANTS[typeCfg.color];
                  return (
                    <div key={reqType} className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                      {/* Header loại */}
                      <div className={cn('px-5 py-3 flex items-center gap-2', typeColors.bg)}>
                        <span className={typeColors.text}>{typeCfg.icon}</span>
                        <span className={cn('font-bold text-sm', typeColors.text)}>{typeCfg.label}</span>
                        <span className={cn('ml-auto text-xs font-bold px-2 py-0.5 rounded-full', typeColors.badge, typeColors.badgeText)}>
                          {reqs.length}
                        </span>
                      </div>

                      {/* Danh sách các request trong nhóm */}
                      <div className="divide-y divide-gray-50">
                        {reqs.map(req => {
                          const requesterName = req.fullName || userProfile?.fullName || req.userName || '';
                          return (
                            <div key={req.id} className="p-4 space-y-2">
                              <div className="flex justify-between items-start gap-2">
                                <div>
                                  {requesterName && (
                                    <p className="text-xs font-bold text-gray-500 mb-0.5">{requesterName}</p>
                                  )}
                                  <span className="text-sm font-bold text-gray-900">
                                    {formatTimeRange(req)}
                                  </span>
                                </div>
                                {getStatusBadge(req.status)}
                              </div>
                              <p className="text-sm text-gray-600">{req.reason}</p>
                              {req.managerComment && (
                                <div className="mt-1 pt-2 border-t border-gray-100 text-sm text-gray-500 italic">
                                  Phản hồi: "{req.managerComment}"
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
