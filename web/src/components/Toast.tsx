import { useEffect, useState } from 'react';
import { IconAlertTriangle, IconCheck, IconInfo } from './Icons';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

let toastListener: ((toast: ToastMessage) => void) | null = null;

export const notify = {
  success: (msg: string) => toastListener?.({ id: Math.random().toString(36).slice(2), type: 'success', message: msg }),
  error: (msg: string) => toastListener?.({ id: Math.random().toString(36).slice(2), type: 'error', message: msg }),
  info: (msg: string) => toastListener?.({ id: Math.random().toString(36).slice(2), type: 'info', message: msg }),
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    toastListener = (toast) => {
      setToasts((prev) => [...prev.slice(-4), toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 4000);
    };
    return () => {
      toastListener = null;
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.type === 'success' && <IconCheck style={{ width: 16, height: 16 }} className="toast-icon" />}
          {t.type === 'error' && <IconAlertTriangle style={{ width: 16, height: 16 }} className="toast-icon" />}
          {t.type === 'info' && <IconInfo style={{ width: 16, height: 16 }} className="toast-icon" />}
          <span className="toast-text">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
