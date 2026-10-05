import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import '@fontsource-variable/montserrat';
import './globals.css';
import './editor.css';

export const metadata: Metadata = {
  title: 'SAWO Playbook',
  description: 'Standard operating procedures, kanbans and skills for operations teams',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
