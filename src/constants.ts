export const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10000,
  // Cho phép dùng cache GPS tối đa 10 giây để tiết kiệm pin
  // (maximumAge: 0 nghĩa là luôn lấy mới — tiêu hao pin không cần thiết)
  maximumAge: 10_000,
};

// Email mặc định của super-admin — không bao giờ bị mất quyền dù role trong Firestore là gì
export const DEFAULT_ADMIN_EMAIL = 'hahvac@gmail.com';
