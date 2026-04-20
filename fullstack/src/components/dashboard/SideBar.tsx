"use client"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import Link from "next/link";
import Image from "next/image";
import { ArrowLeftRight, Cpu, LayoutDashboard, QrCode, Settings, Smartphone, Terminal } from "lucide-react";
import { usePathname } from "next/navigation";
import { SideBarUser } from "@/components/dashboard/SideBarUser";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { getSession } from "@/lib/actions/auth-action";

const menu = [
  { title: "Dashboard", url: "/client/dashboard", icon: LayoutDashboard },
  { title: "Transactions", url: "/client/dashboard/transactions", icon: ArrowLeftRight },
  { title: "Monitoring", url: "/client/dashboard/monitoring", icon: Cpu },
  { title: "Commands", url: "/client/dashboard/commands", icon: Terminal },
  { title: "Device Pairing", url: "/client/dashboard/pairing", icon: Smartphone },
  { title: "QR Payment", url: "/client/dashboard/payments", icon: QrCode },
  { title: "Settings", url: "/client/dashboard/settings", icon: Settings },
]

const SideBar = () => {
  const pathname = usePathname();
  const [user, setUser] = useState<{ name: string; email: string; avatar: string } | null>(null);

  useEffect(() => {
    const fetchUser = async () => {
      const session = await getSession();
      if (session?.user) {
        setUser({
          name: session.user.name || "User",
          email: session.user.email || "user@example.com",
          avatar: session.user.image || "/SSCMlogo.webp"
        });
      } else {
        // Fallback to default user if no session
        setUser({
          name: "Admin",
          email: "admin@example.com",
          avatar: "/SSCMlogo.webp"
        });
      }
    };
    fetchUser();
  }, []);

  const isActive = (url: string) => {
    if (url === "/client/dashboard") {
      return pathname === url;
    }
    return pathname.startsWith(url);
  };

  return (
    <>
      <Sidebar collapsible="offcanvas" className="landing border-r border-white/5 bg-transparent backdrop-blur-xl">
        <SidebarHeader className="py-8 px-4">
            <Link href="/client/dashboard" className="flex items-center gap-3 transition-all group">
                <div className="relative p-2 rounded-xl bg-primary/20 border border-primary/20 group-hover:bg-primary/30 transition-all shadow-[0_0_20px_rgba(var(--primary),0.2)]">
                  <Image src="/SSCMlogoTrans.webp" alt="Logo" width={28} height={28} priority className="object-contain drop-shadow-2xl"/>
                </div>
                <div className="flex flex-col">
                    <span className="text-sm font-black tracking-wider uppercase leading-none text-white/90">Smart Shoe <span className="text-primary text-nowrap">Care Machine</span></span>
                    <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-muted-foreground/50 mt-1">Client Portal</span>
                </div>
            </Link>
        </SidebarHeader>
        
        <SidebarContent className="px-3">
            <SidebarGroup>
                <SidebarGroupContent>
                <SidebarMenu className="gap-2">
                    {menu.map((item) => {
                    const Icon = item.icon;
                    const active = isActive(item.url);
                    return (
                        <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton 
                          asChild 
                          isActive={active}
                          className={`h-11 px-3 rounded-xl transition-all duration-300 group
                            ${active 
                              ? "!bg-primary/10 !text-primary border border-primary/10 shadow-[0_0_15px_rgba(var(--primary),0.05)]"
                              : "text-muted-foreground/60 hover:text-white hover:bg-white/5 hover:border-white/5 border border-transparent"}`}
                        >
                            <Link href={item.url} className="flex items-center gap-3">
                                <div className={`p-1.5 rounded-lg transition-colors duration-200 ${active ? "bg-primary/20 text-primary" : "text-muted-foreground/60 group-hover:text-white"}`}>
                                  <Icon className="w-4.5 h-4.5" />
                                </div>
                                <span className="font-semibold tracking-wide text-sm">{item.title}</span>
                                {active && (
                                  <motion.div 
                                    layoutId="active-pill"
                                    className="ml-auto w-1 h-4 bg-primary rounded-full shadow-[0_0_12px_rgba(79,156,249,0.8)]"
                                    transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                  />
                                )}
                            </Link>
                        </SidebarMenuButton>
                        </SidebarMenuItem>
                    );
                    })}
                </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-4 mt-auto">
            <div className="pt-4 border-t border-white/10">
              <div className="flex items-center justify-between mb-3 px-1">
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-muted-foreground/30">Portal</span>
                <span className="text-[10px] font-mono text-muted-foreground/30">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
              </div>
              {user && (
                <SideBarUser
                  user={user}
                  onProfileUpdated={(name, image) => setUser(prev => prev ? { ...prev, name, avatar: image } : null)}
                />
              )}
            </div>
        </SidebarFooter>
      </Sidebar>
      <style jsx global>{`
        [data-sidebar="sidebar"] {
          background: #050505 !important;
        }
        [data-sidebar="sidebar"][data-mobile="true"] {
          --primary: oklch(0.6 0.2 250);
          --primary-foreground: oklch(0.985 0 0);
          --muted-foreground: oklch(0.6 0 0);
          --sidebar-accent: oklch(1 0 0 / 0.05);
          --sidebar-accent-foreground: oklch(1 0 0);
          --sidebar-foreground: oklch(0.95 0 0);
          --sidebar-border: oklch(1 0 0 / 0.05);
          --sidebar-primary: oklch(0.6 0.2 250);
        }
        @media (min-width: 768px) {
          [data-sidebar="sidebar"] {
            background: transparent !important;
            z-index: 30;
          }
        }
      `}</style>
    </>
  )
}
export default SideBar