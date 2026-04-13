import type { Metadata } from 'next'
import './kiosk.css'
import PairingWrapper from '@/components/kiosk/PairingWrapper'
import { KioskWebSocketProvider } from '@/contexts/KioskWebSocketContext'

export const metadata: Metadata = {
  title: 'SSCM Kiosk',
  description: 'Self-service kiosk for Smart Shoe Care Machine',
  icons: {
    icon: '/SSCMLogoCircle.webp',
    apple: '/SSCMLogoCircle.webp',
  },
}

const isDebug = process.env.NEXT_PUBLIC_DEBUG === 'true'

export default function UserLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {

    return (
        <KioskWebSocketProvider>
            <PairingWrapper>
                <div className="h-screen w-screen bg-gradient-to-r from-green-200 via-cyan-200 to-blue-400 text-gray-900 flex items-center justify-center">
                    {isDebug && (
                        <div className="fixed top-3 right-3 z-50 flex items-center gap-1.5 bg-yellow-400 text-yellow-900 text-xs font-bold px-3 py-1.5 rounded-full shadow-lg select-none">
                            <span className="w-2 h-2 rounded-full bg-yellow-700 animate-pulse inline-block" />
                            Debug Mode On
                        </div>
                    )}
                    {children}
                </div>
            </PairingWrapper>
        </KioskWebSocketProvider>
    );
}