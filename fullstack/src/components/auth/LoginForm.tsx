"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useState } from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { signIn } from "@/lib/auth-client"
import { useRouter } from "next/navigation"

import { motion } from "motion/react"

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [showPassword, setShowPassword] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      const result = await signIn.email({
        email,
        password,
      })

      if (result.error) {
        if (result.error.code === 'EMAIL_NOT_VERIFIED') {
          setError("Please verify your email before logging in. Check your inbox for the verification link.")
        } else {
          setError(result.error.message || "Invalid email or password")
        }
        setLoading(false)
        return
      }

      const role = (result.data?.user as any)?.role
      router.replace(role === 'admin' ? '/admin/dashboard' : '/client/dashboard')
    } catch (err) {
      setError("An error occurred. Please try again.")
      setLoading(false)
    }
  }

  return (
    <div className={cn("flex flex-col gap-8 w-full max-w-[400px] px-4 mx-auto", className)} {...props}>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="flex flex-col items-start gap-2"
      >
        <Link href="/" className="group mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center group-hover:bg-primary transition-colors">
              <img
                src="/SSCMLogoCircle.webp"
                alt="Logo"
                className="w-6 h-6 group-hover:invert transition-all"
              />
            </div>
            <span className="editorial-caps text-[10px] tracking-[0.3em] opacity-50 group-hover:opacity-100 transition-opacity">WELCOME BACK</span>
          </div>
        </Link>

        <h1 className="text-4xl font-black tracking-tighter uppercase italic">
          Login <br /> <span className="text-primary">Interface</span>
        </h1>
        <p className="text-muted-foreground text-sm font-medium">
          Access your smart shoe care machine dashboard.
        </p>
      </motion.div>

      <motion.form
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.2 }}
        className="space-y-6"
        onSubmit={handleSubmit}
      >
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm px-4 py-3 rounded-sm font-medium">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <Field>
            <FieldLabel className="editorial-caps text-[10px] opacity-60 mb-2 block" htmlFor="email">Email Address</FieldLabel>
            <Input
              id="email"
              type="email"
              placeholder="Enter email address"
              className="bg-transparent border-white/10 h-12 rounded-sm focus-visible:ring-primary/50"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </Field>

          <Field>
            <FieldLabel className="editorial-caps text-[10px] opacity-60 mb-2 block" htmlFor="password">Password</FieldLabel>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter password"
                className="bg-transparent border-white/10 h-12 rounded-sm pr-12 focus-visible:ring-primary/50"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </Field>
        </div>

        <Button
          type="submit"
          disabled={loading}
          className="w-full h-12 rounded-sm font-black uppercase tracking-[0.2em] transition-all hover:tracking-[0.3em] bg-primary text-primary-foreground"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Authenticating...
            </>
          ) : (
            "Login"
          )}
        </Button>

        <div className="pt-8 border-t border-white/5 flex items-center justify-between">
          <span className="text-[10px] font-mono tracking-widest opacity-30 uppercase">© 2026 SSCM</span>
          <Link
            href="/"
            className="text-[10px] font-bold tracking-[0.2em] uppercase text-muted-foreground hover:text-primary transition-colors flex items-center gap-2"
          >
            ← Home
          </Link>
        </div>
      </motion.form>
    </div>
  )
}
