import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavProgress } from '@/components/feedback/NavProgress';
import { ToastProvider } from '@/components/feedback/Toast';
import { AuthProvider } from '@/lib/auth';
import '@fontsource-variable/montserrat';
import '@fortawesome/fontawesome-free/css/all.min.css';
import './globals.css';
import './editor.css';
import './ui-kit.css';

export const metadata: Metadata = {
  title: 'SAWO Playbook',
  description: 'Standard operating procedures, kanbans and skills for operations teams',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <NavProgress />
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
