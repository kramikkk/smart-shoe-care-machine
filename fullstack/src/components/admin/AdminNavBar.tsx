'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { getSession } from '@/lib/actions/auth-action'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { UserProfileDialog } from '@/components/dashboard/UserProfileDialog'
import { getInitials } from '@/lib/utils/strings'

export default function AdminNavBar() {
  const [user, setUser] = useState<{ name: string; email: string; avatar: string } | null>(null)
  const [isProfileOpen, setIsProfileOpen] = useState(false)

  useEffect(() => {
    const fetchUser = async () => {
      const session = await getSession()
      if (session?.user) {
        setUser({
          name: session.user.name || "Admin",
          email: session.user.email,
          avatar: session.user.image || "/SSCMlogo.png"
        })
      }
    }
    fetchUser()
  }, [])

  return (
    <nav className="px-6 py-4 flex items-center justify-between border-b border-white/5 bg-transparent backdrop-blur-md sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <div className="relative w-9 h-9 rounded-full overflow-hidden border border-white/10 shadow-lg flex-shrink-0">
          <Image src="/SSCMLogoCircle.png" alt="SSCM Icon" fill sizes="36px" className="object-cover" />
        </div>
        <span className="text-lg font-black tracking-tighter uppercase italic text-white/90">
          SSCM <span className="text-primary">Admin</span>
        </span>
      </div>

      <div className="flex items-center gap-4">
        {user && (
          <>
            <button 
              onClick={() => setIsProfileOpen(true)}
              className="group flex items-center gap-3 p-1 pr-3 rounded-full hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
            >
              <Avatar className="h-9 w-9 flex-shrink-0 ring-2 ring-transparent group-hover:ring-primary/40 transition-all">
                <AvatarImage src={user.avatar} alt={user.name} className="object-cover" />
                <AvatarFallback className="bg-zinc-900 text-[10px] font-bold">{getInitials(user.name)}</AvatarFallback>
              </Avatar>
              <div className="hidden sm:flex flex-col items-start leading-none text-left">
                <span className="text-xs font-bold text-white/90 group-hover:text-white transition-colors">{user.name}</span>
                <span className="text-[10px] text-muted-foreground group-hover:text-muted-foreground/80 transition-colors">Admin Portal · v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
              </div>
            </button>
            <UserProfileDialog 
              user={user} 
              open={isProfileOpen} 
              onOpenChange={setIsProfileOpen} 
            />
          </>
        )}
      </div>
    </nav>
  )
}
