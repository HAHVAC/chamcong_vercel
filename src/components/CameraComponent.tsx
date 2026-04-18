import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Camera, RefreshCw, X } from 'lucide-react';

interface CameraComponentProps {
  onCapture: (base64Image: string) => void;
  onClose: () => void;
}

export const CameraComponent: React.FC<CameraComponentProps> = ({ onCapture, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startCamera = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }, // Front camera
        audio: false,
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.error('Error accessing camera:', err);
      setError('Không thể truy cập camera. Vui lòng kiểm tra quyền truy cập.');
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [startCamera]);

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      if (context && video.videoWidth > 0 && video.videoHeight > 0) {
        // Calculate new dimensions (max 600px)
        const MAX_DIMENSION = 600;
        let width = video.videoWidth;
        let height = video.videoHeight;

        if (width > height) {
          if (width > MAX_DIMENSION) {
            height *= MAX_DIMENSION / width;
            width = MAX_DIMENSION;
          }
        } else {
          if (height > MAX_DIMENSION) {
            width *= MAX_DIMENSION / height;
            height = MAX_DIMENSION;
          }
        }

        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const base64Image = canvas.toDataURL('image/jpeg', 0.5);
        onCapture(base64Image);
      } else {
        setError('Camera chưa sẵn sàng. Vui lòng thử lại.');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center p-4">
      <div className="relative w-full max-w-md aspect-[3/4] bg-gray-900 rounded-2xl overflow-hidden border-4 border-white/20">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-white">
            <p>{error}</p>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover scale-x-[-1]"
          />
        )}
        <canvas ref={canvasRef} className="hidden" />
        
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-3 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
        >
          <X size={24} />
        </button>
      </div>

      <div className="mt-8 flex gap-6">
        {!error && (
          <button
            onClick={capturePhoto}
            className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-2xl active:scale-90 transition-transform"
          >
            <div className="w-16 h-16 border-4 border-black rounded-full" />
          </button>
        )}
      </div>
      
      <p className="mt-4 text-white/70 font-medium uppercase tracking-widest text-sm">
        Chụp ảnh xác thực
      </p>
    </div>
  );
};
