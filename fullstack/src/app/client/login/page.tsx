import type { Metadata } from "next"
import { LoginForm } from "@/components/auth/LoginForm"

export const metadata: Metadata = {
  title: "SSCM Login",
  description: "Sign in to Smart Shoe Care Machine.",
}
import { LoginVisualSide } from "@/components/auth/LoginVisualSide"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await auth.api.getSession({
      headers: await headers(),
    });
    if (session) {
      if (session.user.role === 'admin') {
        redirect("/admin/dashboard");
      }
      redirect("/client/dashboard");
    }
    
  return (
    <main className="landing h-svh bg-background flex flex-col md:flex-row overflow-hidden selection:bg-primary/30 selection:text-primary">
        {/* Visual Side - Left on Desktop */}
        <section className="hidden md:block md:w-[55%] lg:w-[60%] h-full relative">
            <LoginVisualSide />
        </section>

        {/* Form Side - Right on Desktop */}
        <section className="flex-1 flex flex-col items-center justify-center p-8 md:p-12 lg:p-24 relative z-10 bg-background">
            {/* Background elements for mobile or subtle depth */}
            <div className="absolute inset-0 z-0 opacity-30 md:hidden">
                <div className="absolute inset-0 bg-gradient-to-b from-primary/10 to-transparent" />
            </div>
            
            <div className="w-full max-w-md relative z-10">
                <LoginForm />
            </div>

            {/* Subtle noise overlay for the form side too */}
            <div className="absolute inset-0 z-[-1] opacity-[0.03] pointer-events-none noise-overlay" />
        </section>
    </main>
  )
}
