import type { Metadata } from 'next'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { Toaster } from '@/components/ui/sonner'
import AdminNavBar from '@/components/admin/AdminNavBar'
import { getSession } from '@/lib/actions/auth-action'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: "SSCM Admin Dashboard",
  description: "Admin dashboard for Smart Shoe Care Machine.",
}

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession()
  if (!session?.user || session.user.role !== 'admin') {
    redirect('/client/login')
  }

  return (
    <div className="landing relative min-h-screen overflow-x-hidden">
      {/* Background Decorative Blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 blur-[120px] rounded-full pointer-events-none z-0" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/10 blur-[120px] rounded-full pointer-events-none z-0" />

      <div className="relative z-10 flex flex-col min-h-screen">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange />
        <AdminNavBar />
        <main className="flex-1 px-4 pb-8 max-w-7xl mx-auto w-full">{children}</main>
      </div>
      <Toaster />
    </div>
  )
}
