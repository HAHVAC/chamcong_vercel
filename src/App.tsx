import React, { useState, useEffect } from 'react';
import { auth, signInWithGoogle, signInWithGoogleRedirect, logout } from './firebase';
import { onAuthStateChanged, User, getRedirectResult } from 'firebase/auth';
import { AttendanceForm } from './components/AttendanceForm';
import { AttendanceHistory } from './components/AttendanceHistory';
import { UserDashboard } from './components/UserDashboard';
import { WorkRequests } from './components/WorkRequests';
import { AdminPanel } from './components/AdminPanel';
import { AttendanceCalendar } from './components/AttendanceCalendar';
import { LogOut, User as UserIcon, ShieldCheck, HardHat, Construction, Clock, Settings, WifiOff, BarChart3, FileText, CalendarDays } from 'lucide-react';
import { cn } from './lib/utils';
import { DEFAULT_ADMIN_EMAIL } from './constants';
import { db } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { syncToLark } from './lib/larkSync';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [isManager, setIsManager] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'attendance' | 'history' | 'dashboard' | 'requests' | 'admin' | 'calendar'>('attendance');
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    // Xử lý kết quả đăng nhập sau redirect (Google redirect flow)
    getRedirectResult(auth).then((result) => {
      if (result?.user) {
        // User đã đăng nhập qua redirect — onAuthStateChanged sẽ tự bắt
        console.log('Redirect login success:', result.user.email);
      }
    }).catch((error) => {
      console.error('Redirect result error:', error);
      setLoginError(error.message || 'Lỗi đăng nhập chuyển hướng.');
    });

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user);
      if (user) {
        // Kiểm tra email admin TRƯỚC khi gọi Firestore để fallback catch hoạt động đúng
        let isUserAdmin = !!(user.email && user.email.toLowerCase() === DEFAULT_ADMIN_EMAIL);
        let isUserManager = false;
        let currentRole = isUserAdmin ? 'admin' : 'worker';

        try {
          const userRef = doc(db, 'users', user.uid);
          const userDoc = await getDoc(userRef);

          // Chỉ đọc role từ Firestore nếu không phải default admin
          if (!isUserAdmin && userDoc.exists()) {
            if (userDoc.data().role === 'admin') {
              isUserAdmin = true;
              currentRole = 'admin';
            } else if (userDoc.data().role === 'manager') {
              isUserManager = true;
              currentRole = 'manager';
            }
          }

          setIsAdmin(isUserAdmin);
          setIsManager(isUserManager);

          // Sync user profile
          if (!userDoc.exists()) {
            const isDefaultAdmin = user.email && user.email.toLowerCase() === DEFAULT_ADMIN_EMAIL.toLowerCase();
            await setDoc(userRef, {
              uid: user.uid,
              email: user.email || '',
              displayName: user.displayName || '',
              role: currentRole,
              verified: isDefaultAdmin, // Default admin is auto-verified
              assignedSiteIds: []
            });
            
            // Sync to Lark
            syncToLark('users', {
              "ID": user.uid,
              "Tên": user.displayName || user.email || '',
              "Email": user.email || '',
              "Vai trò": currentRole,
              "Trạng thái": isDefaultAdmin ? 'Đã xác thực' : 'Chưa xác thực'
            });
          } else {
            const existingData = userDoc.data();
            const newDisplayName = user.displayName || existingData.displayName || '';
            const newEmail = user.email || existingData.email || '';

            // Chỉ ghi Firestore nếu displayName hoặc email thực sự thay đổi
            const needsUpdate = newDisplayName !== existingData.displayName || newEmail !== existingData.email;
            if (needsUpdate) {
              await setDoc(userRef, {
                uid: user.uid,
                email: newEmail,
                displayName: newDisplayName,
                role: existingData.role || currentRole,
                assignedSiteIds: existingData.assignedSiteIds || []
              }, { merge: true });

              // Sync to Lark khi có thay đổi
              syncToLark('users', {
                "ID": user.uid,
                "Tên": newDisplayName || newEmail,
                "Email": newEmail,
                "Vai trò": existingData.role || currentRole,
                "Trạng thái": existingData.verified ? 'Đã xác thực' : 'Chưa xác thực'
              });
            }
          }
        } catch (e) {
          console.error("Error checking/syncing user status", e);
          setIsAdmin(isUserAdmin); // Fallback to email check if network fails
        }
      } else {
        setIsAdmin(false);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-24 h-24 bg-blue-600 rounded-3xl flex items-center justify-center shadow-2xl animate-pulse mb-6">
          <Construction size={48} className="text-white" />
        </div>
        <h1 className="text-2xl font-black text-gray-900 uppercase tracking-tighter">
          Công Trường Check-in
        </h1>
        <p className="text-gray-500 font-medium mt-2">Đang khởi động hệ thống...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-8 text-center">
        <div className="w-32 h-32 bg-blue-600 rounded-[40px] flex items-center justify-center shadow-2xl mb-12 transform rotate-3">
          <HardHat size={64} className="text-white" />
        </div>
        
        <div className="space-y-4 mb-12">
          <h1 className="text-4xl font-black text-gray-900 uppercase tracking-tighter leading-none">
            Hệ Thống <br />
            <span className="text-blue-600">Chấm Công</span>
          </h1>
          <p className="text-gray-500 font-medium max-w-xs mx-auto">
            Ứng dụng dành riêng cho kỹ sư và công nhân tại các công trường xây dựng.
          </p>
        </div>

        {loginError && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl max-w-xs w-full text-left">
            <p className="text-sm text-red-600 font-medium">{loginError}</p>
            <p className="text-xs text-red-500 mt-2">
              Lưu ý: Nếu bạn dùng trình duyệt nhúng (Zalo, Facebook) hoặc Safari trên iPhone, hãy thử nút "Đăng nhập (Chuyển hướng)" bên dưới.
            </p>
          </div>
        )}

        <div className="space-y-3 w-full max-w-xs">
          <button
            onClick={async () => {
              try {
                setLoginError(null);
                await signInWithGoogle();
              } catch (error: any) {
                console.error('Login error:', error);
                setLoginError(error.message || 'Đăng nhập thất bại. Vui lòng thử lại.');
              }
            }}
            className="w-full h-16 bg-gray-900 text-white rounded-3xl flex items-center justify-center gap-4 font-bold text-lg shadow-xl active:scale-95 transition-all"
          >
            <img 
              src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" 
              alt="Google" 
              className="w-6 h-6"
              referrerPolicy="no-referrer"
            />
            Đăng nhập Google
          </button>

          <button
            onClick={async () => {
              try {
                setLoginError(null);
                await signInWithGoogleRedirect();
              } catch (error: any) {
                console.error('Redirect login error:', error);
                setLoginError(error.message || 'Đăng nhập chuyển hướng thất bại.');
              }
            }}
            className="w-full h-14 bg-white border-2 border-gray-200 text-gray-700 rounded-3xl flex items-center justify-center gap-3 font-bold text-sm shadow-sm hover:bg-gray-50 active:scale-95 transition-all"
          >
            Đăng nhập (Chuyển hướng)
          </button>
        </div>
        
        <p className="mt-8 text-xs text-gray-400 uppercase font-bold tracking-widest">
          Bảo mật bởi Google Firebase
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-32">
      {/* Header */}
      <header className="bg-white px-6 py-6 flex items-center justify-between border-b border-gray-100 shadow-sm sticky top-0 z-30">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg relative">
            <ShieldCheck size={24} className="text-white" />
            {isOffline && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 border-2 border-white rounded-full animate-pulse"></span>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-black text-lg text-gray-900 uppercase tracking-tighter leading-none">
                Check-in
              </h1>
              {isOffline && (
                <span className="px-2 py-0.5 bg-red-100 text-red-600 text-[10px] font-bold uppercase tracking-widest rounded-full flex items-center gap-1">
                  <WifiOff size={10} /> Ngoại tuyến
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 font-bold uppercase tracking-widest">
              Kỹ sư: {user.displayName?.split(' ').pop()}
            </p>
          </div>
        </div>
        <button
          onClick={logout}
          className="p-3 bg-gray-100 rounded-2xl text-gray-600 hover:bg-gray-200 active:scale-90 transition-all"
        >
          <LogOut size={20} />
        </button>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto">
        {activeTab === 'attendance' && <AttendanceForm />}
        {activeTab === 'history' && <AttendanceHistory />}
        {activeTab === 'dashboard' && <UserDashboard />}
        {activeTab === 'requests' && <WorkRequests />}
        {activeTab === 'calendar' && <AttendanceCalendar isManager={isManager} isAdmin={isAdmin} />}
        {activeTab === 'admin' && <AdminPanel isAdmin={isAdmin} isManager={isManager} />}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-8 left-4 right-4 bg-gray-900 rounded-[32px] p-1.5 flex items-center shadow-2xl z-30 max-w-md mx-auto">
        {([
          { tab: 'attendance', icon: <Construction size={18} />, label: 'Chấm' },
          { tab: 'history',    icon: <Clock size={18} />,        label: 'Lịch sử' },
          { tab: 'dashboard',  icon: <BarChart3 size={18} />,    label: 'Báo cáo' },
          { tab: 'calendar',   icon: <CalendarDays size={18} />, label: 'Lịch' },
          { tab: 'requests',   icon: <FileText size={18} />,     label: 'Đề xuất' },
        ] as { tab: typeof activeTab; icon: React.ReactNode; label: string }[]).map(({ tab, icon, label }) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 h-14 rounded-[22px] flex flex-col items-center justify-center gap-0.5 font-bold transition-all",
              activeTab === tab ? "bg-white text-gray-900 shadow-lg" : "text-gray-400"
            )}
          >
            {icon}
            <span className="text-[9px] uppercase tracking-tighter">{label}</span>
          </button>
        ))}
        {(isAdmin || isManager) && (
          <button
            onClick={() => setActiveTab('admin')}
            className={cn(
              "flex-1 h-14 rounded-[22px] flex flex-col items-center justify-center gap-0.5 font-bold transition-all",
              activeTab === 'admin' ? "bg-white text-gray-900 shadow-lg" : "text-gray-400"
            )}
          >
            <Settings size={18} />
            <span className="text-[9px] uppercase tracking-tighter">QL</span>
          </button>
        )}
      </nav>
    </div>
  );
}
