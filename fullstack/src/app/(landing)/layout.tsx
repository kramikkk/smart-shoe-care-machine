import type { Metadata } from "next"
import { SmoothScrollProvider } from "@/components/providers/SmoothScrollProvider"

export const metadata: Metadata = {
  title: "Smart Shoe Care Machine",
  description: "Revolutionizing shoe care through intelligent automation, IoT integration, and AI-powered recognition.",
}

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="dark landing">
      <SmoothScrollProvider>
        {children}
      </SmoothScrollProvider>
    </div>
  )
}
