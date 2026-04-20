import type { Metadata } from "next";
import SideBar from "@/components/dashboard/SideBar";
import NavBar from "@/components/dashboard/NavBar";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { cookies } from "next/dist/server/request/cookies";
import { Toaster } from "@/components/ui/sonner";
import { DeviceFilterProvider } from "@/contexts/DeviceFilterContext";
import { DashboardWebSocketProvider } from "@/contexts/DashboardWebSocketContext";

export const metadata: Metadata = {
  title: "SSCM Client Dashboard",
  description: "Client dashboard for Smart Shoe Care Machine.",
}

export default async function AdminLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const cookieStore = await cookies()
    const defaultOpen = cookieStore.get("sidebar_state")?.value === "true"

    return (
        <SidebarProvider defaultOpen={defaultOpen}>
            <DeviceFilterProvider>
                <SideBar/>
                <SidebarInset className="flex flex-col h-screen bg-transparent min-w-0">
                    <div className="landing relative flex-1 flex flex-col overflow-hidden min-h-screen">
                        {/* Background Decorative Blobs */}
                        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 blur-[120px] rounded-full pointer-events-none z-0" />
                        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/10 blur-[120px] rounded-full pointer-events-none z-0" />
                        
                        <main className="relative z-10 w-full flex flex-col flex-1 overflow-hidden">
                            <div className="sticky top-0 z-20 bg-transparent"><NavBar/></div>
                            <div className="px-4 sm:px-6 pb-4 flex-1 flex flex-col overflow-y-auto overflow-x-hidden">
                                <ThemeProvider
                                    attribute="class"
                                    defaultTheme="dark"
                                    enableSystem={false}
                                    disableTransitionOnChange
                                />
                                <DashboardWebSocketProvider>
                                    {children}
                                </DashboardWebSocketProvider>
                            </div>
                        </main>
                    </div>
                </SidebarInset>
                <Toaster />
            </DeviceFilterProvider>
        </SidebarProvider>
    );
}




